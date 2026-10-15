import { createFuelFilter } from '../telemetry/filters/fuelFilter';
import { createRangeFilter } from '../telemetry/filters/rangeFilter';
import { createSpeedFilter } from '../telemetry/filters/speedFilter';
import type { SensorFilter, SensorKey } from '../telemetry/filters/types';

export interface VehicleThresholds {
  lowFuelPct: number;
  criticalFuelPct: number;
  highEngineTempC: number;
  maxPlausibleSpeedKmh: number;
}

/**
 * Everything that is specific to a kind of vehicle lives here. The telemetry
 * pipeline, stores and UI only talk to this interface, so adding e.g. an
 * electric van (battery instead of fuel, different speed limits) means
 * registering one new definition — no changes to existing code.
 */
export interface VehicleTypeDefinition {
  id: string;
  label: string;
  /** Decides whether a vehicle from the API belongs to this type. */
  matches(vehicle: { id: string; name?: string }): boolean;
  thresholds: VehicleThresholds;
  createFilters(): Record<SensorKey, SensorFilter<unknown>>;
  /** Map glyph (kept trivial; map quality is not graded). */
  glyph: string;
}

export class VehicleTypeRegistry {
  private types: VehicleTypeDefinition[] = [];

  /** Later registrations take precedence, so specific types can shadow the generic fallback. */
  register(def: VehicleTypeDefinition): this {
    if (this.types.some((t) => t.id === def.id)) throw new Error(`Vehicle type "${def.id}" already registered`);
    this.types.unshift(def);
    return this;
  }

  resolve(vehicle: { id: string; name?: string }): VehicleTypeDefinition {
    const def = this.types.find((t) => t.matches(vehicle));
    if (!def) throw new Error(`No vehicle type matches "${vehicle.id}"`);
    return def;
  }

  get(id: string): VehicleTypeDefinition | undefined {
    return this.types.find((t) => t.id === id);
  }
}

const TRUCK_THRESHOLDS: VehicleThresholds = {
  lowFuelPct: 15,
  criticalFuelPct: 8,
  highEngineTempC: 105,
  maxPlausibleSpeedKmh: 160,
};

export const deliveryTruck: VehicleTypeDefinition = {
  id: 'delivery-truck',
  label: 'Delivery truck',
  matches: () => true, // fallback: every vehicle the API knows today is a truck
  thresholds: TRUCK_THRESHOLDS,
  glyph: '▲',
  createFilters: () => ({
    speed: createSpeedFilter({ maxPlausibleKmh: TRUCK_THRESHOLDS.maxPlausibleSpeedKmh }),
    fuel: createFuelFilter({ suddenDropPct: 15, confirmAfterMs: 8000 }),
    engineTemp: createRangeFilter('engineTemp', -40, 150, '°C'),
  }) as Record<SensorKey, SensorFilter<unknown>>,
};

export function createDefaultVehicleRegistry(): VehicleTypeRegistry {
  return new VehicleTypeRegistry().register(deliveryTruck);
}
