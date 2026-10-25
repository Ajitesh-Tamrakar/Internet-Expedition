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
