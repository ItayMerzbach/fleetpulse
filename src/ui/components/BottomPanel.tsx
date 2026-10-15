import { useMemo, useState } from 'react';
import { ROUTE_TRANSITIONS } from '../../domain/routes';
import type { AnomalyKind } from '../../domain/types';
import type { UiState } from '../../stores/stores';
import { useFleetPulse, useStore } from '../context';
import { fmtNum, fmtTime } from '../format';
import { ErrorBoundary } from './ErrorBoundary';
import { useRouteActions } from './RouteActions';

const TABS: Array<{ id: UiState['panel']; label: string; key: string }> = [
  { id: 'routes', label: 'Routes', key: '1' },
  { id: 'activity', label: 'Activity log', key: '2' },
  { id: 'alerts', label: 'Alerts', key: '3' },
  { id: 'anomalies', label: 'Sensor anomalies', key: '4' },
  { id: 'observability', label: 'Observability', key: '5' },
];

export function BottomPanel() {
  const app = useFleetPulse();
  const panel = useStore(app.stores.ui, (s) => s.panel);
  const unacked = useStore(app.stores.alerts, (s) => s.filter((a) => !a.acknowledged).length);

  return (
    <section className="bottom">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={panel === t.id}
            className={`tab ${panel === t.id ? 'active' : ''}`}
            onClick={() => app.stores.ui.setState((u) => ({ ...u, panel: t.id }))}
            title={`Shortcut: ${t.key}`}
          >
            {t.label}
            {t.id === 'alerts' && unacked > 0 && <span className="count">{unacked}</span>}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        <ErrorBoundary name={panel} key={panel}>
          {panel === 'routes' && <RoutesTable />}
          {panel === 'activity' && <ActivityLog />}
          {panel === 'alerts' && <AlertsInbox />}
          {panel === 'anomalies' && <AnomalyDashboard />}
          {panel === 'observability' && <ObservabilityPanel />}
        </ErrorBoundary>
      </div>
    </section>
  );
}

