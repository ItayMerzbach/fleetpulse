import { ApiError, type Api } from './api';
import type { Route, RouteStatus } from './types';

/** Allowed status changes. The server accepts anything, so the UI enforces the flow. */
export const NEXT_STATUSES: Record<RouteStatus, RouteStatus[]> = {
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const isActive = (route: Route) => route.status === 'assigned' || route.status === 'in-progress';

/**
 * Keep the newer version. The WebSocket broadcast and the HTTP response for the
 * same change can arrive in either order — an older one must not win.
 */
export function mergeRoute(routes: Record<string, Route>, route: Route): Record<string, Route> {
  const existing = routes[route.id];
  if (existing && existing._version > route._version) return routes;
  return { ...routes, [route.id]: route };
}

/** The dispatcher who touched the route most recently (assign, update or reassign). */
export function lastChangedBy(route: Route): string {
  let by = route.assignedBy;
  let at = route.assignedAt;
  if (route.lastModifiedBy && route.lastModifiedAt && route.lastModifiedAt > at) {
    by = route.lastModifiedBy;
    at = route.lastModifiedAt;
  }
  if (route.reassignedBy && route.reassignedAt && route.reassignedAt > at) {
    by = route.reassignedBy;
  }
  return by;
}

/**
 * Message shown when our update was rejected with 409. We look at the CURRENT
 * route (re-fetched) to name who changed it — the 409 body's lastModifiedBy
 * misses reassignments.
 */
export function conflictMessage(routeId: string, current: Route | undefined, nameOf: (id: string) => string): string {
  if (!current) return `${routeId} was changed by another dispatcher. Your change was not applied.`;
  return (
    `${routeId} was changed by ${nameOf(lastChangedBy(current))} while you were working on it ` +
    `(now "${current.status}" on ${current.truckId}). Your change was not applied — check the route and try again.`
  );
}

export type ChangeResult = { ok: true; route: Route } | { ok: false; message: string; latestRoutes?: Route[] };

/**
 * Status change with optimistic locking. `seen` is the route as the dispatcher
 * saw it, so its version goes out as If-Match. On 409 we re-fetch the routes and
 * explain who changed it. We never retry automatically: that would overwrite
 * the other dispatcher's decision.
 */
export async function changeStatusSafely(
  api: Pick<Api, 'updateRouteStatus' | 'getRoutes'>,
  seen: Route,
  status: RouteStatus,
  nameOf: (id: string) => string,
): Promise<ChangeResult> {
  try {
    return { ok: true, route: await api.updateRouteStatus(seen, status) };
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) return { ok: false, message: (err as Error).message };
    const { routes } = await api.getRoutes().catch(() => ({ routes: [] as Route[] }));
    return { ok: false, message: conflictMessage(seen.id, routes.find((r) => r.id === seen.id), nameOf), latestRoutes: routes };
  }
}

/**
 * The reassign endpoint has no If-Match, so we check the version ourselves just
 * before calling it. This narrows the race window but cannot fully close it.
 */
export async function reassignSafely(
  api: Pick<Api, 'reassignRoute' | 'getRoutes'>,
  seen: Route,
  newTruckId: string,
  nameOf: (id: string) => string,
): Promise<ChangeResult> {
  try {
    const { routes } = await api.getRoutes();
    const current = routes.find((r) => r.id === seen.id);
    if (!current || current._version !== seen._version) {
      return { ok: false, message: conflictMessage(seen.id, current, nameOf), latestRoutes: routes };
    }
    return { ok: true, route: await api.reassignRoute(seen.id, newTruckId) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** Returns an error message, or null when the input is valid. */
export function validateRouteInput(destination: string, notes: string): string | null {
  const d = destination.trim();
  if (d.length < 3) return 'Destination must be at least 3 characters';
  if (d.length > 120) return 'Destination must be at most 120 characters';
  if (notes.length > 500) return 'Notes must be at most 500 characters';
  return null;
}
