console.log("========== LINKEDIN EXTENSION STARTED ==========");
const BUTTON_CLASS = "my-linkedin-save-btn";
const PROCESSED_ATTR = "data-linkedin-save-processed";
const DEBUG = false;

/* ===========================
   SAVED-STATE HELPER (shared, duplicated per content script)
=========================== */

function bmSetState(btn, next, message) { // 'saving' | 'saved' | 'error'
    if (!btn) return;
    btn.classList.remove("bm-saving", "bm-saved", "bm-error");
    const label = btn.querySelector(".bm-label");
    if (next === "saving") btn.classList.add("bm-saving");
    if (next === "error") {
        // reset aria back to the idle/unsaved announcement — otherwise a failure
        // after a prior success leaves aria-pressed="true"/"Saved" under a red stroke
        btn.classList.add("bm-error");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", message || "Save to Bookmark");
        if (label) label.textContent = "Save";
    }
    if (next === "saved") {
        btn.classList.add("bm-saved");
        btn.setAttribute("aria-pressed", "true");
        btn.setAttribute("aria-label", "Saved to Bookmark");
        if (label) label.textContent = "Saved";
        btn.classList.remove("bm-pulse");
        void btn.offsetWidth; // reflow so the pulse can replay
        btn.classList.add("bm-pulse");
    }
}

/* ===========================
   LOGGER
=========================== */

function log(...args) {
    if (DEBUG) {
        console.log("[LINKEDIN-EXT]", ...args);
    }
}

function warn(...args) {
    console.warn("[LINKEDIN-EXT]", ...args);
}

function error(...args) {
    console.error("[LINKEDIN-EXT]", ...args);
}

/* ===========================
   HELPERS
=========================== */

function unique(arr) {
    return [...new Set(arr.filter(Boolean))];
}

function cleanText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
}

function getLikelyLongestText(spans) {
    return spans
        .map(el => cleanText(el.innerText))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)[0] || "";
}

// Accessible name of a control: prefer aria-label (LinkedIn labels its action
// buttons even when the visible text is icon-only / hashed-class markup), then
// fall back to visible text. Stable across the SDUI redesign's obfuscated
// class/componentkey churn.
function accessibleName(el) {
    return cleanText(el.getAttribute("aria-label") || el.textContent || "");
}

// The social action labels we expect on a feed post, in roughly DOM order.
const ACTION_LABELS = ["like", "comment", "repost", "send"];

function actionLabelMatch(el) {
    const name = accessibleName(el).toLowerCase();
    if (!name) return null;
    return ACTION_LABELS.find(label => name.includes(label)) || null;
}

// A real feed post (vs. a sidebar/menu listitem that also uses role="listitem")
// either announces itself via the "Feed post" heading or carries an author
// profile link alongside at least one social action control.
function looksLikeFeedPost(post) {
    const heading = [...post.querySelectorAll("h2")]
        .some(h => cleanText(h.textContent).toLowerCase() === "feed post");
    if (heading) return true;

    const hasAuthor = !!post.querySelector('a[href*="/in/"]');
    const hasAction = [...post.querySelectorAll('button,[role="button"],a')]
        .some(el => actionLabelMatch(el));
    return hasAuthor && hasAction;
}

/* ===========================
   PERMALINK RESOLUTION
   ---------------------------
   early.js (a separate content script, run_at: document_start) injects
   inject.js into the page's MAIN world, which passively observes LinkedIn's
   own network responses for `urn:li:activity:<id>` occurrences and posts
   them back, along with best-guess fingerprint context (reaction count /
   author name), into window.__liExtState.candidates.

   This section's job is the hard part the spec calls out explicitly: there
   is no guaranteed 1:1 ordering between network response order and DOM
   render order, so each on-screen post has to be matched to a candidate by
   fingerprint -- reaction count as the primary key (least likely to
   collide), author name as a secondary check -- rather than assumed by
   position. Posts that can't be matched with confidence (ads, reshares,
   data that hasn't arrived yet) are explicitly left unresolved rather than
   guessing, and content.js's existing DOM-based href fallback still applies
   for those.
=========================== */

const resolvedPermalinks = new WeakMap(); // post element -> permalink string
const consumedCandidateIds = new Set();   // candidate ids already assigned to a post

function extractDomFingerprint(post) {
    const text = cleanText(post.innerText || "");
    const reactionMatch = text.match(/([\d,]+)\s+(?:reactions?|likes?)\b/i);
    const reactionCount = reactionMatch
        ? parseInt(reactionMatch[1].replace(/,/g, ""), 10)
        : null;

    const author_name =
        cleanText(
            post.querySelector('a[href*="/in/"] span[aria-hidden="true"]')?.innerText
        ) || "";

    return { reactionCount, author_name };
}

