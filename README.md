# 🚛 FleetPulse — Real-Time Fleet Dispatch Dashboard

A real-time dashboard for 12 delivery trucks, built so dispatchers can **trust** what they see: it filters out sensor bugs, holds up under an unreliable API, and stops dispatchers from silently overwriting each other's changes.

React 19 · TypeScript · Vite · Vitest · zod · Google Maps (`@vis.gl/react-google-maps`). No state-management or chart libraries.

---

## Setup

```bash
npm install
npm start        # mock server on :3000 + dashboard on :5173 (opens the browser)
npm test         # 57 unit + integration tests
```

- Requires Node 20+.
- **Google Maps:** copy `.env.example` to `.env.local` (git-ignored) and set `VITE_GOOGLE_MAPS_API_KEY` (a key with the *Maps JavaScript API* enabled). `VITE_GOOGLE_MAPS_MAP_ID` is optional; Google's `DEMO_MAP_ID` is used by default, and Advanced Markers need one. **Without a key, or if Google rejects it**, the map falls back to an offline SVG grid with a note in the legend, so `npm start` always works.
- If port 5173 is busy, Vite picks the next free port; check the console for the URL.
- **To test with several dispatchers**, open a second tab and sign in under a different name. Identity is stored in `sessionStorage`, so each tab is its own dispatcher.
- To reset the server: `curl -X POST localhost:3000/api/reset`
- Other scripts: `npm run server` (mock server only), `npm run dev` (UI only), `npm run typecheck`, `npm run build`.

> **About `server.js`:** its *behaviour* is unchanged. It was copied out of the assignment PDF, and the PDF's text layer had mangled the operators (`===` → `=//`, `&&` → `&/`, `...` → `.//`, `?.` → `?/`, plus words split across line breaks). Each corruption follows one consistent pattern, so restoring them is unambiguous. No logic, timing or quirk was changed.

---

## Architecture

```
                 ┌──────────────── transport (no React, no stores) ───────────────┐
 /api/telemetry  │ SseConnection   ─ backoff reconnect, freshness watchdog, zod   │
 /ws             │ WsConnection    ─ register, ping/pong RTT, zombie detect, zod  │
 REST            │ ApiClient       ─ X-Dispatcher-Id, If-Match, typed errors, zod │
                 │ withRetry(Retry-After) ∘ CircuitBreaker                        │
                 └──────────┬───────────────────────────┬─────────────────────────┘
                            │ EventBus 'sse'            │ EventBus 'ws'
                            ▼                           ▼
     ┌──────────── services / domain (framework-agnostic, unit tested) ───────────┐
     │ TelemetryService → TelemetryProcessor ─ per-vehicle ordering, SortedWindow  │
     │                     └ SensorFilter plugins (speed, fuel, range) per type    │
     │ FleetService      ─ poll + retry + breaker + cache → degraded mode          │
     │ RouteService      ─ optimistic locking, conflict model, per-route mutex     │
     │ PresenceService   ─ presenceReducer (ghosts, TTL, resurrection), heartbeat  │
     └──────────┬──────────────────────────────────────────────────────────────────┘
                ▼
     Stores (createStore + useSyncExternalStore; telemetry store is frame-batched)
     fleet · routes · presence · audit · alerts · anomalies · connection · metrics · ui
                ▼
     React UI ─ Header · FleetList · FleetMap · DetailPanel(widget registry) · BottomPanel
                each region and widget sits in its own ErrorBoundary
```

`src/app/createFleetPulse.ts` is the **composition root**, the only file that wires these pieces together. Transports never import stores, and the UI never imports transports.

### How a telemetry message flows

1. `SseConnection` parses the JSON and validates the envelope with zod. Bad payloads are counted and dropped.
2. `TelemetryService` validates **each reading separately**, so one malformed reading doesn't throw away the other eleven.
3. `TelemetryProcessor.ingest()` sorts readings by **event timestamp**, then for each vehicle:
   - **newer than current** → run through that vehicle type's sensor filters → becomes the current state and a chart point.
   - **older than current** (out-of-order, or a GPS batch backlog) → merged into the path at its correct position, but never moves the truck backwards or overrides newer sensor values.
4. **One store commit per SSE message**, no matter how many readings it carried. The store also coalesces notifications to at most **one render per animation frame**.
5. Anomalies go to the anomaly store. Health alerts (low fuel, hot engine) are computed **from the filtered value only**, with hysteresis so a value hovering at the threshold doesn't fire repeatedly.

### Extensibility
- **New vehicle type** (EV van, reefer truck): register a `VehicleTypeDefinition` in `src/vehicles/vehicleTypes.ts`, with its own thresholds, its own `SensorFilter`s and a `matches()` predicate. The pipeline, stores and UI don't change.
- **Map provider:** `useMapModel()` provides rows, selection, presence viewers, path and staleness. `GoogleFleetMap` and `GridMap` only render that model, so swapping provider (e.g. Mapbox) doesn't touch any data code.
- **New detail widget:** one component plus one `register()` call in `src/ui/widgets/index.ts`. A widget can limit itself to certain vehicle types with `appliesTo`.
- **New sensor rule:** implement `SensorFilter<S>`, a pure `(state, raw, ctx) → {state, output, anomalies}` reducer.

