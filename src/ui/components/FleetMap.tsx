import { memo, useMemo } from 'react';
import { viewersByTruck, type PresenceEntry } from '../../domain/presence';
import { useFleetPulse, useStore } from '../context';
import { colorFor, initials } from '../format';
import { useFilteredRows, type TruckRow } from '../hooks/useFleetView';
import { useNow } from '../hooks/useNow';

// Simple equirectangular projection around the depot. Map quality is not graded;
// an SVG grid keeps us free of tile servers/API keys and renders 12 trucks trivially.
const CENTER = { lat: 32.0853, lng: 34.7818 };
const SPAN = 0.075; // degrees each side
const SIZE = 600;
const LNG_SCALE = Math.cos((CENTER.lat * Math.PI) / 180);

const project = (lat: number, lng: number) => ({
  x: SIZE / 2 + ((lng - CENTER.lng) * LNG_SCALE * SIZE) / (2 * SPAN),
  y: SIZE / 2 - ((lat - CENTER.lat) * SIZE) / (2 * SPAN),
});

const STALE_MS = 10_000;

const Marker = memo(function Marker({
  row,
  selected,
  viewers,
  stale,
  onSelect,
}: {
  row: TruckRow;
  selected: boolean;
  viewers?: PresenceEntry[];
  stale: boolean;
  onSelect: (id: string) => void;
}) {
  const t = row.telemetry;
  const loc = t?.location ?? row.info?.location;
  if (!loc) return null;
  const { x, y } = project(loc.lat, loc.lng);
  const heading = t?.heading ?? row.info?.heading ?? 0;
  const faulty = t && (t.speed.quality === 'fault' || t.fuel.quality !== 'ok');
  return (
    <g
      transform={`translate(${x},${y})`}
      className={`marker status-${row.status ?? 'unknown'} ${selected ? 'selected' : ''} ${stale ? 'stale' : ''}`}
      onClick={() => onSelect(row.id)}
      role="button"
      aria-label={row.name}
    >
      <title>{`${row.name} · ${row.status ?? '?'}${stale ? ' · no recent data' : ''}`}</title>
      {selected && <circle r={16} className="marker-ring" />}
      <g transform={`rotate(${heading})`}>
        <path d="M0,-11 L7,8 L0,4 L-7,8 Z" className="marker-shape" />
      </g>
      {faulty && <circle r={3.5} cx={9} cy={-9} className="marker-fault" />}
      <text y={22} textAnchor="middle" className="marker-label">
        {row.name.replace('Truck ', '')}
      </text>
      {viewers?.map((v, i) => (
        <g key={v.id} transform={`translate(${14 + i * 13},${-14})`}>
          <circle r={6.5} fill={colorFor(v.id)} />
          <text textAnchor="middle" y={3} className="marker-viewer">
            {initials(v.name)}
          </text>
        </g>
      ))}
    </g>
  );
});

export function FleetMap() {
  const app = useFleetPulse();
  const rows = useFilteredRows();
  const selected = useStore(app.stores.ui, (s) => s.selectedTruckId);
  const presence = useStore(app.stores.presence, (s) => s);
  const viewers = useMemo(() => viewersByTruck(presence), [presence]);
  const now = useNow(2000);

  const selectedRow = rows.find((r) => r.id === selected);
  const trail = selectedRow?.telemetry?.trail ?? [];
  const trailPath = trail.map((p, i) => {
    const { x, y } = project(p.lat, p.lng);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const grid = [];
  for (let i = 1; i < 6; i++) {
    const v = (SIZE / 6) * i;
    grid.push(<line key={`v${i}`} x1={v} y1={0} x2={v} y2={SIZE} />, <line key={`h${i}`} x1={0} y1={v} x2={SIZE} y2={v} />);
  }

  return (
    <div className="map-wrap">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="map" role="img" aria-label="Fleet map">
        <rect width={SIZE} height={SIZE} className="map-bg" onClick={() => app.selectTruck(null)} />
        <g className="map-grid">{grid}</g>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={4} className="map-depot" />
        <text x={SIZE / 2 + 8} y={SIZE / 2 + 4} className="map-depot-label">
          Depot
        </text>
        {trailPath.length > 1 && <path d={trailPath.join(' ')} className="map-trail" />}
        {trail
          .filter((p) => p.source === 'batch' || p.source === 'late')
          .map((p) => {
            const { x, y } = project(p.lat, p.lng);
            return <circle key={p.timestamp} cx={x} cy={y} r={2} className={`trail-pt trail-${p.source}`} />;
          })}
        {rows.map((r) => (
          <Marker
            key={r.id}
            row={r}
            selected={r.id === selected}
            viewers={viewers[r.id]}
            stale={!!r.telemetry && now - r.telemetry.lastTimestamp > STALE_MS}
            onSelect={app.selectTruck}
          />
        ))}
      </svg>
      <div className="map-legend small">
        <span>
          <i className="status-dot status-active" /> active
        </span>
        <span>
          <i className="status-dot status-idle" /> idle
        </span>
        <span>
          <i className="status-dot status-maintenance" /> maintenance
        </span>
        <span>
          <i className="legend-fault" /> sensor issue
        </span>
        {selectedRow && <span className="muted">path: {trail.length} fixes (hollow = late/batched)</span>}
      </div>
    </div>
  );
}
