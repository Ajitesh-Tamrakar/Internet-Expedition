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

// The frontend's origin — the second per-manifest constant (contract §8
// carries its drift rule: one coordinated commit to change it, via the
// dev/manifest-dev.sh swap; §4 lands it first). The *website* address:
// every "open the website" action — the UNAUTHENTICATED sign_in_url, the
// popup's Sign in, the toast's sign-in link — must use this, never
// API_BASE_URL (the bare API server has no /login page). In the SaaS
// build the website is same-origin with the API (one pinned domain); in
// the dev build they are different ports, which is why it is its own
// constant. The popup carries its own copy of the same value (it cannot
// read this worker's variables).
const FRONTEND_ORIGIN = "https://internetexpedition.ajiteshtamrakar.com";

// The extension's only memory (rework config/storage block): exactly two
// keys in chrome.storage.local, and this worker is the SOLE WRITER
// (the popup is a reader + storage.onChanged listener; content scripts —
// including the relay — never touch storage). The MV3 worker is stateless
// (killed when idle), so whatever must survive a restart lives here: it
// is read once on wake and cached for the worker's lifetime — the cache
// cannot go stale mid-lifetime because we are the sole writer.
//   api_base_url   — the bare API origin; seeded on first install from
//                    the constant above, after which only the documented
//                    manual DevTools override writes it (no UI).
//   session_state  — the session-state key under the PRIMARY design
//                    (AUTH_MODE "cookie" below): a non-secret VALUE
//                    ("signed_in" / "signed_out" — the value is the
//                    state). A cache / UI signal, never proof: the
//                    worker re-verifies against the backend on every
//                    SESSION_EVENT and on the popup-open check.
//   access_token   — the session-state key under the documented
//                    FALLBACK (AUTH_MODE "header"): the body token;
//                    PRESENCE is the state. Retired under the primary —
//                    onInstalled/update removes any legacy copy.
// The mode flip is one constant + the two cookie env vars + the state
// key name (the settled Authentication contract) — never two keys at
// once: the cleanup below keeps the retired one out of the jar of keys.
let configCache = null;

