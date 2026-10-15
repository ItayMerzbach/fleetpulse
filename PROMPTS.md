# PROMPTS.md — AI usage journal

**Tool:** Claude Code (Claude Opus 5.5, agentic mode in the Claude desktop app), with shell, file editing and a built-in browser.

**How AI was used:** as an implementation partner working under my direction. I gave one task-level prompt. The agent then planned, built, ran the app against the real mock server, wrote tests, and reported back. I asked it to check with me on decisions where an unexpected problem came up. Every interesting step below includes what the AI did, what turned out to be **wrong**, and how it was caught.

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

## 9. Verification performed (not just "tests pass")

- **Live, in the browser, against the real mock server:** truck_7 shows *SENSOR FAULT · reported 999 km/h, showing last valid reading*. Fuel glitches are held as *SUSPECT* and logged "resolved after 4.0s — no action needed". GPS batches appear as hollow path points. Validation messages show on bad input. Route created; stale-version race reproduced and resolved through the dialog; the other dispatcher (`curl` as `omer-1a2b`) is shown by name, which comes from the id slug.
- **Observability tab live:** ~0.4 SSE events/s, matching 0.4 store commits/s (one commit per message, as designed), WS RTT ≈1 ms, 0 handler errors.
- `npm test` → 58/58; `tsc` strict → clean; `vite build` → OK; `npm start` from scratch starts both server and UI.

---

## 10. What I'd tell a reviewer about AI usage

- I used AI for **speed**: boilerplate, schemas, CSS, and the first draft of every module. I kept **judgement** for myself: which quirk handling is correct, what the UX should say during a conflict, and which heuristic to drop.
- The most valuable "prompts" were not code requests. They were *"run it against the real server and try to break it"*, which found 5.1 and 5.2, and *"write tests from the quirks, not from the implementation"*, which found 5.3 and exposed the bad assumption in 5.4. The AI's first draft passed a typecheck with all four defects still in it.
- Every design decision in the README is one I can defend without the AI. The trade-offs (reassign race, presence before join, in-memory audit) are stated as limitations rather than hidden.
