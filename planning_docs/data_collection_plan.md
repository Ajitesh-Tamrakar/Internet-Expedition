# Internet Expedition — Data Collection Plan

## Purpose

This document defines how the Internet Expedition browser extension collects webpage content and resource URLs, organizes the collected information into one canonical capture shape (Section 5), passes it to `background.js`, and submits it to the backend.

This plan covers **data collection, the SAVE message, and the worker-to-backend request**: the canonical shape end-to-end — content script → worker → `POST /captures/` — including the backend serializer changes needed to accept it (Section 10). Authentication, 401 recovery, response envelopes, and retry behavior remain governed by the settled message-bus contract and are intentionally not re-specified here.

## Section 0: Where we are (read this first)

A fresh session should hold the repo's current state before building anything from this document. Status as of 2026-11-02:

| Component | State |
|---|---|
| Extension bus contract (`planning_docs/PopUp_Background_message_relay.md` — local-only) | §1–§9 all landed (2026-10-31/11-01): the `MSG`+`STATUS` catalog, the sync relay, the single-listener dispatcher, auth + session lifecycle, the one shared request path, search, library + user, capture coordination, the in-repo test net. **§10–§12 (the popup) landed 2026-11-01** (two-view layout, session-state integration, sign-in navigation). Remaining: §13's remainder (the profile icon's real name + account navigation), §14 (popup search), §15 (final integration + cleanup). |
| Worker capture path (`extension/background.js`, the CAPTURE COORDINATION section) | Reads the **v1 envelope** (`toCanonicalCapture` + the five per-platform mappers) and submits the current four-field canonical capture (`text` list / `image` screenshot / `media` `{url}` objects / `source_url`), always-multipart. **This document rewrites that seam** (Section 6). |
| Content scripts (`extension/content/`) | All five send the v1 envelope (`mandatory_fields` / `platform_specific_data`). **This document rewrites four of them** (`universal.js`, `twitter.js`, `youtube.js`, `pinterest.js`) to the canonical shape; **LinkedIn is deferred** (owner rebuilds it later). **Live bug on the milestone board:** all five declare a top-level `const MSG` in the page's shared isolated world → the duplicate declaration kills the later-injected script → **injected save buttons are dead on the four platform origins** (the context-menu path still works). The one-line-per-file rename lands as **step 0 of this build** (owner decision 2026-11-03 — the build order below, Section 11); the rewritten scripts must not add new generic top-level names. |
| Backend (`core/`) | SaaS pipeline: media ingest (plain `requests.get` per stored URL — no platform downloaders) → Gemini context → embeddings. The `CaptureSerializer` accepts the historical shapes; **this document adds canonical acceptance** (Section 10). Processing beyond storage is a separate backend concern (Section 10, item 5). |
| Frontend (`IE-ClientSide/`) | Landed (2026-10-30): `/login`, `/signup` (6-digit code verification), `/account`, `/search` (placeholder), `/account/password/reset`; cookie-only session; vitest suites. The ~5-line sync-event emitter is the one missing piece (a carried open item — the test net simulates the emission until it lands). |
| Test net (`extension/test/`, zero npm, `node ≥ 22`) | Three tiers: `worker-lifecycle.test.mjs` (the real worker in `node:vm`; 59 checks), `popup-session.test.mjs` (the real popup against the real worker; 37 checks), `browser-integration.mjs` (full integration on the live bench; 37 checks). The `SAVE` fixtures in the worker-lifecycle and browser-integration files **encode the v1 envelope and must be updated to the canonical shape** (Section 6). |
| Progress docs | `planning_docs/extension_milestone_progress.md` (the board) + `planning_docs/extension_documention.md` (the session log) — the §0.4 discipline applies to this build too: a session that lands anything updates both, records **actual** test results, and commits per step. |

**The one rule for this build:** the worker's seam rewrite and the content-script rewrites **must land together**. Today the worker understands only the v1 envelope — a canonical-shape SAVE would map to an empty capture, fail `hasUsableContent`, and error out; and a worker purged of v1-envelope reading would break the not-yet-rewritten scripts. There is **no dual-shape transition** (owner decision — the v1 envelope is fully retired), so the landing is atomic: Section 6 (worker + its test fixtures) + Section 10 (serializer) + the four content-script rewrites, as one unit. Within a session, build in any order: the serializer is purely additive (historical clients keep working) and can land first; the worker + scripts + fixtures are the atomic core.

**Build order for this document's sections:**