function namesLooselyMatch(a, b) {
    if (!a || !b) return false;
    const norm = s => s.toLowerCase().replace(/[^a-z]/g, "");
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return false;
    return na.includes(nb) || nb.includes(na);
}

function attemptResolvePermalinks() {
    const state = window.__liExtState;
    if (!state || !state.candidates.size) return;

    const posts = document.querySelectorAll('[role="listitem"]');

    posts.forEach(post => {
        if (resolvedPermalinks.has(post)) return;

        const fp = extractDomFingerprint(post);
        if (fp.reactionCount === null) return; // not enough signal to match on yet

        let bestMatch = null;
        for (const [id, candidate] of state.candidates.entries()) {
            if (consumedCandidateIds.has(id)) continue;
            if (candidate.reactionCount === null) continue;

            // Counts can drift slightly between fetch time and render time --
            // tolerate a difference of 1 rather than requiring exact equality.
            const countDiff = Math.abs(candidate.reactionCount - fp.reactionCount);
            if (countDiff > 1) continue;

            const authorOk =
                !candidate.authorGuess ||
                !fp.author_name ||
                namesLooselyMatch(candidate.authorGuess, fp.author_name);

            if (authorOk) {
                bestMatch = id;
                break;
            }
        }

        if (bestMatch) {
            consumedCandidateIds.add(bestMatch);
            const permalink = `https://www.linkedin.com/feed/update/urn:li:activity:${bestMatch}/`;
            resolvedPermalinks.set(post, permalink);
            log(`Resolved permalink (reactions=${fp.reactionCount}):`, permalink);
        } else {
            // Left unresolved on purpose -- could be an ad/reshare without a
            // normal activity URN, or data that simply hasn't arrived yet.
            log("No confident permalink match yet for post with reactions=", fp.reactionCount);
        }
    });
}

/* ===========================
   EXTRACT LINKEDIN POST
=========================== */

function extractLinkedInPost(post) {
    // Author name
    const author_name =
        cleanText(
            post.querySelector('a[href*="/in/"] span[aria-hidden="true"]')
                ?.innerText
        ) || "";

    // Author profile
    const author_profile_url =
        post.querySelector('a[href*="/in/"]')?.href || "";

    // Headline
    const author_headline =
        [...post.querySelectorAll("span")]
            .map(el => cleanText(el.innerText))
            .find(text =>
                text &&
                text.length > 5 &&
                !text.includes("Follow") &&
                !text.includes("•")
            ) || "";

    // Post text
    const post_text = getLikelyLongestText([...post.querySelectorAll("span")]);

    // Hashtags
    const hashtags = unique(
        [...post.querySelectorAll("a")]
            .map(a => cleanText(a.innerText))
            .filter(text => text.startsWith("#"))
    );

    // Images
    const images = unique(
        [...post.querySelectorAll("img")]
            .map(img => img.src)
            .filter(src =>
                src &&
                !src.includes("profile") &&
                !src.includes("emoji")
            )
    );

    // Videos
    const videos = unique(
        [...post.querySelectorAll("video")]
            .map(video => video.src)
            .filter(Boolean)
    );

    // External links
    const external_links = unique(
        [...post.querySelectorAll("a[href]")]
            .map(a => a.href)
            .filter(href => href && !href.includes("linkedin.com"))
    );

    // Post URL -- prefer the network-resolved permalink (stable
    // urn:li:activity id) over the DOM guess, since LinkedIn doesn't expose
    // a real permalink href anywhere in the rendered feed markup.
    const resolvedUrl = resolvedPermalinks.get(post);
    const post_url =
        resolvedUrl ||
        [...post.querySelectorAll("a[href]")]
            .map(a => a.href)
            .find(href =>
                href.includes("/posts/") ||
                href.includes("/feed/update/")
            ) ||
        "";

    // Media Type
    let content_type = { "text": true, 'image': false, 'video': false };
    if (videos.length) {
        content_type["video"] = true;
    } else if (images.length) {
        content_type["image"] = true;
    }

    source_url = post_url;
    const mandatory_fields = {
        source_url,
        platform: "linkedin",
        content_type,
        capture_method: "platform_injection"
    };

    const platform_specific_data = {
        author_name,
        author_headline,
        author_profile_url,
        post_text,
        hashtags,
        images,
        videos,
        post_url_resolved: Boolean(resolvedUrl), // lets downstream code tell a confirmed permalink from a DOM guess
        external_links,
        saved_at: new Date().toISOString(),
    };
    return {
        platform_specific_data,
        mandatory_fields,
    };
}

