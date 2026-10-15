import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetPulse, type FleetPulse } from '../../src/app/createFleetPulse';
import { fakeFetch, memoryStorage, reading, route } from '../helpers';
import { FakeEventSource, FakeWebSocket, resetFakes } from './fakes';

const fleetTruck = (id: string, over = {}) => ({
  id, name: `Truck ${id}`, status: 'active', location: { lat: 32.08, lng: 34.78 }, speed: 40, heading: 0,
  fuel: 60, engineTemp: 85, currentRouteId: null, _version: 1, ...over,
});

function boot(responses: Parameters<typeof fakeFetch>[0] = []) {
  const net = fakeFetch([
    { status: 200, body: { fleet: [fleetTruck('truck_1'), fleetTruck('truck_7')], timestamp: 1 } },
    { status: 200, body: { routes: [], timestamp: 1 } },
    ...responses,
  ]);
  const app = createFleetPulse({
    apiBaseUrl: 'http://api',
    wsUrl: 'ws://api/ws',
    identity: { id: 'dana-0001', name: 'Dana' },
    transports: {
      fetchImpl: net.impl,
      storage: memoryStorage(),
      createEventSource: (u) => new FakeEventSource(u) as unknown as EventSource,
      createWebSocket: (u) => new FakeWebSocket(u) as unknown as WebSocket,
    },
  });
  app.start();
  const sse = FakeEventSource.instances[0];
  const ws = FakeWebSocket.instances[0];
  sse.open();
  ws.open();
  ws.push({ type: 'registered', dispatcherId: 'dana-0001' });
  return { app, sse, ws, net };
}

/** Fleet store notifications are frame-batched; read state directly. */
const fleetState = (app: FleetPulse) => app.stores.fleet.getState();

describe('FleetPulse end-to-end wiring (fake network)', () => {
  beforeEach(() => resetFakes());
  afterEach(() => vi.useRealTimers());

  it('registers the dispatcher over WS with a stable id and announces presence', () => {
    const { ws, app } = boot();
    expect(ws.sent[0]).toEqual({ type: 'register_dispatcher', dispatcherId: 'dana-0001', name: 'Dana' });
    expect(ws.sent).toContainEqual({ type: 'viewing_truck', truckId: null });
    app.stop();
  });

  it('SSE: truck_7 at 999 km/h is displayed as last valid speed + fault, raw kept for debugging', () => {
    const { sse, app } = boot();
    sse.push({ type: 'telemetry', timestamp: 1000, readings: [reading({ truckId: 'truck_7', timestamp: 1000, speed: 35 })] });
    sse.push({ type: 'telemetry', timestamp: 3000, readings: [reading({ truckId: 'truck_7', timestamp: 3000, speed: 999 })] });
    expect(fleetState(app).telemetry.truck_7.speed).toMatchObject({ value: 35, raw: 999, quality: 'fault' });
    expect(app.stores.anomalies.getState().counts.speed_implausible).toBe(1);
    app.stop();
  });

  it('SSE: a fuel glitch never raises a low-fuel alert, but a real low reading raises exactly one', () => {
    const { sse, app } = boot();
    const tick = (ts: number, fuel: number) => sse.push({ type: 'telemetry', timestamp: ts, readings: [reading({ timestamp: ts, fuel })] });
    tick(1000, 40);
    tick(3000, 0); // braking glitch
    tick(5000, 0);
    tick(7000, 39.9);
    expect(app.stores.alerts.getState()).toHaveLength(0);

    tick(9000, 20);
    tick(11_000, 16); // real, gradual decline (each step < 15 pts, so not a glitch)
    tick(13_000, 14.5);
    tick(15_000, 14.2);
    tick(17_000, 15.5); // hovering around the threshold must not re-alert (hysteresis)
    tick(19_000, 14.1);
    const alerts = app.stores.alerts.getState();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ truckId: 'truck_1', source: 'system', severity: 'warning' });
    app.stop();
  });

  it('SSE: malformed messages and readings are counted and dropped without breaking the stream', () => {
    const { sse, app } = boot();
    sse.push('not json');
    sse.push({ type: 'telemetry', timestamp: 1, readings: [{ truckId: 'truck_1' }, reading({ timestamp: 2000 })] });
    expect(fleetState(app).telemetry.truck_1.lastTimestamp).toBe(2000);
    expect(app.metrics.snapshot().invalidMessages).toBe(2);
    app.stop();
  });

  it('WS: route events update the route store and build an attributed audit trail', () => {
    const { ws, app } = boot();
    ws.push({ type: 'dispatcher_joined', dispatcherId: 'omer-1a2b', name: 'Omer', timestamp: 1, activeDispatchers: 2 });
    const r1 = route({ assignedBy: 'omer-1a2b' });
    ws.push({ type: 'route_assigned', route: r1, truckId: 'truck_1', assignedBy: 'omer-1a2b', truckVersion: 2, timestamp: 2 });
    // An OLDER version arriving late must not roll the route back.
    ws.push({ type: 'route_updated', route: { ...r1, _version: 3, status: 'in-progress' }, updatedBy: 'omer-1a2b', timestamp: 4 });
    ws.push({ type: 'route_updated', route: { ...r1, _version: 2, status: 'assigned' }, updatedBy: 'omer-1a2b', timestamp: 3 });

    expect(app.stores.routes.getState().routes.route_1).toMatchObject({ _version: 3, status: 'in-progress' });
    const summaries = app.stores.audit.getState().map((e) => e.summary);
    expect(summaries).toContain('Omer assigned route_1 → truck_1 (Port of Jaffa, normal)');
    // newcomer discovery: we re-announce when someone joins
    expect(ws.sent.filter((m) => (m as { type: string }).type === 'viewing_truck').length).toBeGreaterThanOrEqual(2);
    app.stop();
  });

  it('WS: a ghost leave arriving after the dispatcher left does not break presence or the audit log', () => {
    const { ws, app } = boot();
    ws.push({ type: 'dispatcher_joined', dispatcherId: 'omer-1a2b', name: 'Omer', timestamp: 1, activeDispatchers: 2 });
    ws.push({ type: 'dispatcher_left', dispatcherId: 'omer-1a2b', timestamp: 2, activeDispatchers: 1 });
    ws.push({ type: 'dispatcher_left', dispatcherId: 'omer-1a2b', timestamp: 12, activeDispatchers: 1 });
    ws.push({ type: 'dispatcher_left', dispatcherId: 'dana-0001', timestamp: 13, activeDispatchers: 1 }); // our own ghost
    expect(app.stores.presence.getState().others).toEqual({});
    expect(app.stores.audit.getState().filter((e) => e.action === 'dispatcher_left')).toHaveLength(1);
    app.stop();
  });
});

