import { memo } from 'react';
import type { PresenceEntry } from '../../../domain/presence';
import { colorFor, initials } from '../../format';
import type { TruckRow } from '../../hooks/useFleetView';
import { MapLegend } from './MapLegend';
import { DEPOT, useMapModel } from './useMapModel';

// Offline fallback used when no Google Maps key is configured (or Google fails
// to load): a plain equirectangular SVG grid around the depot.
const SPAN = 0.075; // degrees each side
const SIZE = 600;
const LNG_SCALE = Math.cos((DEPOT.lat * Math.PI) / 180);

const project = (lat: number, lng: number) => ({
  x: SIZE / 2 + ((lng - DEPOT.lng) * LNG_SCALE * SIZE) / (2 * SPAN),
  y: SIZE / 2 - ((lat - DEPOT.lat) * SIZE) / (2 * SPAN),
});

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

export function GridMap({ note }: { note?: string }) {
  const m = useMapModel();
  const trailPath = m.trail.map((p, i) => {
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
        <rect width={SIZE} height={SIZE} className="map-bg" onClick={() => m.select(null)} />
        <g className="map-grid">{grid}</g>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={4} className="map-depot" />
        <text x={SIZE / 2 + 8} y={SIZE / 2 + 4} className="map-depot-label">
          Depot
        </text>
        {trailPath.length > 1 && <path d={trailPath.join(' ')} className="map-trail" />}
        {m.trail
          .filter((p) => p.source === 'batch' || p.source === 'late')
          .map((p) => {
            const { x, y } = project(p.lat, p.lng);
            return <circle key={p.timestamp} cx={x} cy={y} r={2} className={`trail-pt trail-${p.source}`} />;
          })}
        {m.rows.map((r) => (
          <Marker
            key={r.id}
            row={r}
            selected={r.id === m.selected}
            viewers={m.viewers[r.id]}
            stale={m.isStale(r.telemetry?.lastTimestamp)}
            onSelect={m.select}
          />
        ))}
      </svg>
      <MapLegend trailCount={m.selectedRow ? m.trail.length : null} note={note} />
    </div>
  );
}