/* ===========================
   INJECT BUTTON
=========================== */

function injectButton(post, index) {
    if (post.querySelector(`.${BUTTON_CLASS}`)) {
        return;
    }

    if (post.getAttribute(PROCESSED_ATTR) === "true") {
        return;
    }

    // Skip listitems that aren't actually feed posts (sidebar entries, menus).
    if (!looksLikeFeedPost(post)) {
        return;
    }

    // Locate the social action row by accessible name rather than hashed
    // classes. Collect every Like/Comment/Repost/Send control, then choose an
    // insertion slot with graceful fallback. If none is found, bail WITHOUT
    // flagging the post so a later mutation can retry once the row renders --
    // better no button than one dropped in an unknown location.
    const actionControls = [...post.querySelectorAll('button,[role="button"],a')]
        .map(el => ({ el, label: actionLabelMatch(el) }))
        .filter(item => item.label);

    if (!actionControls.length) {
        return;
    }

    const sendCtrl = actionControls.find(item => item.label === "send");
    const anchor = sendCtrl ? sendCtrl.el : actionControls[actionControls.length - 1].el;

    const btn = document.createElement("button");
    btn.className = `${BUTTON_CLASS} bm-btn bm-btn--linkedin`;
    btn.type = "button";
    btn.setAttribute("aria-label", "Save to Bookmark");
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = `
        <span class="bm-icon-wrap">
            <svg viewBox="0 0 24 24" width="17" height="17">
                <path class="bm-ribbon" d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5v18l-7-4.5-7 4.5v-18z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none" />
                <circle class="bm-dot" cx="12" cy="9" r="1.7" fill="#EF9F27" />
            </svg>
        </span>`;

    btn.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();

        // One last attempt right at click time, in case network data for
        // this specific post has arrived since the last periodic check.
        attemptResolvePermalinks();

        if (DEBUG) {
            console.table(
                [...post.querySelectorAll("a[href]")]
                    .map(a => ({
                        text: a.innerText,
                        href: a.href
                    }))
            );
        }

        const payload = extractLinkedInPost(post);

        if (!payload.post_url_resolved) {
            warn("Saved post without a confirmed permalink -- using DOM fallback URL", payload.post_url);
        }

        if (DEBUG) {
            console.group("💾 Sending LinkedIn Post Payload");
            console.log(payload);
            console.log(JSON.stringify(payload, null, 2));
            console.groupEnd();
        }

        bmSetState(btn, "saving");

        chrome.runtime.sendMessage({ type: "SAVE", data: payload }, (response) => {
            if (DEBUG) {
                console.group("📨 Response From Background");
                console.log(response);
                console.groupEnd();
            }
            if (chrome.runtime.lastError) {
                error("Runtime Error:", chrome.runtime.lastError);
            }
            if (response?.status === "OK") {
                bmSetState(btn, "saved");
                window.bmShowConfirmation(response.data?.bookmark_id);
            } else if (response?.setupRequired) {
                bmSetState(btn, "error");
                window.bmShowSetupRequired(response.message);
            } else {
                bmSetState(btn, "error", window.bmErrorMessage(response));
                window.bmShowError(response);
            }
        });
    });

    try {
        anchor.insertAdjacentElement("afterend", btn);
        post.setAttribute(PROCESSED_ATTR, "true");
    } catch (err) {
        error(`Post #${index}: button insertion failed`, err);
    }
}

/* ===========================
   PROCESS POSTS
=========================== */

let processTimeout = null;

function processPosts() {
    const posts = document.querySelectorAll('[role="listitem"]');

    posts.forEach((post, index) => {
        try {
            injectButton(post, index);
        } catch (err) {
            error(`Post #${index}: unexpected error`, err);
        }
    });

    attemptResolvePermalinks();
}

/* ===========================
   DEBOUNCED RUNNER
=========================== */

function scheduleProcessPosts() {
    clearTimeout(processTimeout);
    processTimeout = setTimeout(processPosts, 300);
}

/* ===========================
   INITIAL RUN
=========================== */

processPosts();

/* ===========================
   OBSERVER
=========================== */

const observer = new MutationObserver(() => {
    scheduleProcessPosts();
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// New network data can arrive for a post that's already on screen and
// already failed to match (e.g. its reaction-count response hadn't landed
// yet). This periodic check catches those without waiting for a DOM
// mutation to trigger scheduleProcessPosts again.
setInterval(attemptResolvePermalinks, 2000);

console.log("========== LINKEDIN EXTENSION READY ==========");