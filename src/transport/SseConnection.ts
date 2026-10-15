import { SseMessageSchema } from '../domain/schemas';
import type { SseMessage } from '../domain/types';
import { createBackoff } from './backoff';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SseConnectionOptions {
  url: string;
  onMessage: (msg: SseMessage) => void;
  onInvalid?: (raw: string, reason: string) => void;
  onStatus?: (status: ConnectionStatus) => void;
  onReconnect?: () => void;
  /** No data (telemetry every 2 s, heartbeat every 15 s) for this long => assume a dead stream. */
  staleAfterMs?: number;
  createEventSource?: (url: string) => EventSource;
}

/**
 * EventSource wrapper with explicit lifecycle.
 *
 * We don't rely on the browser's built-in reconnect: it retries forever at a
 * fixed interval, gives no visibility, and cannot detect a "silently dead"
 * stream (TCP open, no data). Instead: close on error, reconnect with jittered
 * exponential backoff, and run a watchdog on message freshness.
 */
export class SseConnection {
  private es: EventSource | null = null;
  private status: ConnectionStatus = 'idle';
  private backoff = createBackoff(1000, 30_000);
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private stopped = true;
  private hasConnectedBefore = false;

  constructor(private readonly opts: SseConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    const staleAfter = this.opts.staleAfterMs ?? 20_000;
    this.watchdog = setInterval(() => {
      if (this.status === 'open' && Date.now() - this.lastMessageAt > staleAfter) {
        this.scheduleReconnect();
      }
    }, Math.min(5000, staleAfter));
  }

  stop(): void {
    this.stopped = true;
    this.teardownSource();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnectTimer = null;
    this.watchdog = null;
    this.setStatus('closed');
  }

  private connect() {
    this.setStatus(this.hasConnectedBefore ? 'reconnecting' : 'connecting');
    const es = (this.opts.createEventSource ?? ((u) => new EventSource(u)))(this.opts.url);
    this.es = es;
    es.onopen = () => {
      this.lastMessageAt = Date.now();
      this.backoff.reset();
      this.setStatus('open');
      if (this.hasConnectedBefore) this.opts.onReconnect?.();
      this.hasConnectedBefore = true;
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      this.lastMessageAt = Date.now();
      this.handleRaw(ev.data);
    };
    es.onerror = () => this.scheduleReconnect();
  }

  private handleRaw(raw: string) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.opts.onInvalid?.(raw, 'invalid JSON');
      return;
    }
    const parsed = SseMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.opts.onInvalid?.(raw, parsed.error.issues[0]?.message ?? 'schema mismatch');
      return;
    }
    this.opts.onMessage(parsed.data);
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.teardownSource();
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, this.backoff.next());
  }

  private teardownSource() {
    if (!this.es) return;
    this.es.onopen = this.es.onmessage = this.es.onerror = null;
    this.es.close();
    this.es = null;
  }

  private setStatus(s: ConnectionStatus) {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }
}
