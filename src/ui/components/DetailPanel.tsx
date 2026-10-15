import { viewersByTruck } from '../../domain/presence';
import { useMemo } from 'react';
import { useFleetPulse, useStore } from '../context';
import { detailWidgets } from '../widgets';
import { ErrorBoundary } from './ErrorBoundary';
import { Viewers } from './FleetList';

export function DetailPanel() {
  const app = useFleetPulse();
  const truckId = useStore(app.stores.ui, (s) => s.selectedTruckId);
  const info = useStore(app.stores.fleet, (s) => (truckId ? s.info[truckId] : undefined));
  const status = useStore(app.stores.fleet, (s) => (truckId ? (s.telemetry[truckId]?.status ?? s.info[truckId]?.status) : undefined));
  const presence = useStore(app.stores.presence, (s) => s);
  const viewers = useMemo(() => (truckId ? viewersByTruck(presence)[truckId] : undefined), [presence, truckId]);

  if (!truckId) {
    return (
      <section className="detail empty">
        <p className="muted">Select a truck on the map or in the list (j / k).</p>
      </section>
    );
  }
  const type = app.vehicleTypes.resolve({ id: truckId, name: info?.name });

  return (
    <section className="detail" aria-label="Vehicle detail">
      <div className="detail-head">
        <div>
          <h2>{info?.name ?? truckId}</h2>
          <span className={`status-chip status-${status ?? 'unknown'}`}>{status ?? 'unknown'}</span>
          <span className="muted small"> {type.label} · {truckId}</span>
        </div>
        <Viewers viewers={viewers} />
        <button className="btn btn-sm" onClick={() => app.selectTruck(null)} aria-label="Close detail">
          ✕
        </button>
      </div>
      {detailWidgets.forVehicleType(type.id).map(({ id, title, Component }) => (
        <div className="widget" key={id}>
          <h4>{title}</h4>
          <ErrorBoundary name={title}>
            {/* key resets widget-local state (forms) when switching trucks */}
            <Component key={truckId} truckId={truckId} />
          </ErrorBoundary>
        </div>
      ))}
    </section>
  );
}
