import type { AnomalyEvent, SensorValue } from '../../domain/types';

export type SensorKey = 'speed' | 'fuel' | 'engineTemp';

export type AnomalyInput = Omit<AnomalyEvent, 'id'>;

export interface FilterContext {
  truckId: string;
  timestamp: number;
}

export interface FilterResult<S> {
  state: S;
  output: SensorValue;
  anomalies: AnomalyInput[];
}

/**
 * A sensor filter is a pure reducer: (state, raw reading) -> (state, display value, anomalies).
 * Pure functions make the anomaly logic trivially unit-testable and let each
 * vehicle type plug in its own filters without touching the pipeline.
 */
export interface SensorFilter<S = unknown> {
  readonly id: string;
  initialState(): S;
  process(state: S, raw: number, ctx: FilterContext): FilterResult<S>;
}
