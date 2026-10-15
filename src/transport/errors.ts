export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    /** Parsed Retry-After header, in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get isRetryable(): boolean {
    return this.status === 503 || this.status === 502 || this.status === 504 || this.status === 429 || this.status === 0;
  }
}

/** Network failure / CORS / server down. Modelled as status 0 so it is retryable. */
export class NetworkError extends ApiError {
  constructor(cause: unknown) {
    super(`Network error: ${cause instanceof Error ? cause.message : String(cause)}`, 0, null);
    this.name = 'NetworkError';
  }
}

export class ValidationError extends Error {
  constructor(message: string, readonly issues: unknown) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class CircuitOpenError extends Error {
  constructor(readonly retryAt: number) {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

/** Retry-After may be delta-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}
