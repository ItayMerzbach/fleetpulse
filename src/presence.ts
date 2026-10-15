import type { Dispatcher } from './types';

export interface PresenceState {
  selfId: string;
  others: Record<string, Dispatcher>;
}

/** `now` is the local arrival time of the event, passed in so the reducer stays pure. */
export type PresenceEvent =
  | { type: 'joined'; dispatcherId: string; name: string; now: number }
  | { type: 'viewing'; dispatcherId: string | null; truckId: string | null; now: number }
  /** The dispatcher did something (route change, alert) — proof they're online. */
  | { type: 'activity'; dispatcherId: string | undefined; now: number }
  | { type: 'left'; dispatcherId: string; now: number }
  /** Periodic clock tick, used to drop uncertain dispatchers that went quiet. */
  | { type: 'tick'; now: number };

/** The server's ghost `dispatcher_left` arrives ~10 s after the old connection closed. */
export const GHOST_LEAVE_WINDOW_MS = 11_000;
/** An uncertain dispatcher with no activity for this long is removed. */
export const UNCERTAIN_TIMEOUT_MS = 60_000;

/**
 * Who else is online and which truck they're looking at.
 *
 * Ghost handling (quirk #6). When someone refreshes and reconnects with the same
 * id, the leave of their OLD connection arrives ~10 s late, after the new join.
 * The server's timestamp on the leave is set after the delay, so we use our own
 * arrival times (`lastSeenAt`), the same "suspect" idea as the fuel filter:
 *  - a leave < 11 s after we last saw them → 'uncertain' (shown greyed), not removed;
 *  - any activity from them → 'online' again;
 *  - uncertain and silent for 60 s → removed (on 'tick');
 *  - a leave ≥ 11 s after we last saw them → removed immediately.
 * Leaves for ourselves (our old connection) or for unknown ids are ignored.
 */
export function presenceReducer(state: PresenceState, event: PresenceEvent): PresenceState {
  const update = (d: Dispatcher) => ({ ...state, others: { ...state.others, [d.id]: d } });

  switch (event.type) {
    case 'joined': {
      if (event.dispatcherId === state.selfId) return state;
      const prev = state.others[event.dispatcherId];
      return update({
        id: event.dispatcherId,
        name: event.name,
        viewingTruckId: prev?.viewingTruckId ?? null,
        status: 'online',
        lastSeenAt: event.now,
      });
    }
    case 'viewing': {
      const id = event.dispatcherId;
      if (!id || id === state.selfId) return state;
      const prev = state.others[id];
      return update({ id, name: prev?.name ?? nameFromId(id), viewingTruckId: event.truckId, status: 'online', lastSeenAt: event.now });
    }
    case 'activity': {
      // Only refreshes dispatchers we already know: an API call alone doesn't prove a live connection.
      const prev = event.dispatcherId ? state.others[event.dispatcherId] : undefined;
      if (!prev) return state;
      return update({ ...prev, status: 'online', lastSeenAt: event.now });
    }
    case 'left': {
      const prev = state.others[event.dispatcherId];
      if (event.dispatcherId === state.selfId || !prev) return state;
      if (event.now - prev.lastSeenAt < GHOST_LEAVE_WINDOW_MS) return update({ ...prev, status: 'uncertain' });
      const others = { ...state.others };
      delete others[event.dispatcherId];
      return { ...state, others };
    }
    case 'tick': {
      const expired = Object.values(state.others).filter(
        (d) => d.status === 'uncertain' && event.now - d.lastSeenAt >= UNCERTAIN_TIMEOUT_MS,
      );
      if (expired.length === 0) return state;
      const others = { ...state.others };
      for (const d of expired) delete others[d.id];
      return { ...state, others };
    }
  }
}

/**
 * Our dispatcher ids look like "dana_levi-3f2a": a slug of the name plus 4 random
 * hex chars. Generated in the browser so the id exists before the first request
 * and stays the same across reconnects; the slug lets us show a readable name for
 * anyone, even if we never received their "joined" message.
 */
export function createDispatcherId(name: string, random: () => number = Math.random): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 20) || 'dispatcher';
  const suffix = Math.floor(random() * 0x10000)
    .toString(16)
    .padStart(4, '0');
  return `${slug}-${suffix}`;
}

export function nameFromId(id: string): string {
  const match = /^([a-z0-9_]+)-[0-9a-f]{4}$/.exec(id);
  if (!match) return id;
  return match[1]
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}