0. **Step 0 — the `const MSG` rename** (owner decision 2026-11-03): each of the five content scripts renames its top-level `MSG` constant to a project-unique name — the live collision that kills the injected save buttons on the four platform origins (Section 11). A standalone commit that lands **before everything else**: it is the precondition for every platform-adapter browser test.
1. **Section 10** — the backend serializer accepts the canonical shape (additive; everything else keeps working).
2. **Section 6** — the worker SAVE seam reads the canonical shape; the v1-envelope reader + the five mappers are retired; the `SAVE` fixtures in the test net update in the same landing.
3. **Sections 1/2/4/5** — the `universal.js` rewrite (general web: the Readability-or-fallback text, the link/media extraction step, the metadata harvest, the canonical object assembly, the `capture_id` toast).
4. **Sections 7/8/9** — the `twitter.js` / `youtube.js` / `pinterest.js` rewrites (LinkedIn: deferred, not in this build).
5. **Section 11 — run the full net** (L1 suite → L2 + L3 → L4 bench → the owner's manual smoke) and record the actual results in the session log + board.

**Relation to the other docs:** the bus envelope (`type` + `data`, the `STATUS` vocabulary, auth and request rules) is owned by the contract doc; **this document owns the canonical capture object** (Section 5) and everything that shape implies on both sides of the bus. If the two ever disagree about the capture's shape, this document is the later one and its owner decisions stand — the session log records each decision with the reason. The contract doc is local-only; if it is absent from a checkout, the worker's catalog block in `extension/background.js` is the bus contract, and this file (git-tracked) is the capture contract.

## Section 1: Readability and Page Information

### What we want

Use Mozilla Readability to extract the main article content from the current webpage. Use the result of `parse()` to obtain the article text and useful descriptive information.

### Collected fields

The collection flow should produce these fields:

- `text` — the extracted article text.
- `source_url` — the URL of the webpage being captured.
- `metadata` — a JSON object containing the remaining descriptive information collected from Readability.

The `metadata` object should use key-value pairs. Include the available Readability information, such as:

- `title`
- `byline`
- `excerpt`
- `site_name`
- `length`
- `language`
- `dir`

Example:

```javascript
{
  text: "Extracted article text...",
  source_url: "https://example.com/article",
  metadata: {
    title: "Article title",
    byline: "Author name",
    excerpt: "Short article summary",
    site_name: "Example",
    length: 4200,
    language: "en",
    dir: "ltr"
  }
}
```

The example values are illustrative. Actual values depend on the current webpage; unavailable metadata values are **omitted** (the single convention, Section 5). Key names follow the canonical metadata contract of Section 5 (snake_case): Readability's own property names such as `siteName` and `lang` are **mapped** to the canonical names, never stored verbatim.

Keep `source_url` separate from `metadata`; it is a dedicated field, not just another metadata property.

### Important distinction

Readability's `content` is filtered article HTML, not the complete webpage HTML. Use Readability to obtain the main article text and article metadata, but use the original webpage `document` to collect links and media resources from across the page.

The non-article fallback for pages that are not suitable for Readability is defined in Section 4. Do not define that fallback as part of this section.

### Acceptance

- **L3 (script vm tier):** with a stubbed `Readability`, a `null` parse result takes the fallback path without crashing; Readability-provided values map to the canonical names (`siteName` → `site_name`, `lang` → `language`) — the mapping is asserted, the vendor itself is not re-tested.
- **L4 (live bench):** a real article page → non-empty `text` that is the article (not a body dump); a real non-article page → the `innerText` fallback; a real page whose parse fails → the fallback path, and the save still completes.
- **Evidence:** the stored row's `text` is non-empty and came from the expected path.

## Section 2: Link and Media URL Extraction

### Where it lives: inside the new `content/universal.js` (no new file)

The step is part of the rewritten `content/universal.js` — **not** a separate `linkextraction.js` file (owner decision). It inspects the original webpage `document`, discovers links and media resource URLs, and organizes them into the `media` categories. It should not rely only on Readability's filtered article HTML, because that HTML may omit resources outside the main article.

Two facts pin this placement:

- **It has exactly one caller.** Only the general-web flow in `universal.js` needs it; the platform adapters (Twitter, YouTube, Pinterest) each do their own platform-specific extraction and never touch it. A separate file would add manifest entries, a load-order rule, and one more script in the page's shared scope, with zero reuse in return.
- **The isolated-world rule.** Every content script Chrome injects into a page runs in that page's *one* shared JavaScript scope (the "isolated world"). On platform origins, `universal.js` **and** the platform script both live in that scope. A top-level `const`/`let` in one script that collides with the same name in another **kills the later script with a `SyntaxError` before any of its code runs** — this is a live, tracked bug: five content scripts each declare a top-level `const MSG`, which is why injected save buttons are currently dead on the four platform origins (milestone board, open item; renamed as step 0 of this build — Section 11). Folding the step in keeps the file count flat instead of widening that blast radius.

Consequences for the implementation:

- **No manifest changes.** `universal.js` is already registered on `<all_urls>` (minus the app origin) in both manifests; the step rides that existing entry — no new entry, no `web_accessible_resources`, no new permission.
- **Naming discipline:** the step's helpers should be `function` declarations with project-unique names (e.g. `ieExtractPageLinks`, `ieExtractMedia`). Two same-named `function` declarations across scripts at least do not crash, but two same-named `const`/`let` **do** — and a same-named `function` that gets silently shadowed is just as wrong. Do not introduce new top-level `const`s with generic names a platform script might also declare (`MSG`, `STATUS`, …). Step 0 renames each script's `MSG` to a project-unique name (Section 11); the rewritten files must end the same way.
- **Isolated world, not the page's world:** the step reads the original page DOM (`document`), which is fully readable from the isolated world — no `window.postMessage` / main-world bridge is needed or permitted for it.

### How it should work

On a general-web save (the `CAPTURE_WEB` flow, Section 4), the step runs against the **original page DOM** — page-wide in both paths, article or not (Section 4):

1. Find hyperlinks and media resources:
   - `links` — `<a href>` targets.
   - `images` — `<img>` elements: prefer `currentSrc`, fall back to `src`.
   - `videos` — `<video src>`, `<video><source src>`, and embedded-player iframes (the existing YouTube/Vimeo embed patterns).
   - `audios` — `<audio src>`, `<audio><source src>`.
2. Keep only `http:` / `https:` URLs — drop `data:`, `blob:`, `mailto:`, `tel:`, `javascript:`, `about:`, and bare `#` anchors.
3. Resolve relative URLs to absolute ones (DOM properties like `href` / `src` / `currentSrc` already return absolute values; anything assembled by hand must go through `new URL(u, location.href)`).
4. Dedupe within each category, preserving document order.
5. Apply the per-category cap (below).
6. Return the `media` object (Output) for the canonical capture object (Section 5).

**Selector scope is final (owner-decided: minimal).** Image sources are read as `currentSrc` with a `src` fallback — and that is all. `currentSrc` is the browser's *own* answer to `srcset` (it reports the file actually displayed, after responsive-size selection), so responsive images are covered for free; do **not** add lazy-load guessing (`data-src` and the many `data-*` variants are non-standard conventions with stale-value risk). Embedded-player iframes keep the two existing patterns (YouTube, Vimeo) — do not add more. The baseline above is the complete contract, not a sketch to extend.

**Bounded arrays (required, owner-confirmed values):** every `media` entry the extension sends becomes a download the backend attempts in `processing_media`, and a gallery page can expose thousands of images. The step must apply a per-category cap *after* dedupe, keeping the first N in document order: **images 50, links 100, videos 10, audios 10.** The tightness tracks the cost: every image/video/audio entry triggers a backend download, while links just ride along in `metadata` (gated only by its 64 KB cap), so links get the loose number. Do not ship unbounded, and do not change the numbers without an owner decision.

The extension collects **URLs only** for webpage links and media. It does not download the image, video, or audio files. Downloading or processing media is a server-side concern and is outside this data-collection plan.

### Output

The `media` field should contain all URL categories in one object:

```javascript
{
  links: [],
  images: [],
  videos: [],
  audios: []
}
```

- `media.links` — ordinary webpage hyperlinks.
- `media.images` — URLs of images found on the webpage.
- `media.videos` — URLs of video resources or embedded video sources that can be discovered.
- `media.audios` — URLs of audio resources that can be discovered.

Some embedded or streaming media may not expose a direct resource URL, so not every resource is guaranteed to be discoverable.

**Naming distinction:** `media.images` contains webpage image URLs. It is not the screenshot of the page. The screenshot is a separate top-level `screenshot` field. The plural keys intentionally match the backend's `*_sources` column names, so the canonical shape survives the trip to the server without a key rename.

### Acceptance

- **L3 (primary — stub-DOM battery):** categories fill from the right sources (`<a>` → `links`, `<img>` → `images` with `currentSrc` preferred over `src`, `<video>`/`<source>` → `videos`, the two embed-iframe patterns → `videos`, `<audio>` → `audios`); `data:`/`blob:`/`mailto:`/`tel:`/`javascript:`/`#` URLs dropped; relative URLs resolved to absolute; dedupe preserves document order; **the caps are exact after dedupe** — a 60-image page yields exactly 50 (the first 50 in document order), 12 videos → 10, 150 links → 100; the returned object is Section 5's `media` shape.
- **Source audit:** no new generic top-level `const`s; the selector set stays at the owner-pinned minimum (no `data-src` guessing, no new iframe patterns).
- **L4:** a real page with images → `media.images` non-empty, ≤ 50, all absolute URLs; a link-heavy page → `metadata.links` ≤ 100.

## Section 3: Screenshot Capture

### What we want

Capture a screenshot of the currently visible browser tab using Chrome's `chrome.tabs.captureVisibleTab()` API, as part of the overall collection flow. The call is made in the **background worker** — `chrome.tabs.captureVisibleTab()` is only available there, never in a content script. The worker passes the resulting data-URL to the content script through the `CAPTURE_WEB` payload, the content script carries it in the canonical object's `screenshot` field, and the worker converts data-URL → `File` right there when it builds the multipart form (Section 6).

### Expected behavior

- The screenshot is a separate item from `text`, `source_url`, `media`, and `metadata`.
- Check the extension manifest for the permission needed to capture the visible tab. Keep the appropriate existing permission if it is already present; add it only if required.
- Capture the same active tab that the collection flow is working with.
- Handle screenshot capture failures gracefully. If a screenshot cannot be captured, the rest of the collected page information should still be usable.
- The screenshot stays a separate field of the canonical object — never folded into `text`, `metadata`, or any JSON-serialized value. Inside the extension its value is the data-URL string that `chrome.tabs.captureVisibleTab()` returns (or `null` when capture failed — the only representation a content script can hold); the worker converts it to the `file:screenshot:0` file part on submission (Section 6), so no base64 string ever rides a form field.

For clarity in the collection code, the screenshot is referred to as `screenshot` — that is its canonical field name in Section 5. The worker sends it to the backend as the multipart file part `file:screenshot:0` (Sections 6 and 10); the legacy `image` form field / `file:image:0` part remains accepted for other clients.

### Acceptance

- **L3:** the canonical object carries the worker-supplied data-URL string, or `null`; a `null` screenshot still assembles a savable object; the screenshot never appears inside `text` / `metadata` / `media` (source audit).
- **L2:** a `CAPTURE_WEB` with a screenshot data-URL → the worker's form carries `file:screenshot:0` (a real `File`, converted exactly once); a `null` screenshot → no file part, and the save still submits.
- **L4:** a real `captureVisibleTab` → the backend stores the file under the capture's storage prefix (asserted on the stored row); an induced capture failure → 201 with no screenshot, the row completes.

## Section 4: Save Trigger and General-Web Readability Flow

### Trigger and adapter selection

When the user chooses Save—through an injected save button or the general-web context-menu action—the extension follows the capture path appropriate to the current page. YouTube, X/Twitter, and Pinterest use their platform-specific content scripts/adapters. General webpages use `content/universal.js`. **LinkedIn is deferred**: its adapter is currently non-functional (its injected button is dead) and will be rebuilt later by the owner; this document does no work on it, and the v1-envelope purge (Section 6) leaves its existing v1 capture script in place, failing gracefully until the rebuild.

The general-web path has **no injected save button** — the right-click context menu is its only trigger, and `universal.js` registers the `CAPTURE_WEB` listener, it injects no UI. (The injected buttons exist only on the platform origins, from the platform adapters.) The context-menu path uses the message bus: `background.js` sends `CAPTURE_WEB` to the content script in the selected tab through `chrome.tabs.sendMessage()`. This request can include the user's selected text and screenshot data. The content script then runs the general-web capture flow. Platform-specific save buttons use their own adapter flows; this section does not redefine those implementations.

### General-web extraction decision

In `content/universal.js`, the general-web flow checks `isProbablyReaderable(docClone)`:

- **Suitable for Readability:** run `new Readability(docClone, { serializer: el => el }).parse()` and use the parsed article text and available metadata. Media collection (Section 2) is **page-wide in both paths**: the extraction step in `universal.js` always inspects the original page DOM, whether or not the page is an article. The Readability clone feeds only the `text` and `metadata` fields — it does not scope the `media` arrays.
- **Not suitable for Readability:** use `document.body.innerText` as the fallback text. This collects the page's body text as plain text; it does not collect the complete HTML document. The existing plan does not specify extra cleaning or processing of this fallback text.
- **Parse returns `null`:** `isProbablyReaderable()` is a suitability check, not a guarantee that `parse()` succeeds. The implementation should handle a `null` parse result safely rather than assuming an article object exists. This is an implementation consideration, not a separately detailed fallback in the source documents.

### Metadata harvest (who fills `metadata`)

Section 5's `metadata` fields have two sources, and this subsection assigns both — without an assignment, the head-tag fields would simply never be populated:

- **Readability** fills whatever `parse()` returns: `title`, `author` (from `byline`), `excerpt`, `site_name`, `language` (from `lang`), `dir`, `length`, and the other Readability details Section 5 lists. Where Readability provides a value, it wins.
- **DOM meta rules** fill what Readability never sees — the page's `<head>` and body markup, read from the original `document` (Section 2's isolated-world note applies):
  - `canonical_url` — the `<link rel="canonical">` `href`.
  - `description` — `<meta name="description">`, falling back to `<meta property="og:description">`.
  - `favicon_url` — the favicon `<link>` `href` (`rel="icon"` or `rel="shortcut icon"`).
  - `og_image` — `<meta property="og:image">`, falling back to `<meta name="twitter:image">`.
  - `published_at` — `<meta property="article:published_time">`, falling back to the first `<time datetime>` in the page body.
  - `modified_at` — `<meta property="article:modified_time">`.
  - `content_type` — never read from the page: the flow already knows which path it took, so it is `article` when Readability produced a usable article and `website` on the fallback path.

