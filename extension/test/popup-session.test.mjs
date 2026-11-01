// ==================================================================
// Sections 11-12 (contract "Popup — authentication-state integration"
// + "sign-in navigation") — the in-repo acceptance net.
//
// Runs the REAL extension/popup/popup.js in a node:vm context (a
// minimal DOM stub + a chrome stub) against the REAL
// extension/background.js through the shared harness (harness.mjs):
// the popup's USER send rides the same real bus listener the relay
// and the content scripts do, and the worker's session_state writes
// fire the popup's chrome.storage.onChanged with Chrome-shaped change
// objects — the C2 broadcast, the popup's only live link.
//
//   AT1  open while signed in (a live session) → the signed-in layout,
//        pre-rendered from the cache and confirmed by the USER check
//   AT2  open while signed out → the signed-out layout (including the
//        honest default: a fresh profile with no session ever checked)
//   AT3  a STALE cache (storage says signed_in, the session is dead)
//        → the pre-render shows signed-in, the USER response WINS and
//        flips to signed-out
//   AT4  a live flip with no reload: the relay's signed-out event lands
//        in storage → the open popup re-renders via the C2 broadcast,
//        with no second USER sent and no backend call
//   AT5  a worker restart: a re-open while the worker is dead keeps its
//        pre-render (a voided send is not a verdict); a respawned
//        worker + a fresh reopen re-requests USER and renders the
//        backend's truth
//   AT6  a sick backend (5xx) / a dead network → the view and the state
//        are untouched (the worker's "unknown" rule, mirrored)
//   AT7  (contract §12) the Sign in button opens exactly the popup's
//        FRONTEND_ORIGIN + /login in a new tab, and that constant
//        matches the worker's copy (three places, one value)
//   audits   the §11 contract bullets on the popup source: no cookie
//        read, no token, no direct backend call, no storage write, no
//        timers; the popup carries its own FRONTEND_ORIGIN constant
//
// No bench required — the fake backend stands in for the Django app.
// Run:  node extension/test/popup-session.test.mjs
// ==================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
    EXT_DIR, NO_RESPONSE, HUNG,
    makeBench, waitFor,
} from "./harness.mjs";

// ------------------------------------------------------------------
// Tiny assertion ledger (the worker-lifecycle.test.mjs pattern).
// ------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; failures.push(name); console.log(`  FAIL ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EV_IN = { type: "SESSION_EVENT", event: "signed-in" };
const EV_OUT = { type: "SESSION_EVENT", event: "signed-out" };
const SESSION_PATH = "/api/auth/app/v1/auth/session";
const state = (bench) => bench.storage.snapshot().session_state;
const sessionGets = (bench, from = 0) =>
    bench.backend.requests.slice(from).filter((r) => r.method === "GET" && r.path === SESSION_PATH).length;

// Which view the popup currently shows (the §11 rendered state).
const view = (p) =>
    p.elements["view-signed-in"].hidden
        ? (p.elements["view-signed-out"].hidden ? "none" : "signed_out")
        : "signed_in";

// Let the popup's USER round-trip finish: wait for the worker's
// session GET on the fake backend, rest for the response + render,
// then pump in case the worker's state write fired the C2 broadcast
// (both paths render the same state; the pump is this test's delivery
// of the onChanged Chrome would fire).
async function settleUserCheck(bench, popup, mark) {
    await waitFor(() => sessionGets(bench, mark) >= 1);
    await sleep(30);
    popup.pump();
    await sleep(5);
    popup.pump();
}

// ------------------------------------------------------------------
// PopupProcess — one popup "open": the real popup.js in a fresh vm
// context. The popup is ephemeral (contract rule 9): a close is a
// process the test simply stops pumping; a reopen is a fresh process
// over the same persistent storage.
// ------------------------------------------------------------------
class PopupProcess {
    constructor({ source, storage, worker }) {
        this.source = source;
        this.storage = storage; // the shared persistent StorageStub
        this.worker = worker;   // the harness WorkerProcess (may be dead)
        this.onChangedListeners = [];
        this.sent = [];         // every runtime.sendMessage payload
        this.tabCreations = []; // every chrome.tabs.create props object
    }

