import { createStore, type Store } from '../core/store';
import { initialPresence, type PresenceState } from '../domain/presence';
import type { AnomalyEvent, AnomalyKind, FleetTruck, Route, VehicleTelemetry } from '../domain/types';
import type { CircuitState } from '../transport/CircuitBreaker';
import type { ConnectionStatus } from '../transport/SseConnection';

export interface FleetSourceState {
  /** live = fresh REST snapshot; degraded = breaker open, showing cache; error = nothing to show */
  mode: 'loading' | 'live' | 'degraded' | 'error';
  breaker: CircuitState;
  lastSyncAt: number | null;
  /** Timestamp of the data currently displayed (cache age when degraded). */
  dataAsOf: number | null;
  nextProbeAt: number | null;
  error: string | null;
}

export interface FleetState {
  info: Record<string, FleetTruck>;
  telemetry: Record<string, VehicleTelemetry>;
  details: Record<string, { mileage: number; fetchedAt: number }>;
  source: FleetSourceState;
}

export interface RouteState {
  routes: Record<string, Route>;
  loaded: boolean;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  actor: string | null;
  action:
    | 'route_assigned'
    | 'route_updated'
    | 'route_reassigned'
    | 'truck_alert'
    | 'fleet_reset'
    | 'dispatcher_joined'
    | 'dispatcher_left'
    | 'conflict';
  routeId?: string;
  truckId?: string;
  summary: string;
}

export interface AlertItem {
  id: string;
  truckId: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  source: 'dispatch' | 'system';
  sentBy?: string | null;
  timestamp: number;
  acknowledged: boolean;
}

export interface AnomalyState {
  events: AnomalyEvent[];
  counts: Partial<Record<AnomalyKind, number>>;
}

export interface ConnectionState {
  sse: ConnectionStatus;
  ws: ConnectionStatus;
}

export interface MetricsSnapshot {
  sseEventsPerSec: number;
  sseMessages: number;
  readingsAccepted: number;
  readingsLate: number;
  gpsBatches: number;
  invalidMessages: number;
  sseReconnects: number;
  wsReconnects: number;
  wsLatencyMs: number | null;
  wsMessages: number;
  http503: number;
  httpRetries: number;
  httpErrors: number;
  conflicts409: number;
  handlerErrors: number;
  storeCommitsPerSec: number;
  heapMb: number | null;
  uptimeSec: number;
}

export interface UiState {
  selectedTruckId: string | null;
  panel: 'routes' | 'activity' | 'anomalies' | 'alerts' | 'observability';
  showHelp: boolean;
  filters: { status: 'all' | 'active' | 'idle' | 'maintenance'; lowFuelOnly: boolean; route: 'all' | 'assigned' | 'unassigned'; query: string };
}

const AUDIT_CAP = 500;
const ANOMALY_CAP = 300;
const ALERT_CAP = 200;

export const capPrepend = <T>(list: T[], item: T, cap: number): T[] => [item, ...list].slice(0, cap);

export function createStores(selfId: string) {
  return {
    // Telemetry store is frame-batched: many SSE events -> at most one render per frame.
    fleet: createStore<FleetState>(
      {
        info: {},
        telemetry: {},
        details: {},
        source: { mode: 'loading', breaker: 'closed', lastSyncAt: null, dataAsOf: null, nextProbeAt: null, error: null },
      },
      { notify: 'frame' },
    ),
    routes: createStore<RouteState>({ routes: {}, loaded: false }),
    presence: createStore<PresenceState>(initialPresence(selfId)),
    audit: createStore<AuditEntry[]>([]),
    alerts: createStore<AlertItem[]>([]),
    anomalies: createStore<AnomalyState>({ events: [], counts: {} }),
    connection: createStore<ConnectionState>({ sse: 'idle', ws: 'idle' }),
    metrics: createStore<MetricsSnapshot | null>(null),
    ui: createStore<UiState>({
      selectedTruckId: null,
      panel: 'routes',
      showHelp: false,
      filters: { status: 'all', lowFuelOnly: false, route: 'all', query: '' },
    }),
  };
}

export type Stores = ReturnType<typeof createStores>;
export type AnyStore = Store<unknown>;
export { AUDIT_CAP, ANOMALY_CAP, ALERT_CAP };
