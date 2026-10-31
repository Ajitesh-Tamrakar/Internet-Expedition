// ==================================================================
// Sync relay (contract §2 — planning_docs/PopUp_Background_message_relay.md)
//
// A small content script registered ONLY on the frontend app origin
// (both manifests: the pinned SaaS origin in production, the vite
// origin in the dev load dir — see the relay entries in
// manifest.json / manifest.dev.json). Registered at document_idle; it
// only listens, and injects nothing.
//
// Its single job: receive the frontend's window.postMessage auth
// events and forward them to the service worker as SESSION_EVENT.
// That is everything. It is NOT an authentication module — by its own
// boundaries it never:
//   - reads or copies either HttpOnly token (a postMessage event can't
//     carry one anyway — the check below rejects anything but the two
//     agreed field-less names);
//   - makes fetch/XHR requests to the backend;
//   - reads or writes chrome.storage;
//   - modifies the page DOM;
//   - implements login, logout, token refresh, or session validation;
//   - decides a session is valid because it saw `auth:signed-in`
//     (the worker re-checks the backend — the event is a notification,
//     never proof).
//
// Push fast path only (contract §2): if the service worker is gone or
// the send fails, the relay voids it and moves on — the worker's next
// session check restores correct state. The IIFE keeps every name out
// of the isolated world's shared scope (content scripts on a page run
// in one realm — no top-level identifiers by design).
// ==================================================================

(function () {
    // The one bus name this script speaks (contract §1 inventory — the
    // payload/response shapes are documented there, once; the constant
    // is defined inline in each file that uses it, no shared file).
    const MSG = {
        SESSION_EVENT: "SESSION_EVENT",  // → worker: signed-in / signed-out; fire-and-forget
    };

    // The agreed translation: the frontend's page-level event name →
    // the worker's SESSION_EVENT `event` value (contract §2). The map
    // IS the validation — a name not in it is not one of the two
    // agreed names, so it is ignored.
    const SESSION_EVENTS = {
        "auth:signed-in":  "signed-in",
        "auth:signed-out": "signed-out",
    };

    window.addEventListener("message", (event) => {
        // The frontend posts with targetOrigin = its own origin. The
        // relay runs in the page's isolated world, so
        // window.location.origin is that same origin — anything else is
        // an unrelated page talking to itself. Ignore.
        if (event.origin !== window.location.origin) return;

        // The payload must be EXACTLY { type: <agreed name> }: one
        // field, no tokens, no user data. Any deviation — extra fields,
        // wrong field, non-object, array — does nothing (contract §2:
        // "it does nothing at all on a malformed or unrelated message").
        if (typeof event.data !== "object" || event.data === null) return;
        const keys = Object.keys(event.data);
        if (keys.length !== 1 || keys[0] !== "type") return;

        const mapped = SESSION_EVENTS[event.data.type];
        if (!mapped) return;

        // Forward as the bus message (contract §1: SESSION_EVENT —
        // relay → service worker, fire-and-forget, no response).
        chrome.runtime.sendMessage(
            { type: MSG.SESSION_EVENT, event: mapped },
            () => {
                // A missing or torn-down receiver sets lastError; void
                // it so the send is a silent no-op, never an uncaught
                // throw. The relay never retries and never replaces the
                // worker's responsibilities.
                void chrome.runtime.lastError;
            },
        );
    });
})();