    open() {
        const elements = {
            "view-signed-out": { hidden: true },
            "view-signed-in": { hidden: true },
            "profile-tooltip": { textContent: "User" },
            "sign-in-button": {
                hidden: false,
                listeners: [],
                addEventListener(type, fn) { this.listeners.push({ type, fn }); },
            },
        };
        const sandbox = {
            console,
            document: { getElementById: (id) => elements[id] },
            chrome: {
                tabs: { create: (props) => this.tabCreations.push(props) },
                storage: {
                    local: {
                        // The one key the popup reads, delegated to the
                        // same persistent storage the worker writes.
                        get: (keys) => {
                            const list =
                                typeof keys === "string" ? [keys]
                                : Array.isArray(keys) ? keys
                                : Object.keys(this.storage.data);
                            const out = {};
                            for (const k of list) if (k in this.storage.data) out[k] = this.storage.data[k];
                            return Promise.resolve(out);
                        },
                    },
                    onChanged: { addListener: (fn) => this.onChangedListeners.push(fn) },
                },
                runtime: {
                    sendMessage: (message) => {
                        this.sent.push(message);
                        if (!this.worker.alive) {
                            // Chrome rejects a sendMessage whose receiving
                            // end does not exist (a reaped worker).
                            return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
                        }
                        return this.worker.send(message).then((value) => {
                            if (value === NO_RESPONSE || value === HUNG) {
                                return Promise.reject(new Error("the channel closed without a response"));
                            }
                            return value;
                        });
                    },
                },
            },
        };
        sandbox.globalThis = sandbox;
        this.elements = elements;
        this.last = this.storage.snapshot(); // the pump's previous view
        vm.createContext(sandbox);
        vm.runInContext(this.source, sandbox, { filename: "popup.js" });
        return this;
    }

    // Emulate Chrome's storage.onChanged for this popup: dispatch to the
    // registered listeners a Chrome-shaped changes object (only the keys
    // that changed, with oldValue / newValue) for whatever the worker's
    // writes have landed in the shared storage since the last pump.
    pump() {
        const now = this.storage.snapshot();
        const keys = new Set([...Object.keys(this.last), ...Object.keys(now)]);
        const changes = {};
        for (const k of keys) {
            if (this.last[k] !== now[k]) changes[k] = { oldValue: this.last[k], newValue: now[k] };
        }
        this.last = now;
        if (!Object.keys(changes).length) return false;
        for (const fn of this.onChangedListeners) fn(changes, "local");
        return true;
    }

    // Fire the Sign in button's click handler (contract §12).
    clickButton() {
        for (const { type, fn } of this.elements["sign-in-button"].listeners) {
            if (type === "click") fn();
        }
    }
}

