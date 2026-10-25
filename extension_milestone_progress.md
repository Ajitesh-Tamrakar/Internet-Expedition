# Extension rework — milestone progress

Companion to `extension_documention.md` (the §0.4 session log — per-task detail, actual test results, decisions, deviations). This file is the **one-screen status board**: milestone statuses, the next milestone's concrete entry point, and the cross-cutting state. Keep the two synchronized; when they disagree, the session log is the finer record.

Milestones per `planning_docs/extension_implementation.md` §7 (M1–M8).

## 1. Status at a glance (2026-10-25)

| Milestone | Title | Status |
|---|---|---|
| **M1** | Extension foundation: seed, vendor, strip | ✅ **Completed** (2026-10-25) — 5 commits + docs |
| **M2** | Extension core architecture: identity, floor, dev environment + CORS hardening (B0) | ▶ **Next** — first action below |
| M3 | Minimal frontend: the identity surface | ⬜ Not started |
| M4 | Extension session: consume-only auth wrapper + sync relay (step 0: SameSite probe) | ⬜ Not started |
| M5 | Submission: canonical capture, always-multipart POST, first real capture (M5a B2 → M5b) | ⬜ Not started |
| M6 | The popup + read-back (M6a B1 → M6b) | ⬜ Not started |
| M7 | Platform adapters: four tributaries + per-item media degradation (M7a B3 → M7b) | ⬜ Not started |
| M8 | Integration: the end-to-end flow as a repeatable regression net | ⬜ Not started |

## 2. M1 — what landed, and the evidence

Branch `extension/rework` (base `aeaeac3`); 6 commits after the docs commit:

| Commit | Content |
|---|---|
| `7337a1f` | copy v1 tree from `origin/main` (state C), excluding dead `content.js` — 27 files, diff = exactly that exclusion |
| `bf2e2fe` | vendor Readability 0.6.0 (tarball shasum `134e3ce3ff…` verified; 8 snapshot files out, 2 upstream + LICENSE + VENDOR.md in; manifest all_urls swap atomic) |
| `ec7b2da` | strip v1 note UI + setup flow from the confirmation core (atomic; JS 311→180, CSS 292→141) |
| `279c31d` | remove v1-only background code + the five setup call sites (228→144) |
| `b72270e` | drop `content_type` / `capture_method` envelope fields (universal −1, twitter −2, youtube −2, pinterest −6, linkedin −10) |
| (docs) | this file + `extension_documention.md` |

**Acceptance (impl doc M1) — actuals:** seed diff = the `content.js` exclusion only ✅ · vendor files byte-match the tarball, manifest load order preserved ✅ · `node --check` clean on every JS incl. vendor ✅ · orphan grep = exactly the 5 documented URL-literal survivors ✅ · manifest parses ✅ · load-unpacked smoke (Brave 156 stand-in for Chrome; fake backend, no real server): extension loads; canary 1 error-panel → neutral copy → zero `:8081` links → 10 s auto-dismiss, **passed twice, reproducible** (the note-UI surgery canary); canary 2 stub verified real (h1 read in the first run; launcher side-effect in later runs — see log §6/§9); canary 3 YouTube button injected, console clean ✅ · worker console shows the expected v1 flow (`Detected platform: web` → `Failed to fetch` on the dead `:8080`), no exceptions ✅.

**Post-M1 tree:** 23 files — `manifest.json`, `background.js`, `inject.js`, `content/` ×9, `icons/` ×5, `popup/` ×2 (v1 stub, byte-identical, dies in M6), `vendor/readability/` ×4.

## 3. M2 — next milestone (the concrete entry point)

Objective: the extension's floor exists and the extension is pointed at a backend — stable identity, config/storage, bus plumbing, dev environment, and the backend's CORS hardening (B0) so the first credentialed call (M4) is sound.

**First action:** generate the RSA keypair once; commit the base64 DER SPKI **public** key as `manifest.json`'s `key`; derive + record the stable extension ID in a comment block + the session log. **The private key is never committed but must be kept forever** — record its storage location in the log (Flag: one-shot; lose it → new ID → the CORS entry breaks).

Then, in order (impl doc §7 M2):
1. SaaS manifest step (atomic with `api_base_url` → pinned origin `https://internetexpedition.ajiteshtamrakar.com`; retire the two localhost patterns; drop `scripting`; drop the `icons/*` WAR entry; add the all_urls `exclude_matches` on the app origin. **No relay entry** — M4.)
2. `manifest.dev.json` + `dev/manifest-dev.sh` (local-origins twin, same key).
3. Config/storage in the worker: `getApiBaseUrl()` (per-manifest constant block), `getAccessToken()` / `setAccessToken()` (presence = state; callers arrive M4), merged `onInstalled` (seed `api_base_url` if absent + context menu).
4. Bus plumbing: the `listen(type, handler)` wrapper; migrate `SAVE` onto it (handler body still v1-shaped, URL now `{api_base_url}/captures/`); void `lastError` on all fire-and-forget sends incl. `CAPTURE_WEB`.
5. Context-menu origin guard (`tab.url?.startsWith(api_base_url)` → return).
6. **Backend B0** (`bookmark/settings.py`): one deduped `CORS_ALLOWED_ORIGINS` = [new ext ID, `http://localhost:5173`, `http://127.0.0.1:5173`]; `CORS_ALLOW_ALL_ORIGINS` → `DEBUG`-gated; keep `CORS_ALLOW_CREDENTIALS`; reword the stale comment. `.env` (gitignored): `JWT_AUTH_SAMESITE=Strict` explicit. **The SameSite probe itself is M4 step 0** (needs a session in the cookie jar — the M3 frontend).
7. Progress-log entry.

