# Extension rework — milestone progress

Companion to `extension_documention.md` (the §0.4 session log, alongside this file in `planning_docs/` — per-task detail, actual test results, decisions, deviations). This file is the **one-screen status board**: milestone statuses, the next milestone's concrete entry point, and the cross-cutting state. Keep the two synchronized; when they disagree, the session log is the finer record.

Milestones per `planning_docs/extension_implementation.md` §7 (M1–M8).

## 1. Status at a glance (2026-10-26)

| Milestone | Title | Status |
|---|---|---|
| **M1** | Extension foundation: seed, vendor, strip | ✅ **Completed** (2026-10-25) — 5 commits + docs |
| **M2** | Extension core architecture: identity, floor, dev environment + CORS hardening (B0) | ✅ **Completed** (2026-10-26) — all 6 tasks + the B0 ID fix (`067770a`); static, CORS, suite, **and the full browser acceptance** all passed with actual results (§3) |
| M3 | Minimal frontend: the identity surface | ⬜ Not started |
| M4 | Extension session: consume-only auth wrapper + sync relay (step 0: SameSite probe) | ⬜ Not started |
| M5 | Submission: canonical capture, always-multipart POST, first real capture (M5a B2 → M5b) | ⬜ Not started |
| M6 | The popup + read-back (M6a B1 → M6b) | ⬜ Not started |
| M7 | Platform adapters: four tributaries + per-item media degradation (M7a B3 → M7b) | ⬜ Not started |
| M8 | Integration: the end-to-end flow as a repeatable regression net | ⬜ Not started |

## 2. M1 — what landed, and the evidence

Branch `cloud-migration` (base `aeaeac3`); 6 commits after the docs commit:

| Commit | Content |
|---|---|
| `7337a1f` | copy v1 tree from `origin/main` (state C), excluding dead `content.js` — 27 files, diff = exactly that exclusion |
| `bf2e2fe` | vendor Readability 0.6.0 (tarball shasum `134e3ce3ff…` verified; 8 snapshot files out, 2 upstream + LICENSE + VENDOR.md in; manifest all_urls swap atomic) |
| `ec7b2da` | strip v1 note UI + setup flow from the confirmation core (atomic; JS 311→180, CSS 292→141) |
| `279c31d` | remove v1-only background code + the five setup call sites (228→144) |
| `b72270e` | drop `content_type` / `capture_method` envelope fields (universal −1, twitter −2, youtube −2, pinterest −6, linkedin −10) |
| (docs) | this file + `extension_documention.md` |

**Acceptance (impl doc M1) — actuals:** seed diff = the `content.js` exclusion only ✅ · vendor files byte-match the tarball, manifest load order preserved ✅ · `node --check` clean on every JS incl. vendor ✅ · orphan grep = exactly the 5 documented URL-literal survivors ✅ · manifest parses ✅ · load-unpacked smoke (Brave 156 stand-in for Chrome; fake backend, no real server): extension loads; canary 1 error-panel → neutral copy → zero `:8081` links → 10 s auto-dismiss, **passed twice, reproducible** (the note-UI surgery canary); canary 2 stub verified real (h1 read in the first run; launcher side-effect in later runs — see log §6/§9); canary 3 YouTube button injected, console clean ✅ · worker console shows the expected v1 flow (`Detected platform: web` → `Failed to fetch` on the dead `:8080`), no exceptions ✅.

**Post-M1 tree:** 23 files — `manifest.json` (20 lines), `background.js` (144), `inject.js` (280), `content/` ×9, `icons/` ×5, `popup/` ×2 (v1 stub, byte-identical, dies in M6), `vendor/readability/` ×4.

## 3. M2 — completed (this session, 2026-10-26)

Objective: the extension's floor exists and the extension is pointed at a backend — stable identity, config/storage, bus plumbing, dev environment, and the backend's CORS hardening (B0).

### Tasks — all six implemented and committed

