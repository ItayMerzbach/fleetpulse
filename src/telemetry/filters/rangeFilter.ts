import type { SensorFilter } from './types';

export interface RangeFilterState {
  lastGood: number | null;
}

/** Generic plausibility gate: values outside [min, max] are rejected and the last good value is held. */
export function createRangeFilter(id: string, min: number, max: number, unit: string): SensorFilter<RangeFilterState> {
  return {
    id,
    initialState: () => ({ lastGood: null }),
    process(state, raw) {
      if (!Number.isFinite(raw) || raw < min || raw > max) {
        return {
          state,
          output: { value: state.lastGood, raw, quality: 'fault', note: `Out of range reading (${raw}${unit})` },
          anomalies: [],
        };
      }
      return { state: { lastGood: raw }, output: { value: raw, raw, quality: 'ok' }, anomalies: [] };
    },
  };
}
