// ==================================================================
// Sections 11-15 (contract "Popup — authentication-state integration"
// + "sign-in navigation" + "profile icon and account navigation" +
// "search integration" + "final integration and cleanup") — the
// in-repo acceptance net.
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
//        with no second USER sent and no backend call; the flip BACK to
//        signed-in sends exactly one more USER (the §13 name refresh)
//   AT5  a worker restart: a re-open while the worker is dead keeps its
//        pre-render (a voided send is not a verdict); a respawned
//        worker + a fresh reopen re-requests USER and renders the
//        backend's truth
//   AT6  a sick backend (5xx) / a dead network → the view and the state
//        are untouched (the worker's "unknown" rule, mirrored)
//   AT7  (contract §12) the Sign in button opens exactly the popup's
//        FRONTEND_ORIGIN + /login in a new tab, and that constant
//        matches the worker's copy (three places, one value)
//   AT8  (contract §13) the profile icon: the tooltip shows the real
//        name from the backend (first + last; the fallback chain: a
//        blank part → display → email → the neutral label) and a click
//        opens exactly FRONTEND_ORIGIN + /account in a new tab
//   AT9  (contract §14) the search field: typing sends nothing, Enter
//        sends exactly one SEARCH (the worker calls GET /search/?q=),
//        the in-flight state is visible, results render (all, rank
//        order, two-line summary + score + date, source_url → new-tab
//        link, no source_url → inert), a failed search shows a
//        recoverable error the user can retry, and a blank Enter is a
//        no-op
//   AT10 (contract §15) the final integration and cleanup: the
//        complete popup across both states re-asserted (the
//        no-library-on-open rule, the profile name + /account,
//        submit-on-Enter search, the loaded build's origins), the
//        worker's reserved LIBRARY / SIGN_OUT handlers still answering
//        (built, not retired), and the session synchronization
//        (the state write flipping a (re)opened popup) surviving the
//        finished popup
//   audits   the §11 contract bullets on the popup source: no cookie
//        read, no token, no direct backend call, no storage write, no
//        timers; the popup carries its own FRONTEND_ORIGIN constant,
//        assembles the name from the USER response's user payload (§13),
//        and defines the SEARCH bus name inline (§14)
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

// §14 search helpers. A /search/ GET on the fake backend, and the settle
// that waits for it + the response round-trip. A SUCCESSFUL search writes
// no session state (no C2 broadcast), so — unlike settleUserCheck — no
// pump is needed: the popup renders directly from the response.
const searchGets = (bench, from = 0) =>
    bench.backend.requests.slice(from).filter((r) => r.method === "GET" && r.path.startsWith("/search/")).length;

async function settleSearch(bench, mark) {
    await waitFor(() => searchGets(bench, mark) >= 1);
    await sleep(30);
}

// Fire the search field's keydown handler (a synthetic Enter). Sets the
// field's value first — the handler reads the element's value, not an
// argument — then dispatches a keydown the popup's listener receives.
function pressSearchEnter(popup, value) {
    const input = popup.elements["search-input"];
    input.value = value;
    for (const { type, fn } of input.listeners) {
        if (type === "keydown") fn({ key: "Enter", preventDefault() {} });
    }
}

// A minimal DOM element stub for the §14 search surface (the popup's
// createElement target): a tagged node with a children array, a
// textContent that — like the real DOM — DROPS the children when set, and
// the attribute surface buildResultRow uses (className / href / target /
// rel / value / disabled) + addEventListener. The views, tooltip, and
// buttons keep their existing hand-rolled shapes (AT1–AT8 depend on them);
// only the new search nodes use this factory.
function makeEl(tag) {
    const el = {
        tagName: tag.toUpperCase(),
        children: [],
        className: "",
        href: undefined,
        target: undefined,
        rel: undefined,
        value: "",
        disabled: false,
        hidden: false,
        listeners: [],
        _text: "",
        appendChild(child) { this.children.push(child); return child; },
        setAttribute(name, val) { this[name] = val; },
        addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    };
    Object.defineProperty(el, "textContent", {
        get() { return this._text; },
        // Like the real DOM, setting textContent replaces the children.
        set(v) { this._text = v; this.children.length = 0; },
    });
    return el;
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
            "profile-tooltip": { textContent: "Account" },
            "sign-in-button": {
                hidden: false,
                listeners: [],
                addEventListener(type, fn) { this.listeners.push({ type, fn }); },
            },
            "profile-button": {
                hidden: false,
                listeners: [],
                addEventListener(type, fn) { this.listeners.push({ type, fn }); },
            },
            // §14: the search surface (the §10 slots). The input and the
            // feedback/results nodes need the createElement/appendChild/
            // value surface buildResultRow + runSearch use, so they use the
            // makeEl factory; the nodes above keep their hand-rolled shapes.
            "search-input": makeEl("input"),
            "search-status": makeEl("div"),
            "search-results": makeEl("div"),
        };
        const sandbox = {
            console,
            document: {
                getElementById: (id) => elements[id],
                createElement: (tag) => makeEl(tag),
            },
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

    // Fire the profile icon's click handler (contract §13).
    clickProfile() {
        for (const { type, fn } of this.elements["profile-button"].listeners) {
            if (type === "click") fn();
        }
    }
}

