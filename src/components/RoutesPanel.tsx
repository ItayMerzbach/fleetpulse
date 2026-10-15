import { lastChangedBy } from '../routes';
import type { FleetPulse } from '../useFleetPulse';

/** All routes with who did what, plus the activity log (route history / audit log). */
export function RoutesPanel({ fp }: { fp: FleetPulse }) {
  const routes = Object.values(fp.routes).sort((a, b) => b.assignedAt - a.assignedAt);

  return (
    <div className="panel bottom">
      <div>
        <h3>Routes</h3>
        {routes.length === 0 ? (
          <p className="muted">No routes yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Route</th>
                <th>Truck</th>
                <th>Destination</th>
                <th>Status</th>
                <th>Assigned by</th>
                <th>Last change by</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((r) => (
                <tr key={r.id} onClick={() => fp.selectTruck(r.truckId)}>
                  <td>{r.id}</td>
                  <td>{fp.truckNames[r.truckId] ?? r.truckId}</td>
                  <td>{r.destination}</td>
                  <td>{r.status}</td>
                  <td>{fp.nameOf(r.assignedBy)}</td>
                  <td>{r.lastModifiedBy || r.reassignedBy ? fp.nameOf(lastChangedBy(r)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div>
        <h3>Activity log</h3>
        {fp.log.length === 0 && <p className="muted">Nothing yet.</p>}
        <ul className="log">
          {fp.log.map((entry) => (
            <li key={entry.id}>
              <span className="muted">{new Date(entry.timestamp).toLocaleTimeString()}</span> {entry.text}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
