function getOriginalImageUrl(url) {
    try {
        const parsed = new URL(url);
        parsed.searchParams.set("name", "orig");
        return parsed.toString();
    } catch {
        return url;
    }
}

const BUTTON_CLASS = "my-twitter-save-btn";

/* ===========================
   SAVED-STATE HELPER (shared, duplicated per content script)
=========================== */

function bmSetState(btn, next) { // 'saving' | 'saved' | 'error'
    if (!btn) return;
    btn.classList.remove("bm-saving", "bm-saved", "bm-error");
    const label = btn.querySelector(".bm-label");
    if (next === "saving") btn.classList.add("bm-saving");
    if (next === "error") {
        // reset aria back to the idle/unsaved announcement — otherwise a failure
        // after a prior success leaves aria-pressed="true"/"Saved" under a red stroke
        btn.classList.add("bm-error");
        btn.setAttribute("aria-pressed", "false");
        btn.setAttribute("aria-label", "Save to Bookmark");
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
   SCRAPE SINGLE TWEET
=========================== */

function extractTweet(tweet) {

    const tweetText =
        tweet.querySelector('[data-testid="tweetText"]')?.innerText || "";

    const statusLink = tweet.querySelector('a[href*="/status/"]');
    const tweetUrl = statusLink
        ? new URL(statusLink.getAttribute("href"), location.origin).href
        : null;

    const tweetId = tweetUrl?.match(/status\/(\d+)/)?.[1] || null;

    const authorName =
        tweet.querySelector('[data-testid="User-Name"] span')?.innerText || "";

    const usernameElement =
        [...tweet.querySelectorAll('a[href^="/"]')].find(a =>
            a.textContent.includes("@")
        );
    const username = usernameElement?.textContent || "";

    const timestamp =
        tweet.querySelector("time")?.getAttribute("datetime") || "";

    // Images — upgrade to original resolution
    const images = [
        ...tweet.querySelectorAll('img[src*="pbs.twimg.com/media"]')
    ].map(img => getOriginalImageUrl(img.src));

    // Videos — collect poster thumbnails + the tweet URL for context.
    // Twitter streams via HLS so video.src is always empty at scrape time.
    // We store the poster (thumbnail) and the tweet URL; your backend can
    // use yt-dlp / gallery-dl against tweetUrl to download the actual video.
    const videos = [
        ...tweet.querySelectorAll("video")
    ].map(video => ({
        poster: video.poster ? getOriginalImageUrl(video.poster) : null,
        // src will be empty for HLS — included for completeness/debug
        src: video.src || null,
    }));

    const hasMedia = images.length > 0 || videos.length > 0;

    const source_url = tweetUrl; // For backward compatibility with older backend expecting source_url
    const mandatory_fields = {
        source_url,
        platform: "twitter",
        content_type: { 'image': true, 'video': false, 'text': true },
        capture_method: "platform_injection",
    };
    const platform_specific_data = {
        tweetId,
        authorName,
        username,
        timestamp,
        tweetText,
        images,
        videos,
        hasMedia,

    };
    return {
        mandatory_fields,
        platform_specific_data
    };
}

/* ===========================
   CREATE BUTTON
=========================== */

function createButton() {
    const button = document.createElement("button");
    button.className = "my-twitter-save-btn bm-btn bm-btn--x";
    button.type = "button";
    button.setAttribute("aria-label", "Save to Bookmark");
    button.setAttribute("aria-pressed", "false");
    button.innerHTML = `
        <span class="bm-icon-wrap">
            <svg viewBox="0 0 24 24" width="17" height="17">
                <path class="bm-ribbon" d="M6 3.5C6 2.67 6.67 2 7.5 2h9c.83 0 1.5.67 1.5 1.5v18l-7-4.5-7 4.5v-18z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" fill="none" />
                <circle class="bm-dot" cx="12" cy="9" r="1.7" fill="#EF9F27" />
            </svg>
        </span>`;
    return button;
}

/* ===========================
   INJECT INTO TWEET
=========================== */

function injectButtonIntoTweet(tweet) {
    if (tweet.querySelector(`.${BUTTON_CLASS}`)) return;

    // Mount inside the tweet's action row so the button sits inline with
    // reply/retweet/like/bookmark, not detached to the right.
    const group = tweet.querySelector('[role="group"]');
    if (!group) return;

    group.appendChild(createButton());
}

/* ===========================
   SCAN PAGE
=========================== */

function scanTweets() {
    document
        .querySelectorAll('article[data-testid="tweet"]')
        .forEach(injectButtonIntoTweet);
}

/* ===========================
   CLICK HANDLER
=========================== */

document.addEventListener("click", (event) => {
    const button = event.target.closest(".my-twitter-save-btn");
    if (!button) return;

    const tweet = button.closest('article[data-testid="tweet"]');
    if (!tweet) return;

    const payload = extractTweet(tweet);

    console.group("🚀 Sending Tweet Payload");
    console.log(payload);
    console.log(JSON.stringify(payload, null, 2));
    console.groupEnd();

    bmSetState(button, "saving");

    chrome.runtime.sendMessage({ type: "SAVE", data: payload }, (response) => {
        console.group("📨 Response From Background");
        console.log(response);
        if (chrome.runtime.lastError) {
            console.error("Runtime Error:", chrome.runtime.lastError);
        }
        console.groupEnd();
        bmSetState(button, response?.status === "OK" ? "saved" : "error");
        if (response?.status === "OK") {
            window.bmShowConfirmation(response.data?.bookmark_id);
        }
    });
});

/* ===========================
   DYNAMIC TWITTER LOADING
=========================== */

const observer = new MutationObserver(() => scanTweets());
observer.observe(document.body, { childList: true, subtree: true });

/* ===========================
   INITIAL LOAD
=========================== */

scanTweets();