async function readConfig() {
    if (configCache) return configCache;
    configCache = await chrome.storage.local.get(["api_base_url", "access_token", "session_state"]);
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

// Sole writer: re-read the wake cache straight from storage (the source
// of truth) — NOT readConfig(), which would short-circuit on the still-
// set cache and "refresh" to the very values we just changed.
async function refreshConfigCache() {
    configCache = await chrome.storage.local.get(["api_base_url", "access_token", "session_state"]);
}

// Fallback-mode (AUTH_MODE "header") accessor (M2; the contract's §4
// gives it its callers). Passing null REMOVES the key; in fallback mode
// presence = signed in. The storage write is what fires the
// chrome.storage.onChanged broadcast (bus channel C2) an open popup
// consumes. Under the primary design nothing writes this key except the
// onInstalled legacy cleanup removing it.
async function setAccessToken(token) {
    if (token) {
        await chrome.storage.local.set({ access_token: token });
    } else {
        await chrome.storage.local.remove("access_token");
    }
    // Sole writer: refresh the wake cache from storage, the source of truth.
    await refreshConfigCache();
}

// ===========================
// AUTH + SESSION (contract §4 — Background B: authentication and session lifecycle)
// ===========================
//
// The settled Authentication contract (planning_docs/PopUp_Background_
// message_relay.md) defines every route, the credential mode, the state
// key, and the 401 policy implemented here; §4 is its worker-side
// implementation. It consumes the shared request path (fetchJson, the
// §5 seam below) and the routing from §3; the popup owns no auth logic —
// it renders what this worker publishes.
//
// Step-0 probe (the contract's gate for all auth work) — recorded 2026-10-31
// in the progress log, outcome 200: the None+Secure token cookies set on
// plain-HTTP localhost AND attached to a service-worker cross-site fetch,
// so AUTH_MODE lands at the primary value and the whole positive path is
// testable locally.

// The credential mode (the contract's one-constant seam): the shared
// request path builds every fetch per this value —
//   "cookie" — PRIMARY, pure-cookie: credentials: 'include', and NO
//             Authorization header ever. The access cookie (path /api/)
//             is bridged into the header server-side; the refresh cookie
//             (path-scoped to the tokens endpoint) is the recovery door.
//             No token value lives anywhere in the extension.
//   "header" — the documented FALLBACK (body-token): the worker reads
//             data.access_token from the refresh response's body into
//             chrome.storage and sends Authorization: Bearer (plus
//             credentials: 'include', so the refresh cookie still rides
//             the recovery call).
// The agent never switches on its own judgment: the fallback's trigger
// is a probe-passed pure-cookie *data* flow that fails in integration
// in a way that requires changing browser cookie behavior, and the
// switch is made explicit to the owner, who flips this constant (plus
// the two cookie env vars — the state key follows from it). Nothing else
// in the worker changes: both branches exist, by construction.
const AUTH_MODE = "cookie";

// The session-state values (the storage key's vocabulary under the
// primary design — the VALUE is the state). Distinct from the bus's
// SESSION_EVENTS values (the MESSAGE BUS section below: "signed-in" /
// "signed-out" — the frontend's hyphenated names the relay forwards):
// same meaning, two vocabularies, per the contract.
const SESSION_STATES = {
    SIGNED_IN:  "signed_in",
    SIGNED_OUT: "signed_out",
};

// Write the session-state key — the one non-secret key's writer (the
// contract: the worker is the sole writer; its write is the C2
// broadcast that flips an open popup). In cookie mode the value is the
// state; in header mode the state is the token key's PRESENCE, which
// recoverSession writes itself — only signed-out (key removal) is
// reachable from here. A stored value is a cache, never proof of
// authentication: the backend check arbitrates.
async function setSessionState(state) {
    if (AUTH_MODE === "cookie") {
        await chrome.storage.local.set({ session_state: state });
    } else if (state === SESSION_STATES.SIGNED_OUT) {
        await setAccessToken(null);
    }
    // Sole writer: refresh the wake cache from storage, the source of truth.
    await refreshConfigCache();
}

// The shared request path (contract §5 — Background C). §4 lands it as
// authentication's dependency (the build order runs §5 immediately
// before §4); §6-§8's features consume it as they land, so no feature
// re-implements fetch plumbing or error vocabulary.
//
// Owns: URL construction from the bare origin (the route-prefix gotcha —
// auth routes under /api/auth/…, data routes at the root; every route
// spelled in full at its call site, never appended to a path-carrying
// base), the credential behavior for the active AUTH_MODE, response
// parsing, and the mapping onto the §1 bus envelope (a network failure
// → FETCH_ERROR; an HTTP error → ERROR with the backend body passed
// through — DRF {"detail": …} or allauth {"errors": […]}; a 2xx → OK).
// Does NOT own: authentication decisions (the 401 recovery and the
// UNAUTHENTICATED verdict are §4, below) — a 401 here is a plain ERROR
// envelope for whoever decides what it means.
async function fetchJson(path, { method = "GET", body = null } = {}) {
    const base = await getApiBaseUrl();
    const init = { method, credentials: "include" };
    // The credential seam: header mode attaches the stored body token.
    // Cookie mode builds NO header — the access cookie is bridged
    // server-side (docs/authentication.md, the AccessTokenBridge); a
    // request with neither is simply anonymous. credentials: 'include'
    // in BOTH modes — the refresh cookie must reach its one endpoint.
    if (AUTH_MODE === "header") {
        const token = await getAccessToken();
        if (token) init.headers = { Authorization: `Bearer ${token}` };
    }
    if (body !== null && body !== undefined) {
        if (typeof body !== "string") {
            init.headers = { ...(init.headers || {}), "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        } else {
            init.body = body;
        }
    }

    let response;
    try {
        response = await fetch(base + path, init);
    } catch (err) {
        return { status: STATUS.FETCH_ERROR, error: String(err) };
    }

    // One body read, JSON if it parses: a non-JSON error page (an HTML
    // 502) is carried as text, never a crash. No body logging — under
    // the primary design the refresh/session responses carry a body copy
    // of the access token, and no token value may reach the console,
    // the bus, or storage.
    const text = await response.text().catch(() => "");
    let data = null;
    try { if (text) data = JSON.parse(text); } catch { /* non-JSON */ }

    if (response.ok) return { status: STATUS.OK, data };
    return { status: STATUS.ERROR, code: response.status, error: data !== null ? data : (text || `HTTP ${response.status}`) };
}

// The session check (contract §4): the one call that decides
// signed-in-or-not — the check that relay SESSION_EVENTs and the
// popup-open USER (§7) both resolve to. Plain fetchJson, NOT authFetch:
// a 401 here is the answer, not a trigger.
//   200 with data.user → "in" · 401 → "out" (dead or expired)
//   5xx / network → "unknown" — the backend didn't answer; callers must
//   leave any prior state untouched (never fabricate one).
async function checkSession() {
    const result = await fetchJson("/api/auth/app/v1/auth/session", { method: "GET" });
    if (result.status === STATUS.OK) return "in";
    if (result.status === STATUS.ERROR && result.code === 401) return "out";
    return "unknown";
}

// The recovery door (contract §4): POST tokens/refresh with an EMPTY
// body — the refresh cookie (path-scoped to this one endpoint)
// authenticates it; credentials: 'include' lets it ride (fetchJson).
//   200 → a fresh access cookie minted into the jar — and, header mode
//         only, the body's access token stored (the one token write in
//         this file; the primary design ignores the body copy).
//   4xx → "gone" — the session is definitively dead (stale / rotated /
//         flushed); the backend answered, so its word is final.
//   5xx / network → "unknown" — the backend didn't answer; nothing may
//         be claimed, no state written.
async function recoverSession() {
    const result = await fetchJson("/api/auth/app/v1/tokens/refresh", { method: "POST" });
    if (result.status === STATUS.OK) {
        // Allauth's envelope nests the token: the body is
        // { status, data: { access_token }, … } — fetchJson's `data` is
        // the whole body, so the token is one level deeper.
        if (AUTH_MODE === "header" && result.data?.data?.access_token) {
            await setAccessToken(result.data.data.access_token);
        }
        return "ok";
    }
    if (result.status === STATUS.ERROR && result.code >= 400 && result.code < 500) return "gone";
    return "unknown";
}

// The UNAUTHENTICATED envelope (contract §1 response envelope): the
// session is gone. sign_in_url is the FRONTEND origin's /login — never
// the API origin (the bare API server has no /login page).
function unauthenticated() {
    return { status: STATUS.UNAUTHENTICATED, sign_in_url: FRONTEND_ORIGIN + "/login" };
}

// The single gate every authenticated data call goes through (contract
// §4 Recovery): a 401 → at most one recovery → at most one retry. Never
// a loop. Outcomes:
//   2xx / non-401 error → passed through as fetchJson gave it.
//   401 → recovery "gone" (a definitive 4xx from the refresh): write
//     signed_out (the C2 broadcast flips an open popup) and report
//     UNAUTHENTICATED with the sign-in URL.
//   401 → recovery "ok": one retry of the original call; a still-401
//     retry means the session died in the gap — same signed-out verdict.
//   401 → recovery "unknown" (the refresh never reached the backend):
//     the session is unverifiable — the original result passes through
//     with NO state write; the next check arbitrates.
async function authFetch(path, options = {}) {
    let result = await fetchJson(path, options);
    if (!(result.status === STATUS.ERROR && result.code === 401)) return result;

    const recovery = await recoverSession();
    if (recovery === "gone") {
        await setSessionState(SESSION_STATES.SIGNED_OUT);
        return unauthenticated();
    }
    if (recovery !== "ok") return result;

    result = await fetchJson(path, options); // the one retry
    if (result.status === STATUS.ERROR && result.code === 401) {
        await setSessionState(SESSION_STATES.SIGNED_OUT);
        return unauthenticated();
    }
    return result;
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
// contract §2). Contract §4 owns the session semantics: the event is a
// notification, never proof — the backend arbitrates, and its answer is
// the session-state write (whose C2 broadcast flips an open popup). The
// events are idempotent, so duplicates and out-of-order delivery
// converge: every handling re-verifies against the backend. Never
// responds (rule 10); a failure is logged, never thrown at the bus.
async function handleSessionEvent(message, _sender, _sendResponse) {
    if (!Object.values(SESSION_EVENTS).includes(message.event)) {
        console.warn(`SESSION_EVENT with unknown event value — ignored: ${String(message.event)}`);
        return;
    }
    if (message.event === SESSION_EVENTS.SIGNED_OUT) {
        // The frontend KNOWS it logged out (its own DELETE) — that is
        // authoritative: write immediately. The jar may still live (a
        // kill can race the event); the worker's next check arbitrates,
        // so no reverse channel is needed (the contract closes that
        // open item).
        await setSessionState(SESSION_STATES.SIGNED_OUT);
        return;
    }
    // signed-in: re-verify — the event is not proof, the backend's
    // answer is the state.
    const check = await checkSession();
    if (check === "in") {
        await setSessionState(SESSION_STATES.SIGNED_IN);
    } else if (check === "out") {
        // The backend says the session is dead — one recovery (an
        // expired access with a live refresh resurrects it), and its
        // outcome is the state. (A recovery "unknown" here can only be
        // a 5xx — the check just reached the backend — so signed_out is
        // the honest state either way.)
        const recovery = await recoverSession();
        await setSessionState(recovery === "ok" ? SESSION_STATES.SIGNED_IN : SESSION_STATES.SIGNED_OUT);
    }
    // check === "unknown" (5xx / network): no state write — a stale
    // cache beats a fabricated one; the next event or the popup-open
    // check re-verifies (contract §9).
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

// SIGN_OUT — popup → worker (request/response; reserved — the v1 popup
// sends neither it nor LIBRARY, contract §1). Contract §4 owns the
// operation: DELETE auth/session — a 401-after-flush is success — then
// the session-state write. Documented payload {} — no required fields.
async function handleSignOut(_message, _sender, sendResponse) {
    let result = await fetchJson("/api/auth/app/v1/auth/session", { method: "DELETE" });

    // A 2xx confirms the flush. A 401 is the contract's success (allauth
    // flushes the session and THEN answers 401 — docs/authentication.md)
    // — but it is ambiguous: an EXPIRED access credential 401s without
    // flushing, and the session (the live refresh cookie) would still
    // stand, so "success" would be a lie the next derive undoes.
    // Disambiguate exactly as authFetch does — one recovery, one retry:
    //   recovery "gone"   → the backend says the session is already dead:
    //                       the sign-out goal is met by definition.
    //   recovery "ok"     → the retry rides the fresh credential; its
    //                       2xx/401 is the real flush.
    //   recovery "unknown"→ the refresh never reached the backend — the
    //                       flush is unverifiable: keep the original 401
    //                       as the answer (a structured error), write no
    //                       state, claim no success (acceptance 4).
    let flushConfirmed = result.status === STATUS.OK;
    if (!flushConfirmed && result.status === STATUS.ERROR && result.code === 401) {
        const recovery = await recoverSession();
        if (recovery === "gone") {
            flushConfirmed = true;
        } else if (recovery === "ok") {
            const retry = await fetchJson("/api/auth/app/v1/auth/session", { method: "DELETE" });
            result = retry;
            // The retry's HTTP status is the envelope's `code` (its
            // `status` is the bus vocabulary): a 2xx or the
            // 401-after-flush confirms the real flush.
            flushConfirmed = retry.status === STATUS.OK || (retry.status === STATUS.ERROR && retry.code === 401);
        }
    }

    if (!flushConfirmed) {
        // No confirmed flush: pass the original result through — the
        // 401 / 5xx / FETCH_ERROR as a structured error. State
        // unchanged, no success claimed.
        sendResponse(result);
        return;
    }

    // The flush is real: both token cookies are cleared by the backend,
    // so nothing can resurrect the session. Write the state — the C2
    // broadcast flips an open popup (and, header mode, removes the
    // stored token).
    await setSessionState(SESSION_STATES.SIGNED_OUT);
    sendResponse({ status: STATUS.OK });
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

    // Legacy-key cleanup (the settled Authentication contract): under
    // the primary design no token value ever lives in storage — the
    // access_token key is retired, so remove any copy a pre-§4 build
    // left behind. Mode-gated: in the fallback the key is the live
    // state key and must survive.
    if (AUTH_MODE === "cookie") {
        await chrome.storage.local.remove("access_token");
    }

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
