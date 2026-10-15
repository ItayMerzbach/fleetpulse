# PROMPTS.md — AI usage journal

**Tool:** Claude Code (Claude Opus 5.5, agentic mode in the Claude desktop app), with shell, file editing and a built-in browser.

**How AI was used:** as an implementation partner working under my direction. I gave one task-level prompt. The agent then planned, built, ran the app against the real mock server, wrote tests, and reported back. I asked it to check with me on decisions where an unexpected problem came up. Every interesting step below includes what the AI did, what turned out to be **wrong**, and how it was caught.

> Note: §3–§8 describe the first, larger version. §9 explains how it was cut down to the current minimal one.

> Rule I followed: nothing counts as done until it has run against the real mock server or a test. Several AI-generated pieces looked right and were not (see §5).

---

## 1. Kick-off prompt (mine, verbatim)

> I have been assigned a task that encourages the use of AI, with a requirement to document the prompts in a file named `prompt.md`. Please carry out the task, and consult with me whenever you need to find a solution to any problems that arise.
> *(attached: FE-Senior-FleetPulse-Fleet-Management-Kit-Assignment.pdf)*

**What the AI did with it**
- Read the 22-page brief and noticed it requires the file to be named **`PROMPTS.md`**, not `prompt.md`. It used the brief's name and told me.
- Picked React + TS + Vite + Vitest (the brief's recommendation) and, at first, an SVG grid map (the brief says map quality isn't graded). I later replaced it with a real map; see §6–7.

---

## 2. Problem: the mock server code in the PDF was corrupted

**Observation:** the PDF's text layer turned operators into garbage: `===` → `=//`, `&&` → `&/`, `||` → `|/`, `++` → `+/`, `...` → `.//`, `?.` → `?/`, and split identifiers across line breaks (`Truck Delt` / `a`).

**Approach:** the corruption follows a fixed pattern (the 2nd/3rd character of the operator becomes `/`), so it's reversible without guessing. The server was rebuilt by hand, then **checked by running it**: 6× `GET /api/fleet`, the raw SSE stream, a `POST /api/routes`, and a stale `If-Match` PATCH returning 409 with `lastModifiedBy`.

**Critical note:** the brief says "do not modify the server". Its behaviour is unchanged; only extraction damage was repaired. This is documented in the README so a reviewer can diff against their original.

---

## 3. Architecture prompt (internal planning step)

The agent planned before writing code. Summary of that plan, which I reviewed:

> Separate transport (SSE/WS/REST, no React) → typed event bus → framework-agnostic services with **pure reducers** for the risky logic (sensor filters, presence, route merge) → small external stores via `useSyncExternalStore` → React. One composition root. Vehicle types and detail widgets as registries so new types don't touch existing code. Every network payload validated with zod.

**Why I accepted it:** the brief weights architecture (20%) and race conditions (20%) highest. Pure reducers make the quirks testable without timers or a network. Choosing hand-rolled stores over Redux or Zustand is a trade-off I can defend: about 40 lines, no dependency, and frame-batched notifications for telemetry.

**Pushback / adjustments during planning**
- *Initial idea:* seed charts from `/api/telemetry/history`. *Concern:* that endpoint returns fabricated noise. *Decision:* use it only to back-fill **older-than-anything-we-have** points, pass it through the same plausibility gate, and label it `source: 'history'`.
- *Presence protocol gaps found by reading the server code:* `dispatcher_joined` is not sent to the joiner, and names are only sent on join. *Decision:* re-announce `viewing_truck` when anyone joins plus a 15 s heartbeat, and put a readable name slug in the client-generated dispatcher id. No server change needed.
- *Reassign has no `If-Match` on the server.* We emulate it with a version re-check before the PUT, and document the remaining one-round-trip race instead of pretending it's solved.

---

## 4. Implementation prompts (sequence)

Roughly the order of the brief's recommended phases. Each was a self-contained instruction the agent ran and then verified:

1. *"Core: typed EventBus with handler isolation, external store with frame-batched notify, SortedWindow (bounded, insert-by-timestamp)."*
2. *"zod schemas for every SSE/WS/REST payload; validate readings individually so one bad reading doesn't drop eleven good ones."*
3. *"Sensor filters as pure reducers (speed, fuel, range) + TelemetryProcessor with event-time ordering; late/batch readings go to the path only."*
4. *"Transport: ApiClient (dispatcher header, If-Match, Retry-After parsing), withRetry, CircuitBreaker (single half-open probe), SSE/WS wrappers with backoff, watchdog, ping RTT."*
5. *"Domain: presence reducer (ghost rules), route state machine, mergeRoute by version, conflict model, lastActor()."*
6. *"Services + composition root; UI: header, list, SVG map, widget-registry detail panel, bottom tabs, conflict dialog, keyboard shortcuts."*
7. *"Run it against the real server in the browser and try to break it."* ← this step found most of the bugs below.
8. *"Tests: quirk-driven, minimum 8, prefer edge cases over 'renders'."* → 57 tests (58 after §8).

---

## 5. Where the AI was wrong — and how it was caught

This is the most important section. The AI's first draft contained these errors, and each one was found by **running** the code, not by reading it.

### 5.1 "Frozen speed sensor" heuristic → false positives (rejected)
- **AI suggestion:** besides rejecting 999 km/h, flag a speed sensor as *stuck* when the same non-zero value repeats 4 times.
- **What happened live:** almost every moving truck showed a yellow **SUSPECT** badge.
- **Root cause:** the server clamps speed with `Math.min(80, …)`, so a fast truck legitimately reports exactly `80` many times in a row, just like real cruise control.
- **Decision:** removed the heuristic entirely instead of tuning the threshold. A frozen speedometer can't be detected reliably from the speed sensor alone; it needs a cross-sensor check (speed vs. GPS displacement), listed under future work. A regression test now asserts that a constant 80 is **not** flagged.
- **Lesson:** a heuristic that sounds reasonable must be checked against the actual data.

### 5.2 Conflict dialog was misleading
- **AI's first version:** two columns, "your intended change" vs. "current version", built from `{...mine, status: newStatus}`.
- **Problem found in the browser** (I reproduced a real race: opened the confirm dialog in the UI, changed the route with `curl` as a second dispatcher, then confirmed): the "yours" column showed the *old* priority and notes as if I were setting them, and highlighted them as conflicts. In fact "apply my change" only changes the status and keeps the other dispatcher's notes.
- **Fix:** three columns: *What you saw (vN)* / *Now (vM, by X)*, with their changes highlighted / *If you apply your change*, which is their version plus only my field. Re-tested live: applying on top kept the other dispatcher's note "Gate 5 closed, use gate 7" and set only the status. A component test locks this in.

### 5.3 Retry loop kept sleeping after the circuit breaker opened (real bug)
- **AI's first version:** `withRetry(() => breaker.execute(fetchFleet), { shouldRetry: isRetryable })`.
- **Caught by an integration test** that recorded sleep durations: expected `[3000, 3000]`, got `[3000, 3000, 3000]`. After the 3rd 503 tripped the breaker, the loop still waited another `Retry-After` only to be rejected with `CircuitOpenError`, which delayed degraded mode by 3 s.
- **Fix:** `shouldRetry` also checks `breaker.state !== 'open'`.

### 5.4 Test data was wrong, not the code
- An integration test for "real low fuel raises exactly one alert" dropped fuel from 30% → 14% in one tick and failed.
- The AI's first instinct was to look for a bug in the alerting code. It isn't one: a 16-point drop in 2 s is physically implausible and **should** be treated as a suspect glitch. The test was rewritten with a gradual decline, plus a step that hovers around the threshold to check hysteresis.
- **Lesson:** when a test fails, decide which one is wrong — the code or the test.