---

## The 8 quirks and how they're handled

| # | Quirk | Handling | Where |
|---|---|---|---|
| 1 | GPS batch of 10–30 old readings | Sorted by event time and merged into a bounded, sorted **path** (hollow dots on the map). One commit and one anomaly per batch. The truck's current position only moves if a batch reading is newer than it. | `TelemetryProcessor` |
| 2 | Fuel reads 0% for 2–4 s while braking | A sudden drop (≥15 points, or an exact 0) is held as **suspect** while the last good value stays on screen. If it recovers, it's logged as a *sensor bug*. If it persists ≥8 s, it's accepted as **real** and flagged for action. Low-fuel alerts use only the filtered value. | `fuelFilter.ts` |
| 3 | truck_7 reports 999 km/h | Implausible values (>160, negative, NaN) are rejected. The dispatcher sees the **last valid speed with a "sensor fault" badge**, never 999, and the chart shows a gap. Fault start/end are logged with duration. | `speedFilter.ts` |
| 4 | 409 on version mismatch | Every PATCH sends `If-Match` with the version **the dispatcher was looking at**. A 409 opens a side-by-side conflict dialog that names who made the other change. | `RouteService`, `ConflictDialog` |
| 5 | Out-of-order SSE readings | A per-vehicle timestamp watermark: older readings never override newer ones. | `TelemetryProcessor` |
| 6 | Ghost presence (leave arrives 10 s late) | Unknown or own-id leaves are no-ops; any later activity brings a dispatcher back; TTL expiry; a 15 s presence heartbeat. | `presence.ts`, `PresenceService` |
| 7 | `GET /api/fleet` returns 503 15% of the time, with Retry-After | Retries wait exactly the server's **Retry-After** (otherwise jittered exponential backoff). A **circuit breaker** opens after 3 consecutive 503s → degraded mode shows cached data with a "stale" banner and data age, and sends one half-open probe after the cooldown. | `retry.ts`, `CircuitBreaker.ts`, `FleetService` |
| 8 | PATCH racing a reassign | Same conflict flow. Because the second 409 body has no `lastModifiedBy`, we re-fetch the route and pick the most recent actor across assign/update/reassign timestamps, so the right person is blamed. | `RouteService.buildVersionConflict`, `lastActor()` |

---

## Multi-dispatcher conflicts

**Principles:** never auto-retry a 409, never overwrite silently, and always show *who*.

