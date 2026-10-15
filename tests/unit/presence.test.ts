import { describe, expect, it } from 'vitest';
import { createDispatcherIdentity, displayNameFromId } from '../../src/domain/dispatcher';
import { initialPresence, presenceReducer, viewersByTruck, type PresenceEvent, type PresenceState } from '../../src/domain/presence';

const SELF = 'dana-0001';
const apply = (events: PresenceEvent[], start: PresenceState = initialPresence(SELF)) => events.reduce(presenceReducer, start);

describe('presence reducer (quirk #6: ghost dispatchers)', () => {
  it('a late dispatcher_left for someone already gone is a harmless no-op', () => {
    const s0 = apply([{ type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer', receivedAt: 0 }]);
    const s1 = apply([{ type: 'left', dispatcherId: 'omer-1a2b', receivedAt: 1 }], s0);
    const s2 = apply([{ type: 'left', dispatcherId: 'omer-1a2b', receivedAt: 10_000 }], s1); // the ghost arrives
    expect(s2).toBe(s1);
    expect(s2.others).toEqual({});
  });

  it('ignores a delayed leave for OUR OWN previous socket after we reconnected', () => {
    const s = apply([{ type: 'left', dispatcherId: SELF, receivedAt: 5 }]);
    expect(s).toEqual(initialPresence(SELF));
  });

  it('heals a ghost leave that arrives after the dispatcher already reconnected', () => {
    const s = apply([
      { type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer', receivedAt: 0 },
      { type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer', receivedAt: 3000 }, // reconnect
      { type: 'left', dispatcherId: 'omer-1a2b', receivedAt: 10_000 }, // ghost of the OLD socket
      { type: 'viewing', dispatcherId: 'omer-1a2b', truckId: 'truck_3', receivedAt: 15_000 }, // heartbeat
    ]);
    expect(s.others['omer-1a2b']).toMatchObject({ name: 'Omer', viewingTruckId: 'truck_3' });
  });

  it('expires dispatchers with no sign of life (covers leave events that never arrive)', () => {
    const s = apply([
      { type: 'joined', dispatcherId: 'a-0001', name: 'A', receivedAt: 0 },
      { type: 'viewing', dispatcherId: 'b-0002', truckId: null, receivedAt: 40_000 },
      { type: 'expire', now: 50_000, ttlMs: 45_000 },
    ]);
    expect(Object.keys(s.others)).toEqual(['b-0002']);
  });

  it('does not duplicate on repeated joins and tracks collaborative viewing per truck', () => {
    const s = apply([
      { type: 'joined', dispatcherId: 'a-0001', name: 'A', receivedAt: 0 },
      { type: 'joined', dispatcherId: 'a-0001', name: 'A', receivedAt: 1 },
      { type: 'viewing', dispatcherId: 'a-0001', truckId: 'truck_7', receivedAt: 2 },
      { type: 'viewing', dispatcherId: 'noa-77aa', truckId: 'truck_7', receivedAt: 3 }, // never saw her join
      { type: 'viewing', dispatcherId: null, truckId: 'truck_1', receivedAt: 4 }, // unregistered socket
    ]);
    expect(Object.keys(s.others)).toHaveLength(2);
    expect(viewersByTruck(s).truck_7.map((d) => d.name)).toEqual(['A', 'Noa']);
    expect(viewersByTruck(s).truck_1).toBeUndefined();
  });
});

describe('dispatcher identity', () => {
  it('generates header-safe ids that round-trip to a readable name', () => {
    const id = createDispatcherIdentity('Dana Levi', () => 0.5);
    expect(id.id).toMatch(/^dana_levi-[0-9a-f]{4}$/);
    expect(displayNameFromId(id.id)).toBe('Dana Levi');
    expect(displayNameFromId('dispatcher_ab12cd34')).toBe('dispatcher_ab12cd34');
  });

  it('falls back to a safe slug for non-latin names', () => {
    expect(createDispatcherIdentity('דנה', () => 0).id).toMatch(/^dispatcher-0000$/);
  });
});
