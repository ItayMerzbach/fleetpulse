import { ApiError } from './errors';

export interface RetryOptions {
  retries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Delay before the next attempt. The server's Retry-After is authoritative;
 * otherwise exponential backoff with full jitter so many dispatchers' browsers
 * don't retry in lockstep (thundering herd on an already overloaded server).
 */
export function computeRetryDelay(err: unknown, attempt: number, opts: RetryOptions): number {
  const max = opts.maxDelayMs ?? 30_000;
  if (err instanceof ApiError && err.retryAfterMs !== null) return Math.min(err.retryAfterMs, max);
  const base = opts.baseDelayMs ?? 500;
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.round((opts.random ?? Math.random)() * exp);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const shouldRetry = opts.shouldRetry ?? ((e) => e instanceof ApiError && e.isRetryable);
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !shouldRetry(err) || opts.signal?.aborted) throw err;
      const delay = computeRetryDelay(err, attempt, opts);
      opts.onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
