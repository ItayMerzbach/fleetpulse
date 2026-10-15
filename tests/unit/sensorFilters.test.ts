import { describe, expect, it } from 'vitest';
import { createFuelFilter, type FuelFilterState } from '../../src/telemetry/filters/fuelFilter';
import { createSpeedFilter, type SpeedFilterState } from '../../src/telemetry/filters/speedFilter';
import type { FilterResult, SensorFilter } from '../../src/telemetry/filters/types';

/** Feed a sequence of [timestamp, raw] through a filter, collecting every result. */
function run<S>(filter: SensorFilter<S>, seq: Array<[number, number]>): FilterResult<S>[] {
  let state = filter.initialState();
  return seq.map(([timestamp, raw]) => {
    const r = filter.process(state, raw, { truckId: 'truck_7', timestamp });
    state = r.state;
    return r;
  });
}

describe('speed filter (quirk #3: truck_7 stuck at 999 km/h)', () => {
  const filter = createSpeedFilter({ maxPlausibleKmh: 160 });

  it('never displays 999 — shows the last valid speed flagged as a sensor fault', () => {
    const out = run<SpeedFilterState>(filter, [
      [0, 52],
      [2000, 999],
      [4000, 999],
      [6000, 999],
    ]);
    for (const r of out.slice(1)) {
      expect(r.output.value).toBe(52);
      expect(r.output.quality).toBe('fault');
      expect(r.output.raw).toBe(999);
    }
  });

  it('reports one anomaly at fault start and one with the duration when the sensor recovers', () => {
    const out = run<SpeedFilterState>(filter, [
      [0, 50],
      [2000, 999],
      [4000, 999],
      [8000, 999],
      [10_000, 47],
    ]);
    const anomalies = out.flatMap((r) => r.anomalies);
    expect(anomalies).toHaveLength(2);
    expect(anomalies[0]).toMatchObject({ phase: 'start', kind: 'speed_implausible', classification: 'sensor_bug' });
    expect(anomalies[1]).toMatchObject({ phase: 'end', durationMs: 8000 });
    expect(out.at(-1)!.output).toEqual({ value: 47, raw: 47, quality: 'ok' });
  });

  it('shows "no value" rather than inventing one when the very first reading is faulty', () => {
    const [first] = run<SpeedFilterState>(filter, [[0, 999]]);
    expect(first.output.value).toBeNull();
    expect(first.output.quality).toBe('fault');
  });

  it('rejects negative and non-finite values but accepts a legitimately constant speed', () => {
    const out = run<SpeedFilterState>(filter, [
      [0, -5],
      [2000, Number.NaN],
      [4000, 80],
      [6000, 80],
      [8000, 80],
      [10_000, 80],
      [12_000, 80],
    ]);
    expect(out[0].output.quality).toBe('fault');
    expect(out[1].output.quality).toBe('fault');
    // Regression: trucks cruise at their 80 km/h cap — that's not a frozen sensor.
    expect(out.slice(2).every((r) => r.output.quality === 'ok')).toBe(true);
  });
});

describe('fuel filter (quirk #2: 0 % for 2–4 s during hard braking)', () => {
  const filter = createFuelFilter({ suddenDropPct: 15, confirmAfterMs: 8000 });

  it('holds the last good value during a short 0 % glitch and classifies it as a sensor bug', () => {
    const out = run<FuelFilterState>(filter, [
      [0, 62],
      [2000, 0],
      [4000, 0],
      [6000, 61.9],
    ]);
    expect(out[1].output).toMatchObject({ value: 62, raw: 0, quality: 'suspect' });
    expect(out[2].output).toMatchObject({ value: 62, quality: 'suspect' });
    expect(out[3].output).toMatchObject({ value: 61.9, quality: 'ok' });

    const anomalies = out.flatMap((r) => r.anomalies);
    expect(anomalies.map((a) => [a.kind, a.phase, a.classification])).toEqual([
      ['fuel_glitch', 'start', 'sensor_bug'],
      ['fuel_glitch', 'end', 'sensor_bug'],
    ]);
    expect(anomalies[1].durationMs).toBe(4000);
  });

  it('accepts a REAL 0 % once it persists beyond the confirmation window', () => {
    const out = run<FuelFilterState>(filter, [
      [0, 40],
      [2000, 0],
      [4000, 0],
      [6000, 0],
      [8000, 0],
      [10_000, 0],
    ]);
    expect(out[3].output.value).toBe(40); // 4 s in: still treated as a possible glitch
    expect(out[4].output.value).toBe(40); // 6 s in
    expect(out[5].output).toEqual({ value: 0, raw: 0, quality: 'ok' }); // 8 s: confirmed
    expect(out[5].anomalies[0]).toMatchObject({ kind: 'fuel_drop_confirmed', classification: 'real' });
  });

  it('treats an exact 0 as suspect even when fuel was already low (below the drop threshold)', () => {
    const out = run<FuelFilterState>(filter, [
      [0, 6],
      [2000, 0],
    ]);
    expect(out[1].output).toMatchObject({ value: 6, quality: 'suspect' });
  });

  it('does not trust a 0 % first reading with no baseline', () => {
    const [first] = run<FuelFilterState>(filter, [[0, 0]]);
    expect(first.output).toMatchObject({ value: null, quality: 'suspect' });
  });

  it('accepts normal consumption and refuelling without flags', () => {
    const out = run<FuelFilterState>(filter, [
      [0, 30],
      [2000, 29.9],
      [4000, 29.8],
      [6000, 95], // refuel
    ]);
    expect(out.every((r) => r.output.quality === 'ok' && r.anomalies.length === 0)).toBe(true);
    expect(out[3].output.value).toBe(95);
  });
});
