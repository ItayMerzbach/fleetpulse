import type { z } from 'zod';
import type {
  FleetTruckSchema,
  RouteSchema,
  RouteStatusSchema,
  SseMessageSchema,
  TelemetryReadingSchema,
  TruckAlertSchema,
  TruckStatusSchema,
  WsServerMessageSchema,
  PrioritySchema,
} from './schemas';

export type TruckStatus = z.infer<typeof TruckStatusSchema>;
export type TelemetryReading = z.infer<typeof TelemetryReadingSchema>;
export type SseMessage = z.infer<typeof SseMessageSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type RouteStatus = z.infer<typeof RouteStatusSchema>;
export type Priority = z.infer<typeof PrioritySchema>;
export type FleetTruck = z.infer<typeof FleetTruckSchema>;
export type TruckAlert = z.infer<typeof TruckAlertSchema>;
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;

export interface LatLng {
  lat: number;
  lng: number;
}

/** Quality of a value shown to the dispatcher. */
export type SensorQuality = 'ok' | 'suspect' | 'fault' | 'unknown';

export interface SensorValue {
  /** Value to DISPLAY (filtered). null = no trustworthy value yet. */
  value: number | null;
  /** Last raw value received from the sensor (for debugging / tooltips). */
  raw: number | null;
  quality: SensorQuality;
  /** Human readable reason when quality !== 'ok'. */
  note?: string;
}

export type AnomalyKind =
  | 'speed_implausible'
  | 'fuel_glitch'
  | 'fuel_drop_confirmed'
  | 'gps_batch'
  | 'out_of_order';

export interface AnomalyEvent {
  id: string;
  truckId: string | null;
  kind: AnomalyKind;
  /** sensor_bug = known hardware/transport quirk; real = the dispatcher should act */
  classification: 'sensor_bug' | 'transport' | 'real';
  message: string;
  timestamp: number;
  /** For anomalies with a duration (glitch start → end). */
  durationMs?: number;
  phase?: 'start' | 'end' | 'instant';
}

export interface HistoryPoint {
  timestamp: number;
  speed: number | null;
  fuel: number | null;
  engineTemp: number | null;
  source: 'live' | 'late' | 'history';
}

export interface TrailPoint extends LatLng {
  timestamp: number;
  source: 'live' | 'late' | 'batch' | 'history';
}

/** Processed telemetry for one vehicle — what the UI renders. */
export interface VehicleTelemetry {
  truckId: string;
  vehicleType: string;
  location: LatLng;
  heading: number;
  status: TruckStatus | null;
  lastTimestamp: number;
  speed: SensorValue;
  fuel: SensorValue;
  engineTemp: SensorValue;
  trail: TrailPoint[];
  history: HistoryPoint[];
  /** Most recent GPS batch merged for this vehicle (receive time, client clock). */
  lastBatch: { count: number; receivedAt: number } | null;
}

export interface DispatcherIdentity {
  id: string;
  name: string;
}
