import type { z } from 'zod';
import { ApiError, NetworkError, ValidationError, parseRetryAfter } from './errors';

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Optimistic-locking version, sent as If-Match. */
  ifMatch?: number;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Read lazily so the header always reflects the current dispatcher. */
  getDispatcherId: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  onResponse?: (info: { method: string; path: string; status: number; durationMs: number }) => void;
}

/**
 * Thin, typed HTTP layer:
 *  - attaches X-Dispatcher-Id on every request (server uses it for attribution)
 *  - attaches If-Match for optimistic locking
 *  - converts non-2xx into ApiError (with parsed Retry-After)
 *  - validates every response body against a zod schema
 * Retry / circuit breaking are composed on top by the services, not baked in,
 * so each call site chooses its own resilience policy.
 */
export class ApiClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
  }

  async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const dispatcherId = this.opts.getDispatcherId();
    if (dispatcherId) headers['X-Dispatcher-Id'] = dispatcherId;
    if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch);
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.opts.timeoutMs ?? 10_000);
    const onAbort = () => timeout.abort();
    options.signal?.addEventListener('abort', onAbort);
    const started = performance.now();

    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.baseUrl + path, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: timeout.signal,
      });
    } catch (err) {
      throw new NetworkError(err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    this.opts.onResponse?.({ method, path, status: res.status, durationMs: performance.now() - started });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const message =
        body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
          ? body.error
          : `HTTP ${res.status}`;
      throw new ApiError(message, res.status, body, parseRetryAfter(res.headers.get('Retry-After')));
    }

    const parsed = options.schema.safeParse(body);
    if (!parsed.success) throw new ValidationError(`Unexpected response from ${method} ${path}`, parsed.error.issues);
    return parsed.data;
  }
}
