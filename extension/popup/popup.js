// Internet Expedition — popup (contract §11: authentication-state
// integration; §12: sign-in navigation; §13: the profile icon's real
// name + account navigation; §14: the search field — submit-on-Enter
// through the bus, loading feedback, recoverable errors, and the
// results region).
//
// The popup does not own authentication: the frontend is the identity
// interface, and the extension rides the shared browser session. Under
// the primary (pure-cookie) design the session lives only in the cookie
// jar; the worker exposes it to the popup as the non-secret
// `session_state` signal — never as a token, since under that design
// no token exists in the extension to show.
//
// Two links to the worker, both wired in this file (§11 replaces §10's
// temporary TEMP_SESSION_STATE flag):
//
//   1. ON OPEN — the `USER` bus message (contract §7), which doubles as
//      the session check: the worker verifies against the backend
//      (contract §4) and answers
//          { status: "OK", user }           → signed in (the user
//                                             payload is the tooltip's
//                                             name — §13)
//          { status: "UNAUTHENTICATED", … } → signed out
//          { status: "ERROR" / "FETCH_ERROR" } → the backend didn't
//      answer — NOT a session verdict: the popup keeps the view it
//      already shows (the worker's "unknown" rule mirrored — a stale
//      view beats a fabricated one; the next check re-arbitrates).
//      The response ALWAYS wins over the pre-render below.
//
//   2. LIVE — the worker's `session_state` storage write (the C2
//      chrome.storage.onChanged broadcast, contract §1): a relay event,
//      a recovery, or a sign-out lands in storage and the open popup
//      re-renders to match. That subscription is the popup's only live
//      link to the worker — no polling, no reload (acceptance 3).
//
// The `session_state` cache read on open may PRE-RENDER the correct
// view in the gap before the USER response arrives; it is a cache
// signal, never proof — a stale value is overwritten by the response
// (acceptance 4), and a never-established state (a fresh profile)
// pre-renders signed-out, the honest default.
//
// Boundaries — what this file must NOT do: read a cookie value or a
// token (no cookie-jar access of any kind; under the primary design
// there is no token in the extension to read), talk to the backend
// directly (the worker is the only extension context that does), or
// write or remove storage (the worker is the sole writer). The
// exceptions to "the frontend owns identity" are two NAVIGATIONS: the
// Sign in button (contract §12) opens the frontend's /login tab, and
// the profile icon (§13) opens its /account tab — both collect nothing
// themselves.

// The bus name + the response envelope's status vocabulary, defined
// inline in this file (the §1 no-shared-file decision; the payload and
// response shapes are documented in the contract, once).
const MSG = {
    USER:   "USER",   // popup → worker; doubles as the on-open session check
    SEARCH: "SEARCH", // popup → worker; submit-on-Enter search (§14)
};

const STATUS = {
    OK:              "OK",
    UNAUTHENTICATED: "UNAUTHENTICATED",
    ERROR:           "ERROR",
    FETCH_ERROR:     "FETCH_ERROR",
};

// The worker's session-state vocabulary — the `session_state` storage
// key's VALUES (the value is the state, contract §1 C2 / Authentication
// contract). The same names the worker's SESSION_STATES table carries.
// (§11 targets the primary design; under the documented fallback
// AUTH_MODE "header" the worker's state key would instead be the token
// key's presence — a one-constant flip there, not here.)
const SESSION_STATES = {
    SIGNED_IN:  "signed_in",
    SIGNED_OUT: "signed_out",
};

// The one storage key the popup reads — the non-secret signal whose
// WRITE is the C2 broadcast (contract §1). The popup reads it (a cache
// consult) and listens for its changes; it never writes it.
const SESSION_STATE_KEY = "session_state";