### 5.5 Smaller issues found while running
- **Layout:** a 4-row CSS grid broke when the optional degraded-mode banner was absent (the bottom panel took the `auto` track). Switched to a flex column.
- **Fuel filter edge:** if fuel was already 6%, a glitch to 0% is below the 15-point "sudden drop" threshold and would have been displayed as a real 0%. Added "an exact 0 is always suspect until it persists", with a test.
- **Modal focus:** inline `onClose` arrow functions re-ran the modal's focus effect on every render. Moved the callback into a ref.
- **Dev environment:** port 5173 was occupied by an unrelated project of mine. The agent noticed it, left that process alone, and made the Vite port configurable instead of killing it.
- **Vite warning:** the root `package.json` must stay CommonJS so the unchanged `server.js` (`require`) runs. Renamed the config to `vite.config.mts` instead of switching the package to ESM.
- **Removed a dead anomaly kind** (`fleet_degraded`) that the first draft declared but never emitted.

---

## 6. Follow-up prompt: switch to Google Maps (mine, verbatim)

> This map is not valid; could you switch to using Google Maps?

**What the AI did**
- Pulled everything the map needs (filtered rows, selection, viewers, path, staleness) out of the SVG component into `useMapModel()`. Then wrote `GoogleFleetMap` (`@vis.gl/react-google-maps`, AdvancedMarkers with the same status colour, heading arrow, fault dot and viewer avatars; a Polyline for the path; hollow dots for late/batched fixes). The SVG map became `GridMap`.
- **Key handling:** read from `VITE_GOOGLE_MAPS_API_KEY` in a git-ignored `.env.local`, with an `.env.example` committed. No key is in the repo.
- **Critical point raised by the AI:** a reviewer who runs `npm start` without a key would otherwise get a grey "For development purposes only" map or nothing at all. So the grid stays as a fallback for three cases: no key, script load failure (`onError`), and a rejected key. Google reports the last one through the global `gm_authFailure` callback, not through the loader's promise, which is easy to miss.
- **Verified:** no key → grid with a legend note. Deliberately invalid placeholder key → Google script loads, rejects the key, app falls back with "Google Maps rejected the API key". The real-key rendering has to be checked with my own key, since the AI did not create or handle credentials.

## 7. Follow-up prompt: Leaflet instead of Google Maps (mine, verbatim)

> For this development, using React-Leaflet is sufficient; Google Maps is not needed.

**What the AI did**
- Replaced the Google renderer with `LeafletFleetMap` (react-leaflet 5). Because the map was already split into `useMapModel()` (data) and a renderer (drawing), **no data code changed**. Also removed the Google dependency, the API-key config, `.env.example`, and the SVG grid fallback, which is no longer needed since Leaflet works without a key.
- Markers are `L.divIcon` HTML with the same visual language. **Security note raised by the AI:** `divIcon` takes a raw HTML string, and dispatcher names are user input, so they are HTML-escaped. The icon is memoised on its appearance (status, heading, fault, viewers), so a position update doesn't rebuild the marker's DOM.
- **AI mistake caught by checking in the browser:** the first tile choice (CARTO "Dark Matter", widely cited as keyless) rendered **"API KEY REQUIRED"** watermarks — the provider's terms have changed. Switched to the standard OpenStreetMap tile server with attribution, darkened via a CSS filter. A second issue: react-leaflet applies layer options only on creation, so the new CSS class only took effect after a full reload, not after hot reload.

## 8. Follow-up prompt: a requirement that looked ignored (mine, verbatim)

> Why did you ignore the task: "Handle GPS batch readings — don't render 30 map markers for one truck, show the path or latest position"

