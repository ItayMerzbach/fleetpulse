import type { PathPoint, Reading, Truck } from './types';

export const MAX_PLAUSIBLE_SPEED = 160; // km/h — anything above is a sensor fault (truck_7 sends 999)
export const FUEL_SUDDEN_DROP = 15; // percentage points between two readings
export const FUEL_CONFIRM_MS = 8000; // the braking glitch lasts 2–4 s; a drop lasting 8 s is real
export const LOW_FUEL = 15; // %
const PATH_SIZE = 60; // ~2 minutes of positions per truck
const HISTORY_SIZE = 60; // chart points per truck

/**
 * Speed sensor: reject impossible values and keep showing the last valid speed,
 * flagged as a fault. The dispatcher never sees 999 km/h.
 */
export function filterSpeed(raw: number, lastValid: number | null) {
  if (!Number.isFinite(raw) || raw < 0 || raw > MAX_PLAUSIBLE_SPEED) {
    return { speed: lastValid, speedFault: true };
  }
  return { speed: raw, speedFault: false };
}

/**
 * Fuel sensor: fuel cannot disappear in 2 seconds, so a sudden drop (or an exact
 * 0, the glitch's signature) is "suspect" and the last trusted value is kept.
 * If the drop is still there after FUEL_CONFIRM_MS it is accepted as real.
 */
export function filterFuel(raw: number, prev: Pick<Truck, 'fuel' | 'fuelSuspectSince'>, timestamp: number) {
  const last = prev.fuel;
  const suddenDrop = last === null ? raw === 0 : last - raw >= FUEL_SUDDEN_DROP || (raw === 0 && last > 0);

  if (!suddenDrop) return { fuel: raw, fuelSuspect: false, fuelSuspectSince: null };

  const since = prev.fuelSuspectSince ?? timestamp;
  if (timestamp - since >= FUEL_CONFIRM_MS) return { fuel: raw, fuelSuspect: false, fuelSuspectSince: null };
  return { fuel: last, fuelSuspect: true, fuelSuspectSince: since };
}

/** Low-fuel warnings only use trusted values, so a glitch can never trigger one. */
export function isLowFuel(truck: Truck): boolean {
  return !truck.fuelSuspect && truck.fuel !== null && truck.fuel < LOW_FUEL;
}

/** Insert into a list kept sorted by timestamp; drop duplicates; keep only the newest `max`. */
export function insertByTime<T extends { timestamp: number }>(list: T[], item: T, max: number): T[] {
  if (list.some((x) => x.timestamp === item.timestamp)) return list;
  const next = [...list, item].sort((a, b) => a.timestamp - b.timestamp);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Basic shape check for data coming from the server; malformed readings are skipped. */
export function isValidReading(r: unknown): r is Reading {
  const x = r as Reading;
  return (
    typeof x?.truckId === 'string' &&
    Number.isFinite(x.timestamp) &&
    Number.isFinite(x.location?.lat) &&
    Number.isFinite(x.location?.lng) &&
    typeof x.speed === 'number' &&
    typeof x.fuel === 'number'
  );
}

function emptyTruck(r: Reading): Truck {
  return {
    id: r.truckId,
    status: r.status,
    location: r.location,
    lastTimestamp: -Infinity,
    speed: null,
    speedFault: false,
    fuel: null,
    fuelSuspect: false,
    fuelSuspectSince: null,
    engineTemp: r.engineTemp,
    path: [],
    history: [],
  };
}

/**
 * Apply a list of readings (a normal telemetry tick OR a GPS batch) to the trucks.
 *
 * Event time wins over arrival order:
 *  - a reading newer than the truck's last one updates position and sensors;
 *  - an older one (out-of-order, or a batch of buffered readings) is only
 *    added to the truck's path at its correct place — the truck never jumps back.
 * So a batch of 30 readings becomes one path, not 30 markers.
 */
export function applyReadings(trucks: Record<string, Truck>, readings: Reading[]): Record<string, Truck> {
  const next = { ...trucks };
  const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);

  for (const r of sorted) {
    const truck = next[r.truckId] ?? emptyTruck(r);
    const point: PathPoint = { ...r.location, timestamp: r.timestamp };

    if (r.timestamp <= truck.lastTimestamp) {
      next[r.truckId] = { ...truck, path: insertByTime(truck.path, point, PATH_SIZE) };
      continue;
    }

    const speed = filterSpeed(r.speed, truck.speed);
    const fuel = filterFuel(r.fuel, truck, r.timestamp);
    next[r.truckId] = {
      ...truck,
      ...speed,
      ...fuel,
      status: r.status,
      location: r.location,
      lastTimestamp: r.timestamp,
      engineTemp: r.engineTemp,
      path: insertByTime(truck.path, point, PATH_SIZE),
      history: insertByTime(
        truck.history,
        {
          timestamp: r.timestamp,
          speed: speed.speedFault ? null : speed.speed,
          fuel: fuel.fuelSuspect ? null : fuel.fuel,
          engineTemp: r.engineTemp,
        },
        HISTORY_SIZE,
      ),
    };
  }
  return next;
}
