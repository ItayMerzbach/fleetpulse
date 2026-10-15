import { isLowFuel } from '../telemetry';
import type { FleetPulse } from '../useFleetPulse';

export function TruckList({ fp }: { fp: FleetPulse }) {
  const trucks = Object.values(fp.trucks).sort((a, b) => Number(a.id.split('_')[1]) - Number(b.id.split('_')[1]));
  const viewers = Object.values(fp.presence.others);

  return (
    <div className="panel list">
      <h3>Trucks</h3>
      {trucks.length === 0 && <p className="muted">Waiting for telemetry…</p>}
      {trucks.map((t) => (
        <div key={t.id} className={`truck-row ${t.id === fp.selectedTruckId ? 'selected' : ''}`} onClick={() => fp.selectTruck(t.id)}>
          <div>
            <span className={`dot ${t.status}`} /> <b>{fp.truckNames[t.id] ?? t.id}</b> <span className="muted">{t.status}</span>
          </div>
          <div className="small">
            {t.speedFault ? <span className="warn">speed sensor fault</span> : `${Math.round(t.speed ?? 0)} km/h`}
            {' · '}
            {t.fuel === null ? 'fuel ?' : `fuel ${Math.round(t.fuel)}%`}
            {t.fuelSuspect && <span className="warn"> (checking sensor)</span>}
            {isLowFuel(t) && <span className="bad"> LOW FUEL</span>}
          </div>
          {viewers
            .filter((d) => d.viewingTruckId === t.id)
            .map((d) => (
              <div key={d.id} className={`small ${d.status === 'uncertain' ? 'muted' : 'viewer'}`}>
                👁 {d.name} is viewing{d.status === 'uncertain' && ' (connection uncertain)'}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
