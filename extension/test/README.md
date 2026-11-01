# extension/test — the section-9 regression net

The in-repo, repeatable verification layer for the extension's background
lifecycle (contract section 9 — `planning_docs/PopUp_Background_message_relay.md`,
"Background G — lifecycle, recovery, and integration testing"). It adds no
feature behavior; it checks the behavior sections 1–8 landed: the worker's
state survives exactly what storage holds, the auth gate recovers exactly
once, the bus messages resolve to the documented envelopes, and the relay's
push path flips the worker against a live backend.

This is the milestone board's "M8 net should be the in-repo successor" —
the throwaway `/tmp` probe harnesses that preceded it (purged on every
reboot) are retired; these two files are the permanent net.

## The tiers

### Tier 1 — `worker-lifecycle.test.mjs` (worker-level, no bench)

Runs the **real `extension/background.js`** in a `node:vm` context
(`harness.mjs`) against a persistent `chrome.storage` stub and a scripted
`FakeBackend` that models the settled Authentication contract (cookie
paths, allauth session/refresh/logout semantics, the DRF routes). A worker
KILL cancels in-flight requests and a WAKE re-runs the script over the same
storage — the exact MV3 lifecycle.

- **Run:** `node extension/test/worker-lifecycle.test.mjs`
- **Needs:** nothing (node ≥ 22 — `vm`, `WebSocket`-free, `FormData`
  globals). No bench, no browser, no npm install.
- **Covers:** the five acceptance tests at worker level — AT1 a MID-FLIGHT
  kill + wake + re-resolution (what CDP *cannot* force — an open channel
  keeps a real worker alive), AT2 a missed SESSION_EVENT both directions,
  AT3 duplicates / out-of-order with backend arbitration, AT4 expired
  access (one recovery, one retry) and the fully-dead transition, AT5 all
  four ops across a restart — plus the section-9 audits (no timers, no
  in-memory-only durable state, no token in storage or any bus response,
  exactly the two storage keys).
- **Duration:** seconds. ~60 checks.

### Tier 1b — `popup-session.test.mjs` (popup-level, no bench)

