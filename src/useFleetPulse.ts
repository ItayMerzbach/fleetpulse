import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ApiError, createApi } from './api';
import { nameFromId, presenceReducer, type PresenceEvent } from './presence';
import { changeStatusSafely, mergeRoute, reassignSafely, type ChangeResult } from './routes';
import { applyReadings, isValidReading } from './telemetry';
import type { LogEntry, Route, RouteStatus, Truck } from './types';

const API_URL = 'http://localhost:3000';
const WS_URL = 'ws://localhost:3000/ws';

export interface Identity {
  id: string;
  name: string;
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const byId = (routes: Route[]) => Object.fromEntries(routes.map((r) => [r.id, r]));

/**
 * All live data for the dashboard:
 *  - SSE  /api/telemetry/stream → trucks (filtered by telemetry.ts)
 *  - WS   /ws                   → presence, route changes, alerts → activity log
 *  - REST                       → truck names, routes, and the actions below
 */
export function useFleetPulse(identity: Identity) {
  const api = useMemo(() => createApi(API_URL, identity.id), [identity.id]);

  const [trucks, setTrucks] = useState<Record<string, Truck>>({});
  const [truckNames, setTruckNames] = useState<Record<string, string>>({});
  const [fleetError, setFleetError] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Record<string, Route>>({});
  const [presence, dispatchPresence] = useReducer(presenceReducer, { selfId: identity.id, others: {} });
  const presenceRef = useRef(presence); // lets the WebSocket handler read the latest presence
  presenceRef.current = presence;
  const [log, setLog] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState({ telemetry: false, dispatch: false });
  const [selectedTruckId, setSelectedTruckId] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const viewingRef = useRef<string | null>(null);
  const dispatcherNames = useRef<Record<string, string>>({});

  const nameOf = (id: string | undefined) =>
    !id ? 'unknown' : id === identity.id ? 'you' : (dispatcherNames.current[id] ?? nameFromId(id));

  const addLog = (text: string) =>
    setLog((prev) => [{ id: Date.now() + Math.random(), timestamp: Date.now(), text }, ...prev].slice(0, 200));

  /** Every presence change goes through here, so real departures get logged (ghosts only turn 'uncertain'). */
  const applyPresence = (event: PresenceEvent) => {
    const prev = presenceRef.current;
    const next = presenceReducer(prev, event);
    for (const id of Object.keys(prev.others)) if (!next.others[id]) addLog(`${nameOf(id)} went offline`);
    presenceRef.current = next; // keep the ref current if several events arrive before the next render
    dispatchPresence(event);
  };

  const sendViewing = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'viewing_truck', truckId: viewingRef.current }));
    }
  };

  const refreshRoutes = async () => {
    const { routes } = await api.getRoutes();
    setRoutes(byId(routes));
    return routes;
  };

  // Truck names come from REST (the stream has none). getFleet retries 503s.
  useEffect(() => {
    api
      .getFleet()
      .then(({ fleet }) => setTruckNames(Object.fromEntries(fleet.map((t) => [t.id, t.name]))))
      .catch((err) => setFleetError(`Could not load fleet: ${err.message}`));
  }, [api]);

  // Telemetry stream. EventSource reconnects by itself after errors.
  useEffect(() => {
    const es = new EventSource(`${API_URL}/api/telemetry/stream`);
    es.onopen = () => setConnected((c) => ({ ...c, telemetry: true }));
    es.onerror = () => setConnected((c) => ({ ...c, telemetry: false }));
    es.onmessage = (event) => {
      const msg = parseJson(event.data);
      if ((msg?.type === 'telemetry' || msg?.type === 'gps_batch') && Array.isArray(msg.readings)) {
        const readings = msg.readings.filter(isValidReading);
        setTrucks((prev) => applyReadings(prev, readings));
      }
    };
    return () => es.close();
  }, []);

  // Clock for presence: drops 'uncertain' dispatchers that stayed silent for 60 s.
  useEffect(() => {
    const timer = setInterval(() => applyPresence({ type: 'tick', now: Date.now() }), 5000);
    return () => clearInterval(timer);
  }, []);

  // Dispatcher WebSocket: presence + route updates from everyone. Reconnects after 2 s.
  useEffect(() => {
    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    function handle(msg: any) {
      switch (msg?.type) {
        case 'dispatcher_joined':
          dispatcherNames.current[msg.dispatcherId] = msg.name;
          applyPresence({ type: 'joined', dispatcherId: msg.dispatcherId, name: msg.name, now: Date.now() });
          sendViewing(); // the newcomer doesn't know about us yet — announce ourselves
          addLog(`${msg.name} came online`);
          break;
        case 'dispatcher_left':
          applyPresence({ type: 'left', dispatcherId: msg.dispatcherId, now: Date.now() });
          break;
        case 'dispatcher_viewing':
          applyPresence({ type: 'viewing', dispatcherId: msg.dispatcherId, truckId: msg.truckId ?? null, now: Date.now() });
          break;
        case 'route_assigned':
          setRoutes((r) => mergeRoute(r, msg.route));
          applyPresence({ type: 'activity', dispatcherId: msg.assignedBy, now: Date.now() });
          addLog(`${nameOf(msg.assignedBy)} assigned ${msg.route.id} (${msg.route.destination}) to ${msg.truckId}`);
          break;
        case 'route_updated':
          setRoutes((r) => mergeRoute(r, msg.route));
          applyPresence({ type: 'activity', dispatcherId: msg.updatedBy, now: Date.now() });
          addLog(`${nameOf(msg.updatedBy)} set ${msg.route.id} to "${msg.route.status}"`);
          break;
        case 'route_reassigned':
          setRoutes((r) => mergeRoute(r, msg.route));
          applyPresence({ type: 'activity', dispatcherId: msg.reassignedBy, now: Date.now() });
          addLog(`${nameOf(msg.reassignedBy)} moved ${msg.route.id} from ${msg.oldTruckId} to ${msg.newTruckId}`);
          break;
        case 'truck_alert':
          applyPresence({ type: 'activity', dispatcherId: msg.alert.sentBy, now: Date.now() });
          addLog(`${nameOf(msg.alert.sentBy)} sent ${msg.alert.severity} alert to ${msg.alert.truckId}: "${msg.alert.message}"`);
          break;
        case 'fleet_reset':
          setRoutes({});
          setTrucks({});
          addLog('Fleet was reset');
          break;
      }
    }

    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'register_dispatcher', dispatcherId: identity.id, name: identity.name }));
        setConnected((c) => ({ ...c, dispatch: true }));
        sendViewing();
        refreshRoutes().catch(() => {}); // catch up on anything missed while disconnected
      };
      ws.onmessage = (event) => handle(parseJson(event.data));
      ws.onclose = () => {
        setConnected((c) => ({ ...c, dispatch: false }));
        if (!stopped) retryTimer = setTimeout(connect, 2000);
      };
    }

    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
    // Runs once per dispatcher. The handlers only use state setters and refs, so they never go stale.
  }, [identity.id, identity.name]);

  // ---------- actions (each returns an error message, or null on success) ----------

  function selectTruck(truckId: string | null) {
    setSelectedTruckId(truckId);
    viewingRef.current = truckId;
    sendViewing();
  }

  async function createRoute(input: { truckId: string; destination: string; priority: string; notes: string }) {
    try {
      const route = await api.createRoute(input);
      setRoutes((r) => mergeRoute(r, route));
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        return `This truck already has ${err.body.currentRouteId}, assigned by ${nameOf(err.body.assignedBy as string)}.`;
      }
      return (err as Error).message;
    }
  }

  /** Shared by both route actions: apply the result, or show and log the conflict. */
  function handleResult(result: ChangeResult) {
    if (result.ok) {
      setRoutes((r) => mergeRoute(r, result.route));
      return null;
    }
    if (result.latestRoutes) {
      setRoutes(byId(result.latestRoutes)); // show the dispatcher the current state
      addLog(`Conflict: ${result.message}`);
    }
    return result.message;
  }

  /** `route` is the version the dispatcher was looking at — it's sent as If-Match. */
  async function changeStatus(route: Route, status: RouteStatus) {
    return handleResult(await changeStatusSafely(api, route, status, nameOf));
  }

  async function reassignRoute(route: Route, newTruckId: string) {
    return handleResult(await reassignSafely(api, route, newTruckId, nameOf));
  }

  async function sendAlert(truckId: string, message: string, severity: string) {
    try {
      await api.sendAlert(truckId, message, severity);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  return {
    api,
    trucks,
    truckNames,
    fleetError,
    routes,
    presence,
    log,
    connected,
    selectedTruckId,
    nameOf,
    selectTruck,
    createRoute,
    changeStatus,
    reassignRoute,
    sendAlert,
  };
}

export type FleetPulse = ReturnType<typeof useFleetPulse>;