**Honest assessment (AI's answer, which I verified):** the *data* side was done and tested (one time-sorted path, no backwards jump, one commit per batch), but the *map* had **two real defects**:
1. The path was drawn **only for the selected truck**, so a batch for any other truck had no visible effect.
2. For the selected truck, every late/batched fix was drawn as its **own dot**, so a 30-reading batch put up to 30 extra markers on the map. That is the exact thing the requirement forbids, introduced while trying to make batches "visible".

**Why it slipped:** the unit tests asserted the processor's output (`trail` length, ordering) but nothing checked what the *map* draws, and the live check focused on markers moving rather than on what happens during a batch.

**Fix:**
- Every truck gets **one path polyline** (faint; the selected truck's is bold). The per-fix dots are removed.
- The processor now records `lastBatch {count, receivedAt}`, and the truck marker shows a **"GPS +N"** badge for 10 s.
- Added tests for `lastBatch`.
- **Verified live** by waiting for a real batch from the server: "GPS +26" on Truck Lima, with the map still at 13 marker icons (12 trucks + depot), 12 path lines, and 0 per-reading dots.

**Lesson:** test requirements against what the user actually *sees*, not only the data layer behind it.

## 9. Follow-up prompt: simplify everything (mine, verbatim)

> Now, I'd like you to simplify the UI—keep it much more basic, implementing only what was requested and nothing more. (I need to be able to stand behind the code and fully understand everything, so I want a minimalist approach.)

The AI asked two clarifying questions before starting, because the answers changed the scope a lot. My answers:
- **Bonus features:** remove all of them (circuit breaker / degraded mode, anomaly dashboard, observability panel, keyboard shortcuts, filters, side-by-side conflict dialog).
- **Scope:** simplify the non-UI code too, not just the React layer.

**Result:** a rewrite from ~60 files to 13 source files (~1,100 lines including types and comments). §3–§8 above describe the first, larger version and are kept as the history of how I got here.

| Before | After |
|---|---|
| Typed event bus, custom stores, composition root, 5 services | One hook, `useFleetPulse.ts`, using plain React state |
| Vehicle-type and widget plugin registries | Plain components |
| zod schemas for every payload | A small `isValidReading` check, plus form validation |
| Sensor filters as reducer plugins and a processor class | Two pure functions, `filterSpeed` and `filterFuel`, plus `applyReadings` |
| Circuit breaker, backoff, watchdog, ping/pong | `withRetry` (Retry-After) for 503s; EventSource's own reconnect; WS reconnect after 2 s |
| Conflict dialog with three columns | A message naming who changed the route and its new state |
| 58 tests (with DOM / integration) | 22 pure unit tests (26 after §10) |

**What was deliberately kept** (each is a requirement):
- Event-time ordering, and merging GPS batches into a single path.
- Speed and fuel filtering, with low fuel computed only from trusted values.
- `If-Match` on every PATCH, and on 409 re-fetching to name *who* changed the route (using all of assign, update and reassign).
- Version check before reassigning.
- Ghost-safe presence reducer, and re-announcing ourselves when someone joins.
- Confirmation dialogs (`window.confirm`), input validation, error boundaries.

**AI bug caught while verifying the rewrite:** the route-create form and the alert form were siblings that both used `key={truckId}`. After creating a route, React left the old form on screen next to the new route card. It was found by inspecting the DOM in the browser, confirmed by React's "two children with the same key" console error, and fixed with distinct keys.

**Verified live against the mock server:**
- 12 trucks, with exactly one marker and one path line each.
- Fuel glitch shown as "(checking sensor)".
- Validation message for a short destination.
- Route creation works.
- A real race, where "Omer" PATCHes while Dana's confirm dialog is open, produces "route_1 was changed by Omer … your change was not applied", the refreshed route card, and two log entries.
- Reassignment works.
- Closing four stale browser tabs removed their presence entries, ghost delays included.

## 10. Follow-up prompt: requirements audit (mine, verbatim)

> Don't you need to perform at least 8 tests? Read through all the requests and make sure you haven't missed anything.

The AI re-read the whole brief line by line against the code. The 8-test minimum was met (22 tests, every required area covered), but the audit found **two real gaps**:
1. **"Test optimistic locking / conflict resolution flow"** was only partly tested. The pieces were covered (If-Match header, 409 → error, message text), but the *flow* (PATCH → 409 → re-fetch → explain who) lived inside the React hook, where no test reached it. Same for the reassign version check. **Fix:** moved both flows into `routes.ts` (`changeStatusSafely`, `reassignSafely`) and added 4 tests with a fake server. These also check that the PATCH is **not** retried and that no PUT is sent when the version changed. The hook now only applies the result.
2. **The README had no "Key technical decisions and trade-offs" section**, which the submission instructions require. Added.

Also checked and documented: which listed endpoints are intentionally unused (`/api/telemetry/history`, `ping`, `/api/reset`).

**Found by cloning the repo fresh and running it as a reviewer would:** the `start` script had been changed to only `vite --open` (my own edit to `package.json`), so the mock server is started separately with `npm run server`. The AI flagged that the brief asks for `npm install && npm start`; I chose to keep the two-step start, and the README setup now says so. The AI also admitted it had swept that edit into an unrelated commit with `git add -A` without noticing.

## 11. Follow-up prompts: the ghost-presence refresh bug (mine, two iterations)

**The bug I found:** when another dispatcher refreshes and reconnects with the same id, the delayed `dispatcher_left` from their **old** connection (quirk #6, ~10 s late) arrived after their new join and removed them while they were online. The server's timestamp on that leave is set *after* the delay, so it can't be used to tell the two connections apart.

**Iteration 1 (my prompt, summarised):** store `joinedAt` (local arrival time) per dispatcher and ignore any leave arriving < 11 s after it, passing `now` into the reducer so it stays pure.
- The AI implemented it. It also noticed the activity log would still print "X went offline" for an ignored ghost, and fixed that.
- It flagged the trade-off: a dispatcher who *really* leaves within 11 s has the leave ignored, and with no expiry they'd stay listed forever.
- I didn't commit this version.

**Iteration 2 (my prompt, summarised):** use the same "suspect" pattern as the fuel filter instead of ignoring:
- keep `lastSeenAt` (updated on join, viewing, and any route/alert action they perform);
- a leave < 11 s after it marks them **uncertain** (shown greyed, "connection uncertain") instead of removing them;
- any activity puts them back online;
- an uncertain dispatcher silent for 60 s is removed via a pure `tick` event;
- a leave ≥ 11 s after their last activity removes them immediately.

**AI's interpretation choices, which I accepted:**
- Route/alert activity only refreshes dispatchers already in the list, so a `curl` user doesn't appear "online".
- All presence events go through one `applyPresence` helper in the hook, which logs "went offline" only when someone is actually removed (by a leave or by the timeout).

**Tests:** left within 11 s → uncertain; activity → online again; 60 s without activity → removed (59 s → still there); left after 11 s → removed immediately; tick never removes online dispatchers; unknown activity is ignored.

**Verified live:** Dana watched while Omer refreshed his tab 5 times. Omer was never dropped, and no false "went offline" was logged. A real 10 s ghost leave arrived and showed him greyed as "connection uncertain" instead of removing him.

**Remaining trade-off (in the README):** someone who refreshes and then stays idle is shown as uncertain after a ghost leave, and drops off after 60 s until their next action. The server sends no presence heartbeat, so the client can't distinguish "refreshed and idle" from "really gone".

## 12. Verification performed (current version)

- `npm test` → 30/30. `tsc` strict → clean. `vite build` → OK.
- Every requirement in the brief was checked in the browser against the real mock server (see §9).

## 13. What I'd tell a reviewer about AI usage

- I used AI for **speed**: drafting code, wiring, tests. I kept **judgement** for myself: what the quirk handling should do, what the dispatcher sees in a conflict, which heuristics to drop, and finally how much code is worth having at all.
- The most valuable prompts were not code requests. They were *"run it against the real server and try to break it"*, *"why does this requirement look ignored?"*, and *"make it small enough that I can defend every line."* Each one exposed problems that typecheck and the unit tests had passed.
- The first version was over-engineered for a 4–8 hour task. Simplifying it was a deliberate decision, made so that every line is one I can explain in the review.
