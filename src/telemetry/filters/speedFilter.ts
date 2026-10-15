import type { SensorFilter, AnomalyInput } from './types';

export interface SpeedFilterConfig {
  /** Anything above this is physically impossible for the vehicle type. */
  maxPlausibleKmh: number;
}

export interface SpeedFilterState {
  lastGood: number | null;
  faultSince: number | null;
}

/**
 * Speed sensor filter (quirk #3: truck_7 reports 999 km/h for 5–10 s).
 *
 * Implausible values (> max, negative, NaN) are REJECTED. The dispatcher sees
 * the last valid speed, explicitly marked as a sensor fault — never 999.
 * Fault start/end are emitted as anomalies so the anomaly dashboard can show
 * the duration, which is what tells a sensor bug apart from a real event.
 *
 * Deliberately NOT implemented: "same value N times => frozen sensor". It was
 * tried and produced false positives — the simulated trucks legitimately sit at
 * their 80 km/h cap for many consecutive readings (real cruise control does the
 * same). See PROMPTS.md.
 */
export function createSpeedFilter(config: SpeedFilterConfig): SensorFilter<SpeedFilterState> {
  return {
    id: 'speed',
    initialState: () => ({ lastGood: null, faultSince: null }),
    process(state, raw, ctx) {
      const anomalies: AnomalyInput[] = [];
      const implausible = !Number.isFinite(raw) || raw < 0 || raw > config.maxPlausibleKmh;

      if (implausible) {
        if (state.faultSince === null) {
          anomalies.push({
            truckId: ctx.truckId,
            kind: 'speed_implausible',
            classification: 'sensor_bug',
            message: `Speed sensor reported ${fmt(raw)} km/h (max plausible ${config.maxPlausibleKmh}) — reading rejected`,
            timestamp: ctx.timestamp,
            phase: 'start',
          });
        }
        return {
          state: { lastGood: state.lastGood, faultSince: state.faultSince ?? ctx.timestamp },
          output: {
            value: state.lastGood,
            raw,
            quality: 'fault',
            note: `Sensor fault: reported ${fmt(raw)} km/h. Showing last valid reading.`,
          },
          anomalies,
        };
      }

      if (state.faultSince !== null) {
        const durationMs = ctx.timestamp - state.faultSince;
        anomalies.push({
          truckId: ctx.truckId,
          kind: 'speed_implausible',
          classification: 'sensor_bug',
          message: `Speed sensor recovered after ${Math.round(durationMs / 1000)}s of invalid readings`,
          timestamp: ctx.timestamp,
          durationMs,
          phase: 'end',
        });
      }

      return { state: { lastGood: raw, faultSince: null }, output: { value: raw, raw, quality: 'ok' }, anomalies };
    },
  };
}

const fmt = (n: number) => (Number.isFinite(n) ? String(Math.round(n)) : String(n));
