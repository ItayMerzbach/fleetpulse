import { AdvancedMarker, APIProvider, ColorScheme, Map, Polyline } from '@vis.gl/react-google-maps';
import { memo, useEffect } from 'react';
import type { PresenceEntry } from '../../../domain/presence';
import { colorFor, initials } from '../../format';
import type { TruckRow } from '../../hooks/useFleetView';
import { MapLegend } from './MapLegend';
import { DEPOT, useMapModel } from './useMapModel';

interface Props {
  apiKey: string;
  mapId: string;
  /** Called on script-load failure or an invalid/unauthorised key so the caller can fall back. */
  onFailure: (reason: string) => void;
}

/**
 * Google Maps renderer. Only presentation lives here — positions, ordering,
 * filtering and presence all come from useMapModel, exactly like the grid map.
 *
 * Markers are AdvancedMarkers with HTML content so we keep the same visual
 * language as the rest of the dashboard: status colour, heading arrow, sensor
 * fault dot, and avatars of other dispatchers viewing the truck.
 */
export function GoogleFleetMap({ apiKey, mapId, onFailure }: Props) {
  const m = useMapModel();

  // Google reports a rejected key (wrong key, referrer not allowed, billing off)
  // by calling this global, not via the loader promise.
  useEffect(() => {
    const w = window as Window & { gm_authFailure?: () => void };
    const prev = w.gm_authFailure;
    w.gm_authFailure = () => onFailure('Google Maps rejected the API key');
    return () => {
      w.gm_authFailure = prev;
    };
  }, [onFailure]);

  const late = m.trail.filter((p) => p.source === 'batch' || p.source === 'late');

  return (
    <div className="map-wrap">
      <APIProvider apiKey={apiKey} onError={() => onFailure('Google Maps failed to load')}>
        <Map
          className="map"
          mapId={mapId}
          defaultCenter={DEPOT}
          defaultZoom={13}
          colorScheme={ColorScheme.DARK}
          gestureHandling="greedy"
          disableDefaultUI
          zoomControl
          clickableIcons={false}
          onClick={() => m.select(null)}
        >
          <AdvancedMarker position={DEPOT} clickable={false} zIndex={1}>
            <div className="gm-depot">Depot</div>
          </AdvancedMarker>

          {m.trail.length > 1 && (
            <Polyline path={m.trail.map((p) => ({ lat: p.lat, lng: p.lng }))} strokeColor="#4ea1ff" strokeOpacity={0.8} strokeWeight={3} />
          )}
          {late.map((p) => (
            <AdvancedMarker key={p.timestamp} position={p} clickable={false} anchorLeft="-50%" anchorTop="-50%" zIndex={2}>
              <div className="gm-trail-pt" title={`${p.source} fix`} />
            </AdvancedMarker>
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
        </Map>
      </APIProvider>
      <MapLegend trailCount={m.selectedRow ? m.trail.length : null} />
    </div>
  );
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
  if (!loc) return null;
  const heading = t?.heading ?? row.info?.heading ?? 0;
  const faulty = t && (t.speed.quality === 'fault' || t.fuel.quality !== 'ok');

  return (
    <AdvancedMarker
      position={loc}
      onClick={() => onSelect(row.id)}
      title={`${row.name} · ${row.status ?? '?'}${stale ? ' · no recent data' : ''}`}
      anchorLeft="-50%"
      anchorTop="-50%"
      zIndex={selected ? 100 : 10}
    >
      <div className={`gm-truck status-${row.status ?? 'unknown'} ${selected ? 'selected' : ''} ${stale ? 'stale' : ''}`}>
        <svg width="26" height="26" viewBox="-13 -13 26 26" style={{ transform: `rotate(${heading}deg)` }} aria-hidden>
          <path d="M0,-11 L7,8 L0,4 L-7,8 Z" className="marker-shape" />
        </svg>
        {faulty && <span className="gm-fault" />}
        <span className="gm-label">{row.name.replace('Truck ', '')}</span>
        {viewers && viewers.length > 0 && (
          <span className="gm-viewers">
            {viewers.map((v) => (
              <span key={v.id} className="avatar avatar-xs" style={{ background: colorFor(v.id) }} title={`${v.name} is viewing`}>
                {initials(v.name)}
              </span>
            ))}
          </span>
        )}
      </div>
    </AdvancedMarker>
  );
});
