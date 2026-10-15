import { EventBus } from '../core/EventBus';
import { AlertInputSchema } from '../domain/schemas';
import { displayNameFromId } from '../domain/dispatcher';
import type { RouteConflict } from '../domain/routes';
import type { DispatcherIdentity, SseMessage, WsServerMessage } from '../domain/types';
import { FleetService } from '../services/FleetService';
import { Metrics } from '../services/Metrics';
import { PresenceService } from '../services/PresenceService';
import { RouteService } from '../services/RouteService';
import { TelemetryService } from '../services/TelemetryService';
import { ALERT_CAP, AUDIT_CAP, capPrepend, createStores, type AlertItem, type AuditEntry } from '../stores/stores';
import { ApiClient } from '../transport/ApiClient';
import { TruckAlertSchema } from '../domain/schemas';
import { ValidationError } from '../transport/errors';
import { SseConnection } from '../transport/SseConnection';
import { WsConnection } from '../transport/WsConnection';
import { createDefaultVehicleRegistry, type VehicleTypeRegistry } from '../vehicles/vehicleTypes';

export interface FleetPulseConfig {
  apiBaseUrl: string;
  wsUrl: string;
  identity: DispatcherIdentity;
  vehicleTypes?: VehicleTypeRegistry;
  /** Injection points for tests (fake network). */
  transports?: {
    fetchImpl?: typeof fetch;
    createEventSource?: (url: string) => EventSource;
    createWebSocket?: (url: string) => WebSocket;
    storage?: Storage;
  };
}

/** Internal application events. Transports publish; features subscribe. */
export interface AppEvents {
  sse: SseMessage;
  ws: WsServerMessage;
  'sse:reconnected': void;
  'ws:registered': { isReconnect: boolean };
  conflict: RouteConflict;
}

/**
 * Composition root. The only place that knows how the pieces fit together:
 *
 *   SseConnection ──▶ bus 'sse' ──▶ TelemetryService ──▶ fleet / anomaly / alert stores
 *   WsConnection  ──▶ bus 'ws'  ──▶ routes · presence · audit · alerts
 *   UI ──▶ services (RouteService, FleetService, …) ──▶ ApiClient
 *
 * Transports never import stores; UI never imports transports. Swapping SSE for
 * WS, or React for anything else, touches one layer.
 */
