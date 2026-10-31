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
//   (The second key is the session-state key. Settled Authentication
//    contract, planning_docs/PopUp_Background_message_relay.md: PRIMARY
//    design = "session_state" with a non-secret VALUE ("signed_in" /
//    "signed_out" — a UI signal, never proof; no token value ever lives
//    in storage); the documented fallback = "access_token" PRESENCE (the
//    body-token design). The M2 accessor pair below is that fallback's
//    half, with no callers yet; the contract's §4 (background B) lands
//    the primary key, its callers, and the legacy-key removal.)
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

// Fallback-mode accessor (M2; no callers yet — the contract's §4 auth
// section brings them, and lands the primary-design key instead).
// Passing null REMOVES the key; in fallback mode presence = signed in.
// The storage write is what fires the chrome.storage.onChanged
// broadcast (bus channel C2) an open popup consumes.
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
// MESSAGE BUS (the bus contract — planning_docs/PopUp_Background_message_relay.md §1)
// ===========================

// The seven-message catalog (contract §1 — the message inventory; the
// payload/response *shapes* are documented there, once). The names are
// constants defined inline in each file that speaks them — no shared
// file (the rework doc's no-shared-file decision, reaffirmed by the
// contract). The worker is the bus's sole owner (contract rule 7), so
// it carries the full catalog: the six listenable types register in
// the bus registration section below (CAPTURE_WEB is send-only). No
// context in the extension retypes a name as a bare string.
const MSG = {
    SAVE:          "SAVE",          // content → worker: the capture to save
    CAPTURE_WEB:   "CAPTURE_WEB",   // worker → content (tabs.sendMessage); fire-and-forget
    SESSION_EVENT: "SESSION_EVENT", // relay → worker: signed-in / signed-out; fire-and-forget
    SEARCH:        "SEARCH",        // popup → worker
    LIBRARY:       "LIBRARY",       // popup → worker (reserved — the v1 popup sends neither it nor SIGN_OUT)
    SIGN_OUT:      "SIGN_OUT",      // popup → worker (reserved)
    USER:          "USER",          // popup → worker; doubles as the on-open session check
};

// The response envelope's status vocabulary (contract §1 — "Response
// envelope": every request/response message resolves to exactly one of
// these). The worker is the bus's sole response builder (rule 7), so the
// vocabulary lands here; the later sections map their backend outcomes
// onto it and never invent a new status.
const STATUS = {
    OK:              "OK",              // { status, …feature payload }
    UNAUTHENTICATED: "UNAUTHENTICATED", // { status, sign_in_url } — the frontend origin's /login
    ERROR:           "ERROR",           // { status, code, error }
    FETCH_ERROR:     "FETCH_ERROR",     // { status, error }
};

// The SESSION_EVENT `event` values (contract §1/§2: the relay maps the
// frontend's auth:signed-in / auth:signed-out to these — the same
// vocabulary from the other side). The lookup in handleSessionEvent
// is the validation: a value not in the set is malformed (rule 5).
const SESSION_EVENTS = {
    SIGNED_IN:  "signed-in",
    SIGNED_OUT: "signed-out",
};

// ===========================
// MESSAGE ROUTING (contract §3 — Background A: message handling and routing)
// ===========================

// One chrome.runtime.onMessage listener for the whole bus (no shared
// file — rework finding 6 stands: the maps and the dispatcher live
// here, in the worker, which is the bus's sole owner, contract rule 7).
//   listen(type, handler) — request/response. The handler runs async
//   and the dispatcher holds the MV3 channel open until the handler
//   responds exactly once (rule 10).
//   notify(type, handler) — fire-and-forget (SESSION_EVENT). The
//   channel is never held open; the handler must never respond.
// Re-registration after a worker restart is by construction: the
// registrations below are top-level, so every wake re-runs them (MV3
// re-executes the script — fresh maps, one fresh listener; rule 9).
const requestHandlers = new Map();
const notificationHandlers = new Map();
let busListenerInstalled = false;

function listen(type, handler) {
    requestHandlers.set(type, handler);
    installBusListener();
}

function notify(type, handler) {
    notificationHandlers.set(type, handler);
    installBusListener();
}

