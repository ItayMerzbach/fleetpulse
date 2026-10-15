import type { Dispatcher } from './types';

export interface PresenceState {
  selfId: string;
  others: Record<string, Dispatcher>;
}

export type PresenceEvent =
  | { type: 'joined'; dispatcherId: string; name: string }
  | { type: 'left'; dispatcherId: string }
  | { type: 'viewing'; dispatcherId: string | null; truckId: string | null };

/**
 * Who else is online and which truck they're looking at.
 *
 * Ghost handling (the server may send `dispatcher_left` up to 10 s late):
 *  - a leave for someone we don't know is ignored (no crash, no change);
 *  - a leave for ourselves is ignored (it's our old connection, we reconnected);
 *  - any later "viewing" message brings a dispatcher back, so a late leave
 *    can't hide someone who is actually online.
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
          [event.dispatcherId]: { id: event.dispatcherId, name: event.name, viewingTruckId: prev?.viewingTruckId ?? null },
        },
      };
    }
    case 'viewing': {
      const id = event.dispatcherId;
      if (!id || id === state.selfId) return state;
      const prev = state.others[id];
      return {
        ...state,
        others: { ...state.others, [id]: { id, name: prev?.name ?? nameFromId(id), viewingTruckId: event.truckId } },
      };
    }
    case 'left': {
      if (event.dispatcherId === state.selfId || !state.others[event.dispatcherId]) return state;
      const others = { ...state.others };
      delete others[event.dispatcherId];
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
