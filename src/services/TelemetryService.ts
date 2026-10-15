import type { Store } from '../core/store';
import { TelemetryReadingSchema } from '../domain/schemas';
import type { AnomalyEvent, FleetTruck, SseMessage, TelemetryReading, VehicleTelemetry } from '../domain/types';
import type { AnomalyInput } from '../telemetry/filters/types';
import { TelemetryProcessor } from '../telemetry/TelemetryProcessor';
import type { VehicleTypeRegistry } from '../vehicles/vehicleTypes';
import { ANOMALY_CAP, capPrepend, type AnomalyState, type FleetState } from '../stores/stores';
import type { Metrics } from './Metrics';

export interface HealthAlert {
  truckId: string;
  key: string;
  message: string;
  severity: 'warning' | 'critical';
}

/**
 * SSE message -> validated readings -> TelemetryProcessor -> one store commit.
 * Also derives vehicle-health alerts from FILTERED values (never raw), with
 * hysteresis so a value hovering around a threshold doesn't spam alerts.
 */
export class TelemetryService {
  readonly processor: TelemetryProcessor;
  private activeHealth = new Set<string>();
  private anomalySeq = 0;

  constructor(
    private readonly registry: VehicleTypeRegistry,
    private readonly fleet: Store<FleetState>,
    private readonly anomalies: Store<AnomalyState>,
    private readonly metrics: Metrics,
    private readonly onHealthAlert: (a: HealthAlert) => void = () => {},
  ) {
    this.processor = new TelemetryProcessor(registry);
  }

  handle(msg: SseMessage): void {
    this.metrics.inc('sseMessages');
    if (msg.type === 'telemetry') this.ingest(msg.readings, 'live');
    else if (msg.type === 'gps_batch') {
      this.metrics.inc('gpsBatches');
      this.ingest(msg.readings, 'batch');
    }
  }

  /** Initial REST snapshot -> seed positions before the first SSE tick (only for unseen vehicles). */
  seedFromSnapshot(fleet: FleetTruck[], timestamp: number): void {
    const known = this.fleet.getState().telemetry;
    const readings: TelemetryReading[] = fleet
      .filter((t) => !known[t.id])
      .map((t) => ({ truckId: t.id, location: t.location, speed: t.speed, heading: t.heading, fuel: t.fuel, engineTemp: t.engineTemp, status: t.status, timestamp }));
    if (readings.length) this.ingest(readings, 'live', false);
  }

  async seedHistory(truckId: string, load: () => Promise<{ history: Array<{ timestamp: number; speed: number; fuel: number; engineTemp: number; location: { lat: number; lng: number } }> }>) {
    const current = this.fleet.getState().telemetry[truckId];
    if (current && current.history.length >= 30) return;
    const { history } = await load();
    this.processor.seedHistory(truckId, history);
    this.commit(new Set([truckId]));
  }

  reset(): void {
    this.processor.reset();
    this.activeHealth.clear();
    this.fleet.setState((s) => ({ ...s, telemetry: {} }));
  }

  private ingest(raw: unknown[], source: 'live' | 'batch', validate = true) {
    const readings: TelemetryReading[] = [];
    for (const r of raw) {
      if (!validate) {
        readings.push(r as TelemetryReading);
        continue;
      }
      const parsed = TelemetryReadingSchema.safeParse(r);
      if (parsed.success) readings.push(parsed.data);
      else this.metrics.inc('invalidMessages');
    }
    const result = this.processor.ingest(readings, source);
    this.metrics.inc('readingsAccepted', result.accepted);
    this.metrics.inc('readingsLate', result.late);
    this.commit(result.updatedTruckIds);
    this.recordAnomalies(result.anomalies);
  }

  private commit(truckIds: Set<string>) {
    if (truckIds.size === 0) return;
    const snapshots: Record<string, VehicleTelemetry> = {};
    for (const id of truckIds) {
      const snap = this.processor.snapshot(id);
      if (snap) {
        snapshots[id] = snap;
        this.checkHealth(snap);
      }
    }
    this.fleet.setState((s) => ({ ...s, telemetry: { ...s.telemetry, ...snapshots } }));
    this.metrics.storeCommit();
  }

  private recordAnomalies(inputs: AnomalyInput[]) {
    if (inputs.length === 0) return;
    this.anomalies.setState((s) => {
      let events = s.events;
      const counts = { ...s.counts };
      for (const a of inputs) {
        const ev: AnomalyEvent = { ...a, id: `an_${++this.anomalySeq}` };
        events = capPrepend(events, ev, ANOMALY_CAP);
        if (a.phase !== 'end') counts[a.kind] = (counts[a.kind] ?? 0) + 1;
      }
      return { events, counts };
    });
  }

  private checkHealth(t: VehicleTelemetry) {
    const { thresholds } = this.registry.resolve({ id: t.truckId });
    const check = (key: string, isBad: boolean, isRecovered: boolean, alert: () => HealthAlert) => {
      const id = `${t.truckId}:${key}`;
      if (isBad && !this.activeHealth.has(id)) {
        this.activeHealth.add(id);
        this.onHealthAlert(alert());
      } else if (isRecovered) this.activeHealth.delete(id);
    };

    const fuel = t.fuel.quality === 'ok' ? t.fuel.value : null;
    if (fuel !== null) {
      check('fuel-critical', fuel < thresholds.criticalFuelPct, fuel > thresholds.criticalFuelPct + 3, () => ({
        truckId: t.truckId, key: 'fuel-critical', severity: 'critical', message: `Fuel critically low: ${fuel.toFixed(0)}%`,
      }));
      check('fuel-low', fuel < thresholds.lowFuelPct, fuel > thresholds.lowFuelPct + 3, () => ({
        truckId: t.truckId, key: 'fuel-low', severity: 'warning', message: `Fuel low: ${fuel.toFixed(0)}%`,
      }));
    }
    const temp = t.engineTemp.quality === 'ok' ? t.engineTemp.value : null;
    if (temp !== null) {
      check('temp-high', temp > thresholds.highEngineTempC, temp < thresholds.highEngineTempC - 5, () => ({
        truckId: t.truckId, key: 'temp-high', severity: 'warning', message: `Engine temperature high: ${temp.toFixed(0)}°C`,
      }));
    }
  }
}