function installBusListener() {
    if (busListenerInstalled) return;
    busListenerInstalled = true;

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Boundary validation (rule 5): a bus message is an object with
        // a string `type`. Anything else — the keepalive's `{}`, a
        // null, a non-object — is ignored, never treated as a command
        // (rule 4).
        if (!message || typeof message.type !== "string") return false;

        const type = message.type;

        if (notificationHandlers.has(type)) {
            runNotifyHandler(type, notificationHandlers.get(type), message, sender);
            return false; // fire-and-forget — no response (rule 10)
        }

        const handler = requestHandlers.get(type);
        if (!handler) return false; // unknown type — ignored: no crash, no side effect, no claimed success (rule 8)

        runRequestHandler(type, handler, message, sender, sendResponse);
        return true; // request/response — open until the handler responds once
    });
}

// Safe-failure guarantee for request/response handlers (rule 8): a
// handler that throws synchronously or rejects still resolves to the
// documented failure shape — and the exactly-once `respond` wrapper
// means a handler that already answered is never double-responded.
function runRequestHandler(type, handler, message, sender, sendResponse) {
    let responded = false;
    const respond = (response) => {
        if (responded) return;
        responded = true;
        sendResponse(response);
    };
    const settle = (err) => {
        console.error(`${type} handler failed:`, err);
        respond({ status: STATUS.ERROR, code: 0, error: `${type} failed: ${err?.message ?? String(err)}` });
    };
    try {
        const result = handler(message, sender, respond);
        if (result && typeof result.catch === "function") {
            result.catch(settle);
        }
    } catch (err) {
        settle(err);
    }
}

// Fire-and-forget handlers: the channel is already closed, so the
// handler's sendResponse is a logged no-op by construction; a throw or
// rejection is contained (rule 8) — a notification handler must never
// take the worker down.
function runNotifyHandler(type, handler, message, sender) {
    const ignoreResponse = () => {
        console.warn(`${type} is fire-and-forget — ignoring a sendResponse call`);
    };
    const contain = (err) => console.error(`${type} handler failed:`, err);
    try {
        const result = handler(message, sender, ignoreResponse);
        if (result && typeof result.catch === "function") {
            result.catch(contain);
        }
    } catch (err) {
        contain(err);
    }
}

// ===========================
// BUS REGISTRATION (contract §3)
// ===========================

// All six listenable bus types, at startup (the §1 catalog above minus
// CAPTURE_WEB, which is worker-SENT — the context-menu handler below
// sends it via chrome.tabs.sendMessage — and is never listened).
//
// Live senders today: the content scripts (SAVE) and the relay
// (SESSION_EVENT — its send now has a receiver; the §2 "no receiver,
// voided lastError" bridge is closed). The v1 popup stub speaks no bus
// names, so SEARCH / LIBRARY / SIGN_OUT / USER have no live consumer
// until the §10–15 popup rewrite.
listen(MSG.SAVE, handleSave);
notify(MSG.SESSION_EVENT, handleSessionEvent);
listen(MSG.SEARCH, handleSearch);
listen(MSG.LIBRARY, handleLibrary);
listen(MSG.SIGN_OUT, handleSignOut);
listen(MSG.USER, handleUser);

// ===========================
// BUS HANDLERS (contract §3 — one per listenable type)
// ===========================

// §3 owns the routing, the required-field validation, and the
// safe-failure envelope — never the operation. Each handler's
// operation belongs to the section named in its header; until that
// section lands, the operation is the marked code-0 stub — a
// documented failure shape that claims no success (rule 8). The stubs
// are the seam: the owning section replaces the operation, not the
// validation or the registration.

// SAVE — content script → worker (request/response). Contract §8 owns
// the operation; its v1-shaped body (platform detection → the router
// below) stands until §8's canonical-capture multipart submission
// replaces it. §3 adds the payload validation.
function handleSave(message, sender, sendResponse) {
    console.log("Received message in background:", message);

    // Required field (rule 5): the capture payload — every content
    // script sends { type, data } (the v1 envelope). The canonical
    // four-field shape inside it is §8's validation.
    if (typeof message.data !== "object" || message.data === null) {
        sendResponse({ status: STATUS.ERROR, code: 0, error: "SAVE requires a capture payload (data)" });
        return;
    }

    const platform = detectPlatform(sender);
    console.log("Detected platform:", platform);

    routeSave(platform, message.data, sendResponse);
}