// ------------------------------------------------------------------
async function main() {
    const backgroundSource = readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
    const popupSource = readFileSync(path.join(EXT_DIR, "popup", "popup.js"), "utf8");
    void backgroundSource; // the worker source is loaded by the harness
    // The popup's per-manifest origin constant, read from the source
    // under test — origin-sensitive assertions track whichever build is
    // loaded (committed = the pinned origin; .dev-load = the local one).
    const mo = popupSource.match(/^const FRONTEND_ORIGIN = "([^"]+)"/m);
    const popupFrontendOrigin = mo ? mo[1] : null;

    // ------------------------------------------------- audits (acceptance 5, static)
    console.log("\n[audit] the popup source");
    check("popup: never reads document.cookie", !/document\.cookie/.test(popupSource));
    check("popup: no token key or credential anywhere", !/access_token|refresh_token|Bearer|Authorization/.test(popupSource));
    check("popup: no direct backend calls (no fetch, no XHR)", !/fetch\(|XMLHttpRequest/.test(popupSource));
    check("popup: never writes or removes storage (the worker is the sole writer)", !/storage\.local\.(set|remove)/.test(popupSource));
    check("popup: no polling timers", !/setTimeout\(|setInterval\(/.test(popupSource));
    check("popup: reads exactly the one non-secret key (session_state)",
        /const SESSION_STATE_KEY = "session_state"/.test(popupSource) &&
        (popupSource.match(/storage\.local\.get\(/g) || []).length === 1 &&
        /storage\.local\.get\(SESSION_STATE_KEY\)/.test(popupSource));
    check("popup: exactly one C2 subscription (its only live link)",
        (popupSource.match(/onChanged\.addListener\(/g) || []).length === 1);
    check("popup: carries its own FRONTEND_ORIGIN constant (§12)", Boolean(popupFrontendOrigin));

    // ------------------------------------------------- bench
    const bench = await makeBench({ backendOpts: { results: [] } });
    const openPopup = () =>
        new PopupProcess({ source: popupSource, storage: bench.storage, worker: bench.worker }).open();
    // Re-seed the worker over a known storage (a fresh profile below
    // mutates the shared storage; a wake re-reads it).
    const respawn = async () => { bench.worker.kill(); bench.worker.spawn(); };

    // ------------------------------------------ AT1: open while signed in
    console.log("\n[AT1] open while signed in (a live session)");
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    const mark1 = bench.backend.requests.length;
    const p1 = openPopup();
    await sleep(0); // the storage read resolves → the cache pre-render lands
    check("AT1: the cache pre-renders the signed-in view before the response", view(p1) === "signed_in");
    await settleUserCheck(bench, p1, mark1);
    check("AT1: the USER response confirms the signed-in layout", view(p1) === "signed_in");
    check("AT1: exactly one USER on open, the inventory's {} payload",
        p1.sent.length === 1 && p1.sent[0].type === "USER" && JSON.stringify(p1.sent[0]) === '{"type":"USER"}');
    check("AT1: the worker verified against the backend (one session GET, no recovery)",
        sessionGets(bench, mark1) === 1);

    // ------------------------------------------ AT2: open while signed out
    console.log("\n[AT2] open while signed out");
    await respawn();
    bench.backend.logout();
    delete bench.storage.data.session_state; // a fresh profile: the key absent

    const mark2 = bench.backend.requests.length;
    const p2 = openPopup();
    await sleep(0);
    check("AT2: a never-established state pre-renders signed-out (the honest default)", view(p2) === "signed_out");
    await settleUserCheck(bench, p2, mark2);
    check("AT2: the USER response renders the signed-out view", view(p2) === "signed_out");
    check("AT2: the worker wrote signed_out (the UNAUTHENTICATED verdict landed)", state(bench) === "signed_out");

    // The worker had already decided (the key reads signed_out): the
    // pre-render and the response agree.
    const mark2b = bench.backend.requests.length;
    const p2b = openPopup();
    await sleep(0);
    check("AT2: a cached signed_out pre-renders the signed-out view", view(p2b) === "signed_out");
    await settleUserCheck(bench, p2b, mark2b);
    check("AT2: still signed-out after the check", view(p2b) === "signed_out");

    // ------------------------------------------ AT3: a stale cache — the response wins
    console.log("\n[AT3] a stale cache — the response always wins");
    await respawn();
    bench.backend.logout(); // the session died server-side; no event
    bench.storage.data.session_state = "signed_in"; // stale

    const mark3 = bench.backend.requests.length;
    const p3 = openPopup();
    await sleep(0);
    check("AT3: the stale cache pre-renders signed-in", view(p3) === "signed_in");
    await settleUserCheck(bench, p3, mark3);
    check("AT3: the USER response WINS over the stale cache → signed-out", view(p3) === "signed_out");
    check("AT3: the worker's signed_out write landed in storage", state(bench) === "signed_out");

    // ------------------------------------------ AT4: a live flip with no reload
    console.log("\n[AT4] a live flip with no reload (the C2 broadcast)");
    await respawn();
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    const mark4 = bench.backend.requests.length;
    const p4 = openPopup();
    await settleUserCheck(bench, p4, mark4);
    check("AT4: settled on the signed-in layout", view(p4) === "signed_in");
    const reqsBefore = bench.backend.requests.length;

    // The frontend logged out → the relay forwards it → the worker's
    // immediate write → the C2 broadcast.
    await bench.worker.send(EV_OUT);
    await waitFor(() => state(bench) === "signed_out");
    p4.pump(); await sleep(5); p4.pump();
    check("AT4: the open popup flipped to signed-out without a reload", view(p4) === "signed_out");
    check("AT4: no polling — exactly one USER was ever sent", p4.sent.length === 1);
    check("AT4: the immediate write made no backend call", bench.backend.requests.length === reqsBefore);

    // And the flip back (a real login on the frontend):
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");
    p4.pump(); await sleep(5); p4.pump();
    check("AT4: the open popup flips back to signed-in on the re-login", view(p4) === "signed_in");

    // ------------------------------------------ AT5: a service-worker restart
    console.log("\n[AT5] a service-worker restart");
    // Precondition: live, signed_in (AT4's end). The worker is reaped…
    bench.worker.kill();
    // …and the session dies while it is dead (the backend flush — a
    // stale jar would let the next check arbitrate back to signed-in,
    // which is the AT3 "late signed-out" semantics, not this scenario).
    bench.backend.logout();
    // A re-open now hits a dead receiver: the voided send is not a
    // verdict.
    const p5 = openPopup();
    await sleep(0);
    check("AT5: a re-open while the worker is dead keeps its (stale) pre-render, no crash", view(p5) === "signed_in");

    // The worker respawns (a relay event wakes it); the session is dead:
    bench.worker.spawn();
    await bench.worker.send(EV_OUT);
    await waitFor(() => state(bench) === "signed_out");
    p5.pump(); await sleep(5);
    check("AT5: the respawned worker's signed_out write flips the still-open popup", view(p5) === "signed_out");

    // A fresh reopen re-requests and renders the backend's truth:
    const mark5 = bench.backend.requests.length;
    const p6 = openPopup();
    await settleUserCheck(bench, p6, mark5);
    check("AT5: a re-opened popup re-requests USER and renders the correct state (signed-out)",
        view(p6) === "signed_out" && p6.sent.some((m) => m.type === "USER"));

    // ------------------------------------------ AT6: a sick backend is not a verdict
    console.log("\n[AT6] a sick backend / dead network is not a session verdict");
    await respawn();
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    bench.backend.faulty = true; // every route 500s
    const mark6 = bench.backend.requests.length;
    const p7 = openPopup();
    await settleUserCheck(bench, p7, mark6);
    check("AT6: a 5xx keeps the popup's view (it stays signed-in)", view(p7) === "signed_in");
    check("AT6: no state write on a 5xx (the worker's 'unknown' rule)", state(bench) === "signed_in");
    bench.backend.faulty = false;

    bench.backend.offline = true; // the network is unreachable
    const mark6b = bench.backend.requests.length;
    const p8 = openPopup();
    await settleUserCheck(bench, p8, mark6b);
    check("AT6: a network failure keeps the popup's view", view(p8) === "signed_in");
    check("AT6: no state write on a network failure", state(bench) === "signed_in");
    bench.backend.offline = false;

    // ------------------------------------------ AT7: sign-in navigation (contract §12)
    console.log("\n[AT7] the Sign in button opens the frontend's /login");
    await respawn();
    bench.backend.logout();
    bench.storage.data.session_state = "signed_out";

    const mark7 = bench.backend.requests.length;
    const p9 = openPopup();
    await settleUserCheck(bench, p9, mark7);
    check("AT7: the signed-out view is up (the button is the one control)", view(p9) === "signed_out");
    p9.clickButton();
    check("AT7: the click opens exactly the frontend origin's /login in a new tab",
        p9.tabCreations.length === 1 && p9.tabCreations[0].url === `${popupFrontendOrigin}/login`);
    check("AT7: the popup's origin copy matches the worker's (three places, one value)",
        popupFrontendOrigin === bench.constants.FRONTEND_ORIGIN);

    // ------------------------------------------ final invariants
    console.log("\n[final] invariants, after everything");
    const snap = bench.storage.snapshot();
    check("storage still holds only the two documented keys",
        Object.keys(snap).sort().join(",") === "api_base_url,session_state");
    check("the final rendered state is coherent (exactly one view visible)", view(p8) === "signed_in");
}

main()
    .then(() => {
        console.log(`\n${passed}/${passed + failed} checks passed`);
        if (failed) {
            console.log("failures:");
            for (const f of failures) console.log(`  - ${f}`);
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("harness crashed:", err);
        console.log(`\n${passed}/${passed + failed + 1} checks passed`);
        process.exit(1);
    });
