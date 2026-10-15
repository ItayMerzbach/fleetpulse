import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, withRetry } from '../src/api';
import { conflictMessage, lastChangedBy, mergeRoute, validateRouteInput } from '../src/routes';
import type { Route } from '../src/types';

const route = (over: Partial<Route> = {}): Route => ({
  id: 'route_1',
  truckId: 'truck_1',
  destination: 'Port of Jaffa',
  priority: 'normal',
  notes: '',
  status: 'assigned',
  assignedBy: 'dana-0001',
  assignedAt: 1000,
  _version: 1,
  ...over,
});

/** fetch double that returns the given responses in order and records requests. */
function fakeFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift()!;
    return new Response(JSON.stringify(next.body), { status: next.status, headers: next.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('optimistic locking', () => {
  it('sends If-Match with the version the dispatcher saw, plus X-Dispatcher-Id', async () => {
    const net = fakeFetch([{ status: 200, body: route({ _version: 4 }) }]);
    await createApi('', 'dana-0001', net.impl).updateRouteStatus(route({ _version: 3 }), 'in-progress');
    const headers = net.calls[0].init.headers as Record<string, string>;
    expect(headers['If-Match']).toBe('3');
    expect(headers['X-Dispatcher-Id']).toBe('dana-0001');
  });

  it('a 409 surfaces as ApiError with the server body', async () => {
    const net = fakeFetch([{ status: 409, body: { error: 'Route was modified by another dispatcher', lastModifiedBy: 'omer-1a2b' } }]);
    const err = await createApi('', 'dana-0001', net.impl).updateRouteStatus(route(), 'cancelled').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  it('the conflict message names who changed the route — including a reassignment', () => {
    const current = route({
      _version: 3,
      status: 'in-progress',
      lastModifiedBy: 'dana-0001',
      lastModifiedAt: 2000,
      reassignedBy: 'omer-1a2b',
      reassignedAt: 3000,
      truckId: 'truck_5',
    });
    expect(lastChangedBy(current)).toBe('omer-1a2b');
    expect(conflictMessage('route_1', current, (id) => (id === 'omer-1a2b' ? 'Omer' : id))).toContain('changed by Omer');
  });

  it('an older version arriving late never overwrites a newer one', () => {
    const newer = route({ _version: 3, status: 'in-progress' });
    const state = mergeRoute({ route_1: newer }, route({ _version: 2 }));
    expect(state.route_1).toBe(newer);
  });
});

describe('503 retry', () => {
  it('waits for the Retry-After the server sends, then succeeds', async () => {
    const net = fakeFetch([
      { status: 503, body: { error: 'Service under heavy load' }, headers: { 'Retry-After': '3' } },
      { status: 200, body: { fleet: [] } },
    ]);
    const waits: number[] = [];
    const result = await createApi('', 'd', net.impl, async (ms) => void waits.push(ms)).getFleet();
    expect(result).toEqual({ fleet: [] });
    expect(waits).toEqual([3000]);
  });

  it('does not retry errors other than 503', async () => {
    const fn = vi.fn().mockRejectedValue(new ApiError('conflict', 409, {}, null));
    await expect(withRetry(fn, 3, async () => {})).rejects.toThrow('conflict');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('route input validation', () => {
  it('rejects too-short destinations and too-long notes', () => {
    expect(validateRouteInput('ab', '')).toMatch(/at least 3/);
    expect(validateRouteInput('Haifa port', 'x'.repeat(501))).toMatch(/Notes/);
    expect(validateRouteInput('Haifa port', '')).toBeNull();
  });
});
