import { describe, expect, it } from 'vitest';
import { TelemetryProcessor } from '../../src/telemetry/TelemetryProcessor';
import { createDefaultVehicleRegistry } from '../../src/vehicles/vehicleTypes';
import { reading } from '../helpers';

const make = () => new TelemetryProcessor(createDefaultVehicleRegistry(), { trailSize: 60, historySize: 150 });

describe('TelemetryProcessor — GPS batch (quirk #1)', () => {
  it('merges a 30-reading backlog into the path without moving the truck backwards', () => {
    const p = make();
    const now = 100_000;
    p.ingest([reading({ timestamp: now, location: { lat: 32.1, lng: 34.8 } })]);

    // Server sends the backlog AFTER the live reading, all with older timestamps.
    const batch = Array.from({ length: 30 }, (_, i) =>
      reading({ timestamp: now - (30 - i) * 2000, location: { lat: 32.0 + i * 0.001, lng: 34.7 }, _batch: true }),
    );
    const res = p.ingest(batch, 'batch');

    const snap = p.snapshot('truck_1')!;
    expect(snap.location).toEqual({ lat: 32.1, lng: 34.8 }); // still the newest fix
    expect(snap.lastTimestamp).toBe(now);
    expect(snap.trail).toHaveLength(31); // one path, not 30 extra markers
    expect(snap.trail.map((t) => t.timestamp)).toEqual([...snap.trail.map((t) => t.timestamp)].sort((a, b) => a - b));
    expect(res.late).toBe(30);
    expect(res.updatedTruckIds).toEqual(new Set(['truck_1'])); // one commit for the whole batch
    expect(res.anomalies.filter((a) => a.kind === 'gps_batch')).toHaveLength(1);
  });

  it('applies batch readings that are newer than current, in timestamp order', () => {
    const p = make();
    p.ingest([reading({ timestamp: 1000 })]);
    // Shuffled arrival order; newest must win.
    p.ingest(
      [
        reading({ timestamp: 5000, location: { lat: 5, lng: 5 } }),
        reading({ timestamp: 3000, location: { lat: 3, lng: 3 } }),
        reading({ timestamp: 4000, location: { lat: 4, lng: 4 } }),
      ],
      'batch',
    );
    const snap = p.snapshot('truck_1')!;
    expect(snap.location).toEqual({ lat: 5, lng: 5 });
    expect(snap.history.map((h) => h.timestamp)).toEqual([1000, 3000, 4000, 5000]);
  });
});

describe('TelemetryProcessor — out-of-order timestamps (quirk #5)', () => {
  it('uses event time, not arrival order: an older reading never overrides the current state', () => {
    const p = make();
    p.ingest([reading({ timestamp: 10_000, location: { lat: 2, lng: 2 }, fuel: 50, speed: 30 })]);
    const res = p.ingest([reading({ timestamp: 6_000, location: { lat: 1, lng: 1 }, fuel: 90, speed: 70, _reordered: true })]);

    const snap = p.snapshot('truck_1')!;
    expect(snap.location).toEqual({ lat: 2, lng: 2 });
    expect(snap.fuel.value).toBe(50);
    expect(snap.speed.value).toBe(30);
    expect(res.accepted).toBe(0);
    expect(res.late).toBe(1);
    // ...but the late fix still lands at the right place in the path
    expect(snap.trail.map((t) => t.timestamp)).toEqual([6_000, 10_000]);
    expect(res.anomalies[0]).toMatchObject({ kind: 'out_of_order', classification: 'transport' });
  });

  it('a reading with the same timestamp as current is not applied twice', () => {
    const p = make();
    p.ingest([reading({ timestamp: 1000, speed: 10 })]);
    p.ingest([reading({ timestamp: 1000, speed: 99 })]);
    expect(p.snapshot('truck_1')!.speed.value).toBe(10);
  });

  it('keeps per-truck ordering independent', () => {
    const p = make();
    p.ingest([reading({ truckId: 'truck_1', timestamp: 5000 }), reading({ truckId: 'truck_2', timestamp: 1000 })]);
    const res = p.ingest([reading({ truckId: 'truck_2', timestamp: 3000 })]); // older than truck_1, newer for truck_2
    expect(res.accepted).toBe(1);
    expect(p.snapshot('truck_2')!.lastTimestamp).toBe(3000);
  });
});

describe('TelemetryProcessor — windowing', () => {
  it('bounds memory: trail and history never exceed their capacity', () => {
    const p = new TelemetryProcessor(createDefaultVehicleRegistry(), { trailSize: 10, historySize: 20 });
    for (let i = 1; i <= 500; i++) p.ingest([reading({ timestamp: i * 2000 })]);
    const snap = p.snapshot('truck_1')!;
    expect(snap.trail).toHaveLength(10);
    expect(snap.history).toHaveLength(20);
    expect(snap.history.at(-1)!.timestamp).toBe(500 * 2000);
  });

  it('returns the same snapshot object until something changes (cheap React selectors)', () => {
    const p = make();
    p.ingest([reading({ timestamp: 1000 })]);
    const a = p.snapshot('truck_1');
    expect(p.snapshot('truck_1')).toBe(a);
    p.ingest([reading({ timestamp: 2000 })]);
    expect(p.snapshot('truck_1')).not.toBe(a);
  });
});