describe('FleetService degraded mode (circuit breaker bonus)', () => {
  beforeEach(() => resetFakes());

  it('three consecutive 503s open the breaker and serve the cached snapshot marked stale; recovery returns to live', async () => {
    const { FleetService } = await import('../../src/services/FleetService');
    const { ApiClient } = await import('../../src/transport/ApiClient');
    const { Metrics } = await import('../../src/services/Metrics');
    const { createStores } = await import('../../src/stores/stores');

    const storage = memoryStorage();
    storage.setItem('fleetpulse.fleetCache', JSON.stringify({ fleet: [fleetTruck('truck_1')], timestamp: 42 }));
    const busy = { status: 503, body: { error: 'Service under heavy load' }, headers: { 'Retry-After': '3' } };
    const net = fakeFetch([busy, busy, busy, { status: 200, body: { fleet: [fleetTruck('truck_1', { name: 'Fresh' })], timestamp: 99 } }]);
    const stores = createStores('me');
    const sleeps: number[] = [];
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const service = new FleetService(new ApiClient({ baseUrl: '', getDispatcherId: () => 'me', fetchImpl: net.impl }), stores.fleet, new Metrics(), {
      storage,
      breakerCooldownMs: 10_000,
      retry: { sleep: async (ms) => void sleeps.push(ms) },
    });

    await service.sync();
    expect(sleeps).toEqual([3000, 3000]); // Retry-After respected between attempts
    expect(service.breaker.state).toBe('open');
    expect(stores.fleet.getState().source).toMatchObject({ mode: 'degraded', breaker: 'open', dataAsOf: 42 });
    expect(stores.fleet.getState().info.truck_1.name).toBe('Truck truck_1');

    now = 10_000; // cooldown elapsed -> half-open probe succeeds
    await service.sync();
    expect(service.breaker.state).toBe('closed');
    expect(stores.fleet.getState().source.mode).toBe('live');
    expect(stores.fleet.getState().info.truck_1.name).toBe('Fresh');
    service.stop();
    vi.restoreAllMocks();
  });
});
