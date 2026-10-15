import { describe, expect, it } from 'vitest';
import { createStore } from '../../src/core/store';
import { RouteConflictError, canReapply, lastActor, mergeRoute } from '../../src/domain/routes';
import { RouteBusyError, RouteRuleError, RouteService } from '../../src/services/RouteService';
import type { RouteState } from '../../src/stores/stores';
import { ApiClient } from '../../src/transport/ApiClient';
import { fakeFetch, route } from '../helpers';

function setup(responses: Parameters<typeof fakeFetch>[0]) {
  const net = fakeFetch(responses);
  const api = new ApiClient({ baseUrl: 'http://x', getDispatcherId: () => 'dana-0001', fetchImpl: net.impl });
  const store = createStore<RouteState>({ routes: {}, loaded: true });
  const conflicts: unknown[] = [];
  const service = new RouteService(api, store, (c) => conflicts.push(c));
  return { service, store, net, conflicts };
}

describe('RouteService — optimistic locking (quirk #4)', () => {
  it('sends If-Match with the version the dispatcher SAW plus the dispatcher header', async () => {
    const seen = route({ _version: 3, status: 'assigned' });
    const { service, net } = setup([{ status: 200, body: route({ _version: 4, status: 'in-progress', lastModifiedBy: 'dana-0001', lastModifiedAt: 2 }) }]);
    await service.updateStatus(seen, 'in-progress');
    expect(net.calls[0]).toMatchObject({ method: 'PATCH', url: 'http://x/api/routes/route_1', body: { status: 'in-progress' } });
    expect(net.calls[0].headers['If-Match']).toBe('3');
    expect(net.calls[0].headers['X-Dispatcher-Id']).toBe('dana-0001');
  });

  it('on 409 fetches the current version and reports BOTH versions and WHO changed it', async () => {
    const seen = route({ _version: 1 });
    const theirs = route({ _version: 2, status: 'in-progress', lastModifiedBy: 'omer-1a2b', lastModifiedAt: 5000 });
    const { service, conflicts } = setup([
      { status: 409, body: { error: 'Route was modified by another dispatcher', currentVersion: 2, yourVersion: 1, lastModifiedBy: 'omer-1a2b' } },
      { status: 200, body: { routes: [theirs], timestamp: 1 } },
    ]);

    const err = await service.updateStatus(seen, 'cancelled').catch((e) => e);
    expect(err).toBeInstanceOf(RouteConflictError);
    expect(err.conflict).toMatchObject({ kind: 'version', changedBy: 'omer-1a2b', mine: seen, theirs, intent: { action: 'status', to: 'cancelled' } });
    expect(conflicts).toHaveLength(1);
  });

  it('quirk #8: PATCH racing a reassign blames the reassigner, not the stale lastModifiedBy', async () => {
    const seen = route({ _version: 2, lastModifiedBy: 'dana-0001', lastModifiedAt: 1000 });
    const theirs = route({ _version: 3, truckId: 'truck_5', lastModifiedBy: 'dana-0001', lastModifiedAt: 1000, reassignedBy: 'noa-77aa', reassignedAt: 2000 });
    const { service } = setup([
      // second check inside the server's delayed handler: no lastModifiedBy in body
      { status: 409, body: { error: 'Route was modified during processing', currentVersion: 3 } },
      { status: 200, body: { routes: [theirs], timestamp: 1 } },
    ]);
    const err = await service.updateStatus(seen, 'in-progress').catch((e) => e);
    expect(err.conflict.changedBy).toBe('noa-77aa');
  });

  it('never sends the request for an invalid transition (completed → in-progress)', async () => {
    const { service, net } = setup([]);
    await expect(service.updateStatus(route({ status: 'completed' }), 'in-progress')).rejects.toBeInstanceOf(RouteRuleError);
    expect(net.calls).toHaveLength(0);
  });

  it('blocks a double-click: a second mutation on the same route while one is in flight', async () => {
    const { service } = setup([{ status: 200, body: route({ _version: 2, status: 'in-progress' }) }]);
    const first = service.updateStatus(route(), 'in-progress');
    await expect(service.updateStatus(route(), 'cancelled')).rejects.toBeInstanceOf(RouteBusyError);
    await first;
    expect(service.isBusy('route_1')).toBe(false);
  });

  it('create → 409 "truck already assigned" names the dispatcher who holds it', async () => {
    const { service } = setup([
      { status: 409, body: { error: 'Truck already assigned', currentRouteId: 'route_9', assignedBy: 'omer-1a2b' } },
      { status: 200, body: { routes: [], timestamp: 1 } },
    ]);
    const err = await service.create({ truckId: 'truck_2', destination: 'Haifa port', priority: 'high' }).catch((e) => e);
    expect(err.conflict).toMatchObject({ kind: 'truck_assigned', assignedBy: 'omer-1a2b', currentRouteId: 'route_9' });
  });

  it('reassign aborts (as a conflict) if the route changed since the dispatcher looked at it', async () => {
    const { service, net } = setup([{ status: 200, body: { routes: [route({ _version: 2, lastModifiedBy: 'omer-1a2b', lastModifiedAt: 9 })], timestamp: 1 } }]);
    const err = await service.reassign(route({ _version: 1 }), 'truck_4').catch((e) => e);
    expect(err).toBeInstanceOf(RouteConflictError);
    expect(net.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('"apply mine on top" re-sends the original intent against THEIR version', async () => {
    const theirs = route({ _version: 4, status: 'in-progress', notes: 'gate 7' });
    const { service, net } = setup([{ status: 200, body: { ...theirs, _version: 5, status: 'completed' } }]);
    await service.reapply({ kind: 'version', routeId: 'route_1', intent: { action: 'status', to: 'completed' }, mine: route({ _version: 3, status: 'in-progress' }), theirs, changedBy: 'omer', serverMessage: '' });
    expect(net.calls[0].headers['If-Match']).toBe('4');
  });
});

describe('route domain helpers', () => {
  it('mergeRoute keeps the higher version regardless of arrival order (WS vs HTTP race)', () => {
    const v2 = route({ _version: 2, status: 'in-progress' });
    const v3 = route({ _version: 3, status: 'completed' });
    expect(mergeRoute(v3, v2)).toBe(v3);
    expect(mergeRoute(v2, v3)).toBe(v3);
  });

  it('canReapply refuses when the other dispatcher already closed the route', () => {
    expect(canReapply({ action: 'status', to: 'in-progress' }, route({ status: 'cancelled' }))).toMatchObject({ ok: false });
    expect(canReapply({ action: 'status', to: 'completed' }, route({ status: 'in-progress' }))).toEqual({ ok: true });
  });

  it('lastActor picks the most recent of assign / update / reassign', () => {
    expect(lastActor(route({ assignedAt: 1, lastModifiedBy: 'a', lastModifiedAt: 5, reassignedBy: 'b', reassignedAt: 3 })).by).toBe('a');
  });
});