// The frontend's origin — the popup's own copy of the per-manifest
// constant the worker carries (contract §8 defines it + its drift rule;
// §12 lands it here): the *website* address, whose /login is the only
// place the user enters credentials. NEVER the API origin — in dev the
// API and the website are on different ports and the bare API server
// has no /login page. The committed file carries the pinned SaaS origin
// (where the website is same-origin with the API); the dev load dir
// built by dev/manifest-dev.sh substitutes the local vite origin — the
// same line-addressed swap it applies to background.js. Three places,
// one value, one coordinated commit (the worker, the relay's
// registered origin, this copy).
const FRONTEND_ORIGIN = "https://internetexpedition.ajiteshtamrakar.com";

// The profile tooltip's name (contract §13): the real name, assembled
// from the USER response's user payload — first_name + last_name
// (space-joined, trimmed); when either part is blank, the `display`
// field, then `email` (the backend's own fallbacks). §10's placeholder
// dies here. The one terminal fallback below is a LABEL, never an
// identity: it shows only before the first USER response lands or when
// the backend answers signed-in without a usable name — the name itself
// is never inferred from anything stored locally.
const PROFILE_NAME_FALLBACK = "Account";

const signedInView = document.getElementById("view-signed-in");
const signedOutView = document.getElementById("view-signed-out");
const profileTooltip = document.getElementById("profile-tooltip");
const profileButton = document.getElementById("profile-button");

// §14: the search surface (§10's slots) — the field, the feedback line,
// and the scrollable results region below the search row.
const searchInput = document.getElementById("search-input");
const searchStatus = document.getElementById("search-status");
const searchResults = document.getElementById("search-results");

profileTooltip.textContent = PROFILE_NAME_FALLBACK;

// §13: the tooltip text from the USER response's user payload — the
// backend's account, on every check. A null user (a 200 with no payload
// — a backend contract violation) degrades to the neutral label, never
// a crash, never an invented identity.
function displayNameFor(user) {
    if (user && user.first_name && user.last_name) {
        return `${user.first_name} ${user.last_name}`.trim();
    }
    if (user) {
        if (user.display) return user.display;
        if (user.email) return user.email;
    }
    return PROFILE_NAME_FALLBACK;
}

function render(state) {
    signedInView.hidden = state !== SESSION_STATES.SIGNED_IN;
    signedOutView.hidden = state !== SESSION_STATES.SIGNED_OUT;
}

// Map a storage-signal value to a state to render: exactly the two
// vocabulary values map to themselves; anything else — a removed key
// (newValue undefined), a corrupt value — maps to "no change" (null):
// a signal the worker didn't write is not a verdict.
function stateFromSignal(value) {
    if (value === SESSION_STATES.SIGNED_IN || value === SESSION_STATES.SIGNED_OUT) {
        return value;
    }
    return null;
}

// Link 1 — the on-open session check: send USER (the §1 inventory's {}
// payload — nothing travels with it but the type) and render from the
// response. The response is authoritative: it lands after the pre-render
// below and always wins it.
async function checkSession() {
    let response;
    try {
        response = await chrome.runtime.sendMessage({ type: MSG.USER });
    } catch {
        // The worker was unreachable for this send (reaped, or the
        // channel voided): the popup keeps whatever view it shows — a
        // re-open re-checks (contract rule 9). Never a crash, never a
        // claimed state.
        return;
    }
    if (!response) return; // the channel closed with nothing — same as above
    if (response.status === STATUS.OK) {
        render(SESSION_STATES.SIGNED_IN);
        // §13: the same response carries the user details — the tooltip's
        // name comes from the backend on every check, never from storage.
        profileTooltip.textContent = displayNameFor(response.user);
    } else if (response.status === STATUS.UNAUTHENTICATED) {
        render(SESSION_STATES.SIGNED_OUT);
    }
    // ERROR / FETCH_ERROR (and any unrecognized status): the backend
    // didn't answer — no state change (the worker's §4 "unknown" rule
    // mirrored client-side).
}

