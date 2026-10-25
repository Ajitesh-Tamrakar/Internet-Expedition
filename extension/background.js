// ===========================
// CONFIG
// ===========================

// The one API origin — the pinned SaaS origin. It is a project constant
// (impl doc Flag §6-9: it appears in a handful of places that must not
// drift — the manifest's host_permissions, the relay entry, the
// exclude_matches, this default, and the backend's CORS allowlist;
// any change is a single coordinated commit). The dev load dir built by
// dev/manifest-dev.sh substitutes this value with the local origin, so
// the same background.js serves both manifests.
const API_BASE_URL = "https://internetexpedition.ajiteshtamrakar.com";

// The extension's only memory (rework config/storage block): exactly two
// keys in chrome.storage.local, and this worker is the SOLE WRITER
// (the popup is a reader + storage.onChanged listener; content scripts —
// including the relay — never touch storage). The MV3 worker is stateless
// (killed when idle), so whatever must survive a restart lives here: it
// is read once on wake and cached for the worker's lifetime — the cache
// cannot go stale mid-lifetime because we are the sole writer.
//   api_base_url  — the bare API origin; seeded on first install from the
//                   constant above, after which only the documented
//                   manual DevTools override writes it (no UI).
//   access_token  — the last derived access token; PRESENCE = signed in,
//                   absent = sign-in-required. No expiry bookkeeping, no
//                   timers — the derive/refresh callers arrive in M4.
let configCache = null;

async function readConfig() {
    if (configCache) return configCache;
    configCache = await chrome.storage.local.get(["api_base_url", "access_token"]);
    return configCache;
}

// The bare API origin: the stored value, else the per-manifest constant.
// Route-prefix gotcha (rework §3.4): auth routes sit under /api/auth/…
// while the data routes are at the root — every call carries its own
// prefix, so the base is always the bare origin, never "/api"-suffixed.
async function getApiBaseUrl() {
    const cfg = await readConfig();
    return cfg.api_base_url || API_BASE_URL;
}

async function getAccessToken() {
    const cfg = await readConfig();
    return cfg.access_token || null;
}

// Presence is the state: passing null REMOVES the key (absent =
// signed out). The storage write is what fires the
// chrome.storage.onChanged broadcast (bus channel C2) an open popup
// consumes. (M2 lands the accessor; its callers arrive in M4.)
async function setAccessToken(token) {
    if (token) {
        await chrome.storage.local.set({ access_token: token });
    } else {
        await chrome.storage.local.remove("access_token");
    }
    // Sole writer: refresh the wake cache from storage, the source of truth.
    configCache = await chrome.storage.local.get(["api_base_url", "access_token"]);
}

// ===========================
// MESSAGE BUS (rework §1 bus block)
// ===========================

// The small intra-file listener wrapper (rework finding 6 — no shared
// bus.js file in v1). Rule 1: every C1 message is {type, …} and a
// listener matches `type` first — everything else is ignored. Rule 2:
// the handler owns the response — it runs async and calls sendResponse
// exactly once, so the listener returns true to keep the MV3 channel
// open until then.
function listen(type, handler) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.type !== type) return false;
        handler(message, sender, sendResponse);
        return true;
    });
}

// M2 registers SAVE only; the rest of the seven-message catalog
// (SESSION_EVENT / SIGN_OUT — M4; SEARCH / LIBRARY / USER — M6)
// registers in its feature milestone, and CAPTURE_WEB is worker→content
// (sent below, never listened). An unregistered type is ignored by rule
// 1, so partial registration is safe.
listen("SAVE", (message, sender, sendResponse) => {
    console.log("Received message in background:", message);

    // Handler body stays v1-shaped in M2 — the canonical-capture
    // redesign and the SaaS status vocabulary are M5 (impl doc §3.3).
    const platform = detectPlatform(sender);
    console.log("Detected platform:", platform);

    // Kick off async work; listen() keeps the channel open (rule 2).
    handleSave(platform, message.data, sendResponse);
});

// ===========================
// PLATFORM DETECTION
// ===========================