export function createFleetPulse(config: FleetPulseConfig) {
  const { identity } = config;
  const metrics = new Metrics();
  const bus = new EventBus<AppEvents>((type, err) => {
    metrics.inc('handlerErrors');
    console.error(`[FleetPulse] "${String(type)}" handler failed`, err);
  });
  const stores = createStores(identity.id);
  const vehicleTypes = config.vehicleTypes ?? createDefaultVehicleRegistry();
  let auditSeq = 0;
  let alertSeq = 0;

  const audit = (entry: Omit<AuditEntry, 'id'>) =>
    stores.audit.setState((list) => capPrepend(list, { ...entry, id: `au_${++auditSeq}` }, AUDIT_CAP));
  const pushAlert = (a: Omit<AlertItem, 'id' | 'acknowledged'> & { id?: string }) =>
    stores.alerts.setState((list) =>
      list.some((x) => x.id === a.id) ? list : capPrepend(list, { ...a, id: a.id ?? `al_${++alertSeq}`, acknowledged: false }, ALERT_CAP),
    );

  const nameOf = (id: string | null | undefined): string => {
    if (!id) return 'unknown';
    if (id === identity.id) return `${identity.name} (you)`;
    return stores.presence.getState().others[id]?.name ?? displayNameFromId(id);
  };

  const api = new ApiClient({
    baseUrl: config.apiBaseUrl,
    getDispatcherId: () => identity.id,
    fetchImpl: config.transports?.fetchImpl,
    onResponse: ({ status }) => {
      if (status === 409) metrics.inc('conflicts409');
    },
  });

  const telemetry = new TelemetryService(vehicleTypes, stores.fleet, stores.anomalies, metrics, (h) =>
    pushAlert({ truckId: h.truckId, message: h.message, severity: h.severity, source: 'system', timestamp: Date.now() }),
  );

  const fleet = new FleetService(api, stores.fleet, metrics, {
    storage: config.transports?.storage,
    onSnapshot: (list, ts) => telemetry.seedFromSnapshot(list, ts),
  });

  const routes = new RouteService(api, stores.routes, (c) => bus.emit('conflict', c));

  const sse = new SseConnection({
    url: `${config.apiBaseUrl}/api/telemetry/stream`,
    createEventSource: config.transports?.createEventSource,
    onMessage: (m) => bus.emit('sse', m),
    onInvalid: () => metrics.inc('invalidMessages'),
    onStatus: (s) => stores.connection.setState((c) => ({ ...c, sse: s })),
    onReconnect: () => {
      metrics.inc('sseReconnects');
      bus.emit('sse:reconnected', undefined);
    },
  });

  const ws = new WsConnection({
    url: config.wsUrl,
    identity,
    createWebSocket: config.transports?.createWebSocket,
    onMessage: (m) => {
      metrics.inc('wsMessages');
      bus.emit('ws', m);
    },
    onInvalid: () => metrics.inc('invalidMessages'),
    onStatus: (s) => stores.connection.setState((c) => ({ ...c, ws: s })),
    onLatency: (ms) => metrics.setWsLatency(ms),
    onReconnect: () => metrics.inc('wsReconnects'),
    onRegistered: (isReconnect) => bus.emit('ws:registered', { isReconnect }),
  });

  const presence = new PresenceService(stores.presence, (m) => ws.send(m));

  // ---------------- event wiring ----------------
  const subscriptions = [
    bus.on('sse', (m) => telemetry.handle(m)),

    // After any gap in the stream, REST is the source of truth for everything
    // SSE doesn't carry (route ids, versions).
    bus.on('sse:reconnected', () => void fleet.sync()),

    bus.on('ws:registered', ({ isReconnect }) => {
      presence.announce();
      // We may have missed route events while disconnected.
      if (isReconnect) void routes.refresh().catch(() => undefined);
    }),

    bus.on('ws', (m) => {
      const receivedAt = Date.now();
      switch (m.type) {
        case 'dispatcher_joined':
          presence.dispatch({ type: 'joined', dispatcherId: m.dispatcherId, name: m.name, receivedAt });
          presence.announce(); // let the newcomer discover us
          audit({ timestamp: m.timestamp, actor: m.dispatcherId, action: 'dispatcher_joined', summary: `${m.name} came online` });
          break;
        case 'dispatcher_left': {
          const known = m.dispatcherId in stores.presence.getState().others;
          presence.dispatch({ type: 'left', dispatcherId: m.dispatcherId, receivedAt });
          if (known) audit({ timestamp: m.timestamp, actor: m.dispatcherId, action: 'dispatcher_left', summary: `${nameOf(m.dispatcherId)} went offline` });
          break;
        }
        case 'dispatcher_viewing':
          presence.dispatch({ type: 'viewing', dispatcherId: m.dispatcherId, truckId: m.truckId, receivedAt });
          break;
        case 'route_assigned':
          routes.upsert(m.route);
          audit({
            timestamp: m.timestamp, actor: m.assignedBy, action: 'route_assigned', routeId: m.route.id, truckId: m.truckId,
            summary: `${nameOf(m.assignedBy)} assigned ${m.route.id} → ${m.truckId} (${m.route.destination}, ${m.route.priority})`,
          });
          break;
        case 'route_updated':
          routes.upsert(m.route);
          audit({
            timestamp: m.timestamp, actor: m.updatedBy, action: 'route_updated', routeId: m.route.id, truckId: m.route.truckId,
            summary: `${nameOf(m.updatedBy)} set ${m.route.id} to "${m.route.status}" (v${m.route._version})`,
          });
          break;
        case 'route_reassigned':
          routes.upsert(m.route);
          audit({
            timestamp: m.timestamp, actor: m.reassignedBy, action: 'route_reassigned', routeId: m.route.id, truckId: m.newTruckId,
            summary: `${nameOf(m.reassignedBy)} moved ${m.route.id} from ${m.oldTruckId ?? '?'} to ${m.newTruckId}`,
          });
          break;
        case 'truck_alert': {
          const a = m.alert;
          const severity = a.severity === 'critical' || a.severity === 'warning' ? a.severity : 'info';
          pushAlert({ id: a.id, truckId: a.truckId, message: a.message, severity, source: 'dispatch', sentBy: a.sentBy, timestamp: a.timestamp });
          audit({ timestamp: a.timestamp, actor: a.sentBy ?? null, action: 'truck_alert', truckId: a.truckId, summary: `${nameOf(a.sentBy)} alerted ${a.truckId}: "${a.message}" [${severity}]` });
          break;
        }
        case 'fleet_reset':
          routes.clear();
          telemetry.reset();
          presence.dispatch({ type: 'reset' });
          presence.announce();
          void fleet.sync();
          audit({ timestamp: m.timestamp, actor: null, action: 'fleet_reset', summary: 'Fleet was reset (dev)' });
          break;
      }
    }),

    bus.on('conflict', (c) => {
      const summary =
        c.kind === 'version'
          ? `Your change to ${c.routeId} was rejected: modified by ${nameOf(c.changedBy)}`
          : c.kind === 'truck_assigned'
            ? `Could not assign ${c.truckId}: already assigned by ${nameOf(c.assignedBy)}`
            : `Could not reassign ${c.routeId}: ${c.newTruckId} is not available`;
      audit({ timestamp: Date.now(), actor: identity.id, action: 'conflict', routeId: 'routeId' in c ? c.routeId : undefined, summary });
    }),
  ];

  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let started = false;

  return {
    identity,
    stores,
    metrics,
    vehicleTypes,
    routes,
    fleet,
    telemetry,
    presence,
    nameOf,

    async sendAlert(truckId: string, input: { message: string; severity: string }) {
      const parsed = AlertInputSchema.safeParse(input);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid alert', parsed.error.issues);
      return api.request(`/api/fleet/${encodeURIComponent(truckId)}/alert`, { method: 'POST', body: parsed.data, schema: TruckAlertSchema });
    },

    acknowledgeAlert(id: string) {
      stores.alerts.setState((list) => list.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)));
    },

    acknowledgeAll() {
      stores.alerts.setState((list) => (list.some((a) => !a.acknowledged) ? list.map((a) => ({ ...a, acknowledged: true })) : list));
    },

    selectTruck(truckId: string | null) {
      stores.ui.setState((u) => (u.selectedTruckId === truckId ? u : { ...u, selectedTruckId: truckId }));
      presence.setViewing(truckId);
    },

    start() {
      if (started) return;
      started = true;
      sse.start();
      ws.start();
      fleet.start();
      presence.start();
      void routes.refresh().catch(() => stores.routes.setState((s) => ({ ...s, loaded: true })));
      metricsTimer = setInterval(() => stores.metrics.setState(metrics.snapshot()), 1000);
    },

    stop() {
      if (!started) return;
      started = false;
      sse.stop();
      ws.stop();
      fleet.stop();
      presence.stop();
      if (metricsTimer) clearInterval(metricsTimer);
      subscriptions.forEach((off) => off());
      bus.clear();
    },
  };
}

export type FleetPulse = ReturnType<typeof createFleetPulse>;