// Link 2 — the C2 storage broadcast (contract §1): the worker's
// `session_state` write re-renders the open popup to match — the live
// flip (acceptance 3). Only the `local` area and only that one key; the
// value is a cache signal, but it lands only after the worker made the
// call, so it is rendered as-is. This file never writes storage — the
// worker is the sole writer.
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !(SESSION_STATE_KEY in changes)) return;
    const state = stateFromSignal(changes[SESSION_STATE_KEY].newValue);
    if (!state) return;
    render(state);
    // §13: a flip TO signed-in re-runs the USER check — the name must
    // come from the backend again, never from the stale value in the
    // tooltip. One check per flip, event-driven (still no polling). A
    // flip to signed-out sends nothing: the signed-in view is gone, and
    // the worker already made its own call before writing that state.
    if (state === SESSION_STATES.SIGNED_IN) checkSession();
});

// The Sign in button (contract §12): opens the frontend's /login in a
// new tab — the only place the user enters credentials. The popup
// collects none of them. After the user completes sign-in there, the
// relay tells the worker, the worker writes `session_state`, and the C2
// link above flips this very popup to the signed-in layout (acceptance
// 3 — no reload). The origin is the FRONTEND one, never the API's.
document.getElementById("sign-in-button").addEventListener("click", () => {
    chrome.tabs.create({ url: FRONTEND_ORIGIN + "/login" });
});

// The profile icon (contract §13): opens the frontend's /account in a
// new tab — the account page, where the user manages their identity.
// The same FRONTEND_ORIGIN constant and drift rule as §12's Sign in
// button: the *website* address, never the API origin (in dev the API
// is on a different port and has no /account page either). The popup
// collects nothing; it only navigates.
profileButton.addEventListener("click", () => {
    chrome.tabs.create({ url: FRONTEND_ORIGIN + "/account" });
});

// ================================================================
// SEARCH (contract §14 — the search integration)
// ================================================================
//
// The field is wired to the worker's SEARCH handler (contract §6) through
// the bus. The popup never talks to the Django API itself (each query can
// trigger an embedding request — which is why search is submit-on-Enter,
// never per-keystroke). One Enter → one `SEARCH { q }` → the worker's
// `GET /search/?q=`. While the (≥4.5 s) call is in flight the field is
// disabled and a "Searching…" indicator shows; on success the results
// replace it, on a failure a recoverable error shows and the field is
// usable again (a new Enter retries). The popup must not crash on a failed
// request, and it never presents stale results as current.
//
// Results render in the scrollable region below the search row, in the
// worker's rank order — EVERY result the backend returns, no cap (the
// backend has no default limit; the owner's decision stands). Each row:
// the capture's summary_text (two-line clamp), its score (the cosine
// similarity, shown as-is — higher = more relevant, never a percentage),
// and its created_at date. A row with a source_url is a link opening that
// URL in a new tab; a row without one is inert. Row text is set via
// textContent, never innerHTML (the summary is backend/user content).

// A month-name date formatter (pure — no I/O) and the score shown as-is.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatScore(score) {
    const n = Number(score);
    return Number.isFinite(n) ? n.toFixed(2) : "—";
}

// The created_at ISO stamp → a stable, locale-independent "Mon D, YYYY".
function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// One user-facing line for a failed search, from the §1 response envelope.
// Every failure is recoverable: the caller re-enables the field so a new
// Enter retries. UNAUTHENTICATED → the session is gone (the C2 broadcast
// flips the view; this is the transient line until it does).
function errorText(result) {
    if (!result) return "Something went wrong. Please try again.";
    if (result.status === STATUS.UNAUTHENTICATED) {
        return "You're signed out. Sign in to search.";
    }
    const err = result.error;
    if (err && typeof err === "object") {
        // DRF {"detail": …} …
        if (typeof err.detail === "string" && err.detail.trim()) return err.detail;
        // … or allauth {"errors": [{"message": …}]}
        if (Array.isArray(err.errors) && err.errors[0] && typeof err.errors[0].message === "string") {
            return err.errors[0].message;
        }
    } else if (typeof err === "string" && err.trim()) {
        return err; // a FETCH_ERROR's error string (a network failure)
    }
    if (result.status === STATUS.FETCH_ERROR) {
        return "Network error — check your connection and try again.";
    }
    return "Something went wrong. Please try again.";
}

