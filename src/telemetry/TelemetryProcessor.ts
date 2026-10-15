import { SortedWindow } from '../core/SortedWindow';
import type {
  HistoryPoint,
  LatLng,
  SensorValue,
  TelemetryReading,
  TrailPoint,
  TruckStatus,
  VehicleTelemetry,
} from '../domain/types';
import type { VehicleTypeRegistry } from '../vehicles/vehicleTypes';
import type { AnomalyInput, SensorFilter, SensorKey } from './filters/types';

export interface ProcessorOptions {
  /** GPS fixes kept per vehicle for the path (~2 min at 2 s). */
  trailSize: number;
  /** Chart points kept per vehicle (~5 min at 2 s). */
  historySize: number;
}

export type ReadingSource = 'live' | 'batch';

export interface IngestResult {
  updatedTruckIds: Set<string>;
  anomalies: AnomalyInput[];
  /** Readings that advanced a vehicle's "current" state. */
  accepted: number;
  /** Readings older than current state — used for the path only. */
  late: number;
}

interface SensorSlot {
  filter: SensorFilter<unknown>;
  state: unknown;
  output: SensorValue;
}

interface VehicleState {
  truckId: string;
  vehicleType: string;
  lastTimestamp: number;
  location: LatLng;
  heading: number;
  status: TruckStatus | null;
  sensors: Record<SensorKey, SensorSlot>;
  trail: SortedWindow<TrailPoint>;
  history: SortedWindow<HistoryPoint>;
  snapshot: VehicleTelemetry | null;
}

const SENSORS: SensorKey[] = ['speed', 'fuel', 'engineTemp'];
const UNKNOWN: SensorValue = { value: null, raw: null, quality: 'unknown' };

/**
 * The telemetry pipeline. Framework-agnostic and synchronous so it can be unit
 * tested without React, timers or a network.
 *
 * Ordering rule: EVENT TIME wins over ARRIVAL TIME. For every vehicle we keep
 * the timestamp of the newest accepted reading:
 *   - newer reading  -> runs through the sensor filters and becomes "current"
 *   - older reading  -> (out-of-order or GPS batch backlog) is merged into the
 *                       path at its correct position but never moves the truck
 *                       backwards or overrides newer sensor values.
 *
 * A GPS batch of 30 readings is processed in one call and produces ONE snapshot
 * per vehicle, i.e. one render — not 30 markers or 30 re-renders.
 */
export class TelemetryProcessor {
  private vehicles = new Map<string, VehicleState>();

  constructor(
    private readonly registry: VehicleTypeRegistry,
    private readonly options: ProcessorOptions = { trailSize: 60, historySize: 150 },
  ) {}

  ingest(readings: TelemetryReading[], source: ReadingSource = 'live'): IngestResult {
    const result: IngestResult = { updatedTruckIds: new Set(), anomalies: [], accepted: 0, late: 0 };
    if (readings.length === 0) return result;

    // Sort by event time so a batch that contains newer-than-current readings
    // is applied in the order the readings were taken.
    const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);
    const batchCounts = new Map<string, number>();

    for (const reading of sorted) {
      const v = this.getOrCreate(reading.truckId);
      if (reading.timestamp > v.lastTimestamp) {
        this.applyCurrent(v, reading, source, result.anomalies);
        result.accepted++;
      } else {
        v.trail.insert({ ...reading.location, timestamp: reading.timestamp, source: source === 'batch' ? 'batch' : 'late' });
        result.late++;
        if (source === 'live') {
          result.anomalies.push({
            truckId: v.truckId,
            kind: 'out_of_order',
            classification: 'transport',
            message: `Out-of-order GPS fix (${Math.round((v.lastTimestamp - reading.timestamp) / 1000)}s older than current) — merged into path, position not rolled back`,
            timestamp: reading.timestamp,
            phase: 'instant',
          });
        }
      }
      if (source === 'batch') batchCounts.set(v.truckId, (batchCounts.get(v.truckId) ?? 0) + 1);
      v.snapshot = null;
      result.updatedTruckIds.add(v.truckId);
    }

    for (const [truckId, count] of batchCounts) {
      result.anomalies.push({
        truckId,
        kind: 'gps_batch',
        classification: 'transport',
        message: `Signal recovered: ${count} buffered GPS fixes merged into path`,
        timestamp: sorted[sorted.length - 1].timestamp,
        phase: 'instant',
      });
    }
    return result;
  }

  /** Back-fill charts with server history (older than anything we have). */
  seedHistory(truckId: string, points: Array<Omit<HistoryPoint, 'source'> & { location: LatLng }>): void {
    const v = this.getOrCreate(truckId);
    const oldest = v.history.oldest()?.timestamp ?? Infinity;
    const { thresholds } = this.registry.resolve({ id: truckId });
    for (const p of points) {
      if (p.timestamp >= oldest) continue;
      const speed = p.speed !== null && p.speed >= 0 && p.speed <= thresholds.maxPlausibleSpeedKmh ? p.speed : null;
      v.history.insert({ timestamp: p.timestamp, speed, fuel: p.fuel, engineTemp: p.engineTemp, source: 'history' });
    }
    v.snapshot = null;
  }

  snapshot(truckId: string): VehicleTelemetry | undefined {
    const v = this.vehicles.get(truckId);
    if (!v) return undefined;
    if (!v.snapshot) {
      v.snapshot = {
        truckId: v.truckId,
        vehicleType: v.vehicleType,
        location: v.location,
        heading: v.heading,
        status: v.status,
        lastTimestamp: v.lastTimestamp,
        speed: v.sensors.speed.output,
        fuel: v.sensors.fuel.output,
        engineTemp: v.sensors.engineTemp.output,
        trail: v.trail.toArray(),
        history: v.history.toArray(),
      };
    }
    return v.snapshot;
  }

  reset(): void {
    this.vehicles.clear();
  }

  private applyCurrent(v: VehicleState, r: TelemetryReading, source: ReadingSource, anomalies: AnomalyInput[]) {
    v.lastTimestamp = r.timestamp;
    v.location = r.location;
    v.heading = r.heading;
    if (r.status) v.status = r.status;

    const ctx = { truckId: v.truckId, timestamp: r.timestamp };
    for (const key of SENSORS) {
      const slot = v.sensors[key];
      const res = slot.filter.process(slot.state, r[key], ctx);
      slot.state = res.state;
      slot.output = res.output;
      anomalies.push(...res.anomalies);
    }

    v.trail.insert({ ...r.location, timestamp: r.timestamp, source: source === 'batch' ? 'batch' : 'live' });
    v.history.insert({
      timestamp: r.timestamp,
      speed: v.sensors.speed.output.value,
      fuel: v.sensors.fuel.output.value,
      engineTemp: v.sensors.engineTemp.output.value,
      source: 'live',
    });
  }

  private getOrCreate(truckId: string): VehicleState {
    let v = this.vehicles.get(truckId);
    if (v) return v;
    const type = this.registry.resolve({ id: truckId });
    const filters = type.createFilters();
    const sensors = {} as Record<SensorKey, SensorSlot>;
    for (const key of SENSORS) {
      sensors[key] = { filter: filters[key], state: filters[key].initialState(), output: UNKNOWN };
    }
    v = {
      truckId,
      vehicleType: type.id,
      lastTimestamp: -Infinity,
      location: { lat: 0, lng: 0 },
      heading: 0,
      status: null,
      sensors,
      trail: new SortedWindow(this.options.trailSize),
      history: new SortedWindow(this.options.historySize),
      snapshot: null,
    };
    this.vehicles.set(truckId, v);
    return v;
  }
}
