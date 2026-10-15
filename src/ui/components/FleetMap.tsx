import { useCallback, useState } from 'react';
import { config } from '../../config';
import { GoogleFleetMap } from './map/GoogleFleetMap';
import { GridMap } from './map/GridMap';

/**
 * Google Maps when a key is configured (VITE_GOOGLE_MAPS_API_KEY in .env.local),
 * otherwise — or if Google rejects the key / fails to load — the offline grid
 * map, so `npm start` always produces a working dashboard.
 */
export function FleetMap() {
  const [failure, setFailure] = useState<string | null>(null);
  const onFailure = useCallback((reason: string) => setFailure((f) => f ?? reason), []);

  if (!config.googleMapsApiKey) return <GridMap note="Offline grid map — set VITE_GOOGLE_MAPS_API_KEY for Google Maps" />;
  if (failure) return <GridMap note={`${failure} — showing offline grid map`} />;
  return <GoogleFleetMap apiKey={config.googleMapsApiKey} mapId={config.googleMapsMapId} onFailure={onFailure} />;
}
