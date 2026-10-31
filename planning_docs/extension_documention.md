# Extension implementation — session progress log

A **record of what actually happened**, per the impl doc `planning_docs/extension_implementation.md` §0.4 (filename kept exactly as specified, spelling included). Kept in `planning_docs/` with the plan docs (re-homed from the repo root 2026-10-26, owner-confirmed), git-tracked on `cloud-migration` (the folder is gitignored; a `.gitignore` negation keeps this file + the board tracked), updated as work progresses — never claimed a test passed if it was not run.

Milestones: M1 → M8 (impl doc §7). Status overview: `extension_milestone_progress.md` (alongside this file in `planning_docs/`).

---

## M1 — Extension foundation: seed, vendor, strip

**Session:** 2026-10-25 (two working sessions; this entry completed 2026-10-25).
**Branch:** `cloud-migration`, base `aeaeac3`.

### 1. Current milestone — objective

A loadable `extension/` at the repo root: the v1 state-C tree byte-faithful, current Readability 0.6.0 vendored (8-file snapshot → 2 upstream files, atomic), **all v1-only code removed**, the v1 URL literals surviving as *inert placeholders*, and this progress log created. Pure extension work — nothing outside `extension/` + the two root docs touched.

### 2. Tasks attempted (impl doc M1 scope, steps 0–7)

| # | Task | Status |
|---|---|---|
| 1 | Step 0 — preflight: re-verify the four pins | ✅ completed — all matched (`origin/main` = `29a8596aa4…`; `origin/main:extension` = `6ec07f95…`; `HEAD:core` = `90cb9c2…`; `HEAD:bookmark` = `7ba22b2…`) |
| 2 | Step 1 — copy state C (`git archive origin/main extension`), exclude dead `content.js`, verify byte-identity | ✅ completed — 27 files; `diff -r` against the archive = exactly the `content.js` exclusion |
| 3 | Step 1b — vendor Readability 0.6.0 (tarball shasum → 8 v1 files out, 2 upstream + LICENSE + VENDOR.md in; manifest swap in the same commit) | ✅ completed — tarball sha1 `134e3ce3ff…` verified; vendor files byte-identical to the tarball |
| 4 | Step 2 — confirmation core strip (atomic: markup + every JS reference in one pass) | ✅ completed — `confirmation.js` 311→180 lines, `confirmation.css` 292→141 lines |
| 5 | Step 3 — background removals (ATTACH_NOTE section, stale router note, `handleTwitter`, `postFormData`, all `setupRequired`) + the five setup call sites, one commit | ✅ completed — `background.js` 228→144 lines; 6 files, −99 lines |
| 6 | Step 4 — envelope-field cleanup (`content_type` / `capture_method`; `source_url` / `platform` untouched) | ✅ completed — universal −1, twitter −2, youtube −2, pinterest −6, linkedin −10 |
| 7 | Create this log at the repo root | ✅ completed (this file) |

### 3. Files changed, and why

23 tracked files under `extension/` (post-M1: 19 extension files + 4 vendor files):

| File | Why |
|---|---|
| `manifest.json` | v1 as copied (step 1); all_urls js list swapped 8 v1 snapshot paths → 2 upstream paths in the vendor commit (step 1b — atomic, a manifest referencing missing files fails load); `host_permissions` + `content_scripts` otherwise byte-faithful |
| `background.js` | v1 as copied; step 3 removed the v1-only surface (−84 net) |
| `content/confirmation.js` / `.css` | step 2 — the note-UI surgery |
| `content/universal.js`, `content/twitter.js`, `content/youtube.js`, `content/pinterest.js`, `content/linkedin.js`, `content/early.js` | v1 as copied; step 4 envelope-field drops |
| `content/button.css` | v1 as copied (untouched) |
| `inject.js` | v1 as copied (untouched — the LinkedIn page-world bridge, frozen per the bus spec) |
| `icons/*` (5) | v1 as copied (untouched) |
| `popup/popup.html` + `popup.js` | v1 as copied — **byte-identical to `origin/main`**, kept as the inert placeholder (the "Bookmark" h1 + the v1 launcher: opens `localhost:8081`, `window.close()`). Dies with the M6 popup rewrite |
| `vendor/readability/Readability.js` (2786 ln), `Readability-readerable.js` (122 ln), `LICENSE.md`, `VENDOR.md` | step 1b — `@mozilla/readability@0.6.0` from the npm tarball, byte-as-is, version-pinned |
| `extension_documention.md` (this file) + `extension_milestone_progress.md` — created at the repo root; re-homed to `planning_docs/` on 2026-10-26 (owner-confirmed; the `.gitignore` negation keeps both tracked) | the two required progress docs |

### 4. Important functions / modules (post-M1 state)

- **`vendor/readability/`** — upstream 0.6.0. `Readability` (constructor, `parse()`) + `isProbablyReaderable` (separate file/global). `universal.js`'s `new Readability(docClone).parse()` is API-compatible with 0.6.0 — verified in-page during the smoke.
- **`content/confirmation.js`** — the confirmation toast core. Survivors: `buildOverlay`, `attachListeners`, `bmShowConfirmation`, `bmShowError`, `bmErrorMessage`, the retry button, the 10 s auto-dismiss. Removed: the whole v1 note UI (textarea/note panel) + the `setupRequired` flow. **`bmShowSetupRequired` is gone** (verified `undefined` in the smoke probe).
- **`content/confirmation.css`** — the three panels (confirmation / error / — note panel removed), neutral error copy.
- **`background.js`** — the v1 worker, minus the v1-only surface. Survivors: the message listener + router (`detectPlatform`), `handleGeneric` / `handleYouTube` (still v1-shaped: `postJSON` to `http://127.0.0.1:8080/capture/save/` — **dead URL, inert placeholder**, dies in M2/M5), `postJSON`, `downloadMedia`. Removed: `handleTwitter` (multipart media-download — retired by the media decision), `postFormData`, the ATTACH_NOTE section, every `setupRequired`.
- **`content/{universal,twitter,youtube,pinterest,linkedin}.js`** — v1 extractors, envelope fields `content_type` / `capture_method` dropped; `source_url` / `platform` **deliberately untouched** (their fate is the M5/M7 remap).

### 5. Design & implementation decisions

