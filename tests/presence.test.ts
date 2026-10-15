import { describe, expect, it } from 'vitest';
import { createDispatcherId, nameFromId, presenceReducer, type PresenceEvent, type PresenceState } from '../src/presence';

const start: PresenceState = { selfId: 'dana-0001', others: {} };
const run = (events: PresenceEvent[]) => events.reduce(presenceReducer, start);

describe('presence with ghost dispatchers', () => {
  it('a late "left" for someone who is already gone changes nothing', () => {
    const afterLeave = run([
      { type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer' },
      { type: 'left', dispatcherId: 'omer-1a2b' },
    ]);
    expect(presenceReducer(afterLeave, { type: 'left', dispatcherId: 'omer-1a2b' })).toBe(afterLeave);
  });

  it('ignores a late "left" for our own previous connection', () => {
    expect(run([{ type: 'left', dispatcherId: 'dana-0001' }])).toEqual(start);
  });

  it('a dispatcher who is active again after a ghost "left" shows up again', () => {
    const state = run([
      { type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer' },
      { type: 'left', dispatcherId: 'omer-1a2b' }, // ghost of an old connection
      { type: 'viewing', dispatcherId: 'omer-1a2b', truckId: 'truck_3' },
    ]);
    expect(state.others['omer-1a2b']).toEqual({ id: 'omer-1a2b', name: 'Omer', viewingTruckId: 'truck_3' });
  });

  it('tracks which truck each dispatcher is viewing', () => {
    const state = run([
      { type: 'joined', dispatcherId: 'omer-1a2b', name: 'Omer' },
      { type: 'viewing', dispatcherId: 'omer-1a2b', truckId: 'truck_7' },
      { type: 'viewing', dispatcherId: 'noa-77aa', truckId: 'truck_2' }, // never saw her join
    ]);
    expect(state.others['omer-1a2b'].viewingTruckId).toBe('truck_7');
    expect(state.others['noa-77aa'].name).toBe('Noa');
  });
});

describe('dispatcher ids', () => {
  it('embed a readable name', () => {
    const id = createDispatcherId('Dana Levi', () => 0.5);
    expect(id).toBe('dana_levi-8000');
    expect(nameFromId(id)).toBe('Dana Levi');
  });
});
