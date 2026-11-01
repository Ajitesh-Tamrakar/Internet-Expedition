// Internet Expedition — popup (contract §11: authentication-state
// integration; §13: the profile icon's real name + account
// navigation).
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
    USER: "USER", // popup → worker; doubles as the on-open session check
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
