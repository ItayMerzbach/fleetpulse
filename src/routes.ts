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

/** Returns an error message, or null when the input is valid. */
export function validateRouteInput(destination: string, notes: string): string | null {
  const d = destination.trim();
  if (d.length < 3) return 'Destination must be at least 3 characters';
  if (d.length > 120) return 'Destination must be at most 120 characters';
  if (notes.length > 500) return 'Notes must be at most 500 characters';
  return null;
}
