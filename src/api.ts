import type { Route, RouteStatus } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: Record<string, unknown>,
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry on 503. Waits for the server's Retry-After when given, otherwise 1 s, 2 s, 4 s.
 * Any other error is thrown immediately.
 */
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, wait = sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof ApiError && err.status === 503;
      if (!retryable || attempt >= retries) throw err;
      await wait(err.retryAfterMs ?? 1000 * 2 ** attempt);
    }
  }
}

export interface FleetTruck {
  id: string;
  name: string;
  status: string;
}

export function createApi(baseUrl: string, dispatcherId: string, fetchImpl: typeof fetch = fetch, wait = sleep) {
  async function request<T>(path: string, options: { method?: string; body?: unknown; ifMatch?: number } = {}): Promise<T> {
    const headers: Record<string, string> = { 'X-Dispatcher-Id': dispatcherId };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.ifMatch !== undefined) headers['If-Match'] = String(options.ifMatch);

    const res = await fetchImpl(baseUrl + path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryAfter = res.headers.get('Retry-After');
      throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status, data, retryAfter ? Number(retryAfter) * 1000 : null);
    }
    return data as T;
  }

  return {
    getFleet: () => withRetry(() => request<{ fleet: FleetTruck[] }>('/api/fleet'), 3, wait),
    getTruck: (id: string) => request<{ mileage: number }>(`/api/fleet/${id}`),
    getRoutes: () => request<{ routes: Route[] }>('/api/routes'),
    createRoute: (input: { truckId: string; destination: string; priority: string; notes: string }) =>
      request<Route>('/api/routes', { method: 'POST', body: input }),
    /** Sends the version the dispatcher was looking at; the server answers 409 if it changed. */
    updateRouteStatus: (route: Route, status: RouteStatus) =>
      request<Route>(`/api/routes/${route.id}`, { method: 'PATCH', body: { status }, ifMatch: route._version }),
    reassignRoute: (routeId: string, newTruckId: string) =>
      request<Route>(`/api/routes/${routeId}/reassign`, { method: 'PUT', body: { newTruckId } }),
    sendAlert: (truckId: string, message: string, severity: string) =>
      request(`/api/fleet/${truckId}/alert`, { method: 'POST', body: { message, severity } }),
  };
}

export type Api = ReturnType<typeof createApi>;
