import { CreateRouteInputSchema, RouteSchema, RoutesResponseSchema } from '../domain/schemas';
import {
  RouteConflictError,
  canReapply,
  canTransition,
  isActiveRoute,
  lastActor,
  mergeRoute,
  type RouteConflict,
  type RouteIntent,
} from '../domain/routes';
import type { Route, RouteStatus } from '../domain/types';
import type { Store } from '../core/store';
import type { ApiClient } from '../transport/ApiClient';
import { ApiError, ValidationError } from '../transport/errors';
import type { RouteState } from '../stores/stores';

export class RouteBusyError extends Error {
  constructor(routeId: string) {
    super(`Another change to ${routeId} is still in progress`);
    this.name = 'RouteBusyError';
  }
}

export class RouteRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RouteRuleError';
  }
}

export interface CreateRouteInput {
  truckId: string;
  destination: string;
  priority: string;
  notes?: string;
}

/**
 * Route mutations with optimistic concurrency control.
 *
 * Every mutation carries the version the dispatcher was LOOKING AT (not the
 * latest one in the store — that may have changed under them while the
 * confirm dialog was open). On 409 we fetch the current server state and throw
 * a RouteConflictError describing both versions so the UI can show a
 * side-by-side resolution and name the dispatcher who made the other change.
 *
 * No automatic retry on 409: silently re-applying would overwrite a colleague's
 * decision, which is exactly the incident in the brief.
 */
export class RouteService {
  private inFlight = new Set<string>();

  constructor(
    private readonly api: ApiClient,
    private readonly store: Store<RouteState>,
    private readonly onConflict: (c: RouteConflict) => void = () => {},
  ) {}

  async refresh(): Promise<Route[]> {
    const { routes } = await this.api.request('/api/routes', { schema: RoutesResponseSchema });
    this.store.setState((s) => {
      const next: Record<string, Route> = {};
      for (const r of routes) next[r.id] = mergeRoute(s.routes[r.id], r);
      return { routes: next, loaded: true };
    });
    return routes;
  }

  /** Apply a route pushed by the server (WS) or returned by a mutation. */
  upsert(route: Route): void {
    this.store.setState((s) => {
      const merged = mergeRoute(s.routes[route.id], route);
      if (merged === s.routes[route.id]) return s;
      return { ...s, routes: { ...s.routes, [route.id]: merged } };
    });
  }

  clear(): void {
    this.store.setState({ routes: {}, loaded: true });
  }

  activeRouteForTruck(truckId: string): Route | undefined {
    return Object.values(this.store.getState().routes).find((r) => r.truckId === truckId && isActiveRoute(r));
  }

  isBusy(routeId: string): boolean {
    return this.inFlight.has(routeId);
  }