// One result row: the summary (two-line clamp; a link when source_url is
// present, inert otherwise) over a meta line (the score + the date).
function buildResultRow(result) {
    const row = document.createElement("div");
    row.className = "result-row";

    const summaryText =
        typeof result.summary_text === "string" && result.summary_text.trim()
            ? result.summary_text
            : "(no summary)";

    const summary = document.createElement(result.source_url ? "a" : "span");
    summary.className = "result-summary";
    summary.textContent = summaryText; // textContent — never innerHTML
    if (result.source_url) {
        summary.href = result.source_url;
        summary.target = "_blank";
        summary.rel = "noopener noreferrer";
    }
    row.appendChild(summary);

    const meta = document.createElement("div");
    meta.className = "result-meta";
    const score = document.createElement("span");
    score.className = "result-score";
    score.textContent = formatScore(result.score);
    meta.appendChild(score);
    const date = document.createElement("span");
    date.className = "result-date";
    date.textContent = formatDate(result.created_at);
    meta.appendChild(date);
    row.appendChild(meta);

    return row;
}

// The full result set into the scrollable region, in the worker's rank
// order — every row, no cap. (The region is empty on open; results appear
// only after a search, never a default list.)
function renderResults(results) {
    searchResults.textContent = ""; // clear (drops the children)
    for (const result of results) {
        searchResults.appendChild(buildResultRow(result));
    }
}

// One search: guard against overlap, show the in-flight state, send
// `SEARCH { q }` through the bus, and render the answer (results, or a
// recoverable error). The field is re-enabled on every path.
let searching = false;

async function runSearch(q) {
    if (searching) return;
    searching = true;
    searchInput.disabled = true;
    searchStatus.textContent = "Searching…";
    searchResults.textContent = ""; // never present stale results as current

    try {
        let response;
        try {
            response = await chrome.runtime.sendMessage({ type: MSG.SEARCH, q });
        } catch {
            // The worker was unreachable for this send (reaped, or the
            // channel voided): a network-style failure, not an answer.
            response = { status: STATUS.FETCH_ERROR, error: "Could not reach the extension." };
        }
        if (response && response.status === STATUS.OK) {
            const results = Array.isArray(response.results) ? response.results : [];
            renderResults(results);
            searchStatus.textContent = results.length
                ? `${results.length} result${results.length === 1 ? "" : "s"}`
                : "No matches";
        } else {
            searchStatus.textContent = errorText(response);
        }
    } finally {
        searching = false;
        searchInput.disabled = false;
    }
}

// Submit on Enter only — typing sends nothing (no per-keystroke request;
// each query costs an embedding call). A blank query is a no-op (the worker
// would 400 it; don't call it).
searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    runSearch(q);
});

// On open: pre-render from the cache, then let the check win.
//
// The sequence is deliberate: the storage read resolves FIRST and the
// pre-render lands, and only then is USER sent. Sending first would let
// a fast response land before the (possibly stale) pre-render — the
// cache would overwrite the backend's word, inverting the "response
// always wins" rule.
(async () => {
    let items = {};
    try {
        items = await chrome.storage.local.get(SESSION_STATE_KEY);
    } catch {
        // A storage read this low in the stack should not fail; if it
        // does, the safe default below still renders and the USER check
        // still arbitrates — never a blank popup.
    }
    // A never-established state (a fresh profile — the key absent)
    // pre-renders signed-out: no session has ever been checked in this
    // profile, so the Sign in button is the honest default. (The USER
    // check that follows confirms it or flips it.)
    render(stateFromSignal(items[SESSION_STATE_KEY]) ?? SESSION_STATES.SIGNED_OUT);
    checkSession();
})();
