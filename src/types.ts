export type TruckStatus = 'active' | 'idle' | 'maintenance';
export type RouteStatus = 'assigned' | 'in-progress' | 'completed' | 'cancelled';

export interface LatLng {
  lat: number;
  lng: number;
}

/** One telemetry reading as sent by the server over SSE. */
export interface Reading {
  truckId: string;
  location: LatLng;
  speed: number;
  heading: number;
  fuel: number;
  engineTemp: number;
  status: TruckStatus;
  timestamp: number;
}

export interface PathPoint extends LatLng {
  timestamp: number;
}

export interface HistoryPoint {
  timestamp: number;
  /** null = the reading was rejected / suspect, shown as a gap in the chart */
  speed: number | null;
  fuel: number | null;
  engineTemp: number;
}

/** What we display for a truck, after filtering sensor glitches. */
export interface Truck {
  id: string;
  status: TruckStatus;
  location: LatLng;
  /** Event time of the newest reading applied. Older readings never override it. */
  lastTimestamp: number;
  speed: number | null;
  speedFault: boolean;
  fuel: number | null;
  fuelSuspect: boolean;
  fuelSuspectSince: number | null;
  engineTemp: number;
  path: PathPoint[];
  history: HistoryPoint[];
}

export interface Route {
  id: string;
  truckId: string;
  destination: string;
  priority: string;
  notes: string;
  status: RouteStatus;
  assignedBy: string;
  assignedAt: number;
  lastModifiedBy?: string;
  lastModifiedAt?: number;
  reassignedBy?: string;
  reassignedAt?: number;
  _version: number;
}

export interface Dispatcher {
  id: string;
  name: string;
  viewingTruckId: string | null;
}

export interface LogEntry {
  id: number;
  timestamp: number;
  text: string;
}