function RoutesTable() {
  const app = useFleetPulse();
  const actions = useRouteActions();
  const routes = useStore(app.stores.routes, (s) => s.routes);
  const loaded = useStore(app.stores.routes, (s) => s.loaded);
  const [showClosed, setShowClosed] = useState(false);
  const list = useMemo(
    () =>
      Object.values(routes)
        .filter((r) => showClosed || r.status === 'assigned' || r.status === 'in-progress')
        .sort((a, b) => Number(b.id.replace(/\D/g, '')) - Number(a.id.replace(/\D/g, ''))),
    [routes, showClosed],
  );

  return (
    <div>
      <label className="check small">
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> show completed / cancelled
      </label>
      {!loaded ? (
        <p className="muted">Loading routes…</p>
      ) : list.length === 0 ? (
        <p className="muted">No routes. Select a truck to assign one (n).</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Route</th>
              <th>Truck</th>
              <th>Destination</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Assigned by</th>
              <th>Last change</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.id} <span className="muted small">v{r._version}</span>
                </td>
                <td>
                  <button className="link" onClick={() => app.selectTruck(r.truckId)}>
                    {app.stores.fleet.getState().info[r.truckId]?.name ?? r.truckId}
                  </button>
                </td>
                <td>{r.destination}</td>
                <td>{r.priority}</td>
                <td>
                  <span className={`route-status rs-${r.status}`}>{r.status}</span>
                </td>
                <td>{app.nameOf(r.assignedBy)}</td>
                <td className="small">
                  {r.reassignedBy && `reassigned by ${app.nameOf(r.reassignedBy)} `}
                  {r.lastModifiedBy && `updated by ${app.nameOf(r.lastModifiedBy)}`}
                </td>
                <td className="nowrap">
                  {ROUTE_TRANSITIONS[r.status].map((to) => (
                    <button key={to} className={`btn btn-xs ${to === 'cancelled' ? 'btn-danger' : ''}`} onClick={() => actions.changeStatus(r, to)}>
                      {to}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ActivityLog() {
  const app = useFleetPulse();
  const audit = useStore(app.stores.audit, (s) => s);
  if (!audit.length) return <p className="muted">No activity yet. Route changes, alerts and presence from all dispatchers appear here.</p>;
  return (
    <ul className="log">
      {audit.map((e) => (
        <li key={e.id} className={`log-${e.action}`}>
          <time>{fmtTime(e.timestamp)}</time> {e.summary}
        </li>
      ))}
    </ul>
  );
}

function AlertsInbox() {
  const app = useFleetPulse();
  const alerts = useStore(app.stores.alerts, (s) => s);
  if (!alerts.length) return <p className="muted">No alerts.</p>;
  return (
    <div>
      <button className="btn btn-sm" onClick={app.acknowledgeAll}>
        Acknowledge all (a)
      </button>
      <ul className="log">
        {alerts.map((a) => (
          <li key={a.id} className={`alert-item sev-${a.severity} ${a.acknowledged ? 'acked' : ''}`}>
            <time>{fmtTime(a.timestamp)}</time>
            <span className={`badge sev-${a.severity}`}>{a.severity}</span>
            <button className="link" onClick={() => app.selectTruck(a.truckId)}>
              {app.stores.fleet.getState().info[a.truckId]?.name ?? a.truckId}
            </button>{' '}
            {a.message}
            <span className="muted small"> · {a.source === 'system' ? 'vehicle health' : `from ${app.nameOf(a.sentBy)}`}</span>
            {!a.acknowledged && (
              <button className="btn btn-xs" onClick={() => app.acknowledgeAlert(a.id)}>
                ack
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_LABEL: Record<AnomalyKind, string> = {
  speed_implausible: 'Speed sensor implausible',
  fuel_glitch: 'Fuel sensor glitch',
  fuel_drop_confirmed: 'Confirmed fuel drop',
  gps_batch: 'GPS batch (signal recovery)',
  out_of_order: 'Out-of-order GPS',
};

function AnomalyDashboard() {
  const app = useFleetPulse();
  const { events, counts } = useStore(app.stores.anomalies, (s) => s);
  const [hideTransport, setHideTransport] = useState(true);
  const visible = events.filter((e) => !hideTransport || e.classification !== 'transport');

  return (
    <div className="anomalies">
      <div className="anomaly-cards">
        {(Object.keys(KIND_LABEL) as AnomalyKind[])
          .filter((k) => counts[k])
          .map((k) => (
            <div key={k} className={`card card-${k === 'fuel_drop_confirmed' ? 'real' : 'bug'}`}>
              <div className="card-n">{counts[k]}</div>
              <div className="small">{KIND_LABEL[k]}</div>
            </div>
          ))}
        {Object.keys(counts).length === 0 && <p className="muted">No anomalies detected yet.</p>}
      </div>
      <p className="small muted">
        <b className="legend-real">Real</b> = needs dispatcher action. <b className="legend-bug">Sensor bug</b> = known hardware quirk, value was filtered.
        <label className="check">
          <input type="checkbox" checked={hideTransport} onChange={(e) => setHideTransport(e.target.checked)} /> hide transport events
        </label>
      </p>
      <ul className="log">
        {visible.slice(0, 120).map((e) => (
          <li key={e.id} className={`log-${e.classification}`}>
            <time>{fmtTime(e.timestamp)}</time>
            <span className={`badge cls-${e.classification}`}>{e.classification.replace('_', ' ')}</span>
            <b>{e.truckId}</b> {e.message}
            {e.durationMs !== undefined && <span className="muted small"> ({(e.durationMs / 1000).toFixed(1)}s)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ObservabilityPanel() {
  const app = useFleetPulse();
  const m = useStore(app.stores.metrics, (s) => s);
  const conn = useStore(app.stores.connection, (s) => s);
  const source = useStore(app.stores.fleet, (s) => s.source);
  if (!m) return <p className="muted">Collecting metrics…</p>;
  const cells: Array<[string, string, string?]> = [
    ['SSE events / s', fmtNum(m.sseEventsPerSec, 2)],
    ['SSE messages', String(m.sseMessages)],
    ['Readings accepted', String(m.readingsAccepted)],
    ['Late / batched readings', String(m.readingsLate), 'merged into path, not applied as current'],
    ['GPS batches', String(m.gpsBatches)],
    ['Invalid / dropped messages', String(m.invalidMessages), 'failed schema validation'],
    ['Store commits / s', fmtNum(m.storeCommitsPerSec, 2), 'telemetry renders are frame-batched'],
    ['SSE reconnects', String(m.sseReconnects)],
    ['WS reconnects', String(m.wsReconnects)],
    ['WS latency (ping RTT)', m.wsLatencyMs === null ? '—' : `${m.wsLatencyMs} ms`],
    ['WS messages', String(m.wsMessages)],
    ['HTTP 503s', String(m.http503)],
    ['HTTP retries', String(m.httpRetries)],
    ['HTTP failures (after retry)', String(m.httpErrors)],
    ['409 conflicts', String(m.conflicts409)],
    ['Handler errors', String(m.handlerErrors), 'event-bus subscriber exceptions'],
    ['Circuit breaker', source.breaker],
    ['Connections', `SSE ${conn.sse} · WS ${conn.ws}`],
    ['JS heap', m.heapMb === null ? 'n/a' : `${m.heapMb} MB`],
    ['Uptime', `${m.uptimeSec}s`],
  ];
  return (
    <div>
      <p className="small muted">Developer-facing. Updated once per second.</p>
      <div className="metrics">
        {cells.map(([k, v, hint]) => (
          <div className="metric" key={k} title={hint}>
            <div className="metric-v">{v}</div>
            <div className="metric-k small">{k}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
