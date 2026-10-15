import { useEffect, useState, type FormEvent } from 'react';
import { NEXT_STATUSES, isActive, validateRouteInput } from '../routes';
import { isLowFuel } from '../telemetry';
import type { Route, RouteStatus } from '../types';
import type { FleetPulse } from '../useFleetPulse';
import { Sparkline } from './Sparkline';

export function TruckDetail({ fp }: { fp: FleetPulse }) {
  const truckId = fp.selectedTruckId;
  const [mileage, setMileage] = useState<number | null>(null);

  // Mileage is only available from the single-truck endpoint.
  useEffect(() => {
    setMileage(null);
    if (truckId) fp.api.getTruck(truckId).then((t) => setMileage(t.mileage)).catch(() => {});
  }, [truckId, fp.api]);

  if (!truckId) return <div className="panel detail muted">Click a truck to see its details.</div>;
  const truck = fp.trucks[truckId];
  if (!truck) return <div className="panel detail muted">No data for {truckId} yet.</div>;

  const route = Object.values(fp.routes).find((r) => r.truckId === truckId && isActive(r));

  return (
    <div className="panel detail">
      <h3>
        {fp.truckNames[truckId] ?? truckId} <span className={`dot ${truck.status}`} /> <span className="muted">{truck.status}</span>
      </h3>

      <table className="stats">
        <tbody>
          <tr>
            <th>Speed</th>
            <td>
              {truck.speed === null ? '—' : `${Math.round(truck.speed)} km/h`}
              {truck.speedFault && <div className="warn small">Sensor fault — showing last valid speed</div>}
            </td>
            <td><Sparkline history={truck.history} field="speed" max={120} /></td>
          </tr>
          <tr>
            <th>Fuel</th>
            <td>
              {truck.fuel === null ? '—' : `${Math.round(truck.fuel)}%`}
              {truck.fuelSuspect && <div className="warn small">Sensor reads 0% — likely a glitch, showing last value</div>}
              {isLowFuel(truck) && <div className="bad small">LOW FUEL</div>}
            </td>
            <td><Sparkline history={truck.history} field="fuel" max={100} /></td>
          </tr>
          <tr>
            <th>Engine</th>
            <td>{Math.round(truck.engineTemp)}°C</td>
            <td><Sparkline history={truck.history} field="engineTemp" max={130} /></td>
          </tr>
          <tr>
            <th>Mileage</th>
            <td colSpan={2}>{mileage === null ? '—' : `${mileage.toLocaleString()} km`}</td>
          </tr>
        </tbody>
      </table>

      <h4>Route</h4>
      {route ? (
        <RouteActions key={route.id} fp={fp} route={route} />
      ) : truck.status === 'maintenance' ? (
        <p className="muted">In maintenance — cannot assign a route.</p>
      ) : (
        <CreateRouteForm key={`create-${truckId}`} fp={fp} truckId={truckId} />
      )}

      <h4>Send alert to driver</h4>
      <AlertForm key={`alert-${truckId}`} fp={fp} truckId={truckId} />
    </div>
  );
}

function RouteActions({ fp, route }: { fp: FleetPulse; route: Route }) {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newTruckId, setNewTruckId] = useState('');

  const freeTrucks = Object.values(fp.trucks).filter(
    (t) => t.id !== route.truckId && t.status !== 'maintenance' && !Object.values(fp.routes).some((r) => r.truckId === t.id && isActive(r)),
  );

  // Disabling the buttons while a request runs also prevents double-clicks.
  async function run(confirmText: string, action: () => Promise<string | null>) {
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(await action());
    setBusy(false);
  }

  const changeTo = (status: RouteStatus) =>
    run(`Change ${route.id} to "${status}"?`, () => fp.changeStatus(route, status));

  return (
    <div>
      <p>
        <b>{route.id}</b> → {route.destination} <span className="muted">({route.priority})</span>
        <br />
        Status: <b>{route.status}</b> · assigned by {fp.nameOf(route.assignedBy)}
        {route.lastModifiedBy && <> · last updated by {fp.nameOf(route.lastModifiedBy)}</>}
        {route.notes && (
          <>
            <br />
            Notes: {route.notes}
          </>
        )}
      </p>
      {NEXT_STATUSES[route.status].map((status) => (
        <button key={status} disabled={busy} onClick={() => changeTo(status)}>
          {status}
        </button>
      ))}
      <div className="row">
        <select value={newTruckId} onChange={(e) => setNewTruckId(e.target.value)}>
          <option value="">Reassign to…</option>
          {freeTrucks.map((t) => (
            <option key={t.id} value={t.id}>
              {fp.truckNames[t.id] ?? t.id}
            </option>
          ))}
        </select>
        <button
          disabled={busy || !newTruckId}
          onClick={() => run(`Move ${route.id} from ${route.truckId} to ${newTruckId}?`, () => fp.reassignRoute(route, newTruckId))}
        >
          Reassign
        </button>
      </div>
      {message && <p className="bad">{message}</p>}
    </div>
  );
}

function CreateRouteForm({ fp, truckId }: { fp: FleetPulse; truckId: string }) {
  const [destination, setDestination] = useState('');
  const [priority, setPriority] = useState('normal');
  const [notes, setNotes] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateRouteInput(destination, notes);
    if (invalid) return setMessage(invalid);
    setBusy(true);
    const error = await fp.createRoute({ truckId, destination: destination.trim(), priority, notes: notes.trim() });
    setBusy(false);
    setMessage(error);
    if (!error) setDestination('');
  }

  return (
    <form onSubmit={submit}>
      <input placeholder="Destination" value={destination} maxLength={120} onChange={(e) => setDestination(e.target.value)} />
      <select value={priority} onChange={(e) => setPriority(e.target.value)}>
        <option value="low">low</option>
        <option value="normal">normal</option>
        <option value="high">high</option>
      </select>
      <input placeholder="Notes (optional)" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      <button disabled={busy}>Assign route</button>
      {message && <p className="bad">{message}</p>}
    </form>
  );
}

function AlertForm({ fp, truckId }: { fp: FleetPulse; truckId: string }) {
  const [text, setText] = useState('');
  const [severity, setSeverity] = useState('info');
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return setMessage('Message is required');
    const error = await fp.sendAlert(truckId, text.trim(), severity);
    setMessage(error ?? 'Alert sent');
    if (!error) setText('');
  }

  return (
    <form onSubmit={submit}>
      <input placeholder="Message" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
      <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
        <option value="info">info</option>
        <option value="warning">warning</option>
        <option value="critical">critical</option>
      </select>
      <button>Send</button>
      {message && <p className="small">{message}</p>}
    </form>
  );
}