Runs the **real `extension/popup/popup.js`** in a `node:vm` context
(minimal DOM stub + chrome stub) against the real worker through the
same `harness.mjs` bench: the popup's `USER` send rides the worker's
real bus listener, and the worker's `session_state` writes fire the
popup's `chrome.storage.onChanged` with Chrome-shaped change objects
(the C2 broadcast — the popup's only live link). Covers the §11
acceptance tests (open signed-in / signed-out, the stale-cache
"response always wins" rule, the live flip with no reload, the
worker-restart re-open) plus the §12 sign-in-button check (opens the
popup's own `FRONTEND_ORIGIN + /login`, which matches the worker's
copy — origin-sensitive assertions read the constant from whichever
build is loaded, so the same file tracks `.dev-load`), and the §11
static audits (no cookie read, no token, no direct backend call, no
storage write, no timers).

- **Run:** `node extension/test/popup-session.test.mjs`
- **Needs:** nothing (node ≥ 22). No bench, no browser.
- **Duration:** seconds. ~37 checks.

### Tier 2 — `browser-integration.mjs` (full integration, real bench)

A real Chromium-based browser (headless) + the **dev extension build**
(`extension/.dev-load`, rebuilt first via `dev/manifest-dev.sh`) + the
**live local bench**: the Django backend, the vite frontend, and a local
Postgres. The pass logs in through the real frontend UI, then runs the
acceptance tests over the real relay + real cookie-jar auth:

| Test | What it exercises |
| ---- | ----------------- |
| AT5a | real login → the **relay push** fast path flips the worker within seconds (the frontend's own emission is *simulated* from the page — its emitter is a carried open item; the relay + worker halves are under test) |
| AT3 | duplicate / out-of-order SESSION_EVENTs over the real relay — final state = backend truth |
| AT5b | SEARCH, LIBRARY, USER, SAVE all succeed (real cookie-jar auth; SEARCH pays real paced Gemini embedding calls) |
| AT1 | the worker-restart re-resolution: a clean **55 s idle window** (keepalive paused, zero CDP activity on the worker), then one liveness eval — the build reaps the idle worker at ~30 s, but the reaped target **lingers in CDP's target list** (presence is not a death signal, and attaching to the lingering entry throws), so death is read from the silent-eval signal; the zombie is dropped, a relay wake is sent, the respawned worker (a NEW targetId) is re-attached, the session re-verifies against the real backend, and the features work again. The MID-FLIGHT kill (an open channel keeps a live worker alive — unforceable from CDP) is Tier 1's forceable coverage |
| AT4 | access cookie deleted from the real jar → one recovery, one retry, rotated cookies land; then the session fully dead via the worker's own **SIGN_OUT** (the real backend flush — a synthetic cookie deletion would leave the session alive server-side, and a re-login against a live session 409s with no new tokens) → signed-out |
| AT5c/AT2 | real sign-out on the account page; with the event *missed*, the next check restores signed-out; the push path confirms |

- **Run:** `node extension/test/browser-integration.mjs`
- **Needs (the local dev bench):**
  - the Django backend answering on the API origin (default
    `http://localhost:8080`) — e.g. `venv/bin/python manage.py runserver`,
    against a local Postgres with the migrations + `CREATE EXTENSION vector`;
  - the vite frontend on the vite origin (default `http://localhost:5173`) —
    `npm run dev` in `IE-ClientSide/`;
  - a Chromium-based browser on PATH — `brave-browser` by default. A branded
    **Google Chrome** refuses `--load-extension`, so point `IE_BROWSER_BIN`
    at an unbranded Chromium/Brave binary if you don't have Brave.
  - **No `run_worker` process** is needed — the pass creates captures that
    must stay `pending` (with no worker, nothing costs Gemini pipeline time;
    only the SEARCH ops' query-embedding calls hit the real API, ~15 s of
    paced calls in total).
- **Duration:** a few minutes (AT1's idle-kill alone is ~30 s).
- **Side effects, self-cleaning:** the pass creates a throwaway **verified**
  probe account (`ie-s9-<timestamp>@example.com` — verified, so the login
  mails nothing) and its one or two captures, and deletes them at the end.
  A crashed run cannot block a re-run: each pass first sweeps any stale
  `ie-s9-*` accounts (and their captures / queued tasks), and the probe is
  given a unique username so leftovers from older runs never violate the
  user table's unique constraint. The email is still printed up front if
  you ever want to inspect or remove it manually.

## Env knobs

| Var | Default | Meaning |
| --- | ------- | ------- |
| `IE_API_ORIGIN` | `http://localhost:8080` | the bench backend origin (also handed to the load-dir build, so the worker's seeded origin matches) |
| `IE_VITE_ORIGIN` | `http://localhost:5173` | the bench frontend origin |
| `IE_BROWSER_BIN` | `brave-browser` | the browser binary (must accept `--load-extension`) |
| `IE_BENCH_DB_HOST` / `IE_BENCH_DB_PORT` / `IE_BENCH_DB_USER` / `IE_BENCH_DB_NAME` / `IE_BENCH_DB_PASSWORD` | `127.0.0.1` / `5432` / `postgres` / `bookmark` / `""` | where the probe-user create/cleanup (`manage.py shell`) points — the same database runserver serves |

Origin-sensitive assertions (e.g. the `sign_in_url`) compare against the
constants **read from the built `.dev-load/background.js`**, not against
the env defaults — the test tracks whatever origins the loaded worker
actually carries.

## CDP notes (why the script is shaped the way it is)

- **One browser-endpoint WebSocket** with flattened attach sessions
  (`Target.attachToTarget {flatten: true}`); every command for a target
  carries the returned `sessionId`. No per-target sockets, no npm
  dependencies (node ≥ 22's built-in `WebSocket`).
- **A same-context `chrome.runtime.sendMessage` from the service worker
  never reaches the worker's own `onMessage`** (probe-verified: the send
  settles with no response). So every worker message — the four ops *and*
  the 20 s keepalive — is driven from the **relay's isolated world** (the
  page's content-script context), the same external context a real popup
  is. The relay world's `executionContextId` is tracked from the page
  session's `Runtime.executionContextCreated` events (`params.context`,
  `auxData.isDefault === false`).
- **An attached CDP session can pin a service worker alive** (inspector
  semantics), so the AT1 idle-kill wait `Target.detachFromTarget`s the
  worker session first; the restarted worker (a *new* target) is
  re-attached after the wake.
- **A page can silently sit at `chrome-error://chromewebdata/`** (title
  "localhost") when the bench is unreachable — every navigation verifies
  `location.href` actually reached the app origin before anything runs in
  the page.
- **This Chromium build mis-parses the two-argument extension flags** —
  `--disable-extensions-except DIR` lands the path as a second URL target
  and the launch dies with "Multiple targets are not supported in headless
  mode". The `=` form is required.
- `chrome-error`/settling quirks of this build's `Runtime.evaluate
  {awaitPromise: true}` (`.then` chains came back mangled in probes) is
  why worker sends use a **callback + in-page race timer** inside one
  promise, not promise chaining.

## What this net deliberately does NOT cover

- **Mid-flight worker kills** — a live CDP channel keeps a real worker
  alive, so a browser run cannot force one; Tier 1's harness models it
  exactly (in-flight cancellation, wake, re-resolution).
- **The popup in the browser** — a headless run does not open the popup
  page; its session-state (§11) and sign-in (§12) logic is covered
  in-repo by Tier 1b (`popup-session.test.mjs`). The bus messages the
  popup sends are driven from the relay's isolated world over the same
  `chrome.runtime` channel, and the "rendered state" observed here is
  the worker's published `session_state` — the value the popup renders.
- **The frontend's sync-event emitter** — a carried open item in
  `IE-ClientSide`; the pass posts the agreed `{type}` payload itself (labeled
  "the simulated emitter") — the relay + worker halves are the ones under
  test.
