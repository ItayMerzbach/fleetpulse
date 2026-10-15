import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { memo, useMemo } from 'react';
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet';
import type { PresenceEntry } from '../../../domain/presence';
import { colorFor, initials } from '../../format';
import type { TruckRow } from '../../hooks/useFleetView';
import { MapLegend } from './MapLegend';
import { DEPOT, useMapModel } from './useMapModel';

// Standard OpenStreetMap tiles: no API key (fine for development per the OSM
// tile usage policy; production would use a paid/self-hosted tile server).
// Darkened with a CSS filter (.fleet-tiles) to match the dashboard theme.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** divIcon takes an HTML string, so anything user-provided (dispatcher names) must be escaped. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const depotIcon = L.divIcon({ className: 'lf-icon', html: '<div class="lf-depot">Depot</div>', iconSize: [44, 16], iconAnchor: [22, 8] });

/**
 * Leaflet renderer. Presentation only — positions, ordering, filtering and
 * presence all come from useMapModel, so the map provider is swappable.
 */
export function LeafletFleetMap() {
  const m = useMapModel();
  const late = m.trail.filter((p) => p.source === 'batch' || p.source === 'late');

  return (
    <div className="map-wrap">
      <MapContainer className="map" center={DEPOT} zoom={13} zoomControl preferCanvas={false} attributionControl>
        <TileLayer url={TILE_URL} attribution={ATTRIBUTION} maxZoom={19} className="fleet-tiles" />
        <DeselectOnMapClick onClick={() => m.select(null)} />
        <Marker position={DEPOT} icon={depotIcon} interactive={false} />

        {m.trail.length > 1 && (
          <Polyline positions={m.trail.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color: '#4ea1ff', weight: 3, opacity: 0.8 }} />
        )}
        {late.map((p) => (
          <CircleMarker key={p.timestamp} center={[p.lat, p.lng]} radius={3.5} pathOptions={{ color: '#f5b942', weight: 1.5, fill: false }} interactive={false} />
        ))}

        {m.rows.map((r) => (
          <TruckMarker
            key={r.id}
            row={r}
            selected={r.id === m.selected}
            viewers={m.viewers[r.id]}
            stale={m.isStale(r.telemetry?.lastTimestamp)}
            onSelect={m.select}
          />
        ))}
      </MapContainer>
      <MapLegend trailCount={m.selectedRow ? m.trail.length : null} />
    </div>
  );
}

function DeselectOnMapClick({ onClick }: { onClick: () => void }) {
  useMapEvents({ click: onClick });
  return null;
}

const TruckMarker = memo(function TruckMarker({
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
  const heading = Math.round(t?.heading ?? row.info?.heading ?? 0);
  const faulty = !!t && (t.speed.quality === 'fault' || t.fuel.quality !== 'ok');
  const label = row.name.replace('Truck ', '');
  const viewersKey = viewers?.map((v) => `${v.id}:${v.name}`).join('|') ?? '';

  // Rebuild the icon only when its appearance changes — not on every position update.
  const icon = useMemo(() => {
    const avatars = (viewers ?? [])
      .map((v) => `<span class="avatar avatar-xs" style="background:${colorFor(v.id)}">${esc(initials(v.name))}</span>`)
      .join('');
    return L.divIcon({
      className: 'lf-icon',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
      html: `<div class="lf-truck status-${row.status ?? 'unknown'}${selected ? ' selected' : ''}${stale ? ' stale' : ''}">
        <svg width="26" height="26" viewBox="-13 -13 26 26" style="transform:rotate(${heading}deg)"><path d="M0,-11 L7,8 L0,4 L-7,8 Z" class="marker-shape"/></svg>
        ${faulty ? '<span class="lf-fault"></span>' : ''}
        <span class="lf-label">${esc(label)}</span>
        ${avatars ? `<span class="lf-viewers">${avatars}</span>` : ''}
      </div>`,
    });
    // viewersKey stands in for `viewers` (a new array on every presence update)
  }, [row.status, selected, stale, heading, faulty, label, viewersKey]);

  if (!loc) return null;
  return (
    <Marker position={[loc.lat, loc.lng]} icon={icon} zIndexOffset={selected ? 1000 : 0} eventHandlers={{ click: () => onSelect(row.id) }}>
      <Tooltip direction="top" offset={[0, -14]}>
        {`${row.name} · ${row.status ?? '?'}${stale ? ' · no recent data' : ''}`}
        {viewers?.length ? ` · viewing: ${viewers.map((v) => v.name).join(', ')}` : ''}
      </Tooltip>
    </Marker>
  );
});
