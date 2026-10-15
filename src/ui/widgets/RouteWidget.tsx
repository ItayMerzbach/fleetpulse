import { useMemo, useState, type FormEvent } from 'react';
import { DESTINATION_MAX, NOTES_MAX } from '../../domain/schemas';
import { ROUTE_TRANSITIONS, isActiveRoute, lastActor } from '../../domain/routes';
import type { Priority, Route } from '../../domain/types';
import { ValidationError } from '../../transport/errors';
import { useRouteActions } from '../components/RouteActions';
import { useFleetPulse, useStore } from '../context';
import { fmtAgo, fmtTime } from '../format';
import { useNow } from '../hooks/useNow';
import { useTruckRows } from '../hooks/useFleetView';
import type { DetailWidgetProps } from './registry';

const STATUS_LABEL: Record<string, string> = {
  'in-progress': 'Start',
  completed: 'Complete',
  cancelled: 'Cancel',
};

export function RouteWidget({ truckId }: DetailWidgetProps) {
  const app = useFleetPulse();
  const routes = useStore(app.stores.routes, (s) => s.routes);
  const route = useMemo(() => Object.values(routes).find((r) => r.truckId === truckId && isActiveRoute(r)), [routes, truckId]);
  const status = useStore(app.stores.fleet, (s) => s.telemetry[truckId]?.status ?? s.info[truckId]?.status);

  if (route) return <ActiveRoute route={route} />;
  if (status === 'maintenance') return <p className="muted">Truck is in maintenance — routes cannot be assigned.</p>;
  return <CreateRouteForm truckId={truckId} />;
}

function ActiveRoute({ route }: { route: Route }) {
  const app = useFleetPulse();
  const actions = useRouteActions();
  const rows = useTruckRows();
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const actor = lastActor(route);
  const changedByOther = actor.by !== app.identity.id && now - actor.at < 15_000;

  const targets = rows.filter((r) => r.id !== route.truckId && !r.route && r.status !== 'maintenance');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="route-card">
      {changedByOther && (
        <div className="banner banner-info" role="status">
          {app.nameOf(actor.by)} {actor.action} this route {fmtAgo(actor.at, now)}.
        </div>
      )}
      <dl className="kv">
        <dt>Route</dt>
        <dd>
          {route.id} <span className="muted small">v{route._version}</span>
        </dd>
        <dt>Destination</dt>
        <dd>{route.destination}</dd>
        <dt>Status</dt>
        <dd>
          <span className={`route-status rs-${route.status}`}>{route.status}</span>
        </dd>
        <dt>Priority</dt>
        <dd>{route.priority}</dd>
        {route.notes && (
          <>
            <dt>Notes</dt>
            <dd className="pre">{route.notes}</dd>
          </>
        )}
        <dt>Assigned</dt>
        <dd>
          {app.nameOf(route.assignedBy)} · {fmtTime(route.assignedAt)}
        </dd>
        {route.lastModifiedBy && (
          <>
            <dt>Last update</dt>
            <dd>
              {app.nameOf(route.lastModifiedBy)} · {route.lastModifiedAt ? fmtTime(route.lastModifiedAt) : ''}
            </dd>
          </>
        )}
        {route.reassignedBy && (
          <>
            <dt>Reassigned</dt>
            <dd>
              {app.nameOf(route.reassignedBy)} · {route.reassignedAt ? fmtTime(route.reassignedAt) : ''}
            </dd>
          </>
        )}
      </dl>
      <div className="btn-row">
        {ROUTE_TRANSITIONS[route.status].map((to) => (
          <button
            key={to}
            className={`btn btn-sm ${to === 'cancelled' ? 'btn-danger' : 'btn-primary'}`}
            disabled={busy}
            onClick={() => run(() => actions.changeStatus(route, to))}
          >
            {STATUS_LABEL[to] ?? to}
          </button>
        ))}
      </div>
      <form
        className="reassign"
        onSubmit={(e) => {
          e.preventDefault();
          if (target) void run(() => actions.reassign(route, target)).then(() => setTarget(''));
        }}
      >
        <select className="input" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Reassign to">
          <option value="">Reassign to…</option>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.status ?? '?'})
            </option>
          ))}
        </select>
        <button className="btn btn-sm" disabled={!target || busy}>
          Reassign
        </button>
      </form>
    </div>
  );
}

function CreateRouteForm({ truckId }: { truckId: string }) {
  const actions = useRouteActions();
  const [destination, setDestination] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await actions.create({ truckId, destination, priority, notes });
      if (r) {
        setDestination('');
        setNotes('');
      }
    } catch (err) {
      setError(err instanceof ValidationError ? err.message : 'Could not create route');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit} noValidate>
      <p className="muted small">No active route. Assign one:</p>
      <label>
        Destination
        <input
          id="route-destination"
          className="input"
          value={destination}
          maxLength={DESTINATION_MAX}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="e.g. Dizengoff Center, loading bay 3"
          required
        />
      </label>
      <label>
        Priority
        <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </label>
      <label>
        Notes <span className="muted small">({notes.length}/{NOTES_MAX})</span>
        <textarea className="input" rows={2} value={notes} maxLength={NOTES_MAX} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary" disabled={busy}>
        {busy ? 'Assigning…' : 'Assign route'}
      </button>
    </form>
  );
}
