import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../../src/transport/CircuitBreaker';
import { ApiError, CircuitOpenError, parseRetryAfter } from '../../src/transport/errors';
import { computeRetryDelay, withRetry } from '../../src/transport/retry';

const e503 = (retryAfterMs: number | null = 3000) => new ApiError('Service under heavy load', 503, {}, retryAfterMs);

describe('withRetry (quirk #7: 503 with Retry-After)', () => {
  it('waits exactly the server-provided Retry-After before retrying', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn().mockRejectedValueOnce(e503(3000)).mockResolvedValueOnce('fleet');
    await expect(withRetry(fn, { retries: 3, sleep })).resolves.toBe('fleet');
    expect(sleep).toHaveBeenCalledWith(3000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('falls back to capped exponential backoff with jitter when there is no Retry-After', () => {
    const opts = { retries: 5, baseDelayMs: 500, maxDelayMs: 4000, random: () => 1 };
    expect([0, 1, 2, 3, 4].map((a) => computeRetryDelay(e503(null), a, opts))).toEqual([500, 1000, 2000, 4000, 4000]);
    expect(computeRetryDelay(e503(null), 3, { ...opts, random: () => 0.25 })).toBe(1000);
  });

  it('gives up after N retries and surfaces the last error', async () => {
    const fn = vi.fn().mockRejectedValue(e503());
    await expect(withRetry(fn, { retries: 2, sleep: async () => {} })).rejects.toBeInstanceOf(ApiError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors (400/404/409)', async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError('conflict', 409, {}));
    await expect(withRetry(fn, { retries: 3, sleep: async () => {} })).rejects.toMatchObject({ status: 409 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('parses Retry-After as seconds or HTTP date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4000)).toBe(6000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('CircuitBreaker', () => {
  const setup = () => {
    let now = 0;
    const transitions: string[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10_000,
      now: () => now,
      isFailure: (e) => e instanceof ApiError && e.isRetryable,
      onStateChange: (s) => transitions.push(s),
    });
    return { breaker, transitions, advance: (ms: number) => (now += ms) };
  };
  const fail = () => Promise.reject(e503());
  const ok = () => Promise.resolve('ok');

  it('opens after 3 consecutive 503s and then fails fast without calling the server', async () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) await expect(breaker.execute(fail)).rejects.toBeInstanceOf(ApiError);
    expect(breaker.state).toBe('open');
    const server = vi.fn(ok);
    await expect(breaker.execute(server)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(server).not.toHaveBeenCalled();
  });

  it('a success in between resets the consecutive-failure count', async () => {
    const { breaker } = setup();
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(fail).catch(() => {});
    await breaker.execute(ok);
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe('closed');
  });

  it('after cooldown lets exactly one probe through; success closes the circuit', async () => {
    const { breaker, transitions, advance } = setup();
    for (let i = 0; i < 3; i++) await breaker.execute(fail).catch(() => {});
    advance(10_000);
    expect(breaker.state).toBe('half_open');

    let release!: (v: string) => void;
    const probe = breaker.execute(() => new Promise<string>((r) => (release = r)));
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError); // concurrent call rejected
    release('ok');
    await expect(probe).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(transitions).toEqual(['open', 'half_open', 'closed']);
  });

  it('a failed probe re-opens the circuit for another full cooldown', async () => {
    const { breaker, advance } = setup();
    for (let i = 0; i < 3; i++) await breaker.execute(fail).catch(() => {});
    advance(10_000);
    await breaker.execute(fail).catch(() => {});
    expect(breaker.state).toBe('open');
    advance(9_999);
    expect(breaker.state).toBe('open');
  });

  it('client errors (404) do not count as server-health failures', async () => {
    const { breaker } = setup();
    for (let i = 0; i < 5; i++) await breaker.execute(() => Promise.reject(new ApiError('nf', 404, {}))).catch(() => {});
    expect(breaker.state).toBe('closed');
  });
});
