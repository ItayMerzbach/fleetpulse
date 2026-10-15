import type { Store } from '../core/store';
import { FleetResponseSchema, HistoryResponseSchema, TruckDetailSchema } from '../domain/schemas';
import type { FleetTruck } from '../domain/types';
import type { ApiClient } from '../transport/ApiClient';
import { CircuitBreaker } from '../transport/CircuitBreaker';
import { ApiError, CircuitOpenError } from '../transport/errors';
import { withRetry, type RetryOptions } from '../transport/retry';
import type { FleetState } from '../stores/stores';
import type { Metrics } from './Metrics';

const CACHE_KEY = 'fleetpulse.fleetCache';

export interface FleetServiceOptions {
  pollIntervalMs?: number;
  breakerCooldownMs?: number;
  retry?: Partial<RetryOptions>;
  storage?: Storage;
  onSnapshot?: (fleet: FleetTruck[], timestamp: number) => void;
}

/**
 * Fleet snapshot (REST) with layered resilience:
 *
 *   poll ─▶ withRetry (respects Retry-After) ─▶ CircuitBreaker ─▶ GET /api/fleet
 *
 * Each HTTP attempt passes through the breaker, so 3 consecutive 503s — even
 * within one retry sequence — trip it. While open we serve the last good
 * snapshot (memory → localStorage) flagged as stale, and schedule a single
 * probe for when the cooldown ends. Live SSE telemetry keeps flowing during
 * degraded mode, so positions stay fresh even though names/route ids may lag.
 */
export class FleetService {
  readonly breaker: CircuitBreaker;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private readonly pollIntervalMs: number;

  constructor(
    private readonly api: ApiClient,
    private readonly store: Store<FleetState>,
    private readonly metrics: Metrics,
    private readonly opts: FleetServiceOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 15_000;
    this.breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: opts.breakerCooldownMs ?? 10_000,
      isFailure: (e) => e instanceof ApiError && e.isRetryable,
      onStateChange: (breaker) =>
        this.store.setState((s) => ({
          ...s,
          source: {
            ...s.source,
            breaker,
            nextProbeAt: breaker === 'open' ? this.breaker.retryAt : null,
          },
        })),
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.sync();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Fetch now. Concurrent callers share the same request. */
  sync(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.doSync().finally(() => {
        this.inFlight = null;
        this.scheduleNext();
      });
    }
    return this.inFlight;
  }

  async fetchDetail(truckId: string): Promise<void> {
    const detail = await this.api.request(`/api/fleet/${encodeURIComponent(truckId)}`, { schema: TruckDetailSchema });
    this.store.setState((s) => ({
      ...s,
      details: { ...s.details, [truckId]: { mileage: detail.mileage, fetchedAt: Date.now() } },
    }));
  }

  fetchHistory(truckId: string, limit = 60) {
    return this.api.request(`/api/telemetry/history/${encodeURIComponent(truckId)}?limit=${limit}`, {
      schema: HistoryResponseSchema,
    });
  }

  private async doSync(): Promise<void> {
    try {
      const { fleet, timestamp } = await withRetry(() => this.breaker.execute(() => this.api.request('/api/fleet', { schema: FleetResponseSchema })), {
        retries: 3,
        // Stop retrying once the breaker has opened: sleeping on Retry-After only
        // to be rejected by the breaker would delay degraded mode for nothing.
        shouldRetry: (e) => e instanceof ApiError && e.isRetryable && this.breaker.state !== 'open',
        onRetry: (e) => {
          this.metrics.inc('httpRetries');
          if (e instanceof ApiError && e.status === 503) this.metrics.inc('http503');
        },
        ...this.opts.retry,
      });
      this.applySnapshot(fleet, timestamp);
      this.writeCache(fleet, timestamp);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) this.metrics.inc('http503');
      this.metrics.inc('httpErrors');
      this.enterDegraded(err);
    }
  }

  private applySnapshot(fleet: FleetTruck[], timestamp: number) {
    const info: Record<string, FleetTruck> = {};
    for (const t of fleet) info[t.id] = t;
    this.store.setState((s) => ({
      ...s,
      info,
      source: { ...s.source, mode: 'live', lastSyncAt: Date.now(), dataAsOf: timestamp, error: null, nextProbeAt: null },
    }));
    this.opts.onSnapshot?.(fleet, timestamp);
  }

  private enterDegraded(err: unknown) {
    const message =
      err instanceof CircuitOpenError
        ? 'Fleet API unavailable (circuit open) — showing cached data'
        : err instanceof Error
          ? err.message
          : 'Unknown error';
    const hasData = Object.keys(this.store.getState().info).length > 0;
    let cached: { fleet: FleetTruck[]; timestamp: number } | null = null;
    if (!hasData) cached = this.readCache();

    this.store.setState((s) => ({
      ...s,
      info: cached ? Object.fromEntries(cached.fleet.map((t) => [t.id, t])) : s.info,
      source: {
        ...s.source,
        mode: hasData || cached ? 'degraded' : 'error',
        dataAsOf: cached ? cached.timestamp : s.source.dataAsOf,
        error: message,
        nextProbeAt: this.breaker.state === 'open' ? this.breaker.retryAt : s.source.nextProbeAt,
      },
    }));
  }

  private scheduleNext() {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    // While open, probe exactly when the cooldown ends instead of the regular poll.
    const delay =
      this.breaker.state === 'open' ? Math.max(250, this.breaker.retryAt - Date.now()) : this.pollIntervalMs;
    this.pollTimer = setTimeout(() => void this.sync(), delay);
  }

  private writeCache(fleet: FleetTruck[], timestamp: number) {
    try {
      (this.opts.storage ?? globalThis.localStorage)?.setItem(CACHE_KEY, JSON.stringify({ fleet, timestamp }));
    } catch {
      /* quota / private mode: cache is best-effort */
    }
  }

  private readCache(): { fleet: FleetTruck[]; timestamp: number } | null {
    try {
      const raw = (this.opts.storage ?? globalThis.localStorage)?.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = FleetResponseSchema.safeParse(JSON.parse(raw));
      return parsed.success ? { fleet: parsed.data.fleet, timestamp: parsed.data.timestamp } : null;
    } catch {
      return null;
    }
  }
}
