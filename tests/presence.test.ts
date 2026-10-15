import { describe, expect, it } from 'vitest';
import { createDispatcherId, nameFromId, presenceReducer, type PresenceEvent, type PresenceState } from '../src/presence';

const start: PresenceState = { selfId: 'dana-0001', others: {} };
const run = (events: PresenceEvent[], from: PresenceState = start) => events.reduce(presenceReducer, from);
const joined = (now: number): PresenceEvent => ({ type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer', now });
const left = (now: number): PresenceEvent => ({ type: 'left', dispatcherId: 'omer-1a2b', now });

describe('presence with ghost dispatchers', () => {
  it('a "left" within 11 s of their last activity marks them uncertain, not removed', () => {
    const state = run([joined(0), left(5_000)]);
    expect(state.others['omer-1a2b'].status).toBe('uncertain');
  });

  it('activity after an uncertain "left" puts them back online (they had refreshed)', () => {
    const state = run([
      joined(0),
      left(5_000), // ghost of the old connection
      { type: 'activity', dispatcherId: 'omer-1a2b', now: 8_000 }, // e.g. they updated a route
    ]);
    expect(state.others['omer-1a2b']).toMatchObject({ status: 'online', lastSeenAt: 8_000 });
  });

  it('an uncertain dispatcher with no activity for 60 s is removed on tick', () => {
    const uncertain = run([joined(0), left(5_000)]);
    expect(run([{ type: 'tick', now: 59_000 }], uncertain).others['omer-1a2b']).toBeDefined();
    expect(run([{ type: 'tick', now: 60_000 }], uncertain).others['omer-1a2b']).toBeUndefined();
  });

  it('a "left" 11 s or more after their last activity removes them immediately', () => {
    const state = run([joined(0), left(12_000)]);
    expect(state.others['omer-1a2b']).toBeUndefined();
  });

  it('tick never removes dispatchers who are online', () => {
    const state = run([joined(0), { type: 'tick', now: 600_000 }]);
    expect(state.others['omer-1a2b'].status).toBe('online');
  });

  it('activity from someone not in the presence list does not add them', () => {
    expect(run([{ type: 'activity', dispatcherId: 'curl-user', now: 1_000 }])).toBe(start);
  });

  it('ignores a "left" for our own previous connection and for unknown ids', () => {
    expect(run([{ type: 'left', dispatcherId: 'dana-0001', now: 20_000 }, left(20_000)])).toBe(start);
  });

  it('tracks which truck each dispatcher is viewing', () => {
    const state = run([
      joined(0),
      { type: 'viewing', dispatcherId: 'omer-1a2b', truckId: 'truck_7', now: 1_000 },
      { type: 'viewing', dispatcherId: 'noa-77aa', truckId: 'truck_2', now: 2_000 }, // never saw her join
    ]);
    expect(state.others['omer-1a2b'].viewingTruckId).toBe('truck_7');
    expect(state.others['noa-77aa']).toMatchObject({ name: 'Noa', status: 'online' });
  });
});

describe('dispatcher ids', () => {
  it('embed a readable name', () => {
    const id = createDispatcherId('Dana Levi', () => 0.5);
    expect(id).toBe('dana_levi-8000');
    expect(nameFromId(id)).toBe('Dana Levi');
  });
});
