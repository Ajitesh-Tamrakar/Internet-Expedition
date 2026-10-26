# Extension implementation — session progress log

A **record of what actually happened**, per the impl doc `planning_docs/extension_implementation.md` §0.4 (filename kept exactly as specified, spelling included). Kept at the repo root, git-tracked on `extension/rework`, updated as work progresses — never claimed a test passed if it was not run.

Milestones: M1 → M8 (impl doc §7). Status overview: `extension_milestone_progress.md`.

---

## M1 — Extension foundation: seed, vendor, strip

**Session:** 2026-10-25 (two working sessions; this entry completed 2026-10-25).
**Branch:** `extension/rework`, base `aeaeac3` (cloud-migration).

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
| `extension_documention.md` (this file) + `extension_milestone_progress.md` (repo root) | the two required progress docs |

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
**Branch:** `extension/rework`; M1 set was the clean base. M2 commits: `77709d6` (identity + manifest step + `api_base_url` + dev manifest + dev script) → `57c33c7` (worker floor) → `b4ff40d` (B0) → `067770a` (B0 fix — the allowlist's extension origin was a derivation error; the browser-verified ID) → docs (this entry + board).

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
