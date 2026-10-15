import type { SensorFilter, AnomalyInput } from './types';

export interface FuelFilterConfig {
  /** A drop of at least this many percentage points between two readings is "sudden". */
  suddenDropPct: number;
  /**
   * How long a sudden drop must persist (event time) before we believe it.
   * The known braking glitch lasts 2–4 s, so 8 s gives a comfortable margin
   * while still surfacing a real leak / theft within ~4 telemetry ticks.
   */
  confirmAfterMs: number;
}

export interface FuelFilterState {
  lastGood: number | null;
  suspectSince: number | null;
}

/**
 * Fuel sensor filter (quirk #2: reads 0 % for 2–4 s during hard braking).
 *
 * Fuel cannot physically vanish in two seconds, so a sudden drop is held as
 * "suspect" and the last trustworthy value keeps being displayed. Low-fuel
 * alerts are computed from the DISPLAYED value, so a glitch can never fire one.
 *
 * - drop recovers within the window  -> classified as sensor glitch (sensor_bug)
 * - drop persists beyond the window   -> accepted as real (classification 'real')
 *   so a genuine 0 % (or leak) is never hidden forever.
 */
export function createFuelFilter(config: FuelFilterConfig): SensorFilter<FuelFilterState> {
  return {
    id: 'fuel',
    initialState: () => ({ lastGood: null, suspectSince: null }),
    process(state, raw, ctx) {
      const anomalies: AnomalyInput[] = [];

      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        return {
          state,
          output: { value: state.lastGood, raw, quality: 'fault', note: `Invalid fuel reading (${raw})` },
          anomalies,
        };
      }

      // An exact 0 is the glitch's signature, so it is suspect even when the
      // previous value was already low (6% -> 0% is below suddenDropPct) or when
      // there is no baseline yet. It only becomes trusted once it persists.
      const suddenDrop =
        state.lastGood === null
          ? raw === 0
          : state.lastGood - raw >= config.suddenDropPct || (raw === 0 && state.lastGood > 0);

      if (suddenDrop) {
        const suspectSince = state.suspectSince ?? ctx.timestamp;
        const elapsed = ctx.timestamp - suspectSince;

        if (elapsed >= config.confirmAfterMs) {
          anomalies.push({
            truckId: ctx.truckId,
            kind: 'fuel_drop_confirmed',
            classification: 'real',
            message: `Fuel drop to ${raw.toFixed(0)}% persisted ${Math.round(elapsed / 1000)}s — treating as REAL (check for leak / refuel issue)`,
            timestamp: ctx.timestamp,
            durationMs: elapsed,
            phase: 'instant',
          });
          return {
            state: { lastGood: raw, suspectSince: null },
            output: { value: raw, raw, quality: 'ok' },
            anomalies,
          };
        }

        if (state.suspectSince === null) {
          anomalies.push({
            truckId: ctx.truckId,
            kind: 'fuel_glitch',
            classification: 'sensor_bug',
            message:
              state.lastGood === null
                ? `Fuel sensor reported 0% with no baseline — awaiting confirmation`
                : `Fuel dropped ${state.lastGood.toFixed(0)}% → ${raw.toFixed(0)}% instantly — holding last value pending confirmation`,
            timestamp: ctx.timestamp,
            phase: 'start',
          });
        }
        return {
          state: { lastGood: state.lastGood, suspectSince },
          output: {
            value: state.lastGood,
            raw,
            quality: 'suspect',
            note: `Sensor reports ${raw.toFixed(0)}% — likely braking glitch, showing last good value`,
          },
          anomalies,
        };
      }

      if (state.suspectSince !== null) {
        const duration = ctx.timestamp - state.suspectSince;
        anomalies.push({
          truckId: ctx.truckId,
          kind: 'fuel_glitch',
          classification: 'sensor_bug',
          message: `Fuel sensor glitch resolved after ${(duration / 1000).toFixed(1)}s — no action needed`,
          timestamp: ctx.timestamp,
          durationMs: duration,
          phase: 'end',
        });
      }

      return {
        state: { lastGood: raw, suspectSince: null },
        output: { value: raw, raw, quality: 'ok' },
        anomalies,
      };
    },
  };
}