The rules run best-effort: a tag absent on a page simply leaves its field unpopulated, and unpopulated fields are **omitted from the object** — no `null`s, no empty strings, no placeholder text (the one convention, matching Section 5). A missing meta tag is never an error and never blocks the save.

### Confirmation message

The save flow should trigger the existing confirmation message/toast through `content/confirmation.js`. The confirmation UI is shared presentation; the actual collection logic differs by page type. YouTube, X/Twitter, Pinterest, and LinkedIn keep their platform-specific capture implementations, while general webpages follow the Readability-or-`document.body.innerText` flow described above.

### Acceptance

- **L3 (the harvest battery, stub `<head>`):** each rule — tag present → field populated; tag absent → key **omitted** (no `null` / empty string / placeholder); each fallback fires (`description` → `og:description`, `og:image` → `twitter:image`, `published_at` → first `<time datetime>`); where both sources supply a value, Readability's wins (e.g. `site_name`); `content_type` = `article` / `website` by the path taken.
- **L3 (trigger audit):** the general-web flow triggers only from `CAPTURE_WEB`; the script injects no UI (no button code in the file).
- **L4:** a real page carrying meta tags → those values appear in the stored `metadata`; a tag-less page → the keys omitted, the save completes.

## Section 5: Canonical Collected Data Shape

Once Readability, link extraction, and screenshot capture have completed, the collected information should be organized into one canonical capture object for the extension's background component.

### Fields

- `text` — extracted article text, or `document.body.innerText` on the non-article fallback path.
- `source_url` — the actual webpage URL the user saved (`location.href`).
- `screenshot` — the data-URL string captured from the visible tab (or `null` when capture failed); a separate top-level field, never inside `metadata`.
- `media` — object containing `links`, `images`, `videos`, and `audios` URL arrays, collected by the extraction step in `universal.js` (Section 2) from the original page DOM.
- `metadata` — a JSON object containing the other available page details as key-value pairs, filled by the two sources assigned in Section 4 (Readability + the DOM meta rules). Best-effort: collect only what is present; a field that cannot be populated is **omitted** — no `null`s, no empty strings, no placeholder text.