| # | Task | Status | Commit |
|---|---|---|---|
| M2.1 | RSA keypair generated **once**; public key (base64 DER SPKI, 392 chars) committed as the `key` in both manifests; extension ID = **`oijkpjikiabildophmlfeihojjpghmed`** (SHA-256 of the public-key DER bytes, first 16 bytes, hex → a–p). An earlier session recorded a *different* ID for the same key (a derivation bug — it landed in the settings allowlist); the **real-browser `chrome.runtime.id`** is the ground truth and is the value now in the allowlist (fix = follow-up commit to B0; logged in the session log §8). Private key: presented to the owner (clipboard) and kept in the scratch dir per the owner's explicit call — **lost in the 2026-10-26 restart** (scratch dir + clipboard purged; full search found no copy; store-publishing association is the only casualty — local ID stands on the committed *public* key) | `77709d6` |
| M2.2 | SaaS manifest step — pinned origin in `host_permissions` (the 7 v1 patterns retire in the same step — atomicity rule), `scripting` dropped, `icons/*` WAR dropped, all_urls `exclude_matches` added, **no relay entry** (M4); `manifest.dev.json` (local-origins twin, same key) + `dev/manifest-dev.sh` (builds a gitignored load dir; `IE_API_ORIGIN`/`IE_VITE_ORIGIN` overrides; SaaS manifest byte-identical before/after — md5-verified). Both manifests parse; they differ **only** in the two origin fields (audited) | `77709d6` |
| M2.3 | Worker config/storage: `API_BASE_URL` per-manifest constant block; `getApiBaseUrl()` (storage-first, constant fallback, wake-cached); `getAccessToken()`/`setAccessToken()` (`null` **removes** the key; presence = state; no callers yet — M4); merged `onInstalled` (seed `api_base_url` **only if absent** + context menu, one listener) | `77709d6` (constant) + `57c33c7` (accessors/`onInstalled`) |
| M2.4 | Bus: `listen(type, handler)` wrapper (rule 1 type-first, rule 2 handler owns `sendResponse`); SAVE migrated onto it — handler body **v1-shaped** (detectPlatform + router + `postJSON` survive); endpoint now `{api_base_url}/captures/`; `lastError` voided on the `CAPTURE_WEB` fire-and-forget send (bus rule 3). `detectPlatform` **kept** in M2 (the impl doc's end-state inventory marks its removal at M2; the milestone spec's "handler body stays v1-shaped" wins — the M5 router collapse is where rework finding 4 applies; behavior-neutral, logged as a decision) | `57c33c7` |
| M2.5 | Context-menu origin guard: `tab?.url && tab.url.startsWith(api_base_url)` → return early (missing tab/url degrades safely; fires precisely on own pages — the app origin is in `host_permissions`) | `57c33c7` |
| M2.6 | **B0** (`bookmark/settings.py`): one deduped `CORS_ALLOWED_ORIGINS` = [`chrome-extension://oijkpjikiabildophmlfeihojjpghmed` (browser-verified), `http://localhost:5173`, `http://127.0.0.1:5173`] (v1-era `:8081` + throwaway v1 ID gone; the shadowed duplicate declaration removed — Flag §6-14 ①); `CORS_ALLOW_ALL_ORIGINS = DEBUG` (the token-theft hole closed in prod; dev stays permissive); `CORS_ALLOW_CREDENTIALS` kept; stale `JWT_AUTH_SAMESITE` comment reworded (start Strict; M4 probe decides; a `None` flip lands after this hardening, never before). `.env` (gitignored): `JWT_AUTH_SAMESITE=Strict` added, resolves via the settings' own environ path. **SameSite probe = M4 step 0 — not run** | `b4ff40d` (+ local `.env`, uncommitted by design) |

### Verification — actual results (all run 2026-10-26)

