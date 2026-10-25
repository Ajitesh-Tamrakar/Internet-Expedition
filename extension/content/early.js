/**
 * early.js
 * --------
 * Isolated-world content script, must be registered in manifest.json with
 * "run_at": "document_start" so it gets a chance to inject inject.js before
 * LinkedIn's app bundle initializes and grabs its own reference to
 * window.fetch / XMLHttpRequest.
 *
 * Responsibilities:
 *   1. Inject inject.js into the page's MAIN world as a real <script> tag
 *      (an isolated-world fetch override would NOT see the page's own
 *      fetch calls -- they're different `window` objects for this purpose).
 *   2. Listen for postMessage data coming back from inject.js, and build a
 *      lightweight candidate map: activityId -> best-guess fingerprint
 *      (reaction count + author name), so content.js can later match each
 *      candidate to the post actually on screen.
 *
 * Shared state lives on `window.__liExtState` rather than a module-local
 * variable, because content.js is a SEPARATE content script file loaded
 * into the same frame/isolated-world -- using `window` is what lets both
 * files see the same candidate map regardless of load order.
 *
 * REQUIRED manifest.json wiring (you don't have this yet, see chat reply):
 *   - early.js registered with "run_at": "document_start"
 *   - inject.js listed under "web_accessible_resources" for linkedin.com
 *   - content.js (the existing button/DOM logic) stays on its own entry
 *     with the default run_at, since it needs document.body to exist.
 */

(function () {
    "use strict";

    if (!window.__liExtState) {
        window.__liExtState = {
            // activityId (string) -> { reactionCount: number|null, authorGuess: string|null, firstSeen: number }
            candidates: new Map(),
            MAX_CANDIDATES: 1000 // bound memory over a long browsing session
        };
    }
    const state = window.__liExtState;

    /* ---- 1. Inject inject.js into the page ASAP ---- */

    function injectPageScript() {
        try {
            const script = document.createElement("script");
            script.src = chrome.runtime.getURL("inject.js");
            script.async = false;
            // Neither <head> nor <body> is guaranteed to exist yet at
            // document_start -- documentElement always does.
            (document.head || document.documentElement).appendChild(script);
            script.onload = () => script.remove();
        } catch (err) {
            console.error("[LINKEDIN-EXT] failed to inject inject.js", err);
        }
    }

    injectPageScript();

    /* ---- 2. Collect URN candidates from inject.js ---- */

    // These field-name patterns are EMPIRICALLY OBSERVED on LinkedIn's
    // current responses, not a documented contract. They will need
    // revisiting after LinkedIn ships frontend/API changes.
    const COUNT_PATTERNS = [
        /"(?:numLikes|likeCount|reactionCount|numComments|numShares|totalSocialActivityCounts|numViews)"\s*:\s*(\d+)/i,
        /"intValue"\s*:\s*(\d+)/i,
        /"count"\s*:\s*(\d+)/i
    ];
    const NAME_PATTERNS = [/"(?:firstName|actorName|name|title)"\s*:\s*"([^"]{2,60})"/i];

    function guessFromContext(rawText, matchIndex) {
        const WINDOW = 1500;
        const start = Math.max(0, matchIndex - WINDOW);
        const end = Math.min(rawText.length, matchIndex + WINDOW);
        const context = rawText.slice(start, end);

        let reactionCount = null;
        for (const re of COUNT_PATTERNS) {
            const m = context.match(re);
            if (m) {
                const n = parseInt(m[1], 10);
                // Sanity bound, guards against grabbing an unrelated large
                // numeric ID instead of an actual count.
                if (!Number.isNaN(n) && n >= 0 && n < 10_000_000) {
                    reactionCount = n;
                    break;
                }
            }
        }

        let authorGuess = null;
        for (const re of NAME_PATTERNS) {
            const m = context.match(re);
            if (m) {
                authorGuess = m[1].trim();
                break;
            }
        }

        return { reactionCount, authorGuess };
    }

    function addCandidate(id, fingerprint) {
        if (!state.candidates.has(id) && state.candidates.size >= state.MAX_CANDIDATES) {
            const oldestKey = state.candidates.keys().next().value;
            state.candidates.delete(oldestKey);
        }
        const existing = state.candidates.get(id);
        state.candidates.set(id, {
            reactionCount: fingerprint.reactionCount ?? existing?.reactionCount ?? null,
            authorGuess: fingerprint.authorGuess ?? existing?.authorGuess ?? null,
            firstSeen: existing?.firstSeen ?? Date.now()
        });
    }

    window.addEventListener("message", event => {
        // Only trust same-window messages tagged with our marker, so we
        // don't react to unrelated postMessage traffic on the page.
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.__liUrnSource !== true || !Array.isArray(data.ids)) return;

        const rawText = data.raw;
        for (const id of data.ids) {
            if (rawText) {
                const idx = rawText.indexOf(id);
                const fingerprint = idx >= 0 ? guessFromContext(rawText, idx) : {};
                addCandidate(id, fingerprint);
            } else {
                addCandidate(id, {});
            }
        }
    });

    console.log("[LINKEDIN-EXT] early.js ready (URN candidate listener installed)");
})();