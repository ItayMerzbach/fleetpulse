# FleetPulse — Real-Time Fleet Dashboard

A deliberately minimal dashboard for 12 trucks: live map, route assignment with conflict handling, dispatcher presence, and a truck detail panel. It handles all 8 server quirks. React + TypeScript + Vite, with React-Leaflet (OpenStreetMap) for the map.

## Setup

```bash
npm install
npm start   # mock server on :3000 + dashboard (Vite prints the URL, normally :5173)
npm test    # 22 unit tests
```

To act as several dispatchers, open a second tab and sign in with another name. Each tab is a separate dispatcher (identity lives in `sessionStorage`). To reset the server: `curl -X POST localhost:3000/api/reset`.

> `server.js` is unchanged in behaviour. The PDF's text layer had mangled the operators (`===` → `=//`, `&&` → `&/`, `...` → `.//`, …), so they were restored. That was the only change.

## Code structure

```
src/
  types.ts           domain types
  telemetry.ts       pure: event-time ordering, GPS batch → path, speed + fuel filters
  presence.ts        pure: presence reducer (ghost handling), dispatcher ids
  routes.ts          pure: status flow, merge by version, "who changed it", input validation
  api.ts             fetch wrapper: X-Dispatcher-Id, If-Match, retry on 503 (Retry-After)
  useFleetPulse.ts   the one hook: SSE + WebSocket + REST → React state, plus actions
  App.tsx            login + layout
  components/        TruckList, FleetMap, TruckDetail, RoutesPanel, Sparkline, ErrorBoundary
tests/               telemetry, presence, routes/api
```

**Data flow:**

```
SSE /api/telemetry/stream ─▶ applyReadings() ─▶ trucks state ─▶ list, map, detail
WS  /ws                   ─▶ presenceReducer / mergeRoute / log ─▶ header, routes, activity log
UI action ─▶ api.ts (REST) ─▶ result merged into state; errors shown next to the button
```

All logic that decides *what is true* (ordering, filtering, conflicts, presence) lives in small pure functions with tests. React components only display state and call actions.

## How each quirk is handled

| # | Quirk | Handling |
|---|---|---|
| 1 | GPS batch (10–30 old readings) | `applyReadings` sorts by timestamp. Readings older than the truck's latest only go into its **path**. The map draws one circle and one path line per truck, never a marker per reading. |
| 2 | Fuel reads 0% while braking | A sudden drop (≥15 points, or exactly 0) is *suspect*, and the last trusted value is shown with "(checking sensor)". If it lasts 8 s it's accepted as real. "LOW FUEL" only uses trusted values. |
| 3 | truck_7 speed 999 km/h | Values above 160 km/h (or negative/NaN) are rejected. The last valid speed is shown with "speed sensor fault", and the chart shows a gap. |
| 4 | 409 on version mismatch | Every PATCH sends `If-Match` with the version the dispatcher was looking at. On 409 we re-fetch routes and show who changed the route and its new state. Nothing is overwritten. |
| 5 | Out-of-order readings | Same rule as #1: a reading older than the truck's latest never overrides it. |
| 6 | Ghost presence (leave 10 s late) | A leave for an unknown dispatcher or for ourselves is ignored. Later activity re-adds a dispatcher. When someone joins, we re-announce what we're viewing. |
| 7 | `GET /api/fleet` 503 + Retry-After | `withRetry` waits Retry-After seconds (otherwise 1/2/4 s), up to 3 retries. If that fails, an error banner is shown; live telemetry still works. |
| 8 | PATCH races a reassign | Same 409 path. The "who" comes from the re-fetched route's assign/update/reassign timestamps, because the 409 body misses reassignments. |

## Multi-dispatcher conflicts

- Each dispatcher sees who else is online and which truck they're viewing (header and truck list).
- Status changes and reassignments ask for confirmation. Buttons are disabled while a request runs, which prevents double submits.
- On a 409 the dispatcher gets a message such as *"route_1 was changed by Omer while you were working on it (now "in-progress" on truck_1). Your change was not applied."* The route card shows the fresh state, so they can decide again. The conflict is also recorded in the activity log.
- Creating a route for a truck that already has one shows who assigned it.
- **Reassign:** the server endpoint has no `If-Match`, so we re-fetch the route and stop if its version changed. This narrows the race to one round-trip but cannot close it.
- The activity log records every route change, alert and presence change, with the dispatcher's name.

## Known limitations

- The reassign race described above.
- The activity log only covers events since the page was opened (the server has no history endpoint).
- Dispatchers who were online before you joined appear once they view a truck, or when anyone joins.
- A dispatcher who really closed their tab still shows for up to 10 s (the server's ghost delay).
- OpenStreetMap's public tiles are fine for development only. Some trucks appear in the sea because the simulator ignores the coastline.
- Server URLs are hard-coded to `localhost:3000`.

## What I'd add with more time

Bonus features from the brief: a circuit breaker with a stale-data mode, an anomaly dashboard, side-by-side conflict resolution, filters and keyboard shortcuts. Also `If-Match` support on the server's reassign endpoint, and end-to-end tests with two browser sessions.
