import { useMemo } from 'react';
import { isActiveRoute } from '../../domain/routes';
import type { FleetTruck, Route, TruckStatus, VehicleTelemetry } from '../../domain/types';
import type { UiState } from '../../stores/stores';
import { useFleetPulse, useStore } from '../context';

export interface TruckRow {
  id: string;
  name: string;
  status: TruckStatus | null;
  info?: FleetTruck;
  telemetry?: VehicleTelemetry;
  route?: Route;
  lowFuel: boolean;
}

/** Joins REST info + live telemetry + routes into one row model (memoised). */
export function useTruckRows(): TruckRow[] {
  const app = useFleetPulse();
  const info = useStore(app.stores.fleet, (s) => s.info);
  const telemetry = useStore(app.stores.fleet, (s) => s.telemetry);
  const routes = useStore(app.stores.routes, (s) => s.routes);

  return useMemo(() => {
    const routeByTruck: Record<string, Route> = {};
    for (const r of Object.values(routes)) if (isActiveRoute(r)) routeByTruck[r.truckId] = r;
    // Union of ids: during an API outage we still list trucks seen on SSE.
    const ids = new Set([...Object.keys(info), ...Object.keys(telemetry)]);
    return [...ids]
      .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
      .map((id) => {
        const t = telemetry[id];
        const i = info[id];
        const { thresholds } = app.vehicleTypes.resolve({ id });
        const fuel = t?.fuel.value ?? i?.fuel ?? null;
        return {
          id,
          name: i?.name ?? id,
          status: t?.status ?? i?.status ?? null,
          info: i,
          telemetry: t,
          route: routeByTruck[id],
          lowFuel: fuel !== null && fuel < thresholds.lowFuelPct,
        };
      });
  }, [info, telemetry, routes, app.vehicleTypes]);
}

export function applyFilters(rows: TruckRow[], f: UiState['filters']): TruckRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.status === 'all' || r.status === f.status) &&
      (!f.lowFuelOnly || r.lowFuel) &&
      (f.route === 'all' || (f.route === 'assigned' ? !!r.route : !r.route)) &&
      (!q || r.name.toLowerCase().includes(q) || r.id.includes(q) || r.route?.destination.toLowerCase().includes(q)),
  );
}

export function useFilteredRows(): TruckRow[] {
  const app = useFleetPulse();
  const rows = useTruckRows();
  const filters = useStore(app.stores.ui, (s) => s.filters);
  return useMemo(() => applyFilters(rows, filters), [rows, filters]);
}