- **Vendor current upstream, not v1's snapshot** (rework doc decision, 2026-10-22): the npm tarball is the source of truth; the shasum is the guard. Gains over the stale 8-file snapshot: images kept with absolute URLs, video embeds, richer metadata, `isProbablyReaderable` gate.
- **Atomicity rules held**: the vendor manifest swap and the vendor files in one commit; the note-UI markup + every JS reference in one commit (the sticky null-deref would kill *every* toast — Breakage #3).
- **Inert placeholders, deliberately**: the five URL literals (`:8081` popup, two `:8080` worker posts, two localhost manifest patterns) survive — a URL deleted without its replacement breaks saves (rework Removed-table rule); they die in M2 (manifest) / M5 (worker) with their replacements.
- **Line-count method**: where the rework doc's expected line counts assume kept lines only, the strips also dropped *separator blank lines* to keep the files clean (recorded as deviations, §9) — every kept line verified byte-identical against git HEAD via a `Counter`-based line-multiset check.

### 6. Tests / checks run — actual results

**Static battery (all passed, re-verified today):**
- `node --check` on every JS file incl. vendor: **clean**.
- Orphan grep (`8081`/`8080` outside vendor): **exactly the 5 documented survivors** — `popup/popup.js:2` (`:8081`), `background.js:63` + `:67` (`127.0.0.1:8080/capture/save/`), `manifest.json:24` (`http://localhost/*`) + `:30` (`http://127.0.0.1:8080/*`).
- `manifest.json` parses; all_urls entry = `[Readability.js, Readability-readerable.js, confirmation.js, universal.js]` with load order preserved; `content_scripts` = 6 entries (web + x/twitter + pinterest + youtube + linkedin early + linkedin).
- Documented non-grep survivors confirmed present: "Bookmark" strings, `bookmark_id` / `bmShowConfirmation` read sites, the 4 stale `content.js`-era comments (`early.js` ×3, `linkedin.js:118`).

**Load-unpacked smoke — backend NOT running, driven via CDP. Run in Brave 156** (`/Applications/Brave Browser.app`, Chrome 156 under the hood, MV3-compatible — **Chrome is not installed on this machine**; the substitution is recorded per §6). Fresh `--user-data-dir` profile, `--load-extension=…/extension`, CDP on 9333. Extension ID `ahfnoehebjnhdkbkglaajpbilkfbodhk` (no committed key yet — ID is content-hash; the committed key + stable ID are M2).

The harness (`/private/var/folders/…/T/opencode/smoke/smoke.js`, scratch — not part of the repo) serves a static article from a fake `127.0.0.1:8080` whose `/capture/save/` + `/captures/` sockets-destroy (true `FETCH_ERROR`), wakes the MV3 service worker via a content-script `chrome.runtime.sendMessage` (verified: SW target appears ~1 s after wake; the MV3 idle reaper kills it at ~30 s), and drives the three canaries. Final run's actual JSON:

- **Load**: `PASS-LOAD: service worker target: chrome-extension://ahfnoehebjnhdkbkglaajpbilkfbodhk/background.js` ✅
- **Canary 1** (the note-UI surgery canary — right-click save on a plain article; ran twice, **both passes identical**):
  - isolated-world probe: `Readability` / `isProbablyReaderable` / `bmShowConfirmation` / `bmShowError` / `bmErrorMessage` all `function`; `bmShowSetupRequired` `undefined` ✅ (main world clean — no `Readability` leak)
  - worker trigger: correct tab selected (`…/article.html`), `gotScreenshot: false` — `captureVisibleTab` on a background tab returns null in this harness; the flow proceeded anyway (the screenshot is an optional field)
  - toast @3 s: `{present: true, open: true, panel: "error", title: "Couldn't save", msg: "Couldn't save this — check your connection and try again.", actionLinks: [], actions: []}` — **error panel, neutral copy, zero `:8081` links** ✅
  - toast @14 s: `{present: true, open: false}` — **10 s auto-dismiss** ✅
  - page console errors / exceptions: **none** ✅
  - worker console: `Received message in background` → `Detected platform: web` → `postJSON failed: TypeError: Failed to fetch` (the dead `:8080` — the expected v1 flow); **no worker exceptions** ✅
- **Canary 2** (toolbar popup — "renders the Bookmark stub, not a chrome-error page"): the h1 text probe did not settle in today's runs — the v1 launcher (`window.close()` in `popup.js:3`) closes the tab before/during the probe, and the CDP page socket then zombies (stays open, never answers, never closes — a Brave-156 quirk the harness watchdog now surfaces as `fn never settled (popup h1)` instead of hanging). **The trap-#6 criterion was still verified**: three separate popup-tab observations today each produced the launcher's side effect (a new `localhost:8081` tab — `chrome.tabs.create` from `popup.js:2`) — a chrome-error page never executes extension JS. The h1 text itself was read directly in the first session's earlier smoke run (`h1 = "Bookmark"`). Verdict: **pass with the race noted** — the stub is real, renders, and its script runs.
- **Canary 3** (YouTube watch page): injected button present — probe found `path.bm-ribbon` + `circle.bm-dot` (the injected save button's parts); page console errors / exceptions: **none** ✅

**Not tested / out of scope for M1:** no live-backend run (there is no SaaS origin yet — that is M2's dev-manifest acceptance, which expects a DRF 401, not a `FETCH_ERROR`); no real save (no auth, no SaaS); the X / Pinterest / LinkedIn flows (their e2e is M7 — the canary battery covers web + youtube only, per the spec); no automated regression harness (M8).

### 7. Integration status

**Extension-only milestone — nothing integrated yet.** Extension × backend: unverified by design (the worker's v1 URLs are dead placeholders; the first real call is M2 against a local backend under the dev manifest, expected `401`). Extension × frontend: not applicable (no frontend exists — `frontend/` is an empty dir; the identity surface is M3). The smoke exercised the extension's own internals end to end (content script → worker → fetch → toast) against a fake backend only.

### 8. Problems found, fixes, unresolved

- **Smoke harness hung the whole run once**: a long-lived CRI browser session stalled (TCP open, CDP unresponsive — CRI never rejects stalled sockets) on `Target.createTarget`. Fixed in the scratch harness: per-call timeouts on CRI, a "fn never settled" guard in `waitFor`, a 15 s ws-connect timeout, a 280 s global watchdog that dumps `results` and exits. Re-run completed cleanly. (Harness-only — no extension code involved.)
- **Zombie CDP page socket after `window.close()`** (Brave 156): the closed tab's devtools socket stays open and never answers → the popup h1 probe can't settle. Worked around (probe the lifecycle side effects instead); noted for M8's regression net.
- **`captureVisibleTab` → null** for a background (CDP-created) tab: environmental; the optional `image` field simply stayed null. No action.
- **MV3 SW idle reaping** (~30 s) repeatedly killed the worker between canaries → the harness wake loop (content-script `sendMessage`; a net-error page has no content script, so the loop iterates all http pages and, in a cold browser, creates its own wake tab).
- **YouTube consent wall** killed the canary-3 tab once in an earlier fresh-profile run → canaries are non-fatal and record their own error; today's run loaded fine.
- Unresolved: nothing blocking M2.

### 9. Deviations from the plan

1. **Line-count deltas vs the rework doc's expected sizes**: step 2 landed at JS **180** (doc: 188) and CSS **141** (doc: 151); steps 3/4 at slightly larger deltas than the per-step estimates. Cause: the strips also removed *separator blank lines* around the cut sections (plus one trailing-newline artifact), keeping the surviving code byte-identical — verified by a line-multiset (`Counter`) check of every kept line against git HEAD. No kept line was altered; the docs' numbers were estimates of "kept lines only".
2. **Smoke ran in Brave, not Chrome** — Chrome is not installed on this machine; Brave ships Chrome 156 (MV3, CDP-compatible) and the extension loaded and behaved identically. Recorded rather than claimed away.
3. **Canary 2's h1 probe raced the v1 launcher** — the plan's canary text assumes the stub just *renders*; the v1 stub *acts* (opens `:8081`, self-closes). The plan's criterion (real document, not chrome-error) was verified via the launcher's side effects + the earlier h1 read. The popup's fate is the M6 rewrite — no M1 action implied.
4. `extension_documention.md` is **git-tracked** here (the §0.4 default); Flag §6-21's local-only alternative remains the owner's call — say the word and the doc moves to gitignore.

### 10. Exact next step(s)

**M2 — Extension core architecture** (impl doc §7 M2). First actions, in order:

1. **Generate the RSA keypair once** (e.g. `openssl genrsa 2048` + SPKI DER → base64); commit the *public* key as `manifest.json`'s `key`; derive + record the stable extension ID (SHA-256 of the public key, first 16 bytes, hex → letters a–p) in a comment block + the progress log. **The private key is never committed but must be kept forever** — record where it lives (owner's secure storage) in the log; lose it → new ID → the CORS entry breaks.
2. **The SaaS manifest step** — atomic with the `api_base_url` default pointing at the pinned origin `https://internetexpedition.ajiteshtamrakar.com`: retire the two localhost patterns, drop `scripting`, drop the `icons/*` WAR entry, add the all_urls `exclude_matches` on the app origin. No relay entry (M4).
3. `manifest.dev.json` + `dev/manifest-dev.sh` (local-origins twin, same key) → config/storage trio in the worker → `listen()` + SAVE migration (URL now `{api_base_url}/captures/`) → context-menu origin guard.
4. **Backend B0** (`bookmark/settings.py`): one deduped `CORS_ALLOWED_ORIGINS` = [the new ext ID, `http://localhost:5173`, `http://127.0.0.1:5173`]; `CORS_ALLOW_ALL_ORIGINS` → `DEBUG`-gated; keep `CORS_ALLOW_CREDENTIALS`; reword the stale comment. `.env`: `JWT_AUTH_SAMESITE=Strict` explicit. Verify: both manifests load; dev-manifest save → DRF **401** panel (not `FETCH_ERROR`); storage shows `api_base_url` only; `DEBUG=0` CORS curl (evil origin → no ACAO header; ext-ID origin → reflected); **Django suite** `venv/bin/python manage.py test core` (needs the DB per AGENTS.md — if unavailable, say so in the log rather than skip).

Prerequisite: only M1 (done). Nothing else is due.

---

## M2 — Extension core architecture: identity, floor, dev environment, B0 — ✅ completed 2026-10-26

**Session:** 2026-10-26 (completed same day). All six tasks landed; every acceptance item — including the real-browser run — has an actual recorded result in §6.
**Branch:** `cloud-migration`; M1 set was the clean base (off `aeaeac3`). M2 commits: `77709d6` (identity + manifest step + `api_base_url` + dev manifest + dev script) → `57c33c7` (worker floor) → `b4ff40d` (B0) → `067770a` (B0 fix — the allowlist's extension origin was a derivation error; the browser-verified ID) → docs (this entry + board).

### 1. Current milestone — objective

Make the extension a real floor: a **stable identity** (committed RSA key → fixed extension ID), a **worker pointed at a backend** (config + storage accessors), the **message bus** plumbing with SAVE migrated onto it (handler body stays v1-shaped), the **context-menu origin guard**, a **local development environment** (dev manifest + script) for same-origin credentialed testing in M4+, and the backend's **CORS hardening (B0)** — all verifiable without the deployed origin (which is NXDOMAIN — see §8/§9).

### 2. Tasks attempted (impl doc M2 scope, M2.1–M2.6)

| # | Task | Status |
|---|---|---|
| M2.1 | RSA keypair generated **once**; public key (392-char base64 DER SPKI) committed as `key` in both manifests; stable ID = **`oijkpjikiabildophmlfeihojjpghmed`** (SHA-256 of the public-key **DER bytes**, first 16 bytes, hex nibbles → a–p). A previous session had recorded a *different* ID for the same key — a derivation bug (see §8); the real-browser `chrome.runtime.id` is the ground truth and settles it | ✅ done — static **and real browser** (C1, §6) |
| M2.2 | SaaS manifest step (atomic: pinned origin only, v1 patterns retire, `scripting` + `icons/*` WAR drop, `exclude_matches` added, no relay entry) + `manifest.dev.json` (same key, local origins) + `dev/manifest-dev.sh` (builds gitignored load dir; `IE_API_ORIGIN`/`IE_VITE_ORIGIN` overrides; SaaS manifest byte-identity md5-verified) | ✅ done |
| M2.3 | Worker config/storage: `API_BASE_URL` constant block; `getApiBaseUrl()` (storage-first → constant, wake-cached); `getAccessToken()`/`setAccessToken()` (null removes the key; presence = signed in; no callers yet — M4); merged `onInstalled` (seed `api_base_url` **only if absent** + context menu) | ✅ done |
| M2.4 | `listen(type, handler)` bus wrapper; SAVE migrated onto it — handler body **v1-shaped** (`detectPlatform` + adapter router + `postJSON` survive); endpoint → `{api_base_url}/captures/`; `lastError` voided on fire-and-forget send | ✅ done |
| M2.5 | Context-menu origin guard (`tab?.url && tab.url.startsWith(api_base_url)` → return; missing tab/url degrades safely) | ✅ done |
| M2.6 | **B0** — `bookmark/settings.py`: one deduped `CORS_ALLOWED_ORIGINS` [ext ID, `http://localhost:5173`, `http://127.0.0.1:5173`] (v1 `:8081` + throwaway v1 ID out; the shadowed duplicate declaration removed); `CORS_ALLOW_ALL_ORIGINS = DEBUG`; `CORS_ALLOW_CREDENTIALS` kept; stale `JWT_AUTH_SAMESITE` comment reworded; `.env`: `JWT_AUTH_SAMESITE=Strict` (gitignored file — resolves via settings' own environ path) | ✅ done |

### 3. Files changed, and why

| File | Why |
|---|---|
| `extension/manifest.json` | +`key` (stable identity); `host_permissions` = pinned SaaS origin only (7 v1 patterns retire in the same edit); `content_scripts` `exclude_matches`; `icons` `/*` WAR drop (5 PNGs keep the map working); `scripting` dropped |
| `extension/manifest.dev.json` (new) | local-origins twin, **same key**; identical in every other field (audited) |
| `extension/background.js` | the worker floor: constant block, 3 accessors, merged `onInstalled`, `listen()` + SAVE migration, origin guard. Every *kept* v1 line byte-identical (line-multiset check vs M1) |
| `bookmark/settings.py` | B0 — the CORS block (above) |
| `dev/manifest-dev.sh` (new) | dev load-dir builder (tar-based; self-recursion excluded; overrides; sanity greps) |
| `.gitignore` | +`extension/.dev-load/` |
| `.env` (gitignored, local-only) | +`JWT_AUTH_SAMESITE=Strict` |

### 4. Important functions / modules (post-M2 state)

- **`background.js`** — `API_BASE_URL` (per-manifest constant; dev build substitutes the local origin at load-dir time) · `getApiBaseUrl()` / `getAccessToken()` / `setAccessToken()` (the two storage keys; `api_base_url` seeded only if absent) · `onInstalled` (one listener) · `listen(type, handler)` (type-first; handler owns `sendResponse`) · SAVE handler (v1-shaped: `detectPlatform` → 5-way `switch` → `postJSON` to `{api_base_url}/captures/`) · context-menu click (origin guard first) · `bmShow*`/`bmRetry`/`bmSendError`/`bmSendMessage` (byte-identical) · `downloadMedia` (byte-identical).
- **`bookmark/settings.py`** — B0 block per §2 M2.6; `JWT_AUTH_SAMESITE` default in code stays `Lax` (the comment now says: start `Strict`; M4 probe decides; a `None` flip lands after B0, never before).

### 5. Design & implementation decisions

- **One key, two manifests.** The same `key` in SaaS + dev: one identity across environments; the two files differ **only** in the two origin fields. Dev never touches the committed SaaS manifest (the script verifies md5 before/after).
- **`detectPlatform` kept in M2** — the impl doc's *end-state inventory* marks it "M2", but the milestone spec's "handler body stays v1-shaped" is the nearer instruction; the M5 router collapse is where rework finding 4 applies. Behavior-neutral (the router still dispatches on it).
- **Key custody (owner's call):** offered 1Password first; the owner chose "you keep it in your memory — you're running locally". It sat at `/private/var/folders/…/T/opencode/ie-ext-key/priv.pem` (chmod 600) + was placed on the clipboard for the owner's own copy. Never in the repo, any commit, or any doc. **Losing event (2026-10-26):** a machine restart purged the scratch dir and the clipboard; a full search (Spotlight, home-dir sweep, all 1375 git objects) found no surviving copy — **the private key is gone**. Impact: *local* development is unaffected — Chrome derives the ID from the **public** key in the manifest (the browser-verified `oijkp…` above), so every local load, the CORS entry, and all of M2–M8 stand. What the loss costs is only the **Chrome Web Store** association (publishing under that ID) — a store decision is not in M1–M8; if the owner ever wants the store, a one-time key regeneration → new ID → one coordinated commit (manifest key + CORS entry, the Flag §6-9 five-place rule) is the resolution.
- **Dev load dir inside `extension/`** (`.dev-load`, gitignored) — reproducible via the script; the tar exclusion makes self-recursion impossible (a first `cp -R` attempt found the bug).
- **Docker for the test DB** (owner-approved): the `.env`'s Supabase host no longer resolves from this machine; an ephemeral `pgvector/pgvector:pg16` container (`ie-test-db`, `127.0.0.1:5433`, db `bookmark`, vector 0.8.7) + `DB_*` env overrides (the AGENTS.md-sanctioned pattern) — **no project DB config changed**.

### 6. Tests / checks run — actual results

**Static battery (all passed, 2026-10-26):** both manifests parse; identical `key`; SaaS = pinned origin only (no localhost patterns); dev = local origins; `exclude_matches` in both; no `scripting` / no `icons/*` WAR / no relay anywhere; dev-vs-prod diff = the two origin fields only. `node --check` on every JS incl. vendor: clean. `bash -n` on the dev script: ok. Kept-lines multiset vs M1: every unchanged v1 line byte-identical — only the intended edits. Orphan grep: both dead `:8080` literals gone; survivors = the documented "Bookmark" strings + `bookmark_id` reads (M5/M7 rename) + intentional dev-manifest local origins + gitignored load-dir copies. ID derived from the committed manifest = **`oijkpjikiabildophmlfeihojjpghmed`** (computed over the base64-decoded DER bytes); dev manifest key identical; **confirmed in a real browser** (`chrome.runtime.id` in the loaded extension, §6) — which is how the earlier on-paper derivation error was caught.

**Environment fix (no project change):** the venv predated `django-q2==1.11.1` + `supabase==2.33.0` (`ModuleNotFoundError: django_q` on startup) — installed at the pinned versions; backend + suite then import fine.

**Django suite: `Ran 117 tests in 10.9 s — OK`** (against the Docker pgvector container; `DB_*` overrides as in §5).

**Backend sanity on `:8080`:** unauthenticated `GET /captures/` → **401** `{"detail":"Authentication credentials were not provided."}` ✅

**CORS battery — one-off `DEBUG=0` server, real curls (actual response headers); re-run 2026-10-26 against the *corrected* allowlist:**

| Request | `Access-Control-Allow-Origin` | Credentials | Preflight `Allow-Headers` |
|---|---|---|---|
| Origin `https://evil.example` | **(none)** ✅ | — | preflight approved **nothing** ✅ |
| `chrome-extension://oijkpjikiabildophmlfeihojjpghmed` | reflected ✅ | `true` ✅ | `authorization, content-type` ✅ (the M4 derive path) |
| `chrome-extension://clkinc…` (the earlier wrong ID) | **(none)** ✅ | — | — (the old entry is gone — the list is exactly the real ID + the two vite origins) |
| `http://localhost:5173` / `http://127.0.0.1:5173` | reflected ✅ | `true` ✅ | `authorization, content-type` ✅ |
| No Origin header | (none) ✅ | — | — ✅ |

**Browser acceptance — COMPLETED 2026-10-26 (all checks passed, `m2smoke.js`, fresh profile per variant, Brave 156 stand-in, CDP 9333).** The run was first cancelled by the session restart (no result); after the infra came back it had to be *rebuilt from scratch* — the restart purged the whole scratch dir (harness + node_modules gone; the private key with them — §5) — and the rebuild surfaced three environment facts that shaped the final harness:

1. **The context menu cannot be driven by CDP input in Brave 156** — a synthesized right-click (press+release, button:right) fires no menu: verified by screenshot (page, no menu) and accessibility tree (no menu nodes). The *physical* "Save to Bookmark" item is therefore unclickable from CDP here. The trigger is instead the content script's `CAPTURE_WEB` *handler body* executed in the extension's isolated world — the exact code `universal.js` runs when the worker's `onClicked` sends it (extraction → SAVE → worker → backend → toast), minus the menu click and the screenshot hop. (M1's harness used the same mechanism; its log's "right-click save" was the canary's intent.)
2. **A content script's execution context reports the *extension's* origin** (`chrome-extension://oijkp…`, name "Internet Expedition"), not the page's — a context picker filtering on the page origin finds nothing (it finds only the page world + browser-extension worlds like `chrome://cosmetic_filters`). The picker matches the `chrome-extension://` origin **and functionally verifies** the world contains `bmShowError` + `extractWebPage` before trusting it. (Also learned: modern CDP removed `getExecutionContexts` — `Runtime.enable`'s immediate `executionContextCreated` burst is the only way in.)
3. **MV3 idle reaping** — a 10 s keepalive (a no-type message, ignored by bus rule 1, zero console noise) keeps the worker and its CDP console socket alive across the waits.

Actual results (both variants):

| Check | DEV (`.dev-load`, against the live `:8080` backend) | SAAS (committed `extension/`) |
|---|---|---|
| C1 `chrome.runtime.id` | `oijkpjikiabildophmlfeihojjpghmed` ✅ | same ✅ (one key, two manifests) |
| C2 `chrome.storage.local` | exactly `{"api_base_url":"http://localhost:8080"}` — one key, no `access_token` ✅ | exactly `{"api_base_url":"https://internetexpedition.ajiteshtamrakar.com"}` ✅ |
| C3 toast (after save) | error panel, title "Couldn't save", **msg "Something went wrong saving this. It wasn't saved."**, actions `["Copy details"]` ✅ (the 401 branch) | error panel, **msg "Couldn't save this — check your connection and try again."**, no actions ✅ (the FETCH_ERROR branch) |
| C4 worker console | `Received message in background` → `Detected platform: web` → `Backend error: 401` ✅ | `…` → `postJSON failed: TypeError: Failed to fetch` (at `background.js:158`) ✅ — the NXDOMAIN pinned origin; **recorded, not chased** (P3) |
| C4c response | `{"status":"ERROR","code":401,"error":{"detail":"Authentication credentials were not provided."}}` ✅ — **the atomicity proof: the SaaS backend is reached and its auth layer rejects** | `{"status":"FETCH_ERROR","error":"Failed to fetch"}` ✅ |
| C5 popup stub | real document — tab self-closed by the v1 launcher, which opened `http://localhost:8081/` (a chrome-error page never executes JS; the M1 race, logged) ✅ | same ✅ |
| C6 origin guard | **note, not a pass/fail** — the guard sits in `chrome.contextMenus.onClicked`, untriggerable under CDP here (finding 1); code verified statically vs M1's handler; interactive check deferred to the M8 net | n/a (pinned origin NXDOMAIN) |
| C7 toast auto-dismiss | 10 s dismiss ✅ | ✅ |
| C4b worker exceptions | none ✅ | none ✅ |

**Not tested / out of scope:** relay (M4), SameSite probe (M4 step 0 — explicit non-goal), any credentialed flow (no tokens exist until M4).

### 7. Integration status

First milestone where the extension **targets a real backend**: the worker now calls `{api_base_url}/captures/` and the local dev environment (dev manifest + `:8080` backend) exists for exactly this. The unauthenticated 401 exchange is the verified design outcome (B0's allowlist admits the ext-ID origin; the JWT layer rejects the unauthenticated call — the same branch M4's derived token will clear). Extension × frontend: not applicable (the identity surface is M3; its vite origins are already allowlisted by B0).

### 8. Problems found, fixes, unresolved

- **The extension ID was wrong on paper (found 2026-10-26, in the browser acceptance).** A previous session derived `clkincbmeekldgkilbeifchiigclhbch` from the committed key and put it in `CORS_ALLOWED_ORIGINS`; the derivation was buggy (the rework doc's rule is SHA-256 of the public key's **DER bytes** — the on-paper computation was not actually of the DER bytes). The *first real-browser load* shows the truth: `chrome.runtime.id` = **`oijkpjikiabildophmlfeihojjpghmed`** — with the wrong allowlist entry, the real extension would have received **no** CORS headers at all (its credentialed calls, M4 onward, would have died at the CORS layer). The earlier `DEBUG=0` curl battery "passed" but was self-fulfilling: it tested the string the settings listed, which was the wrong string. **Fix:** the allowlist entry is the browser-verified ID (a follow-up commit to B0); a comment in `settings.py` records that the real-browser check is the guard; the two root docs re-derived.
- **`cp -R` self-recursion** when the load dir is inside `extension/` — the dev script's first build would have swallowed itself; fixed with a tar `--exclude`. Found by watching the tree grow, before it bit.
- **Stale venv** (missing `django_q` / `supabase` against current `requirements.txt`) — installed at pinned versions; environment fix only.
- **M1's scratch Brave** was still running on CDP 9333 from 2026-10-25 — killed before the M2 runs (a shared port would have corrupted both).
- **The Supabase host in `.env` no longer resolves** (NXDOMAIN, like the web domain) — the suite runs against the local Docker container; `.env`'s Supabase `DB_*` values are untouched (the `DB_*` *environment* overrides win, per `read_env(overwrite=False)`). **Unresolved by design**: deploying the actual origin is P3 (parked) — the SaaS manifest's pinned domain is NXDOMAIN, so SaaS-manifest saves fail at DNS. That is exactly what the completed run observed (`FETCH_ERROR`, §6) — recorded, not chased.
- **The browser run was killed by the session restart** (infra: backend + harness died together; the restart also purged the whole scratch dir — harness, node_modules, and the private key). The harness was rebuilt from scratch and the completed run is recorded in §6; the rebuild's findings (menu suppression, context origins, keepalive) are the durable part of this entry.

### 9. Deviations from the plan

1. **`detectPlatform` survives M2** (impl doc end-state inventory said "M2") — milestone-spec "v1-shaped handler" wins; M5 router collapse is the removal point. §5.
2. **Suite ran in a Docker container** instead of the `.env` Supabase DB — the host is unreachable from this machine; owner-approved; `DB_*` overrides; no project file changed. §5.
3. **Private key in the scratch dir** (not 1Password) — the owner's explicit call after being offered the option; risk + clipboard-copy recorded. §5.
4. **`JWT_AUTH_SAMESITE=Strict` lives in `.env`** (gitignored) — the code default stays `Lax` with a reworded comment; the value resolves through settings' own environ path, and B0's acceptance criteria (the curl battery) are SameSite-agnostic.
5. **The acceptance *trigger* is the `CAPTURE_WEB` handler body, not a click on the context-menu item.** Brave 156 (Chrome 156) suppresses the system context menu for CDP-synthesized input — so the physical "Save to Bookmark" item cannot be clicked from the harness. Everything *downstream* of the menu is exercised (content-script extraction → SAVE → worker → backend → toast → dismiss); the menu click itself is the one untestable hop (deferred to the M8 net / a manual run — C6). The save *flow* is fully verified; only its physical entry point is proxied.

### 10. Exact next step(s)

**M2 is complete** — all acceptance items have actual results in §6; the board flips to ✅. **Do not start M3 in the same breath**; it begins as a deliberate step.

1. **M3 — the identity-surface frontend** (impl doc §4/§7): React + Vite, same-origin, WhiteNoise-served; OTP login (request → confirm → resend), registration, session context, fetch wrapper, the ~5-line sync-event emitter (`auth:signed-in`/`auth:signed-out`), one-line signed-in dashboard. Its M2 prerequisites (vite origins in the allowlist, B0) are in. **First action at kickoff: confirm a working local email path for the OTP code** (console backend for local dev; anymail/Resend later — Railway blocks outbound SMTP) — without it the login flow can't be tested end-to-end and M3's acceptance is blocked.

---

## Docs session — progress docs re-homed to `planning_docs/` + branch correction (2026-10-26)

**Owner decision (2026-10-26):** the two progress docs (this file + `extension_milestone_progress.md`) move from the repo root to `planning_docs/` (alongside the impl + rework plan docs) and remain **git-tracked on `cloud-migration`** — the folder stays gitignored for the local-only plan docs, with a `.gitignore` negation for the two progress docs. Also: **there is no `extension/rework` branch in this checkout** — every commit (M1 + M2) landed directly on `cloud-migration`; the `extension/rework` branch names recorded in the M1/M2 entries above were wrong and are corrected in place. The impl doc's §0.4, §2 tree, §6-21(g), §7 common-to-every-milestone, and M1 sections are amended to match, and the board's branch/flag lines updated. Docs-only session — no code touched, nothing tested that was not previously tested.

**Files changed:** `planning_docs/extension_documention.md` + `planning_docs/extension_milestone_progress.md` (re-homed, `git mv` — tracked status preserved); `.gitignore` (folder-ignore → contents-ignore + two negations); `planning_docs/extension_implementation.md` (local-only — not tracked).

---

## Bus contract — `PopUp_Background_message_relay.md` §1 (2026-10-31)

**Session:** 2026-10-31. **Branch:** `cloud-migration`. **Scope (owner directive):** the new contract doc's section 1 (message bus) only — nothing from §2 onward.

### 1. Objective

Land the *code footprint* of contract §1: the named message catalog and the response-envelope vocabulary as inline constants (the no-shared-file decision stands), and re-point the stale M1/M2 comments at the contract that supersedes them. No handlers, no relay, no auth, no shared request path, no popup, no backend — those are §3–§8's.

### 2. What landed

| File | Change |
|---|---|
| `extension/background.js` | Full seven-type `MSG` catalog + four-state `STATUS` envelope vocabulary (contract §1's inventory and "Response envelope"; the worker is the bus's sole owner per contract rule 7, so it carries the whole catalog though only SAVE is registered yet). Every bare `type:`/`status:` string → constant. Stale comments re-pointed: the storage block no longer implies `access_token` presence is the signed-in indicator (C2 rule — the settled contract: primary `session_state` value-key, fallback `access_token` presence); M4/M6 milestone refs → the contract's §3/§4/§8; the rework rule numbers → contract rules 5/8/10. **Storage code untouched** — the M2 `get/setAccessToken` pair (uncalled) stands until §4 flips the key |
| `extension/content/universal.js` | Inline `MSG` with the two types it speaks (SAVE + CAPTURE_WEB); both bare strings → constants |
| `extension/content/{youtube,twitter,pinterest,linkedin}.js` | Inline `MSG` with SAVE; the send site → constant. Payloads, response dispatch, buttons, toasts: untouched (their normalization to the four-status vocabulary is the M5/M7 remap — impl doc finding 6, not §1) |
| **not touched** | popup stub (speaks no bus names; §10 replaces it whole), the relay (absent — §2), the LinkedIn bridge `inject.js`/`early.js` (frozen — acceptance 4), both manifests (no relay entry until §2), all backend code |

### 3. Decisions

- **The full catalog lives in the worker even though five types are unregistered.** §1's purpose is "the named catalog of everything that crosses a context boundary"; rule 7 makes the worker the bus's sole owner, and §3 (next step) registers the remaining five listenable types against these same constants. Content scripts carry only the types they speak — "defined inline in each file that uses them."
- **`STATUS` lands in the worker only.** It is the sole response builder (rule 7). The v1-shaped consumer comparisons in the five content scripts + the toast core keep their literal `"OK"`/`"FETCH_ERROR"` reads for now: rewriting those dispatches (incl. the sign-in-required branch) is the M5/M7 normalization, which §8's status mapping also owns. §1's no-bare-string rule covers *message names*, and those are all constants.
- **Storage: comment-only, by the contract's own division of labor.** §1's last bullet is explicit — "the cookie flow and the non-secret session-state representation are … settled in the Authentication contract section, and **section 4 implements them as written**." The only §1 obligation on storage is the C2 wording (acceptance 3: the key is defined in the contract; no token value in any key or message — true: the uncalled M2 accessors store nothing today, and no bus message carries a token).

### 4. Verification — actual results

- `node --check` on every non-vendor JS file (worker, 5 content scripts, bridge ×2, popup): **clean**.
- **Bare-string audit:** the seven wire names now occur *only* at their constant-definition sites (6 files); no `type: "…"` literal anywhere outside `vendor/`. The constant values are byte-identical to the old wire strings — a behavior-neutral rename.
- **Kept-line check** (all six diffs reviewed): every non-constant line is byte-identical to the committed version — the diffs are additions + renames only.
- **LinkedIn bridge unchanged:** `inject.js` / `early.js` zero diff (acceptance 4); their `__liUrnSource` page-messaging contract is a separate use of C3 the bus does not revise. Popup stub + both manifests: zero diff.
- **Contract acceptance 2** (documented shapes): satisfied at the contract level — the inventory + envelope + the fire-and-forget notes (CAPTURE_WEB / SESSION_EVENT) live once in the doc §1, which is the documented "one place." **Acceptance 3:** the C2 key is defined in the contract; no token value appears in any storage key or bus message.
- **No browser smoke re-run.** M2's browser acceptance (C1–C7, all passed) covers exactly the flow this rename touches, and the rename is wire-identical — the static battery stands as the evidence; a full CDP re-run for a string rename was judged unnecessary (owner: don't go overboard).

### 5. Next step (contract build order)

**Step 2 — the Frontend task (the `IE-ClientSide` sync-event emitter) + the relay (§2), together.** The client landed 2026-10-30 (`3c57b56`…`25e481f`) but emits no auth events yet: new `IE-ClientSide/src/lib/authEvents.js` hooked into `authStore.js`'s `setAuthenticated`/`setUnauthenticated`, plus the new `content/relay.js` and its entries in **both** manifests (frontend origin only, `document_idle`). Note: the step-0 SameSite probe (build order) has **no recorded outcome** anywhere in these docs — it gates the *auth* sections (§4/§5, incl. the `AUTH_MODE` seam and the `session_state` key flip), not this step or the one after.

---

## Sync relay — `PopUp_Background_message_relay.md` §2 (2026-10-31)

**Session:** 2026-10-31. **Branch:** `cloud-migration`. **Scope (owner directive):** contract §2 only — "implement section 2, don't go overboard." The Frontend task's emitter (a separate section that the build order would normally run together with §2), §3 onward, the popup, and the backend: untouched.

### 1. Objective

Land contract §2: the new `content/relay.js` — a small content script registered **only on the frontend origin** in both manifests (`document_idle`, listens, injects nothing) that translates the frontend's `window.postMessage` auth events (`auth:signed-in` / `auth:signed-out`) into `SESSION_EVENT`s for the service worker. One new file + its manifest entries. No worker changes (registering `SESSION_EVENT` on the bus is §3), no frontend changes (the emitter is the Frontend task), no storage, no fetch — by the section's own boundaries.

### 2. What landed

| File | Change |
|---|---|
| `extension/content/relay.js` | New (80 lines). IIFE — every name kept out of the isolated world's shared scope (content scripts on a page run in one realm; see the finding below). One `window` `message` listener with the contract's exact gate: `event.origin === window.location.origin`, payload **exactly** `{ type: <agreed name> }` (one field; the `SESSION_EVENTS` map `"auth:signed-in"→"signed-in"` / `"auth:signed-out"→"signed-out"` is the translation *and* the validation — a name not in the map is "unrelated" by construction) → forward `{ type: "SESSION_EVENT", event }` via `chrome.runtime.sendMessage` with `lastError` voided (missing/torn-down receiver = silent no-op, never a throw; the relay never retries or replaces the worker's duties). No fetch/XHR, no `chrome.storage`, no DOM, no session decisions |
| `extension/manifest.json` | One `content_scripts` entry, first in the array: matches the pinned SaaS origin only, `js: ["content/relay.js"]`, `run_at: "document_idle"`. The all_urls entry *excludes* that origin, so the relay is the **only** content script on the frontend app and the platform capture scripts never run there |
| `extension/manifest.dev.json` | The dev twin: same entry on `http://localhost:5173` (the same origin its all_urls entry excludes) |
| **not touched** | `IE-ClientSide/` (the emitter — the separate Frontend task), `background.js` (no `SESSION_EVENT` registration — that is §3; until it lands the relay's send has no receiver and voids `lastError` silently, which is the documented bridge, not a gap), the five content scripts, the LinkedIn bridge, the popup stub, `dev/manifest-dev.sh` (its sed already substitutes every occurrence of the vite origin in the manifest — the relay entry gets `IE_VITE_ORIGIN` overrides for free; the relay file carries no origin literal — it compares `e.origin` against `window.location.origin` at runtime), all backend code |

### 3. Decisions

- **File at `content/relay.js`** (the contract says just "relay.js"): every content script in the tree lives under `content/`, and the §1 session log had already recorded that location.
- **IIFE, not top-level `const`** (the §1 pattern for content scripts): on the four platform origins two scripts with a top-level `const MSG` now share one isolated world and collide (finding below). The relay is the sole script on its origin so either shape would work there; the IIFE is unconditionally collision-proof and matches the tree's other self-contained listener files (`confirmation.js`, `early.js`, `inject.js`).
- **The map is the validation** — one source of truth for the two agreed names, no second name check.
- **No worker listener in this section** — the contract's own division of labor: §2 = the relay, §3 = bus registration, §4 = session semantics.
- **Live acceptance via manual postMessage.** The emitter does not exist yet (Frontend task), so the page-side events were fired by the harness in the exact contract shapes. The relay's contract is origin + exact shape → forward; the emitter is its *upstream*, not part of it. The full end-to-end (emitter → relay → worker → popup) still awaits the Frontend task + §3/§4.

### 4. Verification — actual results

**Static (all run):**
- `node --check content/relay.js` — clean; both manifests parse; relay entry present in each with the right origin + `document_idle`.
- Dev-vs-prod diff audit (the M2 invariant): exactly three origin fields — `host_permissions`, the relay `matches`, the `exclude_matches` (the new relay line adds one occurrence of the per-build frontend origin; the SaaS manifest carries the pinned one, the dev twin the vite one).
- Boundary grep on relay.js (acceptance 4): no `fetch` / `XMLHttpRequest` / `chrome.storage` / `document.` / cookie / localStorage **code** — the only hits are the comments documenting what it does not do.
- `dev/manifest-dev.sh` re-run, standard values + an `IE_VITE_ORIGIN` override: the relay entry picks up the substitution (the script's own sanity greps pass).

**Live browser (all run 2026-10-31, this machine — Brave 156.1 headless + CDP; bench: the real vite app on :5173, the dev load dir, backend :8080 *down* — irrelevant to the relay):**
- The extension loads with the correct stable ID: the SW target is `chrome-extension://oijkpjikiabildophmlfeihojjpghmed/background.js` (the key → ID derivation intact).
- **The relay's send wakes the MV3 service worker** — the SW target appears only after the first relayed event: the push path works even when the worker is asleep.
- On the real vite page (`/login`), with a capturing `onMessage` listener armed in the worker via CDP (harness-side only — no shipped code touched):
  - `auth:signed-in` → **exactly one** `SESSION_EVENT` `{event:"signed-in"}`, sender = the vite page (acceptance 1) ✅
  - `auth:signed-out` → one more, `{event:"signed-out"}` (acceptance 2) ✅
  - unrelated type / extra field / wrong field / string payload → **zero** forwards (acceptance 3) ✅
  - foreign sender origin (a `data:` iframe posting into the page) → ignored (the origin check) ✅
  - a `data:` tab (unrelated origin) → **no isolated world at all** — nothing injects, relay included (acceptance 5, "never registered broadly") ✅
- **Environment note:** branded Google Chrome refuses `--load-extension` ("not allowed in Google Chrome, ignoring"); the smoke ran in Brave 156, as in M1/M2.

**Finding (out of scope — recorded, not fixed; owner: §2 only):** the §1 commit is a **live breakage of the injected-button save flow on all four platform origins** (youtube / x / pinterest / linkedin): `universal.js` (all_urls) and the platform script both inject on those pages into the one shared isolated world, and §1 gave both a top-level `const MSG` → reproduced in the real browser on youtube.com: **`SyntaxError: Identifier 'MSG' has already been declared`** — the later-injected platform script dies at parse, so its button + SAVE send never run (v1 had no duplicated top-level declaration — verified against `origin/main`; that is why M1/M2 smokes were clean pre-§1). One-line-per-file fix (file-scoped IIFE or renamed constants); the context-menu path (universal's `CAPTURE_WEB` handler) still works. Natural landing: a hotfix or the §3 session — owner's call. The relay itself is unaffected (sole script on its origin).

### 5. Next step (contract build order)

The other half of step 2 — the **Frontend task's emitter** (`IE-ClientSide/src/lib/authEvents.js` + the `authStore` hook points), the relay's upstream — then step 3 (bus routing: register the six listenable types on the worker against the §1 `MSG` catalog, `SESSION_EVENT` first). Carried: the `const MSG` collision finding above.

---

## Bus routing — `PopUp_Background_message_relay.md` §3 (2026-10-31)

**Session:** 2026-10-31. **Branch:** `cloud-migration`. **Scope (owner directive):** contract §3 (Background A — message handling and routing) only, "don't go overboard": no §4+ operations, no relay / Frontend-task / content-script / manifest / backend / popup changes. The §1 `const MSG` collision stays the owner's call and is untouched (board §6); the step-0 SameSite probe is not gated by this step (it gates §4/§5 only).

### 1. Objective

The worker's §3 foundation: one message listener for the whole bus, all six listenable types registered, each routed to a dedicated handler with required-field validation and the safe-failure envelope — so §4–§8 land their operations against a stable routing seam.

### 2. What landed

| File | Change |
|---|---|
| `extension/background.js` | (a) `SESSION_EVENTS` vocabulary block — the two `event` values, the worker side of the relay's map. (b) Routing foundation: **one** `chrome.runtime.onMessage` listener dispatching to `requestHandlers` / `notificationHandlers` maps. The §1 `listen(type, handler)` wrapper is kept as the registration API (now map-into + one shared dispatcher, instead of one listener per type — the §3 "a single listener registers all six" wording mandates it); a `notify(type, handler)` sibling carries the fire-and-forget lifecycle (rule 10: channel never held open, handler never responds). `runRequestHandler` is the safe-failure guarantee (rule 8): a sync throw or a rejected promise resolves to the code-0 ERROR envelope, and the exactly-once `respond` wrapper means no double-respond. `runNotifyHandler` contains throws/rejections but never responds. (c) All six listenable types registered at startup: `SAVE`, `SESSION_EVENT` (notify), `SEARCH`, `LIBRARY`, `SIGN_OUT`, `USER` — `CAPTURE_WEB` remains send-only (the context menu). (d) Six dedicated handlers, uniform `(message, sender, sendResponse)` signature: **SAVE** = the v1 body reshaped onto the bus triple + a `data`-payload validation (the canonical four-field shape is still §8's); **SESSION_EVENT** = validation + no-op (the §4 session semantics replace the body); **SEARCH** = non-blank-`q` validation + code-0 stub (§6); **LIBRARY** / **SIGN_OUT** / **USER** = code-0 stubs (§7 / §4 / §7 own the operations; the documented payloads are `{}` — no required fields). (e) The v1 router `handleSave` renamed `routeSave` (the bus handler takes the name) — switch body byte-identical; its crash envelope gains the §1 `code: 0`. The v1 sections (`detectPlatform` / router / adapters / `postJSON`) get banner annotations as §5/§8's territory. Storage accessors, context menu, `downloadMedia`: untouched. |
| `planning_docs/extension_milestone_progress.md` | the re-sequenced line: §3 ✅ landed, next = the Frontend-task emitter + §5; the board §6 MSG-collision line: still the owner's call (landed without it per this session's scope) |
| `extension/.dev-load/` (gitignored) | rebuilt via `dev/manifest-dev.sh` so the browser load dir carries the new worker |

### 3. Decisions

- **Single-listener dispatcher** — the §3 wording ("a single `chrome.runtime.onMessage` listener registers all six") can't be met by the §1 per-type wrapper, so `listen()` keeps its call-site shape but registers into maps served by one dispatcher. The event-vs-request distinction (rule 10) is explicit at the registration site (`listen` vs `notify`), not hidden in handler bodies.
- **Stubs, not fakes.** The four operations without a landed section resolve to a code-0 ERROR naming the owning contract section — never a claimed success (rule 8), never a silent no-op on a request (the popup must be able to recover and retry — the §6/§9 failure shape). No live consumer exists yet (the v1 popup stub speaks no bus names), so the stubs regress nothing.
- **The relay's `SESSION_EVENT` now has a receiver** — the §2 log's "no receiver, voided `lastError` silently" bridge is closed. The no-op body is the documented interim: the events are idempotent and the worker's next session check (the §4 `USER` doubling) arbitrates. The relay itself is unchanged and its §2 smoke still stands (its callback voids `lastError` either way).
- **Validation at §3, operations at the owning section** — the seam for §4/§6/§7/§8 is the marked stub line inside each handler, not the validation and not the registration.
- **The `routeSave` crash envelope gains `code: 0`** — the §1 ERROR envelope is `{status, code, error}`; the crash path is a worker-side failure with no HTTP status, and `code: 0` is the contract's documented value for exactly that class. Additive for consumers (the toast readers pass the whole response through).
- **No browser smoke this session** — the node dispatch harness (below) drives the *real* listener, which is the stronger test for routing logic; the live SAVE flow's downstream (platform router → `postJSON` → toast) is byte-identical to what M2's browser acceptance verified, and the relay smoke (§2) is unaffected. Recorded rather than claimed away.
- **Content scripts untouched** — the §1 `const MSG` collision (the injected-button breakage on the four platform origins) is the owner's documented call; "implement section 3 only" kept it out of this session. Board §6.

### 4. Verification — actual results

**Static (all run):**
- `node --check extension/background.js` — clean.
- Registration audit: exactly six registrations (five `listen` + one `notify`), all against the §1 `MSG` constants; `CAPTURE_WEB` occurs only at its constant definition, the context-menu send site, and comments — never registered.
- Kept-line review (full `git diff`, +222/−32): every untouched v1/M2 line byte-identical — the only v1 *line* changes are the `routeSave` rename, its crash `code: 0`, and four banner annotations; the v1 console sequence for a SAVE (`Received message in background` → `Detected platform: web`) is preserved.

**Dispatch harness (all run 2026-10-31 — node 22, a throwaway chrome-stub harness at `/tmp/opencode/ie-s3/dispatch-test.js` driving the real listener; backend `:8080` down, so the live SAVE lands the documented `FETCH_ERROR` branch): 33/33 checks passed**, covering:
- the single-listener structure (exactly one `onMessage` listener; the `onInstalled` / `onClicked` registrations intact);
- each of the six listenable types routes to its dedicated handler — `SAVE` (valid v1 envelope → `FETCH_ERROR`, exactly one response, channel held; the youtube platform branch; three malformed variants → code-0 ERROR naming `data`), `SEARCH` (valid `q` → stub; missing / blank / non-string `q` → the validation error), `LIBRARY` / `SIGN_OUT` / `USER` (→ their stubs), `SESSION_EVENT` (both values → **no** response, channel not held, acknowledged; unknown / missing `event` → safely ignored with a warn);
- unknown type, the `{}` keepalive, `null`, and a non-object message → ignored: no response, no crash, no console noise (the M2 keepalive behavior preserved);
- the dispatcher's safe-failure machinery, via test-only handlers appended inside the eval (never shipped): a rejected promise → code-0 ERROR, a sync throw → code-0 ERROR, a double-responding handler → exactly one response;
- `chrome.storage.local` untouched by routing (still exactly `api_base_url`).

`dev/manifest-dev.sh` re-run: load dir rebuilt, the script's own origin sanity greps passed.

### 5. Next step (contract build order)

- **The Frontend task's emitter** (`IE-ClientSide`) — the other half of step 2; the relay is live but its upstream still emits nothing, so the push fast path can't fire until it lands.
- Then **§5** (the shared backend request path, the `AUTH_MODE` seam) — gated on the **step-0 SameSite probe, which still has no recorded outcome** (it gates §4/§5 only; §3 landed probe-independent). The owner runs it on the dev bench and the outcome is recorded verbatim in the log before §4/§5.
- Carried: the §1 `const MSG` collision (one-line-per-file fix in the five content scripts — the owner's call).

---

## Auth + session lifecycle — `PopUp_Background_message_relay.md` §4 (with its §5 dependency) (2026-10-31)

**Session:** 2026-10-31. **Branch:** `cloud-migration`. **Scope (owner directive):** contract §4 only — "implement section 4, don't go overboard, don't commit (draft the message, I review)". One necessary deviation, called out by the contract's own build order (its step 4 = §5 "shared backend communication", step 5 = §4, "authentication will also need to make backend requests"): **§5's `fetchJson` landed as §4's hard dependency**. §6/§7/§8, the popup §10–15, the relay, the Frontend-task emitter, the content scripts, both manifests, and all backend code: untouched.

### 1. Objective

Land contract §4 (Background B — authentication and session lifecycle) as the worker-side implementation of the settled Authentication contract, on the §3 routing seam: the `AUTH_MODE` credential seam, the session check, the recovery door, the 401 gate (`authFetch`), the real `SESSION_EVENT` + `SIGN_OUT` handlers, the `session_state` storage key, and the `FRONTEND_ORIGIN` constant that every `sign_in_url` uses. The step-0 SameSite probe — the contract's gate for **all** auth work — ran first, its outcome is recorded verbatim below, and `AUTH_MODE` is set to that outcome.

### 2. What landed

| File | Change |
|---|---|
| `extension/background.js` | (a) **CONFIG** — new `FRONTEND_ORIGIN` per-manifest constant (§8 nominally defines it, but §4's `sign_in_url` needs it now; the drift rule — one coordinated commit via the `dev/manifest-dev.sh` swap — applies from this step); the storage block re-written to the settled two-key scheme (`api_base_url` + `session_state` in cookie mode, `api_base_url` + `access_token` in header mode; never both); new `refreshConfigCache()` — the sole-writer discipline reads storage **directly** (via `readConfig()` it would short-circuit on the still-set cache and "refresh" to the values just changed). (b) **AUTH+SESSION section (new)** — `AUTH_MODE = "cookie"` (the probe's outcome); `SESSION_STATES` vocabulary (`"signed_in"`/`"signed_out"` — deliberately distinct from the bus's hyphenated `SESSION_EVENTS`; same meaning, two vocabularies, per the contract); `setSessionState` (the one non-secret key's writer; its write is the C2 broadcast; header mode writes only via key presence/removal); `checkSession` (200→`in`, 401→`out`, 5xx/network→`unknown` — a missing backend answer writes nothing, never fabricates); `recoverSession` (2xx→`ok`, 4xx→`gone`, 5xx/network→`unknown`; **header mode only** stores the token — read from `data.data.access_token`, allauth's envelope nests it one level below `fetchJson`'s `data`); `unauthenticated()` (`sign_in_url` = `FRONTEND_ORIGIN + "/login"` — never the bare API origin, which has no /login page); `authFetch` — the single gate every authenticated data call goes through: 401 → at most one recovery → at most one retry, never a loop; recovery `gone` or a still-401 retry writes `signed_out` and reports `UNAUTHENTICATED` + sign-in URL; recovery `unknown` passes the original through with **no** state write. (c) **`fetchJson` (§5, landed as the dependency)** — the shared request path: URL construction from the bare origin (route-prefix gotcha: auth under `/api/auth/…`, data routes at the root — every route spelled in full at its call site), the per-`AUTH_MODE` credential behavior (cookie: `credentials:'include'` and **no** Authorization header ever; header: Bearer from storage + `credentials:'include'` so the refresh cookie still rides recovery), one-body-read parsing (non-JSON error pages carried as text, never a crash; **no body logging** — under the primary design the refresh/session responses carry a body copy of the access token and no token value may reach the console), and the §1 envelope mapping (2xx→`OK`, HTTP error→`ERROR` + code + backend body passed through, network→`FETCH_ERROR`). §6–§8 consume it as they land. (d) **`handleSessionEvent`** — `signed-out` → write `signed_out` immediately (the frontend KNOWS it logged out — authoritative); `signed-in` → the backend check arbitrates (200→`signed_in`; 401→one recovery, its outcome is the state; `unknown`→no write — a stale cache beats a fabricated one). Idempotent; duplicates/out-of-order converge. (e) **`handleSignOut`** — `DELETE auth/session`; a 2xx or the 401-after-flush confirms; but the 401 is **disambiguated, not trusted** (an *expired* credential 401s without flushing): one recovery — `gone` → the goal is met by definition, `ok` → the retry's 2xx/401 is the real flush, `unknown` → the original passes through as a structured error, **no state write, no success claimed** (acceptance 4). Only a confirmed flush writes `signed_out`. (f) **`onInstalled`** — cookie mode removes any legacy `access_token` key (mode-gated: in the fallback it is the live state key and must survive). |
| `dev/manifest-dev.sh` | The per-manifest origin swap gains the second constant: line-anchored seds now substitute **both** `API_BASE_URL` and `FRONTEND_ORIGIN` in the built load dir (committed files keep the production strings); the script's own sanity greps cover the vite origin too. |
| `extension/.dev-load/` (gitignored) | rebuilt via the dev script — the load dir carries the new worker + the local two-constant values (verified) |
| `.env` (gitignored) | the step-0 primary cookie vars (SAMESITE/SECURE ×2 — landed in the prior session) **+ new `AUTH_ACCESS_COOKIE_PATH=/`** — the data-route finding, §3/§4 below |
| the two progress docs | this entry + the board's re-sequenced line (the §0.4 protocol) |
| **not touched** | the relay + its manifest entries, `IE-ClientSide/` (the emitter — still open), the five content scripts, the LinkedIn bridge, the popup stub (crashes headless — §4 finding 2; §10–15 replaces it whole), both manifests, all backend **code** (the path fix is env-only, deliberately — the settings default stays as `docs/authentication.md` documents it), §6/§7/§8 |

### 3. Decisions

- **Step-0 probe — outcome recorded verbatim: `200` (passed).** Run 2026-10-31 on the local bench (Brave 156.1 headless + CDP; real backend :8080, real vite app :5173): both token cookies **set with `SameSite=None; Secure` on plain-HTTP localhost** (Chrome treats localhost as a secure context) **AND attached to a service-worker cross-site fetch** — `POST /api/auth/app/v1/tokens/refresh` → **200** (a rotated refresh + mirrored access both landed in the jar) and `GET /api/auth/app/v1/auth/session` → **200** (user `ie-probe@example.com`). Per the contract's outcome table: the cookies set *and* attached → **proceed with the primary pure-cookie design; the whole positive path is testable locally.** Hence `AUTH_MODE = "cookie"`. Deviation, recorded: the probe account was pre-created as email-verified and signed in with email+password on the frontend's login page (no 6-digit OTP mail burned); the cookie semantics under test are unchanged. The fallback flip to `"header"` remains an **owner-only** decision — the probe passed and the positive path works, so it is not taken.
- **§5's `fetchJson` landed as §4's dependency** (called out to the owner in the session scope): the contract's build order runs build-step 4 (§5) immediately before step 5 (§4) and states why ("authentication will also need to make backend requests"). It is the only code from another section in this change; §6/§7/§8 will consume it as they land, per the same order.
- **`FRONTEND_ORIGIN` lands with §4, not §8** — the contract's `sign_in_url` is a §4 artifact and the constant is the seam it uses; the drift rule (one coordinated commit; the dev-script swap) starts applying now.
- **The data-route path finding (the session's one real discovery — an owner sign-off is the open item).** The first live run of `authFetch('/captures/')` 401-looped: the access cookie's `path` **defaults to `/api/`** (`bookmark/settings.py`; `docs/authentication.md`: "The path is `/api/` — every API endpoint") — which covers the allauth tree but **not** the core data routes, which are mounted at the **root** (`path('', include('core.api.urls'))` in `bookmark/urls.py`). A path-`/api/` cookie is attached to no root route, so a pure-cookie client is **anonymous on every data route** — and the SPA makes the same assumption in its own `client.js`, so the flaw is systemic, not extension-specific. Live proof from the vite page: `GET /captures/` (credentials include) → **401** while `GET /api/auth/app/v1/auth/session` → **200**, same jar, same fetch. **Fix (env-only — no settings code change, the same mechanism the contract already uses for the SAMESITE flip): `AUTH_ACCESS_COOKIE_PATH=/`** in the local `.env` — after which the whole positive path works (the battery below is the evidence); third-party exposure stays contained by the B0 CORS allowlist exactly as the contract argues for the `None` flip (the cookie is HttpOnly; a hostile origin gets no CORS reflection → no readable response; state changes die at preflight). **Owner items (not edited unilaterally — the settled contract doc and the canonical backend doc are the owner's): (1)** the contract's "Worker request rules" line reads "the access cookie (path `/api/`) is bridged into the header server-side" — that path assumption is the error; the primary design needs `AUTH_ACCESS_COOKIE_PATH=/` in the deployment env (a third env var alongside the two SAMESITE flips); **(2)** `docs/authentication.md` needs the companion note (the "every API endpoint" claim is false for the root data routes); **(3)** the step-0 probe as written checks attachment on the *auth* routes only — its attachment step should carry a data-route probe so a path regression can't hide behind a passing probe again.
- **A definitive backend answer is the state; a missing answer changes nothing** — the one rule behind `checkSession`/`recoverSession`/`authFetch` (2xx/4xx resolve, 5xx+network leave every state untouched).
- **`SIGN_OUT`'s 401 is disambiguated** — the contract says "a 401 response *is* success" (allauth flushes then answers 401) — but the same 401 is what an *expired* credential answers **without** flushing, so trusting it would claim a success the next derive undoes. The handler runs the same one-recovery-one-retry disambiguation as `authFetch`; only a confirmed flush writes state. (Under the primary design an expired access is in practice unreachable here — every 401 recovers first — but the branch is correct in both modes and costs one local call in the one case where it matters.)
- **No token exposure, enforced at the seams** — cookie mode: no storage key, no bus message, no code path touches a token value (the relay's §2 boundaries + the storage scheme above); `fetchJson` additionally logs **no response bodies** — under the primary design the refresh/session responses carry a body copy of the access token, and the console is a token sink.
- **The allauth envelope nesting** (`{status, data: {access_token}, …}`) — the token lives at `result.data.data.access_token` because `fetchJson`'s `data` is the whole body. Caught by the node harness, not the live run (cookie mode never reads it) — the header-mode branch is covered by the harness exactly for this reason.

### 4. Verification — actual results

**Static (all run):**
- `node --check extension/background.js` — clean; `bash -n dev/manifest-dev.sh` — clean.
- `dev/manifest-dev.sh` re-run: the load dir carries `API_BASE_URL=http://localhost:8080` + `FRONTEND_ORIGIN=http://localhost:5173` (dev) while the committed files keep the production strings; the script's own sanity greps pass.

**Node harness (`/tmp/opencode/ie-s4/s4-test.js` — throwaway chrome-stub harness driving the real worker code; re-run against the final tree): 53/53 checks passed**, covering: `fetchJson` shapes (cookie vs header credential behavior, envelope mapping, non-JSON error bodies); `checkSession` (in/out/unknown — including the 5xx and network branches); `recoverSession` (ok/gone/unknown; the header-mode token write at the nested envelope path; no write in cookie mode); the `authFetch` recovery matrix (2xx pass-through, 401→gone→signed_out+UNAUTHENTICATED, 401→ok→retry-2xx, 401→ok→still-401, 401→unknown→pass-through with no state write); the `SIGN_OUT` matrix (2xx, 401-after-flush, expired-credential-401→gone, expired→retry-401, recovery-unknown→no success claimed); the `SESSION_EVENT` matrix (both values, unknown value ignored, the out→recovery branch, the no-write-on-unknown); `onInstalled` legacy-key removal (cookie mode removes, header mode keeps); the two-key storage invariant; header mode end-to-end (presence = state; `session_state` never written).

**Live CDP battery (`/tmp/opencode/ie-s4/live-s4.js` — the real worker, real bench: backend :8080, vite :5173, the probe session in the jar): 13/13 checks passed:**
1. the relay event wakes the idle-killed worker;
2. storage afterwards = **exactly** `{api_base_url, session_state: "signed_in"}` (two keys — acceptance 5);
3. no `access_token` key in storage (primary design);
4. `checkSession()` → `in` (acceptance 1's worker half — the popup-render half is §10–15);
5. **`authFetch('/captures/')` with the access cookie deleted from the jar → `OK`** (one recovery + one retry — the pure-cookie *data* flow, the contract's data-call rule);
6. the recovery re-minted the access cookie into the jar;
7. relay `signed-out` → `session_state` flips to `signed_out` (the C2 write);
8. **`SIGN_OUT` on the bus → `{status: "OK"}`** (the 401-after-flush success path — acceptance 4), sent from the vite page's **isolated world** (a content→worker runtime message = the same bus channel; the handler ignores the sender — see finding 2 for why neither the popup tab nor the worker itself can be the live sender);
9. `session_state` = `signed_out` after sign-out;
10. **both token cookies cleared from the jar** (the backend-side flush — nothing can resurrect the session);
11. `checkSession()` → `out` (acceptance 2's worker half);
12. **re-login on the frontend closes the loop** — the app-root boot discovers the dead session through its **own** 401 → refresh-failure path (the contract's "reverse logout" note, in the real app), lands on `/login`, and the login submits → `/search`;
13. the relay `signed-in` again → `checkSession` `in` + storage `signed_in`.

**Live findings the battery surfaced (both fixed on the bench, both recorded):**
1. **The access cookie's `path` (the decision above)** — found as the step-5 401 loop, fixed with the env-only `AUTH_ACCESS_COOKIE_PATH=/` + a clean re-login (the stale `path=/api/` copy in the jar was deleted first — same name, different path, would otherwise **coexist** and the browser would send both on `/api/*` requests).
2. **The v1 popup stub kills its own tab's render process in this headless Brave** — `popup/popup.html` → `Inspector.detached: "Render process gone"` (while `icons/icon16.png` and a nonexistent page in the same origin load fine). The stub is the documented M1/M2 launcher side-effect (`popup.js`: `chrome.tabs.create('http://localhost:8081')` + `window.close()` on `DOMContentLoaded` — the latter is also why stray `:8081` tabs accumulated in the bench profile); it is replaced whole in §10–15, so it is **recorded, not fixed** (a §4 session does not touch the popup). Consequence for the harness only: `SIGN_OUT` is sent from the isolated world — the worker itself cannot self-send a runtime message ("Receiving end does not exist": a service worker is not a receiving end for its own messages), and the popup tab's renderer dies on load.
3. **Environment:** the profile's `Service Worker/` LevelDB had been serving the **pre-§4** `background.js` from an earlier session to the freshly-launched browser (same manifest version `1.0` → Chrome kept the cached SW script; the live worker was logging the pre-§4 no-op stub while the load-dir file on disk was the new code) — wiping that cache dir + relaunch fixed it; the stale-vite-on-`[::1]`-only socket was the same kind of bench zombie (`--host` restart). Neither is a product issue.

### 5. Next step (contract build order)

- **The Frontend task's emitter** (`IE-ClientSide`) — the other half of build-step 2; the relay is live but its upstream emits nothing, so the push fast path still can't fire (the live battery used a harness `postMessage` stand-in — the real emitter is what fires it in production).
- Then **§6 search** (`GET /search/?q=…` through `authFetch` — the `handleSearch` stub is the seam; §7, §8, §9 after, per the contract's order).
- **Carried (owner's call — the §3 finding above):** `AUTH_ACCESS_COOKIE_PATH=/` sign-off = the contract's "Worker request rules" line corrected to the path the primary design needs + the `docs/authentication.md` companion note + a data-route check added to the step-0 probe. The local `.env` runs it today; the deployment env needs the same var.
- **Carried:** the §1 `const MSG` collision (board §6 — the injected-button breakage on the four platform origins); the fallback `AUTH_MODE="header"` flip stays an owner-only decision and is **not** in flight (the probe passed; the positive path works).
