import { describe, expect, it } from 'vitest';
import { applyReadings, filterFuel, filterSpeed, isLowFuel } from '../src/telemetry';
import type { Reading, Truck } from '../src/types';

const reading = (over: Partial<Reading> & { timestamp: number }): Reading => ({
  truckId: 'truck_1',
  location: { lat: 32.08, lng: 34.78 },
  speed: 40,
  heading: 0,
  fuel: 60,
  engineTemp: 85,
  status: 'active',
  ...over,
});

/** Feed readings one tick at a time, like the SSE stream does. */
const feed = (readings: Reading[]) =>
  readings.reduce<Record<string, Truck>>((trucks, r) => applyReadings(trucks, [r]), {});

describe('GPS batch', () => {
  it('merges 30 buffered readings into the path without moving the truck back', () => {
    let trucks = applyReadings({}, [reading({ timestamp: 100_000, location: { lat: 32.1, lng: 34.8 } })]);
    const batch = Array.from({ length: 30 }, (_, i) =>
      reading({ timestamp: 100_000 - (30 - i) * 2000, location: { lat: 32 + i * 0.001, lng: 34.7 } }),
    );
    trucks = applyReadings(trucks, batch);

    expect(Object.keys(trucks)).toEqual(['truck_1']); // still one truck = one marker
    expect(trucks.truck_1.location).toEqual({ lat: 32.1, lng: 34.8 }); // latest position kept
    expect(trucks.truck_1.path).toHaveLength(31); // batch shown as path
    const times = trucks.truck_1.path.map((p) => p.timestamp);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('out-of-order timestamps', () => {
  it('an older reading arriving later does not override the newer one', () => {
    const trucks = feed([
      reading({ timestamp: 10_000, location: { lat: 2, lng: 2 }, speed: 30, fuel: 50 }),
      reading({ timestamp: 6_000, location: { lat: 1, lng: 1 }, speed: 70, fuel: 52 }),
    ]);
    expect(trucks.truck_1.location).toEqual({ lat: 2, lng: 2 });
    expect(trucks.truck_1.speed).toBe(30);
    expect(trucks.truck_1.path.map((p) => p.timestamp)).toEqual([6_000, 10_000]);
  });

  it('readings in one message are applied in timestamp order, not array order', () => {
    const trucks = applyReadings({}, [
      reading({ timestamp: 3000, location: { lat: 3, lng: 3 } }),
      reading({ timestamp: 1000, location: { lat: 1, lng: 1 } }),
    ]);
    expect(trucks.truck_1.location).toEqual({ lat: 3, lng: 3 });
  });
});

describe('speed sensor (truck_7 sends 999 km/h)', () => {
  it('never shows 999 — keeps the last valid speed and flags a fault', () => {
    const trucks = feed([reading({ timestamp: 1000, speed: 52 }), reading({ timestamp: 3000, speed: 999 })]);
    expect(trucks.truck_1.speed).toBe(52);
    expect(trucks.truck_1.speedFault).toBe(true);
    expect(trucks.truck_1.history[1].speed).toBeNull(); // gap in the chart
  });

  it('clears the fault when valid readings return', () => {
    expect(filterSpeed(48, 52)).toEqual({ speed: 48, speedFault: false });
  });

  it('rejects negative and non-numeric values too', () => {
    expect(filterSpeed(-5, 30).speedFault).toBe(true);
    expect(filterSpeed(Number.NaN, 30).speedFault).toBe(true);
  });
});

describe('fuel sensor (reads 0% for 2–4 s when braking)', () => {
  it('a short 0% glitch keeps the last value and never triggers low fuel', () => {
    const trucks = feed([
      reading({ timestamp: 0, fuel: 62 }),
      reading({ timestamp: 2000, fuel: 0 }),
      reading({ timestamp: 4000, fuel: 0 }),
    ]);
    expect(trucks.truck_1.fuel).toBe(62);
    expect(trucks.truck_1.fuelSuspect).toBe(true);
    expect(isLowFuel(trucks.truck_1)).toBe(false);
  });

  it('a 0% that persists past the confirmation window is accepted as real', () => {
    const trucks = feed([0, 2000, 4000, 6000, 8000, 10_000].map((t, i) => reading({ timestamp: t, fuel: i === 0 ? 40 : 0 })));
    expect(trucks.truck_1.fuel).toBe(0);
    expect(trucks.truck_1.fuelSuspect).toBe(false);
    expect(isLowFuel(trucks.truck_1)).toBe(true);
  });

  it('a gradual real decline below 15% does trigger low fuel', () => {
    const trucks = feed([20, 17, 14].map((fuel, i) => reading({ timestamp: i * 2000, fuel })));
    expect(isLowFuel(trucks.truck_1)).toBe(true);
  });

  it('an exact 0 is suspect even if fuel was already low', () => {
    expect(filterFuel(0, { fuel: 6, fuelSuspectSince: null }, 1000)).toEqual({ fuel: 6, fuelSuspect: true, fuelSuspectSince: 1000 });
  });
});
