import { displayNameFromId } from './dispatcher';

export interface PresenceEntry {
  id: string;
  name: string;
  viewingTruckId: string | null;
  joinedAt: number | null;
  /** Client receive time of the last sign of life (join / viewing). */
  lastSeenAt: number;
}

export interface PresenceState {
  selfId: string;
  others: Record<string, PresenceEntry>;
}

export type PresenceEvent =
  | { type: 'joined'; dispatcherId: string; name: string; receivedAt: number }
  | { type: 'left'; dispatcherId: string; receivedAt: number }
  | { type: 'viewing'; dispatcherId: string | null; truckId: string | null | undefined; receivedAt: number }
  | { type: 'expire'; now: number; ttlMs: number }
  | { type: 'reset' };

export const initialPresence = (selfId: string): PresenceState => ({ selfId, others: {} });

/**
 * Pure presence reducer. Ghost handling (quirk #6: a dispatcher_left may arrive
 * up to 10 s late):
 *
 *  - `left` for an unknown dispatcher is a no-op (already expired / never seen),
 *    so a late leave can't crash or corrupt the list.
 *  - `left` for OURSELVES is ignored: it is the delayed leave of our previous
 *    socket arriving after we reconnected with the same id.
 *  - Any sign of life (`viewing`) AFTER a leave re-adds the dispatcher. A ghost
 *    leave for someone who already reconnected therefore heals itself at their
 *    next presence heartbeat instead of hiding them forever.
 *  - `expire` drops entries with no sign of life for ttl — this also covers
 *    leave events that never arrive at all (server restart, lost message).
 */
export function presenceReducer(state: PresenceState, event: PresenceEvent): PresenceState {
  switch (event.type) {
    case 'joined': {
      if (event.dispatcherId === state.selfId) return state;
      const prev = state.others[event.dispatcherId];
      return {
        ...state,
        others: {
          ...state.others,
          [event.dispatcherId]: {
            id: event.dispatcherId,
            name: event.name || prev?.name || displayNameFromId(event.dispatcherId),
            viewingTruckId: prev?.viewingTruckId ?? null,
            joinedAt: event.receivedAt,
            lastSeenAt: event.receivedAt,
          },
        },
      };
    }
    case 'viewing': {
      const id = event.dispatcherId;
      if (!id || id === state.selfId) return state;
      const prev = state.others[id];
      return {
        ...state,
        others: {
          ...state.others,
          [id]: {
            id,
            name: prev?.name ?? displayNameFromId(id),
            viewingTruckId: event.truckId ?? null,
            joinedAt: prev?.joinedAt ?? null,
            lastSeenAt: event.receivedAt,
          },
        },
      };
    }
    case 'left': {
      if (event.dispatcherId === state.selfId) return state;
      if (!(event.dispatcherId in state.others)) return state;
      const { [event.dispatcherId]: _removed, ...rest } = state.others;
      return { ...state, others: rest };
    }
    case 'expire': {
      const cutoff = event.now - event.ttlMs;
      const stale = Object.values(state.others).filter((d) => d.lastSeenAt < cutoff);
      if (stale.length === 0) return state;
      const others = { ...state.others };
      for (const d of stale) delete others[d.id];
      return { ...state, others };
    }
    case 'reset':
      return initialPresence(state.selfId);
  }
}

/** truckId -> dispatchers currently looking at it. */
export function viewersByTruck(state: PresenceState): Record<string, PresenceEntry[]> {
  const out: Record<string, PresenceEntry[]> = {};
  for (const d of Object.values(state.others)) {
    if (!d.viewingTruckId) continue;
    (out[d.viewingTruckId] ??= []).push(d);
  }
  return out;
}
