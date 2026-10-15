import type { Route, RouteStatus } from './types';

/** Client-side workflow. The server accepts any status; the UI must not. */
export const ROUTE_TRANSITIONS: Record<RouteStatus, RouteStatus[]> = {
  assigned: ['in-progress', 'cancelled'],
  'in-progress': ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransition(from: RouteStatus, to: RouteStatus): boolean {
  return ROUTE_TRANSITIONS[from].includes(to);
}

export function isActiveRoute(route: Pick<Route, 'status'>): boolean {
  return route.status === 'assigned' || route.status === 'in-progress';
}

/** Transitions that are destructive enough to require explicit confirmation. */
export function requiresConfirmation(to: RouteStatus): boolean {
  return to === 'cancelled' || to === 'completed';
}

/**
 * Last-writer-wins by VERSION, not arrival order. A WS broadcast and the HTTP
 * response for the same mutation race each other; whichever is older must not
 * overwrite the newer one.
 */
export function mergeRoute(existing: Route | undefined, incoming: Route): Route {
  if (!existing) return incoming;
  return incoming._version >= existing._version ? incoming : existing;
}

/** Who touched the route last, from the timestamps the server keeps. */
export function lastActor(route: Route): { by: string; at: number; action: 'assigned' | 'updated' | 'reassigned' } {
  const candidates = [
    { by: route.assignedBy, at: route.assignedAt, action: 'assigned' as const },
    route.lastModifiedBy && route.lastModifiedAt
      ? { by: route.lastModifiedBy, at: route.lastModifiedAt, action: 'updated' as const }
      : null,
    route.reassignedBy && route.reassignedAt
      ? { by: route.reassignedBy, at: route.reassignedAt, action: 'reassigned' as const }
      : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  return candidates.reduce((a, b) => (b.at > a.at ? b : a));
}

export type RouteIntent =
  | { action: 'status'; to: RouteStatus }
  | { action: 'reassign'; newTruckId: string };

export type RouteConflict =
  | {
      kind: 'version';
      routeId: string;
      intent: RouteIntent;
      /** Snapshot the dispatcher was looking at when they acted. */
      mine: Route;
      /** Current server state (null if it could not be fetched). */
      theirs: Route | null;
      changedBy: string | null;
      serverMessage: string;
    }
  | { kind: 'truck_assigned'; truckId: string; currentRouteId: string | null; assignedBy: string | null; serverMessage: string }
  | { kind: 'target_unavailable'; routeId: string; newTruckId: string; serverMessage: string };

export class RouteConflictError extends Error {
  constructor(readonly conflict: RouteConflict) {
    super(conflict.serverMessage);
    this.name = 'RouteConflictError';
  }
}

/**
 * Can the user's original intent still be applied on top of the newer server
 * version? (Used for "keep mine" in the conflict dialog.)
 */
export function canReapply(intent: RouteIntent, theirs: Route): { ok: true } | { ok: false; reason: string } {
  if (intent.action === 'status') {
    if (theirs.status === intent.to) return { ok: false, reason: `Route is already "${intent.to}".` };
    if (!canTransition(theirs.status, intent.to))
      return { ok: false, reason: `Route is now "${theirs.status}" — cannot move to "${intent.to}".` };
    return { ok: true };
  }
  if (!isActiveRoute(theirs)) return { ok: false, reason: `Route is now "${theirs.status}" and can no longer be reassigned.` };
  if (theirs.truckId === intent.newTruckId) return { ok: false, reason: 'Route is already on that truck.' };
  return { ok: true };
}