- **Version captured at intent time.** The route object passed to a mutation is the one on screen when the dispatcher clicked. If someone changes it while the confirm dialog is open, the request 409s; it is not quietly rebased onto the newer version.
- **Conflict dialog** (bonus "undo/conflict resolution"), with three columns:
  1. *What you saw (vN)*
  2. *Now (vM, by Omer)*, with Omer's changes highlighted
  3. *If you apply your change*: their version plus only your field

  "Apply my change on top" re-checks that the transition is still valid (for example, you can't start a route that Omer already cancelled), then re-sends using **their** version. "Keep current version" discards your change.
- **Create on an already-assigned truck** → "already has route_7, assigned by Omer".
- **Double-click guard:** a per-route mutex blocks a second mutation while one is in flight. Otherwise the second request would always 409 against our own first write.
- **Reassign has no `If-Match` on the server.** We emulate it by re-reading the route and aborting if its version moved. This narrows the race to one round-trip but cannot close it (see limitations).
- **Awareness before conflicts happen:** every dispatcher's avatar sits on the truck they're viewing (map and list). The route card shows "Omer updated this route 3s ago". The activity log attributes every change.
- **What the *other* dispatcher sees:** their change landed normally. If the loser then applies their change on top, it arrives as a normal attributed `route_updated` in the winner's log and route card banner.

**Identity:** dispatcher ids are generated client-side as `<name-slug>-<4hex>`. This makes them stable across WS reconnects, available before the first REST call, and readable as a name even for dispatchers who joined before us (the server only sends names in `dispatcher_joined`, which latecomers never receive).

---

## Security and quality

- `X-Dispatcher-Id` on every request; `If-Match` on every PATCH.
- **zod validation at every network boundary** (SSE, WS, REST responses) and on all user input: destination 3–120 characters, notes ≤500, alert ≤200, priority/severity enums, control characters rejected, name validated. React escapes all rendered text, and there is no `dangerouslySetInnerHTML`.
- Confirmation for destructive actions: cancel, complete, reassign and critical alerts. Invalid status transitions are blocked client-side, since the server accepts any status.
- Error boundaries around every panel and every widget. The event bus isolates subscribers, so a throwing handler is counted, not fatal.
- Identity lives in `sessionStorage`. There is **no real authentication** — the server has none. The id is self-asserted and only used for attribution.

---

## Performance and resilience (running for hours)

- **Memory stays flat:** path is capped at 60 fixes, charts at 150 points, audit log at 500, anomalies at 300 and alerts at 200, all in fixed-size windows.
- **Render cost:** one store commit per SSE message, frame-coalesced notifications, memoised rows and markers, and selectors that return stable references. The Observability tab shows store commits per second next to SSE events per second.
- **SSE:** we run our own reconnect with jittered backoff, plus a watchdog that reconnects if no data arrives for 20 s (heartbeat is 15 s). After any reconnect, we re-sync the REST snapshot.
- **WS:** application-level ping every 10 s gives RTT (shown in Observability) and detects zombie sockets after two missed pongs. After re-registering, we re-fetch routes and re-announce presence.
- A truck with no telemetry for 10 s fades on the map ("no recent data").
- **Observability panel** (bonus, tab 5): SSE events/s, accepted/late/batched readings, invalid messages, reconnects, WS RTT, 503s, retries, 409s, handler errors, breaker state, heap size and uptime.

---

## Bonus features implemented

- Circuit breaker with degraded mode
- Anomaly dashboard (real vs. sensor bug vs. transport)
- Observability panel
- Side-by-side conflict resolution
- Keyboard shortcuts (`?` lists them): `j/k`, `n`, `/`, `a`, `1–5`, `Esc`
- Filterable fleet view: status, low fuel, route assignment, text search

**Not implemented:** geofencing.

---

## Tests (`npm test`, 57 cases)

| File | Covers |
|---|---|
| `unit/telemetryProcessor.test.ts` | GPS batch merge (no backwards jump, one commit), batch newer than current, out-of-order handling, duplicate timestamps, per-truck independence, windowing, snapshot identity |
| `unit/sensorFilters.test.ts` | 999 km/h rejection and fault duration, no invented value, constant-80 regression; fuel glitch vs. **confirmed real 0%**, 6%→0%, no-baseline 0, refuel |
| `unit/resilience.test.ts` | Retry-After respected, backoff/jitter, give-up, no retry on 4xx; breaker open / fail-fast / single half-open probe / re-open / ignores 404 |
| `unit/routeService.test.ts` | If-Match and headers, 409 → both versions and *who*, quirk #8 blame, invalid transition never sent, double-click mutex, create 409, reassign pre-check, "apply mine" uses their version, version merge |
| `unit/presence.test.ts` | Ghost leave no-op, own ghost ignored, resurrection after ghost, TTL expiry, no duplicates, viewers per truck, id/name round-trip |
| `unit/core.test.ts` | SortedWindow ordering and eviction; EventBus subscriber isolation |
| `integration/app.test.ts` | Full composition root with fake SSE/WS/fetch: registration, 999 km/h end-to-end, **glitch never fires low-fuel but real decline fires exactly once**, malformed data, audit attribution and stale route events, ghost leave; FleetService **degraded mode** with cache, then recovery |
| `integration/conflictDialog.test.tsx` | Dialog names the other dispatcher, keeps their notes in the merged result, disables "apply mine" with a reason when the route is cancelled |

---

## Known issues and limitations

- **Reassign is not atomic.** The server's reassign endpoint ignores `If-Match`, so our pre-check leaves a one-round-trip race window. A real fix needs the server to support `If-Match` on PUT.
- **The audit log only covers events since this tab connected.** The server has no history endpoint, so the log lives in memory. Route records themselves still carry `assignedBy` / `lastModifiedBy` / `reassignedBy`.
- **Presence before we joined:** existing dispatchers become visible at their next heartbeat (≤15 s) or when they change truck. Their names come from the id slug, so the server's own anonymous ids show as raw ids.
- **A real ghost (closed tab) still shows for up to 10 s.** That's the server's delay; with no client heartbeat from them we can't tell sooner. Their avatar fades after 20 s of inactivity.
- Alert acknowledgement is local-only (the server has no ack endpoint).
- Staleness compares server timestamps with the client clock. That's fine locally; in production it would need clock-skew correction.
- The breaker only protects `GET /api/fleet`. Route mutations deliberately aren't retried (not idempotent).
- Truck_7 is in *maintenance*, yet the server still sends 999 km/h for it. We filter it the same way.
- "Duplicate tab" copies `sessionStorage`, so the duplicate shares the dispatcher id.

## What I'd improve with more time

1. Server: `If-Match` on reassign, a presence snapshot on connect, an audit/history endpoint, ack for alerts, and typed `event:` names on SSE.
2. Geofencing (zones as another `SensorFilter`-style rule over location).
3. Marker clustering and a WebGL/deck.gl overlay for hundreds of vehicles; snapping GPS paths to roads (Roads API).
4. Playwright e2e running two browser contexts against the real mock server for the conflict flow.
5. Send metrics to a backend (OpenTelemetry) and alert on breaker-open rate, 409 rate, SSE reconnects and stale-truck count. Those are what I'd watch in production.
6. Cross-sensor checks: speed vs. GPS displacement to detect frozen speedometers properly.