The `metadata` object should support these fields:

- `title`
- `canonical_url`
- `description`
- `author`
- `published_at`
- `modified_at`
- `site_name`
- `language`
- `favicon_url`
- `og_image` — social-sharing/preview image URL, if available.
- `content_type` — page type when it can be identified, such as `article` or `website`.
- Existing Readability details when available, including `byline`, `excerpt`, `length`, `lang`, and `dir`. Map overlapping values consistently; do not store duplicate representations of the same value without a reason.

`keywords` and `referrer_url` are optional future additions and are not required for this version. `saved_at` is capture-time information generated by the extension or backend, not page metadata; keep it in metadata only if that is the agreed capture contract, and do not pretend it was extracted from the webpage.

Example of the logical collected data shape:

```javascript
{
  text: "Extracted or fallback page text...",
  source_url: "https://example.com/page",
  screenshot: /* screenshot file/value, if available */,
  media: {
    links: ["https://example.com/related"],
    images: ["https://example.com/image.jpg"],
    videos: [],
    audios: []
  },
  metadata: {
    title: "Page title",
    canonical_url: "https://example.com/page",
    description: "Short page description",
    author: "Author name",
    published_at: "2026-10-31T09:00:00Z",
    site_name: "Example",
    language: "en",
    favicon_url: "https://example.com/favicon.ico",
    og_image: "https://example.com/preview.jpg",
    content_type: "article",
    excerpt: "Short excerpt when available",
    length: 4200,
    dir: "ltr"
  }
}
```

The example values are illustrative. Actual values depend on the webpage. Field names in the canonical capture object should be consistent (use the snake_case names above for the metadata contract); map Readability's property names such as `siteName` and `lang` into the chosen canonical names where appropriate.

This is a logical shape for the collected information, not a JSON serialization of the screenshot. The screenshot is a file/value and is not a normal JSON string.

The `metadata` object contains the additional page information. Keep `text`, `source_url`, `media`, and the screenshot as their own fields; do not nest them inside `metadata`.

### Acceptance

- **L3:** the assembled SAVE `data` deep-equals the shape's key set — `text` a **string** (never a list), `source_url`, `screenshot` (data-URL or `null`), `media` with exactly the four plural keys, `metadata` snake_case — asserted for each path: article, fallback, no-screenshot.
- **Source audit (all five content scripts):** no `mandatory_fields` / `platform_specific_data` anywhere; no singular `image`/`video`/`audio` keys; no `bookmark_id` reads (the toast reads `capture_id`).
- **L2 + L4:** the object round-trips — the worker accepts it and the backend returns 201; the shape is proven end-to-end, not in isolation.

## Section 6: Message Bus and Component Communication

### Purpose

The message bus is the internal communication contract that lets the extension's components exchange requests and data without each component directly handling every other component's responsibilities.

For this collection flow, the key components are:

- **Content scripts / page collector:** access the webpage DOM, run Readability, collect the original page's resource URLs, and assemble the page-derived fields.
- **Background service worker (`background.js`):** acts as the central coordinator. It receives messages from content scripts, performs extension-level work such as screenshot capture when required, and coordinates the next step in the workflow.
- **Popup:** provides the extension's user interface. It communicates with the background worker through the extension messaging APIs; it should not independently duplicate the page-collection logic.

### Required messages in this capture flow

Use the message names and directions from the base message-bus contract; do not invent a separate message just for the fallback:

1. **`CAPTURE_WEB` — background service worker → content script in the selected tab.** The worker sends this through `chrome.tabs.sendMessage()`. The documented payload is `{ selectionText, screenshot_base64 }`. It is a worker-to-content capture request and is fire-and-forget; a missing or unresponsive content script must fail gracefully. The general-web content script then runs the Readability-or-fallback collection path and its link/media extraction step (Section 2) for page links and media URLs.
2. **`SAVE` — platform content script → background service worker.** Once the canonical capture object is assembled, the content script sends it through `chrome.runtime.sendMessage()` using the existing `SAVE` contract. The worker handles submission coordination and returns the documented capture status/error response. The popup is not a participant in `SAVE`.

The base message-bus document describes `CAPTURE_WEB`'s existing payload as `{ selectionText, screenshot_base64 }`, while the canonical capture shape in this plan includes `text`, `source_url`, `screenshot`, `media`, and `metadata`. Treat those as different stages of the flow: `CAPTURE_WEB` requests page-side capture; `SAVE` carries the resulting capture. Any change to either message's established payload must be made deliberately in the shared contract and all affected senders/receivers.

### Message-bus rules relevant here

- `chrome.tabs.sendMessage()` is used when the worker targets a content script in a specific tab; `chrome.runtime.sendMessage()` is used for the content-script-to-worker `SAVE` message.
- Keep the existing message names and payload fields stable. Validate required fields and handle missing scripts, malformed messages, and failures without claiming success.
- The worker is the extension-level coordinator. Content scripts collect page information; they do not independently submit to the SaaS backend. The popup does not perform page extraction or participate in `SAVE`.
- The message bus is not the backend API. The worker's backend submission of a capture **is** specified in this document (Section 6); authentication, 401 recovery, and retry remain governed by the settled contract.

The message bus is an internal communication mechanism; it is not the backend API and does not itself mean that data has been sent to the server.

### The worker's SAVE handling (what changes in `background.js`)

The `data` slot of `SAVE` now carries the canonical object of Section 5, assembled by the content script. This is a deliberate, owner-confirmed reversal of the §8 "sender-side reshape note" (recorded in the session log): the content scripts **are** rewritten to emit the canonical shape, and the v1 envelope is **purged entirely** — there is no dual-shape transition. Concretely:

