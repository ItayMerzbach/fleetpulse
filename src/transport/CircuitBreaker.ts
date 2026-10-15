import { CircuitOpenError } from './errors';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker. */
  failureThreshold: number;
  /** How long to stay open before letting a single probe through. */
  cooldownMs: number;
  /** Only these errors count as failures (e.g. 503s — a 404 says nothing about server health). */
  isFailure?: (err: unknown) => boolean;
  now?: () => number;
  onStateChange?: (state: CircuitState, prev: CircuitState) => void;
}

/**
 * Classic three-state circuit breaker.
 *
 *  closed ──(N consecutive failures)──▶ open ──(cooldown elapsed)──▶ half_open
 *    ▲                                   ▲                              │
 *    └──────────── probe succeeds ───────┼──────── probe fails ─────────┘
 *
 * While open, calls fail fast with CircuitOpenError so the UI can switch to
 * cached data immediately instead of hammering an overloaded server.
 * Only one probe is allowed in half_open; concurrent callers fail fast.
 */
export class CircuitBreaker {
  private _state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this._state === 'open' && this.now() - this.openedAt >= this.opts.cooldownMs) return 'half_open';
    return this._state;
  }

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** When the next probe will be allowed (only meaningful while open). */
  get retryAt(): number {
    return this.openedAt + this.opts.cooldownMs;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open') throw new CircuitOpenError(this.retryAt);
    if (state === 'half_open') {
      if (this.probeInFlight) throw new CircuitOpenError(this.retryAt);
      this.transition('half_open');
      this.probeInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.opts.isFailure ? this.opts.isFailure(err) : true) this.onFailure();
      else if (state === 'half_open') this.onSuccess(); // server answered: it's alive
      throw err;
    } finally {
      if (state === 'half_open') this.probeInFlight = false;
    }
  }

  reset(): void {
    this.failures = 0;
    this.transition('closed');
  }

  private onSuccess() {
    this.failures = 0;
    this.transition('closed');
  }

  private onFailure() {
    this.failures++;
    if (this._state === 'half_open' || this.failures >= this.opts.failureThreshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private transition(next: CircuitState) {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    this.opts.onStateChange?.(next, prev);
  }
}
