import { useEffect } from 'react';
import type { SensorValue } from '../../domain/types';
import { SensorBadge } from '../components/FleetList';
import { Sparkline } from '../components/Sparkline';
import { useFleetPulse, useStore } from '../context';
import { fmtAgo, fmtNum } from '../format';
import { useNow } from '../hooks/useNow';
import type { DetailWidgetProps } from './registry';

function Gauge({ label, value, unit, digits = 0, max, warnAt, warnBelow }: {
  label: string;
  value: SensorValue;
  unit: string;
  digits?: number;
  max: number;
  warnAt?: number;
  warnBelow?: number;
}) {
  const v = value.value;
  const pct = v === null ? 0 : Math.max(0, Math.min(100, (v / max) * 100));
  const warn = v !== null && ((warnAt !== undefined && v > warnAt) || (warnBelow !== undefined && v < warnBelow));
  return (
    <div className={`gauge ${warn ? 'gauge-warn' : ''} gauge-${value.quality}`} title={value.note}>
      <div className="gauge-label">
        {label} <SensorBadge value={value} />
      </div>
      <div className="gauge-value">{fmtNum(v, digits, unit)}</div>
      <div className="gauge-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      {value.quality !== 'ok' && value.note && <div className="gauge-note small">{value.note}</div>}
    </div>
  );
}

export function TelemetryWidget({ truckId }: DetailWidgetProps) {
  const app = useFleetPulse();
  const t = useStore(app.stores.fleet, (s) => s.telemetry[truckId]);
  const detail = useStore(app.stores.fleet, (s) => s.details[truckId]);
  const { thresholds } = app.vehicleTypes.resolve({ id: truckId });
  const now = useNow(1000);

  // Mileage only exists on the detail endpoint; refresh while the panel is open.
  useEffect(() => {
    const load = () => app.fleet.fetchDetail(truckId).catch(() => undefined);
    void load();
    void app.telemetry.seedHistory(truckId, () => app.fleet.fetchHistory(truckId, 60)).catch(() => undefined);
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [app, truckId]);

  if (!t) return <p className="muted">No telemetry received yet.</p>;
  const age = now - t.lastTimestamp;

  return (
    <div className="telemetry">
      <div className="gauges">
        <Gauge label="Speed" value={t.speed} unit=" km/h" max={120} />
        <Gauge label="Fuel" value={t.fuel} unit="%" max={100} warnBelow={thresholds.lowFuelPct} />
        <Gauge label="Engine" value={t.engineTemp} unit="°C" max={130} warnAt={thresholds.highEngineTempC} />
        <div className="gauge">
          <div className="gauge-label">Mileage</div>
          <div className="gauge-value">{detail ? `${detail.mileage.toLocaleString()} km` : '—'}</div>
          <div className={`small ${age > 10_000 ? 'text-warn' : 'muted'}`}>updated {fmtAgo(t.lastTimestamp, now)}</div>
        </div>
      </div>
      <div className="charts">
        <div>
          <div className="chart-label small muted">Speed (km/h) — gaps = rejected readings</div>
          <Sparkline points={t.history} field="speed" min={0} max={100} label="Speed history" />
        </div>
        <div>
          <div className="chart-label small muted">Fuel (%)</div>
          <Sparkline points={t.history} field="fuel" min={0} max={100} threshold={{ value: thresholds.lowFuelPct, label: 'low' }} label="Fuel history" />
        </div>
        <div>
          <div className="chart-label small muted">Engine temp (°C)</div>
          <Sparkline points={t.history} field="engineTemp" min={20} max={130} threshold={{ value: thresholds.highEngineTempC, label: 'hot' }} label="Engine temperature history" />
        </div>
      </div>
    </div>
  );
}