- **Retired in the worker:** `toCanonicalCapture`'s envelope reading (`mandatory_fields` / `platform_specific_data`), the five per-platform mappers (`mapWeb`, `mapYouTube`, `mapTwitter`, `mapPinterest`, `mapLinkedIn`, and the `CANONICAL_MAPPERS` table), and everything that translated between shapes. Today that code only understands the v1 envelope; a payload in the canonical shape would map to an empty capture and fail the `hasUsableContent` check — so this change is **required for the new content scripts to work at all**, and it must land together with them.
- **Replaced by:** a light normalizer over the canonical shape — trim blank strings, dedupe URLs within each `media` category, drop absent/empty fields. The worker no longer translates; it validates and submits.
- **`hasUsableContent`** is redefined over the canonical fields: a capture is usable when `text` is non-blank, or `source_url` is set, or `screenshot` is present, or any `media` array is non-empty. Nothing usable → the existing structured code-0 `ERROR`, nothing submitted.
- **Submission to the backend — the same shape, always multipart, through the existing auth gate:** `text` as a **plain string** form field (never `JSON.stringify`-quoted — the serializer would store the quotes), `media` and `metadata` as JSON-string form fields, `source_url` as a plain string, and the screenshot as the file part `file:screenshot:0` (the existing data-URL → `File` conversion; a failed conversion degrades to a no-screenshot capture, never a failed save). Absent optional fields are simply not appended. The request/response envelopes, the 401 → `UNAUTHENTICATED` + sign-in-URL path, and the status mapping stay exactly as the settled contract defines them.
- **Presentation stays:** the injected save button and the confirmation toast keep their current look and behavior. One v1 leftover goes with the rewrite: the confirmation call currently reads `response.data.bookmark_id`; the SaaS backend returns `capture_id`, so the rewritten scripts read `capture_id`.
- **LinkedIn (deferred):** its content script still sends the v1 envelope. After the purge, a LinkedIn save maps to an empty canonical object and fails gracefully at the usable-content check (error toast, nothing submitted) — acceptable per the owner, since the adapter is non-functional today and will be rebuilt against the canonical shape later. The worker gets **no** LinkedIn-specific code.
- **Existing tests:** the `SAVE` fixtures in `extension/test/` (`worker-lifecycle.test.mjs`, `browser-integration.mjs`) send the v1 envelope and must be updated to the canonical shape as part of this work; the net's other assertions (auth envelopes, the multipart POST, the storage audit) are unchanged.

### Acceptance

- **L2 (primary — updated fixtures):** a canonical SAVE → the exact multipart form (`text` a plain string with **no** JSON quotes, `media` / `metadata` JSON strings, `source_url` raw, `file:screenshot:0` present only when a screenshot exists); a **v1-envelope SAVE now maps to nothing usable** → code-0 `ERROR` with **zero fetches** (the no-dual-shape proof); the `hasUsableContent` matrix (text-only / media-only / screenshot-only / all-empty → the last fails gracefully); a failing screenshot conversion degrades to a no-screenshot save, never a failed save; the 401 path reuses the same `FormData` across the one-recovery-one-retry; the status mapping and `UNAUTHENTICATED` + `sign_in_url` stay exactly as the settled contract.
- **L4:** the browser-integration `SAVE` op on a canonical payload → 201 → the `LIBRARY` op carries the new row.

## Section 7: Twitter/X Capture Requirements

### What we want

Preserve the existing Twitter/X capture behavior while organizing the collected data into the canonical capture object defined in Section 5.

The extension should continue extracting tweet information from the webpage. The collected tweet text, complete tweet URL, media URLs, and tweet metadata must be passed to the background component using the `SAVE` message described in Section 6.

### Collected fields

Twitter/X captures should use the following structure:

```javascript
{
  text: "The tweet text...",
  source_url: "https://x.com/username/status/123456789",
  media: {
    images: [
      "https://pbs.twimg.com/media/image1?name=orig",
      "https://pbs.twimg.com/media/image2?name=orig"
    ],
    videos: [
      "https://x.com/username/status/123456789"
    ]
  },
  metadata: {
    platform: "twitter",
    tweet_id: "123456789",
    author_name: "Example User",
    username: "@example",
    timestamp: "2026-11-01T10:00:00.000Z"
  }
}
```

The example values are illustrative. Actual values must come from the captured tweet.

