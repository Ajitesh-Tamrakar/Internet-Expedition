/**
 * inject.js
 * ---------
 * Runs in the PAGE's own JS context (the "MAIN" world), not the extension's
 * isolated sandbox. This is required because overriding window.fetch /
 * XMLHttpRequest from an isolated-world content script does NOT intercept
 * the page's own calls to those APIs -- the page has its own copy of
 * `window` for these purposes. So this file gets injected as a real <script>
 * tag by early.js, as early as possible (document_start), before LinkedIn's
 * app bundle has a chance to grab a reference to the original fetch/XHR.
 *
 * WHAT THIS DOES:
 *   - Passively observes responses to requests LinkedIn's OWN page code
 *     already makes during normal feed browsing (reactions, comment counts,
 *     etc -- often called "Voyager" traffic internally). It does not call
 *     any endpoint itself, and does not alter LinkedIn's request/response
 *     behavior in any way -- every original call and response is passed
 *     through untouched.
 *   - Scans response bodies for the substring `urn:li:activity:<digits>`,
 *     which is the stable identifier LinkedIn uses for a feed post,
 *     including when it shows up wrapped, e.g.
 *     urn:li:fsd_update:(urn:li:activity:123..., MESSAGING_RESHARE, ...).
 *     A plain regex scan finds the inner activity URN regardless of wrapper
 *     shape, so we deliberately do NOT try to parse/assume one fixed JSON
 *     schema (different endpoints structure this differently).
 *   - Posts whatever it finds back to the isolated world via
 *     window.postMessage, where early.js picks it up.
 *
 * MAINTENANCE NOTE:
 *   LinkedIn's response shapes and endpoint paths are not a stable contract
 *   and can change without notice. This regex-scan approach is intentionally
 *   schema-agnostic so it keeps working as long as the literal string
 *   "urn:li:activity:" still appears somewhere in responses -- but if that
 *   ever changes, this needs revisiting. This is not a one-time build.
 *
 * SCOPE NOTE:
 *   This only reads data that is already being sent to the user's own
 *   logged-in session as part of normal page operation. It never constructs
 *   or sends a request to any LinkedIn endpoint (internal or public) on its
 *   own, and adds no throttling/timing tricks to evade detection -- that
 *   would be a meaningfully different (and not-okay) step beyond passively
 *   observing what's already on the wire.
 */

(function () {
    "use strict";

    if (window.__liUrnInterceptorInstalled) return;
    window.__liUrnInterceptorInstalled = true;

    const URN_REGEX = /urn:li:activity:(\d+)/g;

    function extractUrnIds(text) {
        const ids = new Set();
        let match;
        URN_REGEX.lastIndex = 0;
        while ((match = URN_REGEX.exec(text)) !== null) {
            ids.add(match[1]);
        }
        return ids;
    }

    function publish(ids, rawText) {
        if (!ids.size) return;
        window.postMessage(
            {
                __liUrnSource: true,
                ids: [...ids],
                // Cap how much raw text we forward -- huge payloads (e.g. an
                // initial feed hydration blob) aren't worth the postMessage
                // copy cost just for fingerprint context.
                raw: rawText.length > 200000 ? null : rawText
            },
            "*"
        );
    }

    /* ---- fetch override ---- */
    const origFetch = window.fetch;
    window.fetch = function (...args) {
        const responsePromise = origFetch.apply(this, args);
        responsePromise
            .then(response => {
                try {
                    // Response bodies can only be read once -- clone before
                    // LinkedIn's own code consumes the stream, so we never
                    // interfere with normal page behavior.
                    const clone = response.clone();
                    clone
                        .text()
                        .then(text => {
                            if (text.includes("urn:li:activity")) {
                                publish(extractUrnIds(text), text);
                            }
                        })
                        .catch(() => {});
                } catch (_) {
                    // Not all responses are cloneable in every edge case --
                    // fail silently rather than ever breaking the page.
                }
            })
            .catch(() => {});
        return responsePromise;
    };

    /* ---- XMLHttpRequest override ---- */
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (...args) {
        return origOpen.apply(this, args);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener("loadend", function () {
            try {
                const text = this.responseText;
                if (text && text.includes("urn:li:activity")) {
                    publish(extractUrnIds(text), text);
                }
            } catch (_) {
                // responseType may not be "text" (blob/arraybuffer/etc) --
                // ignore those, we only care about JSON-ish text bodies.
            }
        });
        return origSend.apply(this, args);
    };

    console.log("[LINKEDIN-EXT] inject.js installed (MAIN world fetch/XHR observer)");
})();