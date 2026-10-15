import { memo, useMemo } from 'react';
import { viewersByTruck, type PresenceEntry } from '../../domain/presence';
import type { SensorValue } from '../../domain/types';
import type { UiState } from '../../stores/stores';
import { useFleetPulse, useStore } from '../context';
import { colorFor, fmtNum, initials } from '../format';
import { useFilteredRows, type TruckRow } from '../hooks/useFleetView';

export function SensorBadge({ value }: { value: SensorValue }) {
  if (value.quality === 'ok' || value.quality === 'unknown') return null;
  return (
    <span className={`badge badge-${value.quality}`} title={value.note}>
      {value.quality === 'fault' ? 'sensor fault' : 'suspect'}
    </span>
  );
}

export function Viewers({ viewers }: { viewers?: PresenceEntry[] }) {
  if (!viewers?.length) return null;
  return (
    <span className="viewers">
      {viewers.map((v) => (
        <span key={v.id} className="avatar avatar-xs" style={{ background: colorFor(v.id) }} title={`${v.name} is viewing this truck`}>
          {initials(v.name)}
        </span>
      ))}
    </span>
  );
}

const Row = memo(function Row({
  row,
  selected,
  viewers,
  onSelect,
}: {
  row: TruckRow;
  selected: boolean;
  viewers?: PresenceEntry[];
  onSelect: (id: string) => void;
}) {
  const t = row.telemetry;
  const fuel = t?.fuel.value ?? null;
  return (
    <li>
      <button className={`truck-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(row.id)} aria-pressed={selected}>
        <span className={`status-dot status-${row.status ?? 'unknown'}`} title={row.status ?? 'unknown'} />
        <span className="truck-name">
          {row.name}
          <span className="muted small"> {row.route ? `→ ${row.route.destination}` : ''}</span>
        </span>
        <Viewers viewers={viewers} />
        <span className="truck-metrics">
          <span title={t?.speed.note}>
            {fmtNum(t?.speed.value, 0, ' km/h')} {t && <SensorBadge value={t.speed} />}
          </span>
          <span className={`fuel ${row.lowFuel ? 'fuel-low' : ''}`} title={t?.fuel.note}>
            <span className="fuel-bar">
              <span style={{ width: `${Math.max(0, Math.min(100, fuel ?? 0))}%` }} />
            </span>
            {fmtNum(fuel, 0, '%')} {t && <SensorBadge value={t.fuel} />}
          </span>
        </span>
      </button>
    </li>
  );
});

export function FleetFilters() {
  const app = useFleetPulse();
  const f = useStore(app.stores.ui, (s) => s.filters);
  const set = (patch: Partial<UiState['filters']>) => app.stores.ui.setState((u) => ({ ...u, filters: { ...u.filters, ...patch } }));
  return (
    <div className="filters">
      <input
        className="input"
        placeholder="Search truck / destination  ( / )"
        value={f.query}
        maxLength={50}
        onChange={(e) => set({ query: e.target.value })}
        id="fleet-search"
      />
      <div className="filter-row">
        <select className="input" value={f.status} onChange={(e) => set({ status: e.target.value as UiState['filters']['status'] })} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="idle">Idle</option>
          <option value="maintenance">Maintenance</option>
        </select>
        <select className="input" value={f.route} onChange={(e) => set({ route: e.target.value as UiState['filters']['route'] })} aria-label="Route">
          <option value="all">Any route</option>
          <option value="assigned">Has route</option>
          <option value="unassigned">No route</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={f.lowFuelOnly} onChange={(e) => set({ lowFuelOnly: e.target.checked })} /> Low fuel
        </label>
      </div>
    </div>
  );
}

export function FleetList() {
  const app = useFleetPulse();
  const rows = useFilteredRows();
  const selected = useStore(app.stores.ui, (s) => s.selectedTruckId);
  const presence = useStore(app.stores.presence, (s) => s);
  const viewers = useMemo(() => viewersByTruck(presence), [presence]);
  const source = useStore(app.stores.fleet, (s) => s.source.mode);

  return (
    <aside className="fleet-list">
      <FleetFilters />
      {rows.length === 0 && (
        <p className="muted pad">{source === 'loading' ? 'Waiting for fleet data…' : 'No trucks match the filters.'}</p>
      )}
      <ul>
        {rows.map((r) => (
          <Row key={r.id} row={r} selected={r.id === selected} viewers={viewers[r.id]} onSelect={app.selectTruck} />
        ))}
      </ul>
    </aside>
  );
}