**Static + backend (all passed):**
- Manifest battery: both parse; identical key; SaaS = pinned origin only (no localhost patterns); dev = local origins; `exclude_matches` in both; no `scripting` / no `icons/*` WAR / no relay; dev-vs-prod diff = the two origin fields only ✅
- Dev script: standard values + port overrides (`IE_API_ORIGIN`/`IE_VITE_ORIGIN`) both verified in the load dir; the SaaS manifest untouched (md5 identical before/after) ✅ (a `cp -R` self-recursion bug when the load dir is inside `extension/` was found and fixed with a tar exclusion)
- ID: derived from the committed manifest key = `oijkpjikiabildophmlfeihojjpghmed`; **confirmed in a real browser** (`chrome.runtime.id`); present in `CORS_ALLOWED_ORIGINS`; dev manifest key identical ✅
- `node --check` on every JS file incl. vendor: clean; `bash -n` on the dev script: ok ✅
- Kept-lines multiset check: the only background.js lines changed vs M1 are the intended edits (every kept v1 line byte-identical) ✅
- Orphan grep: the two dead `:8080` literals are gone; survivors = exactly the documented "Bookmark" strings + `bookmark_id` reads (M5/M7 rename) + the intentional dev-manifest local origins + the gitignored load-dir copies ✅
- Local backend sanity: `GET /captures/` unauthenticated → **401** `{"detail":"Authentication credentials were not provided."}` ✅
- **CORS battery, one-off `DEBUG=0` server, real curls** (actual response headers; re-run 2026-10-26 against the *corrected* allowlist): evil origin `https://evil.example` → **no** `Access-Control-Allow-Origin` (actual request and preflight); the real extension ID `chrome-extension://oijkp…` → reflected + `Access-Control-Allow-Credentials: true` + preflight approving `authorization` (the M4 derive's path); both vite origins → reflected + credentials; the earlier wrong `clkinc…` string → **no** headers (the list is exactly the real ID + the two vite origins) ✅
- **Django suite: `Ran 117 tests in 10.9 s — OK`** against an ephemeral `pgvector/pgvector:pg16` Docker container on `127.0.0.1:5433` (owner-approved; the `.env` Supabase host no longer resolves from this machine — recorded, no project DB config changed; `DB_*` env overrides per the AGENTS.md pattern) ✅

**Browser acceptance (M2 acceptance (1)–(4)) — COMPLETED: ALL CHECKS PASSED** (final `m2smoke.js` run; the first run was cancelled by the session/server restart — no result — and the harness had to be rebuilt from scratch after the restart purged the scratch dir; the rebuild surfaced three environment facts, recorded in the session log §6: CDP input cannot open the context menu in Brave 156, a content-script context reports the *extension's* origin, and the MV3 worker needs a keepalive):

| Check | DEV (against the live `:8080` backend) | SAAS (pinned origin) |
|---|---|---|
| C1 `chrome.runtime.id` | `oijkpjikiabildophmlfeihojjpghmed` ✅ | same ✅ (one key, two manifests) |
| C2 storage | exactly `{"api_base_url":"http://localhost:8080"}` — one key, no `access_token` ✅ | exactly `{"api_base_url":"https://internetexpedition.ajiteshtamrakar.com"}` ✅ |
| C3 toast after save | error panel "Something went wrong saving this. It wasn't saved." + "Copy details" ✅ (the 401 branch) | "Couldn't save this — check your connection and try again.", no actions ✅ (FETCH_ERROR — the NXDOMAIN pinned origin; recorded, not chased) |
| C4 worker console | `Detected platform: web` → `Backend error: 401` ✅ | `postJSON failed: TypeError: Failed to fetch` ✅ |
| C4c response | `{"status":"ERROR","code":401,"error":{"detail":"Authentication credentials were not provided."}}` — **the SaaS backend is reached and its auth layer rejects** ✅ | `{"status":"FETCH_ERROR","error":"Failed to fetch"}` ✅ |
| C5 popup stub | real document (v1 launcher side-effect — the M1 race, logged) ✅ | same ✅ |
| C6 origin guard | **note, not a pass/fail** — the guard sits in `chrome.contextMenus.onClicked`, untriggerable under CDP here (finding 1); code verified statically; interactive check deferred to the M8 net | n/a (pinned origin NXDOMAIN) |
| C7 auto-dismiss / exceptions | 10 s dismiss ✅ / no worker exceptions ✅ | same ✅ |

### Environment notes recorded this session

- **Private key — LOST (2026-10-26).** It had sat at `/private/var/folders/…/T/opencode/ie-ext-key/priv.pem` (1704-byte PEM, `chmod 600`) per the owner's explicit call (1Password offered first, declined; a clipboard copy was also made). A machine restart purged the scratch dir **and** the clipboard; Spotlight + home-dir sweep + all 1375 git objects found no surviving copy. **Impact:** local development is untouched — the ID derives from the *public* key in the manifest (browser-verified `oijkp…`); only the Chrome Web Store association is lost (a store decision is not in M1–M8; a one-time key regeneration → new ID → one coordinated commit would resolve it if ever needed).
- **Stale venv:** the venv predated `django-q2==1.11.1` / `supabase==2.33.0` in `requirements.txt` — both were pip-installed at the pinned versions (environment fix, no project file changed); the backend and the suite then import fine.
- **M1's scratch Brave profile** was still running on CDP 9333 from 2026-10-25 — killed before the M2 runs.

## 4. M3–M8 — not started (one line each)

- **M3 — Minimal frontend (auth only):** React + Vite app that mints and destroys the shared session — OTP login (request → confirm → resend), registration, session context, fetch wrapper, the ~5-line sync-event emitter, a one-line signed-in dashboard. The **only** frontend work in this plan; prerequisite for M4's testing.
- **M4 — Extension session:** derive the access token from the shared HttpOnly refresh cookie, one-401-derive-one-retry on every data call, sign-in-required recovery (open the frontend), global sign-out, live flips via the sync relay. Step 0 = the SameSite probe (experiment, not assumption) — it decides where all later local credentialed testing runs.
- **M5 — Submission:** M5a backend B2 (the `file:image:0` part reader — must land first or the first live submission silently drops every screenshot) → M5b the canonical capture + always-multipart `POST /captures/` → the **first real end-to-end capture**.
- **M6 — Popup + read-back:** M6a backend B1 (`source_url` persisted + returned) → M6b the real popup (sign-in state w/ email via the `USER` pass-through, library, submit-on-Enter search) — this retires M1's popup stub.
- **M7 — Platform adapters:** M7a backend B3 (per-item media degradation) → M7b the four tributaries (X/Twitter, YouTube, Pinterest, LinkedIn) with v1 extraction quality intact.
- **M8 — Integration:** the completion criterion — the working end-to-end flow across all three components as a repeatable regression net. (The scratch CDP smoke harness from M1 is the natural seed for it; the Brave-156 zombie-socket quirk is logged for the net's design.)

## 5. Cross-cutting state

- **Branch:** `cloud-migration` off `aeaeac3`. Working tree clean except gitignored files (`.env` modified with the `JWT_AUTH_SAMESITE` line; `extension/.dev-load/` generated by the dev script).
- **M2 commits:** `77709d6` (key + SaaS manifest step + `api_base_url` + dev manifest + dev script) → `57c33c7` (worker floor) → `b4ff40d` (B0) → `067770a` (B0 fix — the allowlist's extension origin was a derivation error; browser-verified ID) → the docs commit (this file + session log).
- **Repo pins:** `origin/main` = `29a8596aa4…` (v1 state C); `HEAD:core` = `90cb9c2…`; `HEAD:bookmark` = `7ba22b2…` — re-verified at M1 step 0.
- **Environment:** Python 3.11 venv at `venv/` (now incl. `django-q2`/`supabase`); tests need a running Postgres w/ pgvector — this session used the `ie-test-db` Docker container (`pgvector/pgvector:pg16`, `127.0.0.1:5433`, pw `ie-test-pw`, db `bookmark`) since the `.env`'s Supabase host no longer resolves; `.env` points at Supabase via `DB_*` otherwise. **Chrome is not installed** — smokes run in Brave 156; scratch harness at `/private/var/folders/nc/hmk4s7z51kz7s2yxwxczsl900000gn/T/opencode/smoke/m2smoke.js` (M2's — rebuilt this session after the restart purged it; M1's `smoke.js` did not survive the purge; **a reboot purges that scratch dir again** — the M8 net should be the in-repo successor).
- **Stable extension ID (from M2):** `oijkpjikiabildophmlfeihojjpghmed` (derived from the committed manifest key; **browser-verified** via `chrome.runtime.id` — an earlier on-paper derivation had produced a different ID that briefly sat in the allowlist; corrected 2026-10-26). In `extension/manifest.json` `key`, `manifest.dev.json` `key`, and `CORS_ALLOWED_ORIGINS`. The private key's state (lost in the restart) is in §3/§6.
- **Planned origin:** `https://internetexpedition.ajiteshtamrakar.com` (pinned in the SaaS manifest + the worker constant from M2; the domain is **NXDOMAIN** — verified by `nslookup` — so it is not deployed; P3 parked, impl doc §0.3).
- **Docs:** `planning_docs/` is gitignored for the local-only plan docs; the two progress docs live there too (re-homed from the repo root 2026-10-26, owner-confirmed) and stay git-tracked on `cloud-migration` via a `.gitignore` negation.

## 6. Risks / open items carried forward

- **The private key is gone** (M2) — lost in the 2026-10-26 restart (§3); the ID itself stands on the committed *public* key, so local work is unaffected; only a future Chrome Web Store publish would need a regenerated key → new ID → one coordinated commit (Flag §6-9 surface).
- **M2's browser acceptance is done** — all checks passed (table in §3); the only untestable hop is the physical context-menu click itself (C6 note — Brave 156 suppresses the system menu for CDP input; deferred to the M8 net / a manual run). **No open M2 items remain.**
- **Brave ≠ Chrome** differences: the zombie-CDP-socket quirk (M1) is a Brave-156 observation; M8's net should treat "tab closed → socket never closes" as a known hazard. If the owner installs Chrome, re-run the M1 smoke once and note the delta in the log.
- **Flag §6-21(g) — RESOLVED (owner 2026-10-26)** — the progress docs move to `planning_docs/` and stay git-tracked on `cloud-migration` (negation in `.gitignore`); there is no `extension/rework` branch in this checkout — all work lands on `cloud-migration`.

## 7. How a fresh session resumes

1. `git log --oneline -8` on `cloud-migration` — expect the M2 set (`77709d6`, `57c33c7`, `b4ff40d`, `067770a`, + the docs commit) on top of the M1 set; working tree clean except gitignored files.
2. Read `planning_docs/extension_documention.md` (the M2 entry is the fine record — **all** acceptance results, including the browser run, are in its §6) + this file.
3. **M3 — the identity-surface frontend** (impl doc §4/§7 M3) — React + Vite, same-origin, WhiteNoise-served; OTP login (request → confirm → resend), registration, session context, fetch wrapper, the ~5-line sync-event emitter, one-line signed-in dashboard. Its prerequisites from M2 (vite origins in the allowlist, B0) are in. **First action at kickoff: confirm a working local email path for the OTP code** (console backend for local dev; anymail/Resend later — Railway blocks outbound SMTP) — without it the login flow can't be tested end-to-end.
4. Infra for testing (if a reboot killed it): `docker start ie-test-db` (pgvector, `127.0.0.1:5433`, pw `ie-test-pw`) + the backend on `:8080` with the `DB_*` overrides; M2's smoke harness is at `/private/var/folders/…/T/opencode/smoke/m2smoke.js` (**a reboot purges that scratch dir** — rebuild or seed it from the M8 net).
5. Keep both progress docs (in `planning_docs/`) updated as work progresses; never claim a test passed that was not run; commit per step.
