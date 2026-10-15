import { z } from 'zod';

/**
 * Runtime contracts for everything that crosses the network boundary.
 * The server is treated as untrusted: every SSE / WS / REST payload is parsed
 * here before it reaches the domain. Invalid payloads are counted and dropped
 * instead of crashing the UI.
 *
 * Note: schemas validate SHAPE, not plausibility. 999 km/h is a valid number;
 * deciding it is a sensor fault is the job of the telemetry filters.
 */

export const TruckStatusSchema = z.enum(['active', 'idle', 'maintenance']);
export const LocationSchema = z.object({ lat: z.number().finite(), lng: z.number().finite() });

export const TelemetryReadingSchema = z.object({
  truckId: z.string().min(1),
  location: LocationSchema,
  speed: z.number(),
  heading: z.number().optional().default(0),
  fuel: z.number(),
  engineTemp: z.number(),
  status: TruckStatusSchema.optional(),
  timestamp: z.number().finite(),
  _batch: z.boolean().optional(),
  _reordered: z.boolean().optional(),
});

// Envelope schemas keep `readings` as unknown[] so each reading is validated
// individually — one malformed reading must not discard the other eleven.
export const SseMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('connected'), truckCount: z.number(), timestamp: z.number() }),
  z.object({ type: z.literal('heartbeat'), timestamp: z.number() }),
  z.object({ type: z.literal('telemetry'), readings: z.array(z.unknown()), timestamp: z.number() }),
  z.object({ type: z.literal('gps_batch'), truckId: z.string(), readings: z.array(z.unknown()) }),
]);

export const RouteStatusSchema = z.enum(['assigned', 'in-progress', 'completed', 'cancelled']);
export const PrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);

export const RouteSchema = z.object({
  id: z.string(),
  truckId: z.string(),
  destination: z.string(),
  priority: z.string(),
  notes: z.string().optional().default(''),
  status: RouteStatusSchema,
  assignedBy: z.string(),
  assignedAt: z.number(),
  lastModifiedBy: z.string().optional(),
  lastModifiedAt: z.number().optional(),
  reassignedBy: z.string().optional(),
  reassignedAt: z.number().optional(),
  _version: z.number().int(),
});

export const FleetTruckSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: TruckStatusSchema,
  location: LocationSchema,
  speed: z.number(),
  heading: z.number(),
  fuel: z.number(),
  engineTemp: z.number(),
  currentRouteId: z.string().nullable(),
  _version: z.number().int(),
  mileage: z.number().optional(),
});

export const FleetResponseSchema = z.object({ fleet: z.array(FleetTruckSchema), timestamp: z.number() });
export const RoutesResponseSchema = z.object({ routes: z.array(RouteSchema), timestamp: z.number() });
export const TruckDetailSchema = FleetTruckSchema.extend({ mileage: z.number(), lastUpdate: z.number() });
export const HistoryResponseSchema = z.object({
  history: z.array(
    z.object({
      truckId: z.string(),
      location: LocationSchema,
      speed: z.number(),
      fuel: z.number(),
      engineTemp: z.number(),
      timestamp: z.number(),
    }),
  ),
  count: z.number(),
});

export const TruckAlertSchema = z.object({
  id: z.string(),
  truckId: z.string(),
  message: z.string(),
  severity: z.string(),
  sentBy: z.string().optional().nullable(),
  timestamp: z.number(),
  acknowledged: z.boolean(),
});

export const WsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('registered'), dispatcherId: z.string() }),
  z.object({
    type: z.literal('dispatcher_joined'),
    dispatcherId: z.string(),
    name: z.string(),
    timestamp: z.number(),
    activeDispatchers: z.number(),
  }),
  z.object({
    type: z.literal('dispatcher_left'),
    dispatcherId: z.string(),
    timestamp: z.number(),
    activeDispatchers: z.number(),
  }),
  z.object({
    type: z.literal('dispatcher_viewing'),
    // null when the sender never registered (server forwards its local variable)
    dispatcherId: z.string().nullable(),
    truckId: z.string().nullable().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('route_assigned'),
    route: RouteSchema,
    truckId: z.string(),
    assignedBy: z.string(),
    truckVersion: z.number(),
    timestamp: z.number(),
  }),
  z.object({ type: z.literal('route_updated'), route: RouteSchema, updatedBy: z.string(), timestamp: z.number() }),
  z.object({
    type: z.literal('route_reassigned'),
    route: RouteSchema,
    oldTruckId: z.string().optional(),
    newTruckId: z.string(),
    reassignedBy: z.string(),
    timestamp: z.number(),
  }),
  z.object({ type: z.literal('truck_alert'), alert: TruckAlertSchema }),
  z.object({ type: z.literal('fleet_reset'), timestamp: z.number() }),
  z.object({ type: z.literal('pong'), timestamp: z.number() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

// ---------- Outgoing (user input) ----------

export const DESTINATION_MAX = 120;
export const NOTES_MAX = 500;
export const ALERT_MAX = 200;

// Printable text only: rejects control characters that could corrupt logs / headers.
const safeText = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), `${label} contains invalid characters`);

export const CreateRouteInputSchema = z.object({
  truckId: z.string().regex(/^truck_\d+$/, 'Invalid truck'),
  destination: safeText(3, DESTINATION_MAX, 'Destination'),
  priority: PrioritySchema,
  notes: z.union([safeText(0, NOTES_MAX, 'Notes'), z.literal('')]).optional().default(''),
});

export const AlertInputSchema = z.object({
  message: safeText(1, ALERT_MAX, 'Message'),
  severity: z.enum(['info', 'warning', 'critical']),
});

export const DispatcherNameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(30, 'Name must be at most 30 characters')
  .regex(/^[\p{L}\p{N} .'-]+$/u, 'Use letters, numbers, spaces, . \' -');
