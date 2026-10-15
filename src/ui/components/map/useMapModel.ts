import { useMemo } from 'react';
import { viewersByTruck } from '../../../domain/presence';
import { useFleetPulse, useStore } from '../../context';
import { useFilteredRows } from '../../hooks/useFleetView';
import { useNow } from '../../hooks/useNow';

export const DEPOT = { lat: 32.0853, lng: 34.7818 };
const STALE_MS = 10_000;
/** How long the "GPS +N" badge stays on a truck after a batch was merged. */
const BATCH_BADGE_MS = 10_000;

/**
 * Everything a map renderer needs, independent of HOW it draws (today
 * Leaflet). Renderers stay dumb; switching map provider touches no data code.
 */
export function useMapModel() {
  const app = useFleetPulse();
  const rows = useFilteredRows();
  const selected = useStore(app.stores.ui, (s) => s.selectedTruckId);
  const presence = useStore(app.stores.presence, (s) => s);
  const viewers = useMemo(() => viewersByTruck(presence), [presence]);
  const now = useNow(2000);

  const selectedRow = rows.find((r) => r.id === selected);
  const trail = selectedRow?.telemetry?.trail ?? [];

  return {
    rows,
    selected,
    viewers,
    trail,
    selectedRow,
    isStale: (lastTimestamp: number | undefined) => lastTimestamp !== undefined && now - lastTimestamp > STALE_MS,
    recentBatch: (b: { count: number; receivedAt: number } | null | undefined) =>
      b && now - b.receivedAt < BATCH_BADGE_MS ? b.count : null,
    select: app.selectTruck,
  };
}
