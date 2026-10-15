import 'leaflet/dist/leaflet.css';
import { Fragment } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet';
import type { FleetPulse } from '../useFleetPulse';

const CENTER: [number, number] = [32.0853, 34.7818]; // Tel Aviv
const STATUS_COLORS = { active: '#2e9d5b', idle: '#888888', maintenance: '#8a4fd8' };

/**
 * One circle + one path line per truck. GPS batches are already merged into
 * the path by telemetry.ts, so a batch never adds extra markers.
 */
export function FleetMap({ fp }: { fp: FleetPulse }) {
  return (
    <MapContainer center={CENTER} zoom={13} className="panel map">
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      {Object.values(fp.trucks).map((t) => {
        const selected = t.id === fp.selectedTruckId;
        const color = STATUS_COLORS[t.status];
        return (
          <Fragment key={t.id}>
            <Polyline positions={t.path.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={{ color, weight: selected ? 4 : 2 }} />
            <CircleMarker
              center={[t.location.lat, t.location.lng]}
              radius={selected ? 10 : 7}
              pathOptions={{ color: selected ? '#000' : '#fff', weight: 2, fillColor: color, fillOpacity: 1 }}
              eventHandlers={{ click: () => fp.selectTruck(t.id) }}
            >
              <Tooltip>{fp.truckNames[t.id] ?? t.id}</Tooltip>
            </CircleMarker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