// SESSION_EVENT — relay → worker (fire-and-forget; the sender is
// contract §2). Contract §4 owns the session semantics — the backend
// check, the one-401 recovery, the session_state write — and replaces
// this body when it lands. Until then: validate, then no-op. The
// events are idempotent notifications, so a no-op loses nothing — the
// worker's next session check arbitrates (contract §9). Never responds
// (rule 10).
function handleSessionEvent(message, _sender, _sendResponse) {
    if (!Object.values(SESSION_EVENTS).includes(message.event)) {
        console.warn(`SESSION_EVENT with unknown event value — ignored: ${String(message.event)}`);
        return;
    }
    console.log(`SESSION_EVENT: ${message.event} — session semantics land in contract §4 (no-op until then)`);
}

// SEARCH — popup → worker (request/response). Contract §6 owns the
// operation (GET /search/?q= through the §5 shared request path). §3
// owns the validation: the query must be a non-blank string, so the
// backend never sees an empty ?q= (its 400). Until §6 lands the
// operation is the code-0 stub.
function handleSearch(message, _sender, sendResponse) {
    const q = typeof message.q === "string" ? message.q.trim() : "";
    if (!q) {
        sendResponse({ status: STATUS.ERROR, code: 0, error: "SEARCH requires a non-empty 'q'" });
        return;
    }
    // §6's operation (the backend search call) lands here.
    sendResponse({ status: STATUS.ERROR, code: 0, error: "SEARCH is not implemented yet (contract §6)" });
}

// LIBRARY — popup → worker (request/response; reserved — the v1 popup
// sends neither it nor SIGN_OUT, contract §1). Contract §7 owns the
// operation (GET /captures/). Its documented payload is {} — no
// required fields to validate. Until §7 lands: the code-0 stub.
function handleLibrary(_message, _sender, sendResponse) {
    // §7's operation (the capture list) lands here.
    sendResponse({ status: STATUS.ERROR, code: 0, error: "LIBRARY is not implemented yet (contract §7)" });
}

// SIGN_OUT — popup → worker (request/response; reserved). Contract §4
// owns the operation (DELETE /auth/session — a 401-after-flush is
// success — then the session_state write). Its documented payload is
// {} — no required fields. Until §4 lands: the code-0 stub.
function handleSignOut(_message, _sender, sendResponse) {
    // §4's operation (the session teardown) lands here.
    sendResponse({ status: STATUS.ERROR, code: 0, error: "SIGN_OUT is not implemented yet (contract §4)" });
}

// USER — popup → worker (request/response). Contract §7 owns the
// operation (the session route's data.user, passed through), which
// doubles as the popup's on-open session check (contract §4's
// semantics, §7's route). Its documented payload is {} — no required
// fields. Until §7 lands: the code-0 stub.
function handleUser(_message, _sender, sendResponse) {
    // §7's operation (the user details) lands here.
    sendResponse({ status: STATUS.ERROR, code: 0, error: "USER is not implemented yet (contract §7)" });
}

// ===========================
// PLATFORM DETECTION (v1 — contract §8's territory)
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
// ROUTER (v1 — contract §8's territory)
// ===========================

// The v1 platform router — the switch body is v1 byte-identical. §3
// renamed it (the bus handler above takes the name) and gave its crash
// envelope the §1 `code` field; §8 (capture coordination) replaces it
// with the canonical-capture multipart submission.
async function routeSave(platform, payload, sendResponse) {
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
        console.error("routeSave crashed:", err);
        sendResponse({ status: STATUS.ERROR, code: 0, error: err.message });
    }
}

// ===========================
// CAPTURE SUBMISSION (v1 — contract §8's territory)
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
// FETCH HELPERS (v1 — contract §5/§8 replace it)
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
            sendResponse({ status: STATUS.OK, data });
        } else {
            console.error("Backend error:", response.status, data);
            sendResponse({ status: STATUS.ERROR, code: response.status, error: data });
        }
    } catch (err) {
        console.error("postJSON failed:", err);
        sendResponse({ status: STATUS.FETCH_ERROR, error: err.message });
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
            type: MSG.CAPTURE_WEB,
            selectionText: info.selectionText || null,
            screenshot_base64: dataUrl || null,
        }, () => {
            // Fire-and-forget sends void lastError (contract §1 —
            // CAPTURE_WEB carries no response): the tab may have no
            // receiver (a dead / net-error page, or the app origin after
            // exclude_matches) and the void keeps it a silent no-op,
            // never a throw.
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