  async create(input: CreateRouteInput): Promise<Route> {
    const parsed = CreateRouteInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid input', parsed.error.issues);

    // Cheap local pre-check (the server's 409 remains the real guard).
    const existing = this.activeRouteForTruck(parsed.data.truckId);
    if (existing) {
      const conflict: RouteConflict = {
        kind: 'truck_assigned',
        truckId: parsed.data.truckId,
        currentRouteId: existing.id,
        assignedBy: existing.assignedBy,
        serverMessage: 'Truck already assigned',
      };
      this.onConflict(conflict);
      throw new RouteConflictError(conflict);
    }

    try {
      const route = await this.api.request('/api/routes', { method: 'POST', body: parsed.data, schema: RouteSchema });
      this.upsert(route);
      return route;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const body = (err.body ?? {}) as { currentRouteId?: string; assignedBy?: string };
        await this.refresh().catch(() => undefined);
        const conflict: RouteConflict = {
          kind: 'truck_assigned',
          truckId: parsed.data.truckId,
          currentRouteId: body.currentRouteId ?? null,
          assignedBy: body.assignedBy ?? null,
          serverMessage: err.message,
        };
        this.onConflict(conflict);
        throw new RouteConflictError(conflict);
      }
      throw err;
    }
  }

  /** @param seen the route exactly as the dispatcher saw it when they clicked */
  async updateStatus(seen: Route, to: RouteStatus): Promise<Route> {
    if (!canTransition(seen.status, to)) throw new RouteRuleError(`Cannot move a "${seen.status}" route to "${to}"`);
    return this.mutate(seen, { action: 'status', to }, () =>
      this.api.request(`/api/routes/${encodeURIComponent(seen.id)}`, {
        method: 'PATCH',
        body: { status: to },
        ifMatch: seen._version,
        schema: RouteSchema,
      }),
    );
  }

  /**
   * The reassign endpoint does NOT support If-Match, so we emulate it: re-read
   * the route and abort if its version moved since the dispatcher looked at it.
   * This narrows the race window to one round-trip but cannot close it — a
   * known limitation documented in the README.
   */
  async reassign(seen: Route, newTruckId: string): Promise<Route> {
    if (!isActiveRoute(seen)) throw new RouteRuleError(`A "${seen.status}" route cannot be reassigned`);
    if (seen.truckId === newTruckId) throw new RouteRuleError('Route is already on that truck');
    const intent: RouteIntent = { action: 'reassign', newTruckId };
    return this.mutate(seen, intent, async () => {
      const routes = await this.refresh();
      const current = routes.find((r) => r.id === seen.id);
      if (current && current._version !== seen._version) {
        throw new ApiError('Route was modified by another dispatcher', 409, {
          currentVersion: current._version,
          yourVersion: seen._version,
        });
      }
      return this.api.request(`/api/routes/${encodeURIComponent(seen.id)}/reassign`, {
        method: 'PUT',
        body: { newTruckId },
        schema: RouteSchema,
      });
    });
  }

  /** "Keep mine" from the conflict dialog: re-apply the original intent on top of THEIR version. */
  async reapply(conflict: Extract<RouteConflict, { kind: 'version' }>): Promise<Route> {
    if (!conflict.theirs) throw new RouteRuleError('Current server version is unknown — refresh and try again');
    const check = canReapply(conflict.intent, conflict.theirs);
    if (!check.ok) throw new RouteRuleError(check.reason);
    return conflict.intent.action === 'status'
      ? this.updateStatus(conflict.theirs, conflict.intent.to)
      : this.reassign(conflict.theirs, conflict.intent.newTruckId);
  }

  private async mutate(seen: Route, intent: RouteIntent, call: () => Promise<Route>): Promise<Route> {
    // Per-route mutex: a double-click must not send two PATCHes with the same
    // If-Match (the second would always 409 against our own first write).
    if (this.inFlight.has(seen.id)) throw new RouteBusyError(seen.id);
    this.inFlight.add(seen.id);
    try {
      const updated = await call();
      this.upsert(updated);
      return updated;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) throw await this.buildVersionConflict(seen, intent, err);
      throw err;
    } finally {
      this.inFlight.delete(seen.id);
    }
  }

  private async buildVersionConflict(seen: Route, intent: RouteIntent, err: ApiError): Promise<RouteConflictError> {
    // Target-truck conflicts on reassign are not version conflicts.
    if (intent.action === 'reassign' && /target truck/i.test(err.message)) {
      const conflict: RouteConflict = {
        kind: 'target_unavailable',
        routeId: seen.id,
        newTruckId: intent.newTruckId,
        serverMessage: err.message,
      };
      this.onConflict(conflict);
      return new RouteConflictError(conflict);
    }

    let theirs: Route | null = null;
    try {
      const routes = await this.refresh();
      theirs = routes.find((r) => r.id === seen.id) ?? null;
    } catch {
      /* show the conflict even if we can't fetch the latest state */
    }
    const body = (err.body ?? {}) as { lastModifiedBy?: string };
    // Prefer timestamps from the fresh route: the 409 body's lastModifiedBy
    // misses reassignments (quirk #8 — PATCH racing a reassign).
    const changedBy = theirs ? lastActor(theirs).by : (body.lastModifiedBy ?? null);
    const conflict: RouteConflict = {
      kind: 'version',
      routeId: seen.id,
      intent,
      mine: seen,
      theirs,
      changedBy,
      serverMessage: err.message,
    };
    this.onConflict(conflict);
    return new RouteConflictError(conflict);
  }
}