**M2 acceptance:** both manifests load (the SaaS one *expected* to `FETCH_ERROR` on saves — the pinned origin isn't deployed; record, don't chase); under the dev manifest against a locally-running backend, a save → ERROR panel showing **`code: 401`** (DRF reached — the atomicity proof); `chrome.storage.local` shows `api_base_url` and **only** that key; popup stub still opens; `DEBUG=0` CORS curl: evil origin → no `Access-Control-Allow-Origin`, ext-ID origin → reflected; orphan grep re-run (expected survivors: the "Bookmark" strings + `bookmark_id` reads only); **Django suite** `venv/bin/python manage.py test core` (needs a running Postgres w/ pgvector per AGENTS.md — if no DB is available locally, say so in the log rather than skip).

**Non-goals (M2):** no auth logic beyond the storage accessors (M4); no relay (M4); no popup changes (M6); no adapter remaps (M5/M7); no SameSite probe (M4); no deployment, no frontend.

## 4. M3–M8 — not started (one line each)

- **M3 — Minimal frontend (auth only):** React + Vite app that mints and destroys the shared session — OTP login (request → confirm → resend), registration, session context, fetch wrapper, the ~5-line sync-event emitter, a one-line signed-in dashboard. The **only** frontend work in this plan; prerequisite for M4's testing.
- **M4 — Extension session:** derive the access token from the shared HttpOnly refresh cookie, one-401-derive-one-retry on every data call, sign-in-required recovery (open the frontend), global sign-out, live flips via the sync relay. Step 0 = the SameSite probe (experiment, not assumption) — it decides where all later local credentialed testing runs.
- **M5 — Submission:** M5a backend B2 (the `file:image:0` part reader — must land first or the first live submission silently drops every screenshot) → M5b the canonical capture + always-multipart `POST /captures/` → the **first real end-to-end capture**.
- **M6 — Popup + read-back:** M6a backend B1 (`source_url` persisted + returned) → M6b the real popup (sign-in state w/ email via the `USER` pass-through, library, submit-on-Enter search) — this retires M1's popup stub.
- **M7 — Platform adapters:** M7a backend B3 (per-item media degradation) → M7b the four tributaries (X/Twitter, YouTube, Pinterest, LinkedIn) with v1 extraction quality intact.
- **M8 — Integration:** the completion criterion — the working end-to-end flow across all three components as a repeatable regression net. (The scratch CDP smoke harness from M1 is the natural seed for it; the Brave-156 zombie-socket quirk is logged for the net's design.)

## 5. Cross-cutting state

- **Branch:** `extension/rework` off `aeaeac3` (cloud-migration). Working tree clean (after the M1 docs commit).
- **Repo pins:** `origin/main` = `29a8596aa4…` (v1 state C); `HEAD:core` = `90cb9c2…`; `HEAD:bookmark` = `7ba22b2…` — all re-verified at M1 step 0.
- **Environment:** Python 3.11 venv at `venv/`; tests need a running Postgres w/ pgvector (AGENTS.md); `.env` present (GEMINI_API_KEY set; the checkout points at Supabase via `DB_*`). **Chrome is not installed** — the M1 smoke ran in Brave 156 (Chrome 156 under the hood); a future session wanting the smoke again: scratch harness + fake backend live at `/private/var/folders/nc/hmk4s7z51kz7s2yxwxczsl900000gn/T/opencode/smoke/` (survives until the temp dir is purged), Brave relaunch command in the session log.
- **Planned origin:** `https://internetexpedition.ajiteshtamrakar.com` (pinned in the SaaS manifest from M2; the origin itself is **not** deployed — P3 parked, impl doc §0.3).
- **Docs:** `planning_docs/` is gitignored (local to this checkout); the two root progress docs are git-tracked on the branch.

## 6. Risks / open items carried forward

- **The private key is single-point-of-failure** (M2): one-shot; its storage location is recorded in the session log at generation.
- **M2's local-backend acceptance needs a running Postgres** — if the Supabase `.env` target is unreachable from this machine at that time, the log must say so (the suite is offline-mocked except the DB; a local Postgres is the fallback).
- **Brave ≠ Chrome** differences: the zombie-CDP-socket quirk (M1) is a Brave-156 observation; M8's net should treat "tab closed → socket never closes" as a known hazard. If the owner installs Chrome, re-run the M1 smoke once and note the delta in the log.
- **Flag §6-21(g)** — the session log's local-only alternative: the owner may still prefer it; one-line gitignore change either way.

## 7. How a fresh session resumes

1. `git log --oneline -8` on `extension/rework` — expect the 6 M1 commits above; working tree clean.
2. Read `extension_documention.md` (the M1 entry is the fine record) + this file.
3. Start **M2** at "First action" in §3. The impl doc `planning_docs/extension_implementation.md` §7 M2 + the rework doc's manifest / config / floor blocks are the line-level specs — read them before writing code.
4. Keep both root docs updated as work progresses; never claim a test passed that was not run; commit per step.