// ------------------------------------------------------------------
async function main() {
    const backgroundSource = readFileSync(path.join(EXT_DIR, "background.js"), "utf8"); // the harness runs it; the §15 audits read it
    const popupSource = readFileSync(path.join(EXT_DIR, "popup", "popup.js"), "utf8");
    const popupCss = readFileSync(path.join(EXT_DIR, "popup", "popup.css"), "utf8");
    const popupHtml = readFileSync(path.join(EXT_DIR, "popup", "popup.html"), "utf8");
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
    check("popup: the tooltip name is assembled from the USER response's user payload, with the §13 fallback chain",
        /first_name/.test(popupSource) && /last_name/.test(popupSource) &&
        /\.display/.test(popupSource) && /\.email/.test(popupSource));
    check("popup: the SEARCH bus name is defined inline (§14, the §1 no-shared-file decision)",
        /SEARCH:\s*"SEARCH"/.test(popupSource));
    check("popup: search is submit-on-Enter (a keydown handler), never per-keystroke",
        /addEventListener\("keydown"/.test(popupSource) && !/addEventListener\("input"/.test(popupSource));
    check("popup.css: the summary is two-line clamped (§14 acceptance 6)",
        /-webkit-line-clamp:\s*2/.test(popupCss));

    // ------------------------------------------- §15 cleanup audits (static)
    // The §15 "removed and verified absent" pass, run over the sources
    // with their comments stripped: the files legitimately *document*
    // what earlier sections removed (the "no sign-out button" prose),
    // so the audit must see code, not prose.
    console.log("\n[audit] the §15 cleanup (the removed and verified absent)");
    const codeOnly = (source) =>
        source
            .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
            .replace(/\/\/[^\n]*/g, "")       // line comments
            .replace(/<!--[\s\S]*?-->/g, ""); // HTML comments
    const htmlCode = codeOnly(popupHtml);
    const jsCode = codeOnly(popupSource);
    const cssCode = codeOnly(popupCss);
    const workerCode = codeOnly(backgroundSource);

    check("§15: no §10 temporary state flag in the popup (the §11 USER check replaced it)",
        !/TEMP_SESSION_STATE/i.test(jsCode));
    check("§15: the popup speaks exactly its two catalog names — no LIBRARY, no SIGN_OUT, no SAVE, no SESSION_EVENT, no CAPTURE_WEB",
        !/\b(LIBRARY|SIGN_OUT|SAVE|SESSION_EVENT|CAPTURE_WEB)\b/.test(jsCode));
    check("§15: no library fetching in the popup (no /captures/ route, no list of any kind)",
        !/\/captures\//.test(jsCode));
    check("§15: no sign-out control in the popup (no button, no handler, no route)",
        !/sign[\s-]*out/i.test(jsCode) && !/sign[\s-]*out/i.test(htmlCode));
    check("§15: no signed-in header with an email (the layout displays no identity)",
        !/\bemail\b/i.test(htmlCode));
    check("§15: the worker keeps the reserved types — all seven catalog names, LIBRARY + SIGN_OUT still registered, the SESSION_EVENT relay and the session_state sync intact (removing popup UI never removes the synchronization)",
        ["SAVE", "CAPTURE_WEB", "SESSION_EVENT", "SEARCH", "LIBRARY", "SIGN_OUT", "USER"].every(
            (n) => new RegExp(`\\b${n}\\b`).test(workerCode)) &&
        /listen\(MSG\.LIBRARY,/.test(workerCode) &&
        /listen\(MSG\.SIGN_OUT,/.test(workerCode) &&
        /notify\(MSG\.SESSION_EVENT,/.test(workerCode) &&
        /session_state/.test(workerCode));
    check("§15: the palette is black and white only (no other color value in the CSS)",
        (cssCode.match(/#[0-9a-fA-F]{3,8}\b/g) || []).every((h) => h === "#000" || h === "#fff"));
    check("§15: no gradients, shadows, animations, or transitions in the CSS",
        !/gradient|box-shadow|animation|@keyframes|transition/i.test(cssCode));
    check("§15: no CSS framework (one local stylesheet, no @import)",
        (htmlCode.match(/<link[^>]*stylesheet[^>]*>/gi) || []).length === 1 &&
        /href="popup\.css"/.test(htmlCode) && !/@import/i.test(cssCode));
    check("§15: still the ~360 px compact width", /width:\s*360px/.test(cssCode));

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

    // And the flip back (a real login on the frontend). The mark is
    // taken BEFORE the flip: the worker's own session GET for the event
    // lands with it, and the popup's §13 name-refresh GET lands after
    // the pump below — both must fall after the mark.
    bench.backend.login();
    const markFlip = bench.backend.requests.length;
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");
    p4.pump(); await sleep(5); p4.pump();
    check("AT4: the open popup flips back to signed-in on the re-login", view(p4) === "signed_in");

    // §13: the flip TO signed-in refreshes the name — exactly one more
    // USER (event-driven, still not a poll), whose response re-sets the
    // tooltip from the backend.
    await settleUserCheck(bench, p4, markFlip);
    check("AT4 (§13): the flip to signed-in sends exactly one more USER — no more",
        p4.sent.length === 2 && p4.sent[1].type === "USER");
    check("AT4 (§13): exactly one refresh GET — the worker's own check + the popup's, no loop",
        sessionGets(bench, markFlip) === 2);
    check("AT4 (§13): the refreshed name is the backend's real first + last",
        p4.elements["profile-tooltip"].textContent === "S9 Probe");

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

    // ------------------------------------------ AT8: profile icon (contract §13)
    console.log("\n[AT8] the profile icon — the real name + account navigation");
    await respawn();
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    const mark8 = bench.backend.requests.length;
    const p10 = openPopup();
    await settleUserCheck(bench, p10, mark8);
    check("AT8: hovering the icon shows the real name from the backend, not a placeholder",
        p10.elements["profile-tooltip"].textContent === "S9 Probe");

    p10.clickProfile();
    check("AT8: clicking the icon opens exactly the frontend origin's /account in a new tab",
        p10.tabCreations.length === 1 && p10.tabCreations[0].url === `${popupFrontendOrigin}/account`);

    // The §13 fallback chain — a blank name part → the `display` field,
    // then `email`, then the neutral label (a label, never an identity).
    // The fake backend serves this.user per request, so the variants are
    // live backend answers, not popup-side assumptions.
    const mark8b = bench.backend.requests.length;
    bench.backend.user = { id: 7, display: "s9probe", email: "s9@probe.test", first_name: "S9", last_name: "" };
    const p11 = openPopup();
    await settleUserCheck(bench, p11, mark8b);
    check("AT8: a blank last_name falls back to the display field",
        p11.elements["profile-tooltip"].textContent === "s9probe");

    const mark8c = bench.backend.requests.length;
    bench.backend.user = { id: 7, display: "", email: "s9@probe.test", first_name: "", last_name: "" };
    const p12 = openPopup();
    await settleUserCheck(bench, p12, mark8c);
    check("AT8: no names and no display falls back to the email",
        p12.elements["profile-tooltip"].textContent === "s9@probe.test");

    const mark8d = bench.backend.requests.length;
    bench.backend.user = null; // a 200 with no user — a backend contract violation
    const p13 = openPopup();
    await settleUserCheck(bench, p13, mark8d);
    check("AT8: a 200 with no user degrades to the neutral label (never a crash, never an invented identity)",
        p13.elements["profile-tooltip"].textContent === "Account");
    bench.backend.user = { id: 7, display: "s9probe", email: "s9@probe.test", first_name: "S9", last_name: "Probe", has_usable_password: true, username: "s9probe" };

    // ------------------------------------------ AT9: search (contract §14)
    console.log("\n[AT9] the search field (submit-on-Enter, loading, results, recoverable errors)");
    await respawn();
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    // Canned results: one link+summary, one inert+summary, one link+no-summary.
    bench.backend.results = [
        { capture_id: "cap-1", rank: 1, score: 0.9, summary_text: "First summary about transformers and attention.", created_at: "2026-03-15T12:00:00Z", source_url: "https://example.com/first", chunks: [] },
        { capture_id: "cap-2", rank: 2, score: 0.5, summary_text: "Second summary.", created_at: "2025-12-01T12:00:00Z", source_url: null, chunks: [] },
        { capture_id: "cap-3", rank: 3, score: 0.2, summary_text: null, created_at: "2025-06-10T12:00:00Z", source_url: "https://example.com/third", chunks: [] },
    ];

    const mark9 = bench.backend.requests.length;
    const p14 = openPopup();
    await settleUserCheck(bench, p14, mark9); // the signed-in view is up

    // AT9a: typing (no Enter) sends nothing.
    p14.elements["search-input"].value = "machine";
    p14.elements["search-input"].value = "machine learning"; // "typing" — no keydown
    check("AT9a: typing without Enter sends zero SEARCH and zero /search/ GETs",
        p14.sent.filter((m) => m.type === "SEARCH").length === 0 && searchGets(bench, mark9) === 0);

    // AT9b: Enter sends exactly one SEARCH { q }; the in-flight state is
    // set synchronously (before the await), then the worker calls /search/.
    const reqsBefore9 = bench.backend.requests.length;
    pressSearchEnter(p14, "machine learning");
    check("AT9b: the in-flight state is visible (field disabled + indicator)",
        p14.elements["search-input"].disabled === true &&
        p14.elements["search-status"].textContent === "Searching…");
    check("AT9b: Enter sends exactly one SEARCH carrying the query",
        p14.sent.filter((m) => m.type === "SEARCH").length === 1 &&
        p14.sent.find((m) => m.type === "SEARCH").q === "machine learning");
    await settleSearch(bench, reqsBefore9);
    check("AT9b: the worker called GET /search/?q= (URL-encoded) exactly once",
        searchGets(bench, reqsBefore9) === 1 &&
        bench.backend.requests[reqsBefore9].path === "/search/?q=machine%20learning");

    // AT9c: results render — all of them, in the worker's rank order.
    const rows = p14.elements["search-results"].children;
    check("AT9c: every result rendered (no cap), in the worker's rank order, each summary present",
        rows.length === 3 &&
        rows[0].children[0].textContent === "First summary about transformers and attention." &&
        rows[1].children[0].textContent === "Second summary." &&
        rows[2].children[0].textContent === "(no summary)");
    check("AT9c: a source_url row is a link opening a new tab; a null row is inert",
        rows[0].children[0].tagName === "A" && rows[0].children[0].href === "https://example.com/first" &&
        rows[0].children[0].target === "_blank" &&
        rows[2].children[0].tagName === "A" && rows[2].children[0].href === "https://example.com/third" &&
        rows[1].children[0].tagName === "SPAN" && rows[1].children[0].href === undefined);
    check("AT9c: each row carries its score (as-is) and its created_at date",
        rows[0].children[1].children[0].textContent === "0.90" && rows[0].children[1].children[1].textContent === "Mar 15, 2026" &&
        rows[1].children[1].children[0].textContent === "0.50" && rows[1].children[1].children[1].textContent === "Dec 1, 2025" &&
        rows[2].children[1].children[0].textContent === "0.20" && rows[2].children[1].children[1].textContent === "Jun 10, 2025");
    check("AT9c: the in-flight indicator is replaced by the results, the field re-enabled",
        p14.elements["search-status"].textContent === "3 results" &&
        p14.elements["search-input"].disabled === false);

    // AT9d: a failed search shows a recoverable error; the field stays
    // usable; a retry works.
    bench.backend.faulty = true; // every route 500s (a 5xx, not a verdict)
    const reqsBefore9d = bench.backend.requests.length;
    pressSearchEnter(p14, "machine learning");
    await settleSearch(bench, reqsBefore9d);
    check("AT9d: a failed search shows a recoverable error (the backend's own message)",
        p14.elements["search-status"].textContent === "Internal Server Error");
    check("AT9d: the results region is cleared (no stale data presented as current)",
        p14.elements["search-results"].children.length === 0);
    check("AT9d: the field is re-enabled — a new Enter can retry",
        p14.elements["search-input"].disabled === false);
    bench.backend.faulty = false;

    const reqsBefore9e = bench.backend.requests.length;
    pressSearchEnter(p14, "machine learning");
    await settleSearch(bench, reqsBefore9e);
    check("AT9d: a retry after the failure renders the results again",
        p14.elements["search-results"].children.length === 3 &&
        p14.elements["search-status"].textContent === "3 results");

    // AT9e: a blank Enter is a no-op (no request, no error, state unchanged).
    const reqsBefore9f = bench.backend.requests.length;
    pressSearchEnter(p14, "   ");
    await sleep(30);
    check("AT9e: a blank query is a no-op (no request, the prior status stands)",
        searchGets(bench, reqsBefore9f) === 0 &&
        p14.elements["search-status"].textContent === "3 results");

    // Restore the bench for the final invariants.
    bench.backend.results = [];

    // ------------------------------------------ AT10: §15 final integration and cleanup
    console.log("\n[AT10] §15 — the complete popup, both states, and what stays");
    await respawn();
    bench.backend.login();
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");

    // Signed in: the whole view, and the no-library-on-open rule.
    const mark10 = bench.backend.requests.length;
    const p15 = openPopup();
    await settleUserCheck(bench, p15, mark10);
    check("AT10: signed in — the search field and profile icon row is the entire view",
        view(p15) === "signed_in");
    check("AT10: no library fetching on popup open — the one message sent on open is the {} USER",
        p15.sent.length === 1 && p15.sent[0].type === "USER" && JSON.stringify(p15.sent[0]) === '{"type":"USER"}');

    // Profile (§13 re-asserted) — the real name, the loaded build's /account.
    check("AT10: the profile tooltip is the backend's real name, not a placeholder",
        p15.elements["profile-tooltip"].textContent === "S9 Probe");
    p15.clickProfile();
    check("AT10: the profile click opens the loaded build's /account in a new tab",
        p15.tabCreations.length === 1 && p15.tabCreations[0].url === `${popupFrontendOrigin}/account`);

    // Search (§14 re-asserted) — Enter submits through the worker.
    bench.backend.results = [
        { capture_id: "cap-final", rank: 1, score: 0.7, summary_text: "Final integration check.", created_at: "2026-11-01T00:00:00Z", source_url: null, chunks: [] },
    ];
    const reqsBefore10 = bench.backend.requests.length;
    pressSearchEnter(p15, "final integration check");
    await settleSearch(bench, reqsBefore10);
    check("AT10: Enter submits exactly one SEARCH, the worker calls GET /search/?q= once, the result renders",
        p15.sent.filter((m) => m.type === "SEARCH").length === 1 &&
        searchGets(bench, reqsBefore10) === 1 &&
        p15.elements["search-results"].children.length === 1 &&
        p15.elements["search-status"].textContent === "1 result");
    bench.backend.results = [];

    check("AT10: across the whole run the popup spoke only USER and SEARCH — no LIBRARY, no SIGN_OUT (acceptance 7)",
        p15.sent.every((m) => m.type === "USER" || m.type === "SEARCH"));

    // The worker's reserved handlers stay built (§15: cataloged types and
    // §4/§7 handlers are never retired) — they answer.
    const lib = await bench.worker.send({ type: "LIBRARY" });
    check("AT10: the worker's reserved LIBRARY handler still answers ({ status, captures })",
        lib !== undefined && lib.status === "OK" && Array.isArray(lib.captures));
    const signOut = await bench.worker.send({ type: "SIGN_OUT" });
    check("AT10: the worker's reserved SIGN_OUT handler still answers (the live session flushes to success)",
        signOut !== undefined && signOut.status === "OK");
    await waitFor(() => state(bench) === "signed_out");

    // Signed out: the one control — and the synchronization §15 keeps:
    // the state write plus the USER check drive a (re)opened popup to the
    // signed-out view.
    const mark10b = bench.backend.requests.length;
    const p16 = openPopup();
    await settleUserCheck(bench, p16, mark10b);
    check("AT10: signed out — only the centered Sign in remains", view(p16) === "signed_out");
    p16.clickButton();
    check("AT10: the Sign in click opens the loaded build's /login in a new tab",
        p16.tabCreations.length === 1 && p16.tabCreations[0].url === `${popupFrontendOrigin}/login`);
    check("AT10: this popup also never spoke a reserved name",
        p16.sent.every((m) => m.type === "USER" || m.type === "SEARCH"));

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