function detectPlatform(sender) {
    const url = sender?.tab?.url || "";
    if (url.includes("youtube.com"))   return "youtube";
    if (url.includes("twitter.com") || url.includes("x.com")) return "twitter";
    if (url.includes("linkedin.com"))  return "linkedin";
    if (url.includes("pinterest.com")) return "pinterest";
    return "web";
}

// ===========================
// ROUTER
// ===========================

async function handleSave(platform, payload, sendResponse) {
    try {
        switch (platform) {
            case "youtube":
                await handleYouTube(payload, sendResponse);
                break;
            case "twitter":
                await handleGeneric(payload, sendResponse);
                break;
            case "linkedin":
            case "pinterest":
            case "web":
            default:
                await handleGeneric(payload, sendResponse);
                break;
        }
    } catch (err) {
        console.error("handleSave crashed:", err);
        sendResponse({ status: "ERROR", error: err.message });
    }
}

// ===========================
// HANDLERS
// ===========================

async function handleYouTube(payload, sendResponse) {
    // YouTube was already working — plain JSON POST, no media download
    const base = await getApiBaseUrl();
    await postJSON(`${base}/captures/`, payload, sendResponse);
}

async function handleGeneric(payload, sendResponse) {
    const base = await getApiBaseUrl();
    await postJSON(`${base}/captures/`, payload, sendResponse);
}

// ===========================
// FETCH HELPERS
// ===========================

async function postJSON(url, payload, sendResponse) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        const data = await response.json();

        if (response.ok) {
            console.log("JSON POST success:", data);
            sendResponse({ status: "OK", data });
        } else {
            console.error("Backend error:", response.status, data);
            sendResponse({ status: "ERROR", code: response.status, error: data });
        }
    } catch (err) {
        console.error("postJSON failed:", err);
        sendResponse({ status: "FETCH_ERROR", error: err.message });
    }
}

// ===========================
// CONTEXT MENU
// ===========================

// The two onInstalled duties merged into one listener (impl doc §3.3):
// seed the API origin on first install + create the context menu.
chrome.runtime.onInstalled.addListener(async () => {
    // Seed api_base_url ONLY IF ABSENT — a stored value is the
    // documented manual DevTools override and must survive reinstalls
    // and updates (rework config block).
    const cfg = await chrome.storage.local.get("api_base_url");
    if (!cfg.api_base_url) {
        await chrome.storage.local.set({ api_base_url: API_BASE_URL });
    }
    // A fresh worker may have cached pre-seed reads: force the next
    // readConfig() to come from storage. (The seed equals the constant
    // fallback, so a read racing this write resolves identically either
    // way — no behavior race.)
    configCache = null;

    chrome.contextMenus.create({
        id:       "bookmark-save-web",
        title:    "Save to Bookmark",
        contexts: ["page", "selection"],
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId !== "bookmark-save-web") return;

    // Origin guard (rework finding 5, its "optional complement" —
    // included): the app origin is in host_permissions, so tab.url is
    // readable *there* and undefined for every other origin. The check
    // fires precisely on our own pages (a save would otherwise
    // screenshot + capture our own UI — self-capture) and never on the
    // web. A missing tab / url degrades safely past the guard.
    const base = await getApiBaseUrl();
    if (tab?.url && tab.url.startsWith(base)) return;

    chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
            // C5: capture can legitimately fail (disallowed page type, rate limit). Not an
            // error worth surfacing to the user — just proceed without a screenshot.
            dataUrl = null;
        }
        chrome.tabs.sendMessage(tab.id, {
            type: "CAPTURE_WEB",
            selectionText: info.selectionText || null,
            screenshot_base64: dataUrl || null,
        }, () => {
            // Bus rule 3: fire-and-forget senders void lastError — the
            // tab may have no receiver (a dead / net-error page, or the
            // app origin after exclude_matches) and the void keeps it a
            // silent no-op, never a throw.
            void chrome.runtime.lastError;
        });
    });
});

// ===========================
// MEDIA DOWNLOADER
// ===========================

async function downloadMedia(url) {
    try {
        console.log("Downloading:", url);
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.blob();
    } catch (err) {
        console.error("Download failed:", err);
        return null;
    }
}
