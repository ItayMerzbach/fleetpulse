import type { Route, TelemetryReading } from '../src/domain/types';

export const reading = (over: Partial<TelemetryReading> & { timestamp: number }): TelemetryReading => ({
  truckId: 'truck_1',
  location: { lat: 32.08, lng: 34.78 },
  speed: 40,
  heading: 90,
  fuel: 60,
  engineTemp: 85,
  status: 'active',
  ...over,
});

export const route = (over: Partial<Route> = {}): Route => ({
  id: 'route_1',
  truckId: 'truck_1',
  destination: 'Port of Jaffa',
  priority: 'normal',
  notes: '',
  status: 'assigned',
  assignedBy: 'dana-0001',
  assignedAt: 1_000,
  _version: 1,
  ...over,
});

/** Minimal fetch double: queue of responses, records every request. */
export function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request ${init.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  return { impl, calls, responses };
}

export function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