- `text` — the extracted tweet text.
- `source_url` — the complete URL of the tweet.
- `media.images` — an array of collected image URLs.
- `media.videos` — an array of video-related URLs, including the tweet URL when needed for backend video retrieval. (Unlike YouTube, which omits its watch-page URL from `media.videos` — see Section 8.3: each platform adapter makes its own media decision, and the backend's per-platform handling, when the owner adds it, is what resolves the difference.)
- `metadata.platform` — identifies the platform as `twitter`.
- `metadata.tweet_id` — the extracted tweet ID.
- `metadata.author_name` — the author's displayed name.
- `metadata.username` — the author's username.
- `metadata.timestamp` — the timestamp collected from the tweet, when available.

Keep the metadata fields as flat key-value pairs. Do not introduce nested `mandatory_fields` or `platform_specific_data` objects. Do not include a `hasMedia` field; the media arrays represent the collected media URLs.

### Tweet URL and ID extraction

The extension should continue using the existing URL extraction behavior in `twitter.js`.

1. Find a link containing `/status/` inside the tweet element.
2. Resolve the link into a complete URL, using the current page's origin when the link is relative.
3. Extract the tweet ID by matching the digits immediately following `/status/` in the complete URL.
4. Store the complete URL in `source_url` and the extracted ID in `metadata.tweet_id`.

The extension obtains the URL first and extracts the ID from it. It does not construct the URL from the tweet ID.

If no suitable status link is found, the missing URL and ID must be handled safely.

### Image and video collection

The current `twitter.js` collects image URLs and requests original-resolution URLs where supported. It does not download the image files itself.

An earlier v1 implementation downloaded images through the extension's background handler and uploaded them as files. That behavior is **retired in the SaaS flow**: the extension never downloads media, and the old downloader path is not part of this plan and must not be restored.

Image and video URLs must be classified separately in `media.images` and `media.videos`.

X video elements may have an empty or unusable `src` because video playback can use HLS streaming. The actual video may later be retrieved by the backend from `source_url` via a platform downloader (e.g. yt-dlp) — that is the owner's later backend work (Section 10 pipeline boundary); the extension's job ends at storing the URLs.

Collecting a media URL does not mean that the corresponding file has already been downloaded. The extension never downloads media — the canonical submission specified in Sections 6 and 10 carries URLs only, and the backend's `processing_media` phase fetches them.

### Integration with the existing capture flow

Twitter/X remains a platform-specific capture flow, as described in Section 4. Its content script collects the tweet information and sends the resulting capture through the existing `SAVE` message described in Section 6.

The Twitter/X capture object must follow the field organization defined in this section. Any changes to the message payload must remain consistent with the shared message-bus contract and the background component that receives it.

This section defines the required Twitter/X capture data and behavior. It does not redefine the general-web Readability flow or the backend submission contract.

### Acceptance

- **L3 (stub tweet DOM):** the canonical object — `text` = the tweet body; `source_url` = the resolved status URL (URL obtained first, ID extracted *from* it into `metadata.tweet_id`); posters in `media.images`; **the tweet URL in `media.videos`** (the pinned asymmetry vs Section 8.3); `metadata` flat and snake_case, no `hasMedia`; no screenshot field (the platform scripts never carry one).
- **Source audit:** no media download / `fetch` anywhere in the script (the retired v1 downloader must not return); the v1 envelope is gone.
- **L4 (after step 0):** a real tweet page → the injected button works → SAVE → 201; the stored row carries the tweet URL in `video_sources` (link-based) — its later per-item degradation in `processing_media` is the parked processing concern (Section 10, item 5), never a 500.

## Section 8: YouTube Capture Flow

### Purpose

Define how Internet Expedition captures a YouTube video using the existing platform-specific content script and message bus. The extension collects the video's identifying information and passes it to the background service worker. Transcript extraction and subsequent processing remain backend responsibilities.

Unlike general webpages, YouTube captures do not require a screenshot or browser-side video/audio downloads.

### 8.1 Files and Components Involved

The YouTube capture flow involves the following components:

- **`extension/content/youtube.js` — YouTube content script:** Detects the YouTube page, collects the available video and channel information, assembles the capture object, and initiates the existing `SAVE` message.
- **`extension/background.js` — background service worker:** Receives the `SAVE` message, coordinates the extension's existing save flow, and handles the next step according to the established message-bus contract.
- **`content/confirmation.js` — save confirmation:** Provides the existing save confirmation UI. It should remain presentation logic rather than becoming responsible for collecting YouTube data or extracting transcripts.
- **Backend processing components (planned):** receive the saved capture and handle downstream processing. Transcript extraction is not yet built in the SaaS backend — see 8.5.

YouTube must continue to use its platform-specific capture path. It must not be routed through the general-web Readability extraction flow in `content/universal.js` merely to obtain the canonical capture object.

### 8.2 Data Collected by the Extension

The YouTube content script must collect the following information when available:

- **Video URL:** The URL of the YouTube watch page.
- **Video title:** The title of the video.
- **Channel name:** The name of the channel that published the video.
- **Channel URL:** The URL of the channel.

These values must be mapped to the canonical capture object's fields as follows:

| Canonical field | Required value |
|---|---|
| `text` | Empty string (`""`) |
| `source_url` | YouTube watch-page URL |
| `metadata.platform` | `"youtube"` |
| `metadata.title` | Video title |
| `metadata.author` | Channel name |
| `metadata.author_link` | Channel URL |

The YouTube adapter must use the existing canonical field names and must not place `text` or `source_url` inside `metadata`.

### 8.3 Canonical Capture Object

The YouTube content script must assemble the capture object using the following logical structure:

```javascript
{
  text: "",
  source_url: videoUrl,
  media: {
    links: [],
    images: [],
    videos: [],
    audios: []
  },
  metadata: {
    platform: "youtube",
    title: title,
    author: author,
    author_link: authorLink
  }
}
```

The example represents the required logical data shape. `videoUrl`, `title`, `author`, and `authorLink` represent the values collected from the current YouTube page; they are not literal strings to send.

The `media` object retains the canonical structure defined in Section 5. Do not automatically place the YouTube watch-page URL in `media.videos`: `source_url` already identifies the page, and the watch-page URL is not a direct video-file URL. (Twitter does the opposite — it places its tweet URL in `media.videos`, expecting the backend's X handling to resolve the real video from it. The two rules are platform-specific by design; do not "unify" them.)

The following fields and behaviors are intentionally excluded from this YouTube capture:

- **Screenshot:** Not required. The YouTube capture must not depend on screenshot capture succeeding.
- **Browser-side video/audio downloads:** Not required. The extension must not download or transcode video/audio files.
- **Transcript text:** Must not be extracted by the extension for this flow. The initial `text` value is an empty string, and the backend is responsible for transcript extraction.

### 8.4 Message Bus and Save Flow

YouTube capture must use the existing message bus defined in Section 6. Do not introduce a separate message type solely for YouTube.

The flow is:

1. The user activates the existing YouTube save control.
2. `extension/content/youtube.js` collects the video URL, title, channel name, and channel URL.
3. The content script assembles the canonical capture object described in Section 8.3.
4. The content script sends the object to `extension/background.js` through the existing `SAVE` message using `chrome.runtime.sendMessage()`.
5. The background service worker coordinates the existing save/submission flow and handles the documented response or error path.
6. The existing confirmation UI communicates the save outcome to the user.

The message-bus responsibilities remain unchanged: content scripts collect and assemble page information, while the background worker coordinates the next step. The popup does not participate in the `SAVE` message.

Missing page information, malformed messages, or save failures must be handled through the existing error-handling behavior. The extension must not report a successful save before the established flow confirms it.

### 8.5 Backend Transcript Extraction and Processing (out of scope — parked backend work)

An empty `text` value at extension-capture time does not mean that the saved YouTube item should permanently have no text. Transcript extraction is a separate, **server-side** stage — and per the Section 10 pipeline boundary it is **not part of this document**. This section exists only to pin down what the extension must *not* do, and to point a future session at the real backend.

**SaaS reality (read before doing anything else):** this tree's backend is `core/` — `core/pipeline.py` (media ingest → Gemini context → embeddings) and `core/api/gemini.py`. **There is no transcript pipeline in the SaaS backend today** — no `youtube-transcript-api`, no yt-dlp, no whisper. And the v1 files an older draft of this plan named (`capture/views.py`, `process/video_extraction.py`, `process/chunk_builders.py`, a "tagging pipeline") **do not exist in this tree**; v1 lives only on the `main` / `v1-reference` branch. Do not go looking for those paths, and do not resurrect them (AGENTS.md forbids it).

Transcript extraction (for example `youtube-transcript-api`, with an audio fallback) is **planned backend work the owner will add later**, and it will live in `core/` following the SaaS conventions (plain functions, the `processing_*` phases, per-item degradation). Until it lands, a YouTube capture is stored with empty `text` and whatever the existing pipeline derives from it; any quality gap there is a processing concern, not a collection defect.

The extension must not reproduce any of this: no transcript extraction, no video/audio download or transcoding. Its responsibility ends at the `SAVE` submission defined in this document.

### 8.6 Scope and Compatibility

This section defines the YouTube-specific data collected by the extension and how it enters the existing save flow. It does not redefine the shared message-bus contract or the backend API.

- Preserve the existing `SAVE` message name and direction.
- Keep the canonical capture fields consistent with Section 5.
- Keep `platform`, `title`, `author`, and `author_link` inside `metadata`.
- Keep the YouTube watch-page URL in `source_url`.
- Do not require a screenshot for YouTube.
- Do not download video or audio in the extension.
- Keep transcript extraction and subsequent processing on the backend.
- Preserve the existing save confirmation and error-handling behavior.

Any changes to the established message payload, backend request format, or response contract must be coordinated with the components that depend on those contracts.

### Acceptance

- **L3 (stub watch page):** `text` = `""` (no transcript in the extension); `source_url` = the watch-page URL; **`media.videos` empty** (the pinned asymmetry vs Section 7 — the watch URL is not a direct file URL); `metadata` = `platform` / `title` / `author` / `author_link`.
- **Source audit:** the script never downloads or transcodes; no transcript logic.
- **L4 (after step 0):** a real watch page → the injected button → SAVE → 201; the stored row: empty `text`, no `video_sources` entries, the watch URL in `source_url`.

## Section 9: Pinterest Capture Flow

### Purpose

Pinterest uses a platform-specific capture flow because the primary content being saved is an image associated with a Pinterest pin.

The extension collects the pin's URL, image URL, alternative text, and other pin-specific details. It organizes these values into the canonical capture object defined in Section 5 and passes that object through the existing message-bus contract.

Pinterest follows a URL-based collection approach. The extension does not download the image itself. Image downloading, image description generation, and downstream content processing are backend responsibilities.

### 9.1 Files and Components Involved

**`extension/content/pinterest.js` — Pinterest page collector**

This content script identifies Pinterest pin elements and provides a Save button for each detected pin. When the user saves a pin, it extracts the available pin information from the webpage DOM.

The collector is responsible for:

- Identifying the pin being saved.
- Extracting the pin URL, image URL, image `srcset`, pin ID, and image alternative text.
- Mapping the extracted values into the canonical capture structure.
- Sending the completed capture through the existing `SAVE` message.

The Pinterest collector must not independently submit captures to the backend or download image files.

**`extension/background.js` — Background service worker**

The background service worker coordinates extension-level operations and is the central point for handling the `SAVE` message.

It receives the capture from the Pinterest content script, validates and routes the message according to the existing message-bus contract, and coordinates the next step in the established submission flow.

The worker must not duplicate Pinterest DOM extraction logic. It should handle the capture through the existing shared mechanisms rather than introducing a separate Pinterest-only message protocol.

**`content/confirmation.js` — Save confirmation UI**

The existing confirmation UI provides feedback for the save operation. Pinterest should reuse this shared component instead of creating a separate confirmation mechanism.

**Backend image-processing components**

The backend resolves the image URL, downloads the selected image, generates an image description, and makes the resulting content available to the downstream processing pipeline. These responsibilities do not belong to the browser extension.

### 9.2 Data Collected by the Extension

The Pinterest collector extracts the following information from the selected pin:

- `source_url` — the URL of the Pinterest pin.
- `image_url` — the image URL obtained from the pin's image element.
- `image_srcset` — alternative image URLs and their available sizes, when provided by the webpage.
- `pin_id` — the Pinterest pin identifier.
- `alt_text` — the alternative text associated with the image.

These source values must be mapped into the canonical capture object rather than being sent as unrelated top-level fields.

**Image resolution:** an older v1 implementation collected `image_srcset` but its resolver used only `image_url`; the SaaS ingest likewise uses the stored URL as-is today. The flow must **preserve `image_srcset` in `metadata`** (Section 9.3) so a better-resolution selection can be added as backend work later (Section 9.5); the URL in `media.images` is what the current pipeline consumes.

### 9.3 Canonical Capture Object

The Pinterest capture must follow the common data structure defined in Section 5:

```javascript
{
  text: alt_text || "",
  source_url: source_url,

  media: {
    links: [],
    images: image_url ? [image_url] : [],
    videos: [],
    audios: []
  },

  metadata: {
    platform: "pinterest",
    pin_id: pin_id,
    image_srcset: image_srcset
  }
}
```

The values above illustrate the required structure. The implementation must use the values extracted from the actual pin.

**Field mapping rules**

- `text` receives the pin's `alt_text`. If the alternative text is missing or empty, use an empty string.
- `source_url` retains the Pinterest pin URL as its own top-level field.
- `media.images` contains the image URL obtained from `image_url`. If no image URL is available, use an empty array.
- `metadata.platform` identifies the source platform as `"pinterest"`.
- `metadata.pin_id` retains the pin identifier.
- `metadata.image_srcset` retains the alternative image URLs and size information for image-resolution selection.

Keep the canonical field names consistent with Section 5. Do not move `text`, `source_url`, or `media` into `metadata`.

Do not add a separate `metadata.alt_text` field because the alternative text is already represented by `text`. Do not add a screenshot field specifically for Pinterest; the Pinterest capture flow does not require a page screenshot.

The canonical `media.images` value represents an image resource URL, not a screenshot or an uploaded image file.

### 9.4 Message Bus and Save Flow

Pinterest must reuse the existing extension message-bus contract described in Section 6.

The expected flow is:

1. The user selects the Save button injected into a Pinterest pin.
2. `extension/content/pinterest.js` extracts the pin information from the page.
3. The content script assembles the canonical capture object described in Section 9.3.
4. The content script sends the capture to `background.js` through `chrome.runtime.sendMessage()` using the existing `SAVE` message contract.
5. The background service worker handles the message through its established routing and submission-coordination logic.
6. The existing confirmation UI communicates the save result through `content/confirmation.js`, following the shared confirmation behavior.

The Pinterest flow does not need to use `CAPTURE_WEB`. As defined in Section 6, `CAPTURE_WEB` is the worker-to-content-script request used by the general-web capture flow. Pinterest uses its platform-specific collector and Save button.

**Message-bus rules**

- Reuse the existing `SAVE` message name and its established request/response behavior.
- Do not invent a new message type exclusively for Pinterest.
- Keep page extraction inside `pinterest.js` and extension-level coordination inside `background.js`.
- Do not route the capture through the popup. The popup is not a participant in the `SAVE` message flow.
- Handle missing fields and failures safely. Do not report a successful save merely because the content script sent a message.
- Keep the message bus separate from the backend API. Backend authentication, request construction, file handling, submission, and server-response processing remain governed by the established submission implementation and the relevant sending requirements.

### 9.5 Backend Image Processing (out of scope — parked backend work)

The extension provides image URLs and descriptive text; it does not download or analyze the image.

**SaaS reality:** the SaaS backend already has a generic image path — `processing_media` downloads each stored `media.images` URL, and the Gemini vision call in `core/api/gemini.py` generates the image description that the existing pipeline embeds. No Pinterest-specific mechanism is needed for the SaaS flow to work. The v1 files an older draft named (`process/image_description.py`, `process/generation.py`) **do not exist in this tree** — do not look for them.

**Planned enhancement (owner's later backend work):** using `metadata.image_srcset` to pick a higher-resolution candidate before download — the SaaS ingest uses the stored URL as-is today. The extension's only obligation in this document is to *preserve* the data: send the image URL in `media.images` and keep the full `image_srcset` in `metadata`, so that enhancement can be built later without re-collecting.

### 9.6 Downstream Text, Image, and Metadata Processing (out of scope — parked backend work)

Pinterest produces two primary content inputs:

- **Text input:** the alternative text captured from the pin.
- **Image input:** the image downloaded and described by the backend.

The downstream pipeline should preserve the distinction between these inputs. The original alternative text remains captured text, while the vision model's output is a generated image description.

In the SaaS backend this distinction is already structural: `text_sources` carries the captured alternative text, while the generated description lives in `CaptureContext.image_context` — separate fields, separately embedded. (The v1 files an older draft named for this — a text chunk builder, an image-description pipeline, a metadata chunk — do not exist in this tree; the SaaS equivalents are the Gemini context step and `core/embedding_builder.py`.)

The SaaS implementation uses its existing pipeline (context generation + embedding). This section does not require a separate Pinterest-specific mechanism.

### 9.7 Scope and Compatibility

Pinterest capture is limited to the pin information and image resource needed to save and process the pin.

- The extension collects image URLs; it does not download image bytes.
- The extension does not generate image descriptions.
- A screenshot is not required for this platform-specific capture flow.
- Video and audio handling are not required for this Pinterest flow.
- `image_srcset` must be retained so that image-resolution selection can improve on the v1 behavior.
- The existing `SAVE` message and background-worker coordination must be reused.
- The canonical capture object must remain consistent with Section 5, with Pinterest-specific information stored in `metadata`.
- Backend image retrieval and description generation must reuse the existing SaaS processing mechanisms.

This section defines Pinterest-specific collection, data mapping, and component responsibilities. It does not independently redefine the backend API, authentication, request format, media-upload protocol, or server-response contract.

### Acceptance

- **L3 (stub pin page):** `media.images` = the resolved image URL (an empty array when none); the pin's alternative text → `text`; **`metadata.image_srcset` preserved** in full (the data for the parked backend enhancement — 9.5; the extension preserves, the backend may later select); `source_url` = the pin URL; no screenshot field.
- **Source audit:** the script never downloads the image file (retired v1 behavior must not return).
- **L4 (after step 0):** a real pin → the injected button → SAVE → 201; the stored row: the image entry link-based in `image_sources`, the full srcset in `metadata`.

## Section 10: Backend — Accepting the Canonical Shape (`core/api/serializers.py`)

The worker submits the canonical shape as multipart (Section 6), so `CaptureSerializer.create()` must accept it. The historical forms (plural `images`/`videos`/`audios` keys, `{"url": …}` dict items, the `image` screenshot carrier) **keep working for other clients** — this section is additive. Changes:

1. **Contract fields:** `CONTRACT_FIELDS` gains `screenshot` (the canonical top-level name; `image` remains the legacy carrier). The screenshot is accepted as a `file:screenshot:0` file part (primary — the worker's data-URL → `File` conversion) or a `screenshot` form field carrying a base64 data URL (mirroring the existing `image` logic); when both are present the file part wins. The per-file / per-capture size gate must cover the `screenshot` part family.
2. **Media keys and items:** the canonical keys are the **plural** `images`/`videos`/`audios` — deliberately the same keys the backend already reads, so the shape survives the trip without a key rename on either side. The one real change: an item may be a **plain URL string** (the canonical shape) in addition to the existing `{"url": …}` dict item — strings are trimmed, blanks are skipped, and wrapped to a `{"id", "url"}` entry. (`media.links` is not a sources column; it is handled in the next item.)
3. **`media.links`:** the `Capture` model has no links column, so the serializer merges `media.links` into **`metadata.links`** — the owner-decided home for links, returned to clients with the capture. If the merged metadata would exceed the size gate, drop the links key and proceed (a per-key degradation, never a 400): a capture with a huge link list must still save.
4. **Unchanged:** `text` (a plain string already parses to a single-item list — this is why the worker must not JSON-quote it), `source_url` (dedicated model column), `metadata` (JSON object, 64 KB gate), the response shape (source lists stripped, `capture: "success"` added), statuses, and the pipeline.
5. **Pipeline boundary (out of this document):** how the backend later *processes* a stored media URL — download quality, platform-specific retrieval (e.g. yt-dlp for tweet/watch pages, which the owner will add later) — is a separate backend task. This document's responsibility ends at **storage**: the URL is accepted, stored in the right `*_sources` column (or `metadata.links`), and the capture row completes. What a page-URL item later degrades into during `processing_media`/`processing_context` is a processing concern, not a collection or submission defect, and this document makes no requirement about it.

### Acceptance

- **L1 (Django suite — primary):** a canonical multipart create — a plain-string `text` stored **without** quotes; `media` JSON strings with **plain-URL items** → `*_sources` entries, alongside `{"url": …}` dict items (regression guard); the `screenshot` data-URL field and the `file:screenshot:0` part (the file part wins when both are present); the legacy `image` / `file:image:0` carriers still work; `media.links` merges into `metadata.links` and is returned on the row; an over-gate merge **drops the links key and still returns 201** (never 400); the per-file / per-capture size gates cover the `screenshot` part family.
- **Regression:** the existing historical-shape tests pass unchanged (this section is additive).
- **L4:** the probe-account create over a real request in the canonical shape → 201 (this is also part of the step-5 net run).

## Section 11: Testing — the Four Layers

Every section above carries an Acceptance block; the blocks reference these four layers. Three are the in-repo test net and the Django suite (zero npm, `node ≥ 22`); the fourth is new and lands with this build. No other test infrastructure is added.

- **L1 — the Django suite** (`venv/bin/python manage.py test core`). Offline (Gemini mocked); needs a running pgvector Postgres (the `ie-test-db` docker or a scratch cluster with `DB_*` overrides — a remote DB runs the full suite in ~90 s, a local one in seconds). Proves the backend half: Section 10.
- **L2 — the worker tier** (`node extension/test/worker-lifecycle.test.mjs`). The real `background.js` in a `node:vm` context against a scripted fake backend — seconds, no bench. Proves the worker seam: Section 6.
- **L3 — the script tier (new in this build).** The tier-1b pattern (`popup-session.test.mjs`) generalized: the **real content-script file** in a `node:vm` context against a stub DOM, with a **stub `Readability` + `isProbablyReaderable`** for `universal.js` (the 2786-line vendor needs a full DOM — not buildable zero-npm; the stub tests *our* code around it, and the vendor-on-a-real-DOM question stays covered by L4). Lands as `extension/test/script-capture.test.mjs` + a README section; one stub DOM per page shape (article page / tweet / watch page / pin), shared across the four scripts' tests. Proves the content scripts: Sections 1, 2, 4, 5, 7, 8, 9.
- **L4 — the live bench** (`node extension/test/browser-integration.mjs` + the owner's manual load-unpacked smoke). Real headless browser + the dev build + backend `:8080` + vite `:5173` + the self-cleaning probe account; the bench must be rebuilt after a reboot (the recipe is in `extension/test/README.md`). Proves what only a real browser can: Readability on a real DOM, `captureVisibleTab` bytes, the injected buttons, the full bus round-trip.

**Step 0 — the `const MSG` rename (lands first).** A standalone commit: each of the five content scripts renames its top-level `MSG` constant to a project-unique `ie`-prefixed name (one symbol per file — the board's one-line-per-file hotfix). The bus **values** (the strings `SAVE`, `CAPTURE_WEB`, …) are unchanged; only the constant identifiers move, so no other component is affected.

- Why it lands first: the collision is why the injected buttons are dead on the four platform origins, and every platform-adapter L4 check above is gated on the buttons working.
- **Acceptance:** L3 loads `universal.js` **and** one platform script into the *same* vm context (reproducing the shared isolated world) → both evaluate, no `SyntaxError`; L4: on each of the four platform origins the injected save button is present, and the context-menu path still works.

**Step 5 — the full net run (build complete), in order:** L1 (the suite) → L2 + L3 (seconds, no bench) → L4 (the bench) → the owner's manual smoke (right-click a real page → toast with the `capture_id` → inspect the stored row). The session log records the **actual** numbers of every tier — never claim a test that was not run, including failures and environment quirks — and the bench is left exactly as found (probe account deleted; scratch servers stopped).

### Scope boundary

This document defines what data is collected, how it moves between extension components, and how it is submitted to the backend — the canonical shape, the multipart encoding, and the serializer acceptance in Section 10. Authentication, 401 recovery, response envelopes, and retry behavior remain governed by the settled message-bus contract and are intentionally not re-specified here. How the backend *processes* captured media after download (descriptions, embeddings, platform handling) is a separate backend concern and is not part of this document.
