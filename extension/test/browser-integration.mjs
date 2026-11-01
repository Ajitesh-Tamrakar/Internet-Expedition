// ==================================================================
// Section 9 (contract "Background G — lifecycle, recovery, and
// integration testing") — Tier 2: the full integration pass on the
// local dev bench.
//
// A real Chromium-based browser (headless=new) + the DEV extension
// build (extension/.dev-load, rebuilt first) + the live bench:
//   - the Django backend on $IE_API_ORIGIN  (default http://localhost:8080)
//   - the vite frontend on $IE_VITE_ORIGIN  (default http://localhost:5173)
//   - a throwaway VERIFIED probe account (created + deleted by this
//     script — a verified login mails nothing, so no mail provider is
//     needed; the bench needs a local Postgres the probe user can reach,
//     $IE_BENCH_DB_* — default postgres @ 127.0.0.1:5432/bookmark)
//
// Browser: brave-browser by default — a branded Google Chrome build
// refuses --load-extension ("--disable-extensions-except is not allowed
// in Google Chrome"); any unbranded Chromium-based binary works via the
// $IE_BROWSER_BIN env override.
//
// What it covers (the section-9 acceptance tests, as the contract's
// "Environment" bullet prescribes):
//   AT5a  sign in on the frontend (real UI, real cookies); the RELAY
//         push fast path flips the worker's session state within
//         seconds. The frontend's own emission is SIMULATED from the
//         page — the Frontend-task emitter is a carried open item, so
//         the relay + worker halves are what is under test; the
//         worker's backend re-check inside the handler is real.
//   AT3   duplicate / out-of-order SESSION_EVENTs over the real relay —
//         the final state matches the backend truth
//   AT5b  SEARCH, LIBRARY, USER, SAVE all succeed (real backend, real
//         cookie-jar auth from the worker; SEARCH pays one real paced
//         Gemini embedding call)
//   AT1   the worker-restart re-resolution. THIS build reaps the idle
//         worker at ~30 s (the M2 keepalive fact) but the reaped target
//         LINGERS in Target.getTargets — "in the list" is not a liveness
//         signal, and attaching to the lingering entry throws. Death is
//         read the way that works: a clean 55 s window (keepalive
//         paused, zero CDP activity on the worker — an eval might itself
//         reset the 30 s clock), then one liveness eval: a reaped worker
//         answers SILENT ({type:"undefined"}), a live one answers 2. A
//         build that does not reap takes the alive branch; both end in
//         the same contract — the wake re-verifies against the real
//         backend, the features work again. The MID-FLIGHT kill (an open
//         channel keeps a live worker alive, so CDP cannot force it) is
//         the worker-level net's (Tier 1) forceable coverage.
//   AT4   a request that fails because authentication expired (the
//         access cookie deleted from the real jar) — one recovery, one
//         retry, the rotated cookies land; then the session fully dead
//         via the worker's own SIGN_OUT (the real backend flush — a
//         synthetic cookie deletion would leave the session alive
//         server-side, and a re-login against a live session is a 409
//         that mints no tokens) — the signed-out transition
//   AT5c/AT2  sign out on the account page (the real UI); with the
//         event missed, the next session check restores signed-out;
//         the push path then confirms it
//
// Driving notes (why this is shaped the way it is):
//   - A same-context chrome.runtime.sendMessage from the service worker
//     never reaches the worker's own onMessage (verified by probe — a
//     self-send settles with no response), so every worker message —
//     the four ops AND the keepalive — is driven from the RELAY's
//     isolated world: the same external context a real popup/content
//     sender is, over the same chrome.runtime channel.
//   - One browser-endpoint WebSocket with flattened attach sessions;
//     all commands carry the sessionId (no per-target sockets).
//   - A CDP session does NOT pin a worker alive in this build (run-8:
//     it died with one attached; the M2 smoke died with one attached),
//     and the reaped worker's target LINGERS in Target.getTargets
//     (attach to it throws "No target with given id found"). So the
//     net stays attached for observability, reads liveness from the
//     silent-eval signal, drops the zombie record, and re-attaches to
//     the respawned worker (a NEW targetId).
//   - The popup is not opened in this net: its session-state logic
//     (§11) and sign-in navigation (§12) are covered in-repo by
//     popup-session.test.mjs (the real popup.js in a vm DOM/chrome
//     stub against the real worker). This net drives the same bus
//     messages from the relay's isolated world, and "the rendered
//     state" is the worker's published session_state — the value the
//     popup renders.
//   - The page can silently end at chrome-error:// if the bench is not
//     reachable; every navigation verifies location.href actually
//     reached the app origin before anything runs in it.
//
// Run:  node extension/test/browser-integration.mjs
// (needs the bench up; a free debug port in 9333–9342 is picked
// automatically; no npm dependencies — CDP over node's WebSocket)
// ==================================================================

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, EXT_DIR, readConstants } from "./harness.mjs";

const API_ORIGIN = process.env.IE_API_ORIGIN || "http://localhost:8080";
const VITE_ORIGIN = process.env.IE_VITE_ORIGIN || "http://localhost:5173";
const BROWSER_BIN = process.env.IE_BROWSER_BIN || "brave-browser";
const LOAD_DIR = path.join(EXT_DIR, ".dev-load");
const EXPECTED_EXTENSION_ID = "oijkpjikiabildophmlfeihojjpghmed";
const AUTH = `${API_ORIGIN}/api/auth/app/v1`;

// The probe account's database (the bench's local cluster — manage.py
// shell must reach the SAME database runserver serves). Override for an
// unusual local setup.
const BENCH_DB = {
    DB_HOST: process.env.IE_BENCH_DB_HOST || "127.0.0.1",
    DB_PORT: process.env.IE_BENCH_DB_PORT || "5432",
    DB_USER: process.env.IE_BENCH_DB_USER || "postgres",
    DB_NAME: process.env.IE_BENCH_DB_NAME || "bookmark",
    DB_PASSWORD: process.env.IE_BENCH_DB_PASSWORD ?? "",
};

// ------------------------------------------------------------------
// Ledger.
// ------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = "") {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; failures.push(name); console.log(`  FAIL ${name}${detail ? `  [${detail}]` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label, pred, { timeout = 30000, tick = 500 } = {}) {
    const start = Date.now();
    for (;;) {
        const value = await pred();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`);
        await sleep(tick);
    }
}
function step(name) { console.log(`\n=== ${name}`); }

// ------------------------------------------------------------------
// Minimal CDP client (raw WebSocket; the flattened-session protocol —
// one browser-endpoint socket; every command for a target carries the
// sessionId the flattened attach returned).
// ------------------------------------------------------------------
class CDP {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.closed = false;
        ws.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? " " + msg.error.data : ""}`));
                else resolve(msg.result);
            } else if (msg.method) {
                for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params, msg.sessionId);
            }
        };
        ws.onclose = () => { this.closed = true; };
        ws.onerror = () => {};
    }
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = resolve;
            ws.onerror = () => reject(new Error(`ws connect failed: ${wsUrl}`));
            setTimeout(() => reject(new Error(`ws connect timeout: ${wsUrl}`)), 10000);
        });
        return new CDP(ws);
    }
    send(method, params = {}, sessionId) {
        if (this.closed) return Promise.reject(new Error("CDP session closed"));
        const id = this.nextId++;
        const frame = { id, method, params };
        if (sessionId) frame.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(frame));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }
            }, 30000);
        });
    }
    on(method, cb) {
        if (!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(cb);
    }
    close() { try { this.ws.close(); } catch {} }
}

const httpJson = async (url, opts = {}) => {
    const res = await fetch(url, opts);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: res.status, body, text };
};

// ------------------------------------------------------------------
// Browser plumbing.
// ------------------------------------------------------------------
const isSW = (t) => (t.type === "service_worker" || t.type === "serviceWorker") && t.url.includes(EXPECTED_EXTENSION_ID);

class Browser {
    constructor(port) {
        this.port = port;
        this.debug = `http://127.0.0.1:${port}`;
        this.proc = null;
        this.profile = null;
        this.browser = null; // the one CDP session on the browser endpoint
        this.targets = new Map(); // targetId -> { type, url, sessionId }
        this.lastList = [];
        this.page = null; // the app tab (target record)
        this.isolatedContext = null; // the relay world's executionContextId
    }

    async launch(initialUrl = "about:blank") {
        try {
            execFileSync("which", [BROWSER_BIN], { stdio: "pipe" });
        } catch {
            throw new Error(`${BROWSER_BIN} not found on PATH — install a Chromium-based browser or set IE_BROWSER_BIN`);
        }
        this.profile = mkdtempSync(path.join(os.tmpdir(), "ie-s9-browser-"));
        // The `=` form for the extension flags: this Chromium build
        // mis-parses the two-argument form — the path lands as a second
        // URL target and the launch dies with "Multiple targets are not
        // supported in headless mode" (probe-verified).
        const flags = [
            "--headless=new", "--disable-gpu",
            "--no-first-run", "--no-default-browser-check",
            `--disable-extensions-except=${LOAD_DIR}`,
            `--load-extension=${LOAD_DIR}`,
            `--user-data-dir=${this.profile}`,
            `--remote-debugging-port=${this.port}`,
            "--window-size=1280,900",
            initialUrl,
        ];
        this.proc = spawn(BROWSER_BIN, flags, { stdio: "ignore" });
        await this.debugUp();
        this.browser = await CDP.connect((await httpJson(`${this.debug}/json/version`)).body.webSocketDebuggerUrl);
        this.browser.on("Target.targetDestroyed", (p) => this.targets.delete(p.targetId));
        await this.refreshTargets();
    }

    async debugUp(timeout = 30000) {
        const start = Date.now();
        for (;;) {
            try {
                const r = await httpJson(`${this.debug}/json/version`);
                if (r.status === 200) return r.body;
            } catch {}
            if (Date.now() - start > timeout) throw new Error(`${BROWSER_BIN} debug endpoint never came up`);
            await sleep(300);
        }
    }

    // The target list is the source of truth (CDP events are advisory
    // only — without setAutoAttach, created/destroyed events for a
    // target are not guaranteed, and the restarted worker gets a NEW
    // targetId anyway). Records for targets that left the list are
    // PRUNED — a dead worker's record, if kept, would (a) make
    // hasWorker() report true forever (the AT1 idle-kill would be
    // unobservable — run-5's exact failure) and (b) shadow the
    // respawned worker in find(), since the stale record was inserted
    // first.
    async refreshTargets() {
        const r = await this.browser.send("Target.getTargets");
        this.lastList = r.targetInfos ?? [];
        const live = new Set(this.lastList.map((i) => i.targetId));
        for (const [id] of [...this.targets.keys()]) if (!live.has(id)) this.targets.delete(id);
        for (const info of this.lastList) {
            const known = this.targets.get(info.targetId);
            if (known) { known.type = info.type; known.url = info.url; }
            else this.targets.set(info.targetId, { targetId: info.targetId, type: info.type, url: info.url, sessionId: null });
        }
        return this.lastList;
    }

    async findTarget(pred, { timeout = 30000, label = "target" } = {}) {
        return waitFor(label, async () => {
            await this.refreshTargets();
            return [...this.targets.values()].find(pred);
        }, { timeout, tick: 500 });
    }

    // Attach a flattened session to the target (idempotent per record).
    async attach(t) {
        if (t.sessionId) return t;
        const { sessionId } = await this.browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
        t.sessionId = sessionId;
        return t;
    }

    async detach(t) {
        if (!t.sessionId) return;
        try { await this.browser.send("Target.detachFromTarget", { sessionId: t.sessionId }); } catch {}
        t.sessionId = null;
    }

    async evalOn(t, expression, { awaitPromise = false, contextId } = {}) {
        if (!t?.sessionId) throw new Error("no CDP session on the target (attach first)");
        const params = { expression, awaitPromise, returnByValue: true };
        if (contextId) params.contextId = contextId;
        const res = await this.browser.send("Runtime.evaluate", params, t.sessionId);
        if (res.exceptionDetails) {
            throw new Error(`page exception: ${res.exceptionDetails.exception?.description ?? JSON.stringify(res.exceptionDetails)}`);
        }
        return res.result?.value;
    }

    // ---------------- the app tab ----------------

    async openPage(url) {
        if (!this.page || !this.page.sessionId) {
            const t = (await this.findTarget((x) => x.type === "page" && !x.url.startsWith("chrome-error"), { label: "a page target", timeout: 15000 }).catch(() => null))
                ?? (await this.findTarget((x) => x.type === "page", { label: "a page target", timeout: 15000 }).catch(() => null))
                ?? (await this.browser.send("Target.createTarget", { url: "about:blank" }));
            this.page = this.targets.get(t.targetId) ?? this.targets.set(t.targetId, { targetId: t.targetId, type: "page", url: t.url, sessionId: null }).get(t.targetId);
            await this.attach(this.page);
            await this.browser.send("Page.enable", {}, this.page.sessionId);
            await this.browser.send("Network.enable", {}, this.page.sessionId);
            await this.browser.send("Runtime.enable", {}, this.page.sessionId);
            this.trackContexts();
        }
        if (url) {
            await this.browser.send("Page.navigate", { url }, this.page.sessionId);
            await this.waitForReaches(url);
        }
        return this.page;
    }

    // The isolated-world (relay) context, tracked from the page
    // session's Runtime events. In THIS build the created-event's
    // payload is `params.context` (verified by probe).
    //
    // Only OUR extension's world qualifies: a vendor browser injects its
    // own content scripts into every page (Brave registers a
    // chrome://cosmetic_filters isolated world on ordinary pages —
    // probe-verified), and tracking "any non-default context" can lock
    // onto one of those, where `chrome.runtime` is undefined — the
    // keepalive would silently no-op and the worker would idle-kill
    // mid-phase. A content-script world of OUR extension is the only
    // non-default context whose origin is our extension origin.
    trackContexts() {
        if (this._contextsTracked) return;
        this._contextsTracked = true;
        this.browser.on("Runtime.executionContextCreated", (params, sessionId) => {
            if (sessionId !== this.page?.sessionId) return;
            const ctx = params.context;
            if (ctx?.auxData && ctx.auxData.isDefault === false && String(ctx.origin || "").startsWith("chrome-extension://")) {
                this.isolatedContext = ctx.id;
            }
        });
        this.browser.on("Runtime.executionContextDestroyed", (params, sessionId) => {
            if (sessionId !== this.page?.sessionId) return;
            if (this.isolatedContext === params.executionContextId) this.isolatedContext = null;
        });
    }

    // The page must actually have reached the app origin — a dead bench
    // leaves a tab silently on chrome-error:// (title "localhost").
    async waitForReaches(expectPrefix, { timeout = 30000 } = {}) {
        return waitFor(`page to reach ${expectPrefix}`, async () => {
            const href = await this.evalOn(this.page, "location.href").catch(() => "");
            if (href.startsWith("chrome-error")) return false;
            return href.startsWith(expectPrefix);
        }, { timeout, tick: 500 });
    }

    async pageEval(expression, opts = {}) {
        return this.evalOn(this.page, expression, opts);
    }

    // Evaluate in the relay's isolated world. The relay world is where
    // EVERY worker message is driven from (a self-send from the worker
    // never reaches the worker's own onMessage — probe-verified).
    async evalRelayWorld(expression, opts = {}) {
        await this.waitForIsolatedWorld();
        return this.evalOn(this.page, expression, { ...opts, contextId: this.isolatedContext });
    }

    async waitForIsolatedWorld(timeout = 15000) {
        const start = Date.now();
        for (;;) {
            if (this.isolatedContext !== null) return this.isolatedContext;
            if (Date.now() - start > timeout) {
                const href = await this.evalOn(this.page, "location.href").catch(() => "<unreachable>");
                throw new Error(`no relay (content-script) execution context on the page (href=${href}) — the page must be on the load dir's vite origin and actually loaded`);
            }
            await sleep(250);
        }
    }

    // The frontend's sync-event emission, from the page's MAIN world
    // (the relay consumes it in its isolated world and forwards it to
    // the worker). The Frontend-task emitter is a carried open item, so
    // the test posts the agreed payload itself — exactly what the
    // emitter will post: { type }, targetOrigin = the own origin.
    async emitAuthEvent(type) {
        await this.pageEval(`window.postMessage(${JSON.stringify({ type })}, window.location.origin)`);
    }

    // Post a bus message to the worker FROM the relay's isolated world.
    // Callback-race inside the page (a settled promise with .then()
    // chains came back mangled by this Chromium build's awaitPromise —
    // probe-verified): the callback always settles, the 25 s timer is
    // the "no response" marker.
    async sendToWorker(message) {
        const expr = `(() => {
            return new Promise((resolve) => {
                let done = false;
                const finish = (v) => { if (!done) { done = true; resolve(v); } };
                const t = setTimeout(() => finish({ ok: false, timeout: true }), 25000);
                try {
                    chrome.runtime.sendMessage(${JSON.stringify(message)}, (response) => {
                        clearTimeout(t);
                        if (chrome.runtime.lastError) finish({ ok: false, error: chrome.runtime.lastError.message });
                        else finish({ ok: true, value: response });
                    });
                } catch (e) { clearTimeout(t); finish({ ok: false, error: String(e) }); }
            });
        })()`;
        return await this.evalRelayWorld(expr, { awaitPromise: true });
    }

    // The 20 s keepalive beat — a no-op runtime message from the relay
    // world. An incoming message resets the MV3 idle clock even when
    // the dispatcher ignores it ({} has no `type`), so the worker
    // survives the long phases; AT1 stops it on purpose.
    keepAliveTick() {
        if (!this.page?.sessionId) return;
        this.evalRelayWorld(`chrome.runtime.sendMessage({}).catch(() => {})`, { awaitPromise: true }).catch(() => {});
    }

    // ---------------- the service worker ----------------

    async swTarget() {
        await this.refreshTargets();
        return [...this.targets.values()].find(isSW) ?? null;
    }

    async hasWorker() {
        const t = await this.swTarget();
        return t !== null;
    }

    async worker() {
        const t = await this.findTarget(isSW, { label: "the service worker target" });
        await this.attach(t);
        return t;
    }

    async detachWorker() {
        const t = await this.swTarget();
        if (t) await this.detach(t);
    }

    async evalSW(expression, opts = {}) {
        const t = await this.worker();
        let v;
        try {
            v = await this.evalOn(t, expression, opts);
        } catch {
            v = undefined;
        }
        if (v === undefined) {
            // This build answers {type:"undefined"} — not an error —
            // when the worker idle-terminated after the session attached
            // (or is mid-wake). Wake it the documented way (a real
            // external runtime message from the relay world), then probe
            // EVERY worker target with 1+1 until one answers 2: the
            // readable worker may be this same target (a transient
            // mid-wake) or a NEW one — a real death leaves the old id
            // LINGERING in the list as a zombie (attach to it throws;
            // an eval on an attached zombie stays silent-undefined), and
            // the first list match would be the zombie.
            await this.emitAuthEvent("auth:signed-in").catch(() => {});
            for (let round = 0; round < 10 && v === undefined; round++) {
                for (const c of [...this.targets.values()].filter((x) => isSW(x))) {
                    if (!c.sessionId) {
                        try { await this.attach(c); } catch { this.targets.delete(c.targetId); }
                        if (!this.targets.has(c.targetId)) continue;
                    }
                    const probe = await this.evalOn(c, "1+1").catch(() => undefined);
                    if (probe === 2) {
                        v = await this.evalOn(c, expression, opts).catch(() => undefined);
                        break;
                    }
                }
                if (v === undefined) await sleep(1200);
            }
            if (v === undefined) {
                // unanswerable after 12 s = zombie; the next refresh re-adds anything real
                for (const c of [...this.targets.values()].filter((x) => isSW(x))) this.targets.delete(c.targetId);
            }
            if (v === undefined) throw new Error(`service worker unreadable (idle-terminated and the wake did not re-land it in time): ${expression.slice(0, 60)}`);
        }
        return v;
    }

    async storage() {
        const v = await this.evalSW(`(async () => JSON.stringify(await chrome.storage.local.get(null)))()`, { awaitPromise: true });
        return v ? JSON.parse(v) : {};
    }

    async storageState() {
        return (await this.storage()).session_state;
    }

    // ---------------- the cookie jar ----------------

    async allCookies() {
        const t = this.page;
        if (!t?.sessionId) return [];
        const { cookies } = await this.browser.send("Network.getAllCookies", {}, t.sessionId);
        return cookies;
    }

    async tokenCookies() {
        return (await this.allCookies()).filter((c) => c.name === "access_token" || c.name === "refresh_token");
    }

    async deleteCookies(names) {
        const t = this.page;
        if (!t?.sessionId) return;
        for (const c of await this.allCookies()) {
            if (names.includes(c.name)) {
                await this.browser.send("Network.deleteCookies", { name: c.name, domain: c.domain, path: c.path }, t.sessionId);
            }
        }
    }

    async kill() {
        try { this.browser?.close(); } catch {}
        try { this.proc?.kill(); } catch {}
        if (this.profile) { try { rmSync(this.profile, { recursive: true, force: true }); } catch {} }
    }
}

// ------------------------------------------------------------------
// Backend bookkeeping (the probe user, via the real entrypoint).
// ------------------------------------------------------------------
function runPython(code, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn("venv/bin/python", ["manage.py", "shell", "-c", code], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...BENCH_DB, ...extraEnv },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        const timer = setTimeout(() => p.kill(), 120000);
        p.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(err.slice(-800) || `python exited ${code}`)); });
    });
}

// A verified email: the login flow (a verified account) never mails,
// so no mail provider is needed for the whole pass. The username is set
// (the User model's unique username column — an unset one stores "" and
// a second such user would violate the unique constraint, e.g. after a
// crashed run left its probe behind): email is unique per run.
const CREATE_USER = `
import os
from django.contrib.auth import get_user_model
from allauth.account.models import EmailAddress
email, pw = os.environ["IE_S9_EMAIL"], os.environ["IE_S9_PW"]
U = get_user_model()
u, _ = U.objects.get_or_create(email=email, defaults={"first_name": "S9", "last_name": "Probe", "username": email})
u.set_password(pw); u.save()
EmailAddress.objects.get_or_create(user=u, email=email, defaults={"primary": True})
EmailAddress.objects.filter(user=u).update(verified=True, primary=True)
`;

// Self-healing: a crashed run leaves its probe account behind (cleanup
// only runs on the normal exit path) — sweep every stale ie-s9-* user
// (and its captures / queued tasks) before creating a fresh one, so a
// re-run after a crash needs no manual intervention.
const PRE_CLEANUP = `
from django.contrib.auth import get_user_model
from django_q.models import Task
from core.models import Capture
U = get_user_model()
stale = U.objects.filter(email__startswith="ie-s9-")
cap_ids = {str(c) for c in Capture.objects.filter(user__in=list(stale)).values_list("capture_id", flat=True)}
for t in Task.objects.all():
    if any(str(a) in cap_ids for a in (t.args or [])):
        t.delete()
n, _ = U.objects.filter(email__startswith="ie-s9-").delete()
print(f"pre-cleanup: removed {n} stale ie-s9-* users ({len(cap_ids)} captures)")
`;

const CLEANUP = `
import os
from django.contrib.auth import get_user_model
from django_q.models import Task
from core.models import Capture
email = os.environ["IE_S9_EMAIL"]
U = get_user_model()
cap_ids = {str(c) for c in Capture.objects.filter(user__email=email).values_list("capture_id", flat=True)}
for t in Task.objects.all():
    if any(str(a) in cap_ids for a in (t.args or [])):
        t.delete()
U.objects.filter(email=email).delete()
`;

// ------------------------------------------------------------------
// The pass.
// ------------------------------------------------------------------
let browserRef = null; // so the finally-block can kill the browser on ANY exit path
const MSG = { SESSION_EVENT: "SESSION_EVENT", SEARCH: "SEARCH", LIBRARY: "LIBRARY", SIGN_OUT: "SIGN_OUT", USER: "USER" };

// The v1 web envelope the universal content script would send (the
// worker translates it; the bus channel is what is under test here).
const WEB_SAVE = {
    type: "SAVE",
    data: {
        mandatory_fields: { source_url: "https://example.com/s9-lifecycle", platform: "web" },
        platform_specific_data: { text_content: "S9 lifecycle integration article body.", title: "S9 Lifecycle Test" },
    },
};

let keepAliveTimer = null;
function setKeepAlive(browser, on) {
    if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    if (on) {
        keepAliveTimer = setInterval(() => browser.keepAliveTick(), 20000);
    }
}

// The React-controlled-input fill + form submit for the login page.
// (No redundant re-navigation when the tab is already on the login page —
// a full reload of an already-loaded app page is slow and flaky.)
async function loginOn(browser, origin, email, pw) {
    const target = `${origin}/login`;
    const here = await browser.pageEval("location.href").catch(() => "");
    await browser.openPage(here === target ? null : target);
    if ((await browser.pageEval("location.href").catch(() => "")).startsWith("chrome-error")) {
        throw new Error("the page ended at chrome-error — the bench is no longer reachable from the browser mid-run (it passed the step-0 HTTP pre-check)");
    }
    await waitFor("the login form", () => browser.pageEval(`!!document.querySelector('#email')`), { timeout: 20000 });
    await browser.pageEval(`(() => {
        const set = (sel, value) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        };
        return set('#email', ${JSON.stringify(email)}) && set('#password', ${JSON.stringify(pw)});
    })()`);
    await sleep(300); // let React commit both values
    await browser.pageEval(`(() => {
        const form = document.querySelector('#password').closest('form');
        form.querySelector('button[type=submit]').click();
        return true;
    })()`);
}

async function main() {
    const ts = Date.now();
    const email = `ie-s9-${ts}@example.com`;
    const pw = `s9-lifecycle-${ts}`;
    console.log(`probe account: ${email} (deleted at the end — if this run crashes, delete it manually)`);

    // -- 0. preconditions ------------------------------------------
    step("0 — bench preconditions");
    const back = await httpJson(`${AUTH}/config`).catch(() => null);
    check("backend reachable", back !== null, `${API_ORIGIN}`);
    const vite = await httpJson(VITE_ORIGIN + "/").catch(() => null);
    check("vite frontend reachable", vite?.status === 200, `${VITE_ORIGIN}`);
    if (back === null || vite?.status !== 200) throw new Error("bench is not up — start the backend + vite and re-run");

    step("0b — rebuild the dev load dir");
    try {
        execFileSync("bash", ["dev/manifest-dev.sh"], { cwd: REPO_ROOT, stdio: "pipe", env: process.env });
        check("dev/manifest-dev.sh: load dir rebuilt", true);
    } catch (err) {
        check("dev/manifest-dev.sh: load dir rebuilt", false, String(err).slice(0, 200));
        throw err;
    }
    // The origins the LOADED file carries — every origin-sensitive
    // assertion below compares against these, not against the env
    // defaults (the .dev-load build is the worker under test).
    const LOADED = readConstants(readFileSync(path.join(LOAD_DIR, "background.js"), "utf8"));
    check("load dir carries the bench origins", LOADED.FRONTEND_ORIGIN === VITE_ORIGIN && LOADED.API_BASE_URL === API_ORIGIN, JSON.stringify(LOADED));
    const ORIGIN = LOADED.FRONTEND_ORIGIN;

    step("0c — throwaway probe account (verified email — no OTP mail)");
    await runPython(PRE_CLEANUP, {}).then(
        () => check("stale ie-s9-* probe accounts from any crashed run swept", true),
        (err) => check("stale ie-s9-* probe accounts from any crashed run swept", false, String(err).slice(0, 160)),
    );
    await runPython(CREATE_USER, { IE_S9_EMAIL: email, IE_S9_PW: pw });
    check("probe account created (verified — the login flow mails nothing)", true);

    // -- 1. the browser + the extension ------------------------------
    step("1 — " + BROWSER_BIN + " + the extension");
    const browser = new Browser(9333 + Math.floor(Math.random() * 10));
    browserRef = browser;
    // The first tab opens straight on the login page (the proven pattern):
    // an about:blank → Page.navigate round-trip lands the page mid-load on
    // the vite cold start, and this build answers evaluates of a
    // mid-transition document with a silent undefined.
    await browser.launch(`${ORIGIN}/login`).catch((err) => {
        browser.kill();
        throw new Error(`${BROWSER_BIN} launch failed (${err.message})`);
    });
    const sw0 = await browser.findTarget(isSW, { label: "the service worker target", timeout: 45000 }).catch(() => null);
    check("service worker target present after load", sw0 !== null);
    if (!sw0) throw new Error("no service worker target — the extension did not load (check the load dir / this browser build's headless extension support)");
    const extId = (sw0.url.match(/chrome-extension:\/\/([^/]+)/) || [])[1];
    check("extension ID matches the committed key", extId === EXPECTED_EXTENSION_ID, extId);
    await browser.attach(sw0);

    await waitFor("install: the api origin seeded in storage", async () => {
        const keys = Object.keys(await browser.storage());
        return keys.includes("api_base_url") && !keys.includes("access_token");
    }, { timeout: 20000 }).catch(() => false);
    const seeded = await browser.storage();
    check("install seeded exactly the api origin (legacy token key absent, no state yet)",
        Object.keys(seeded).join(",") === "api_base_url" && seeded.api_base_url === API_ORIGIN, JSON.stringify(seeded));

    // -- 2. sign in on the frontend (real UI, real cookies) ----------
    step("2 — sign in on the frontend (the real login page)");
    await loginOn(browser, ORIGIN, email, pw);
    await waitFor("both token cookies in the jar (the login's Set-Cookie landed)",
        async () => {
            const names = (await browser.tokenCookies()).map((x) => x.name);
            return names.includes("access_token") && names.includes("refresh_token");
        }, { timeout: 30000 });
    const jar = await browser.tokenCookies();
    const accessAtLogin = (jar.find((c) => c.name === "access_token") || {}).value;
    const refreshAtLogin = (jar.find((c) => c.name === "refresh_token") || {}).value;
    const full = (c) => ({ name: c.name, samesite: c.sameSite, secure: c.secure, path: c.path, domain: c.domain, partition: c.partitionKey ? JSON.stringify(c.partitionKey) : null, source: `${c.sourceScheme}:${c.sourcePort}`, priority: c.priority });
    // The step-0 contract, functionally: the worker's own cross-site
    // fetch must carry the session. This is the real gate (a null
    // `samesite` in the jar read would mean the cookie does not ride).
    const swStatus = await browser.evalSW(
        `(async () => { try { const r = await fetch(${JSON.stringify(API_ORIGIN + "/api/auth/app/v1/auth/session")}, { method: "GET", credentials: "include" }); return String(r.status); } catch (e) { return "FETCH-ERR:" + String(e); } })()`,
        { awaitPromise: true }).catch(() => "<unreadable>");
    check("step-0 functional: the worker's cross-site fetch is authenticated (200 — the cookie rides the SW fetch)",
        swStatus === "200", `status=${swStatus} jar=${JSON.stringify(jar.map(full))}`);
    // A fresh Set-Cookie can transiently serialize with a null sameSite
    // in this build's getAllCookies — poll for the settled value rather
    // than trusting one instant read.
    const settled = await waitFor("the access cookie's SameSite=None to settle in the jar", async () => {
        const c = (await browser.tokenCookies()).find((x) => x.name === "access_token");
        return c?.sameSite === "None" ? c : null;
    }, { timeout: 15000, tick: 1000 }).catch(() => null);
    check("access cookie: SameSite=None + Secure (the step-0 contract, from the live backend)",
        Boolean(settled) && settled.secure, JSON.stringify(jar.map(full)));
    setKeepAlive(browser, true);

    // -- 3. AT5a: the relay push fast path ----------------------------
    step("AT5a — sign-in push: the relay event flips the worker (no reload)");
    const beforeEmit = await browser.storageState();
    await sleep(1500); // let any stray state settle
    const stillBefore = await browser.storageState();
    check("without the event the worker does NOT know about the login (no polling, no inference)",
        stillBefore !== "signed_in" && stillBefore === beforeEmit, `state=${stillBefore}`);
    await browser.emitAuthEvent("auth:signed-in"); // the simulated emitter
    await waitFor("worker state flips to signed_in",
        () => browser.storageState().then((s) => s === "signed_in").catch(() => false), { timeout: 15000 });
    check("the relay event flipped the worker to signed_in within seconds (the pure-cookie check against the real backend)",
        await browser.storageState() === "signed_in");
    check("storage holds exactly the two keys (no token value anywhere)",
        Object.keys(await browser.storage()).sort().join(",") === "api_base_url,session_state");

    // -- 4. AT3: duplicate / out-of-order over the real relay ---------
    step("AT3 — duplicate / out-of-order SESSION_EVENTs (backend arbitrates)");
    const diag = async (label) => {
        const state = await browser.storageState().catch(() => "<unreadable>");
        const cookies = await browser.tokenCookies();
        const sw = await browser.evalSW(
            `(async () => { try { const r = await fetch(${JSON.stringify(API_ORIGIN + "/api/auth/app/v1/auth/session")}, { method: "GET", credentials: "include" }); return String(r.status); } catch (e) { return "FETCH-ERR:" + String(e); } })()`,
            { awaitPromise: true }).catch(() => "<unreadable>");
        const access = (cookies.find((c) => c.name === "access_token") || {}).value;
        const refresh = (cookies.find((c) => c.name === "refresh_token") || {}).value;
        console.log(`  diag ${label}: state=${state} swFetch=${sw} access=${access ? access.slice(0, 18) + "…" : "ABSENT"} refresh=${refresh ? refresh.slice(0, 18) + (refresh === refreshAtLogin ? "(unchanged)" : "(ROTATED)") : "ABSENT"} jar=${JSON.stringify(cookies.map(full))}`);
    };
    await browser.emitAuthEvent("auth:signed-in");
    try {
        await waitFor("state stable signed_in", () => browser.storageState().then((s) => s === "signed_in").catch(() => false), { timeout: 15000 });
    } catch {
        await diag("AT3 stable-check timeout");
        throw new Error("AT3: state did not settle at signed_in — see diag line above (state / jar / worker fetch)");
    }
    await browser.emitAuthEvent("auth:signed-in"); // duplicate
    await sleep(2000);
    check("duplicate signed-in (live session): final state signed_in = backend truth", await browser.storageState() === "signed_in");
    await browser.emitAuthEvent("auth:signed-out"); // a LATE out, session still live
    await sleep(2000);
    check("late signed-out (live session): the last write lands (the settled immediate write)", await browser.storageState() === "signed_out");
    const arb = await browser.sendToWorker({ type: MSG.USER }); // the next check arbitrates
    await sleep(1000);
    check("the next check arbitrates back to the backend truth (signed_in)",
        arb?.ok && arb?.value?.status === "OK" && (await browser.storageState()) === "signed_in", JSON.stringify(arb).slice(0, 200));

    // -- 5. AT5b: all four ops (real backend, real cookie auth) -------
    step("AT5b — SEARCH, LIBRARY, USER, SAVE all succeed");
    const lib0 = await browser.sendToWorker({ type: MSG.LIBRARY });
    const save = await browser.sendToWorker(WEB_SAVE);
    const lib1 = await browser.sendToWorker({ type: MSG.LIBRARY });
    const search = await browser.sendToWorker({ type: MSG.SEARCH, q: "s9 lifecycle" }); // one real paced embedding call
    const user = await browser.sendToWorker({ type: MSG.USER });
    check("LIBRARY OK (the pre-save list)", lib0?.ok && lib0?.value?.status === "OK" && Array.isArray(lib0?.value?.captures), JSON.stringify(lib0?.value ?? lib0).slice(0, 160));
    check("SAVE OK — the multipart POST authenticated by the real cookie (201 → OK + the backend's status)",
        save?.ok && save?.value?.status === "OK" && save?.value?.data?.status, JSON.stringify(save?.value ?? save).slice(0, 160));
    check("LIBRARY OK and carries the new capture", lib1?.ok && lib1?.value?.status === "OK" && lib1?.value?.captures?.length === 1, JSON.stringify(lib1?.value ?? lib1).slice(0, 160));
    check("SEARCH OK with the results passed through (real Gemini embedding)",
        search?.ok && search?.value?.status === "OK" && Array.isArray(search?.value?.results), JSON.stringify(search?.value ?? search).slice(0, 160));
    check("USER OK with the real user payload", user?.ok && user?.value?.status === "OK" && user?.value?.user?.email === email, JSON.stringify(user?.value ?? user).slice(0, 160));

    // -- 6. AT1: the worker-restart re-resolution ----------------------
    // Contract: "kill the service worker … state is re-resolved and every
    // feature works again." This build DOES reap the idle worker (~30 s —
    // the M2 "the MV3 worker needs a keepalive" fact), but the reaped
    // target LINGERS in Target.getTargets: "present in the list" is not a
    // death signal (runs 5/7/8 — the wait timed out or attach failed with
    // "No target with given id found" against the zombie), and there is no
    // ServiceWorker CDP domain to read running/stopped from. The signal
    // that works (probe-verified): a Runtime.evaluate against a reaped
    // worker comes back SILENT — {type:"undefined"}, no error.
    //
    // So: stay ATTACHED (a CDP session does not pin a worker — run 8 died
    // with one attached; the M2 smoke died with one attached), pause the
    // keepalive, wait a clean 55 s window with ZERO worker activity
    // (no evals during the wait — an eval might itself count as activity
    // and reset the 30 s clock; the reap lands ≤30 s in), then read
    // liveness once. A build that does not reap takes the alive branch;
    // both branches end in the same scored contract: the wake re-verifies
    // the session against the real backend (never a remembered value) and
    // every feature works again. The MID-FLIGHT kill (an open channel
    // keeps a live worker alive, so CDP cannot force it) is Tier 1's.
    step("AT1 — worker restart: the wake re-resolves the state");
    setKeepAlive(browser, false); // an inbound message resets the MV3 idle clock
    let swRec = await browser.swTarget();
    if (swRec && !swRec.sessionId) await browser.attach(swRec);
    const t0 = Date.now();
    await sleep(55000); // the 30 s reap + margin; zero CDP activity on the worker
    let died = !(swRec?.sessionId) || (await browser.evalOn(swRec, "1+1").catch(() => undefined)) !== 2;
    console.log(`  note ${died
        ? `the worker idle-reaped in the window (ordinary MV3 death at ~30 s; the reaped target lingers in the list — death read from the silent eval) — the full respawn path follows`
        : "the worker was still alive at the end of the window (a build that does not reap) — the wake goes to the live worker; the MID-FLIGHT kill is Tier 1's forceable coverage"}`);
    await browser.emitAuthEvent("auth:signed-in"); // the wake: a real external runtime message from the relay (respawns a dead worker; re-verifies a live one)
    let sw1;
    if (died && swRec) {
        await browser.detach(swRec);
        browser.targets.delete(swRec.targetId); // the zombie — that targetId never comes back; a respawn gets a NEW one
    }
    sw1 = await browser.findTarget((x) => isSW(x) && !(died && swRec && x.targetId === swRec.targetId), { label: "the (re)started service worker", timeout: 30000 });
    await browser.attach(sw1);
    const live = await browser.evalOn(sw1, "1+1").catch(() => undefined);
    check("the (re)started worker is live (a clean eval answers)", live === 2, `eval→${String(live)}`);
    setKeepAlive(browser, true);
    const u1 = await browser.sendToWorker({ type: MSG.USER }); // the re-resolution
    await sleep(1000);
    check("the wake re-verified the session against the real backend (state signed_in = backend truth, not a remembered value)",
        (await browser.storageState()) === "signed_in");
    check("USER OK with the same real user payload",
        u1?.ok && u1?.value?.status === "OK" && u1?.value?.user?.email === email, JSON.stringify(u1?.value ?? u1).slice(0, 160));
    const l1 = await browser.sendToWorker({ type: MSG.LIBRARY });
    const s1 = await browser.sendToWorker({ type: MSG.SEARCH, q: "s9 lifecycle again" });
    const v1 = await browser.sendToWorker(WEB_SAVE);
    check("LIBRARY + SEARCH + SAVE all work after the (re)start",
        l1?.ok && l1?.value?.status === "OK" && s1?.ok && s1?.value?.status === "OK" && v1?.ok && v1?.value?.status === "OK",
        [l1?.value?.status, s1?.value?.status, v1?.value?.status].join(","));
    check("storage is exactly the two keys",
        Object.keys(await browser.storage()).sort().join(",") === "api_base_url,session_state");

    // -- 7. AT4: expired authentication -------------------------------
    step("AT4 — the access credential expires (deleted from the real jar)");
    await browser.deleteCookies(["access_token"]);
    const lib2 = await browser.sendToWorker({ type: MSG.LIBRARY }); // 401 → one recovery → one retry
    check("expired access + live refresh: LIBRARY recovers (401 → refresh → retry → OK)",
        lib2?.ok && lib2?.value?.status === "OK", JSON.stringify(lib2?.value ?? lib2).slice(0, 160));
    check("state untouched — the session was never dead", await browser.storageState() === "signed_in");
    await waitFor("the recovered access cookie re-landed in the jar (the rotated Set-Cookie round trip)",
        async () => (await browser.tokenCookies()).some((c) => c.name === "access_token"), { timeout: 20000 });
    const accessAfterRecovery = (await browser.tokenCookies()).find((c) => c.name === "access_token")?.value;
    check("…and the refresh actually rotated (a different access token now in the jar)",
        Boolean(accessAtLogin) && Boolean(accessAfterRecovery) && accessAfterRecovery !== accessAtLogin);
    // The session is now fully dead — via the PRODUCT path, the worker's
    // own SIGN_OUT: it flushes the backend session AND clears both token
    // cookies in one response. (The old synthetic death — deleting the
    // cookies from the jar with CDP — left the backend session row ALIVE,
    // and a backend-verified re-login while that session is alive is
    // rejected with 409 and mints no token cookies: the probe curl showed
    // fresh login → 200 + both Set-Cookies, second login on the live
    // session → 409. That would have poisoned the step-8 re-login — the
    // run-9 step-8 timeout — so the death must go through the flush.)
    const so2 = await browser.sendToWorker({ type: MSG.SIGN_OUT });
    await sleep(1500); // let the flush + the cookie clear settle
    const u2 = await browser.sendToWorker({ type: MSG.USER });
    await sleep(1000);
    check("the sign-out flushed the session (worker OK; both token cookies cleared from the jar)",
        so2?.ok && so2?.value?.status === "OK" && (await browser.tokenCookies()).length === 0, JSON.stringify(so2?.value ?? so2).slice(0, 160));
    check("session fully dead: USER → UNAUTHENTICATED + the loaded build's sign-in URL + signed_out written",
        u2?.ok && u2?.value?.status === "UNAUTHENTICATED" && u2?.value?.sign_in_url === ORIGIN + "/login" && (await browser.storageState()) === "signed_out",
        JSON.stringify(u2?.value ?? u2).slice(0, 200));

    // -- 8. re-login (for the sign-out half) ---------------------------
    step("8 — re-login (real UI)");
    await loginOn(browser, ORIGIN, email, pw);
    await waitFor("token cookies back in the jar",
        async () => (await browser.tokenCookies()).some((c) => c.name === "access_token"), { timeout: 30000 });
    await browser.emitAuthEvent("auth:signed-in");
    await waitFor("state signed_in again",
        () => browser.storageState().then((s) => s === "signed_in").catch(() => false), { timeout: 20000 });
    check("re-login: signed_in via the push path", await browser.storageState() === "signed_in");

    // -- 9. AT5c/AT2: sign out on the account page ---------------------
    step("AT5c/AT2 — sign out on the account page (the real UI)");
    await browser.openPage(`${ORIGIN}/account`);
    await waitFor("the /account page", () => browser.pageEval("location.pathname").then((p) => p === "/account"), { timeout: 20000 });
    await waitFor("the account page's sign-out button", () =>
        browser.pageEval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Sign out')`), { timeout: 20000 });
    await browser.pageEval(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Sign out');
        b.click();
        return true;
    })()`);
    const cleared = await waitFor("both token cookies cleared by the backend's flush",
        async () => (await browser.tokenCookies()).length === 0, { timeout: 30000 }).then(() => true).catch(() => false);
    check("sign-out: the backend cleared both token cookies", cleared);
    // The missed-event case: no emission — the next check restores.
    const u3 = await browser.sendToWorker({ type: MSG.USER });
    await sleep(1000);
    check("missed sign-out event: the next check restores signed_out (no crash, no stale signed_in)",
        u3?.ok && u3?.value?.status === "UNAUTHENTICATED" && (await browser.storageState()) === "signed_out", JSON.stringify(u3?.value ?? u3).slice(0, 200));
    await browser.emitAuthEvent("auth:signed-out"); // the push path, for completeness
    await sleep(1500);
    check("the signed-out event confirms it (idempotent)", await browser.storageState() === "signed_out");

    // -- 10. cleanup ----------------------------------------------------
    step("10 — cleanup (the bench is left as found)");
    setKeepAlive(browser, false);
    browser.kill();
    await runPython(CLEANUP, { IE_S9_EMAIL: email, IE_S9_PW: pw }).then(
        () => check("probe account + its captures + queued tasks deleted", true),
        (err) => check("probe account + its captures + queued tasks deleted", false, `PENDING MANUAL CLEANUP: ${email} — ${String(err).slice(0, 120)}`),
    );
}

main()
    .then(() => {
        console.log(`\n${passed}/${passed + failed} checks passed`);
        if (failed) {
            console.log("failures:");
            for (const f of failures) console.log(`  - ${f}`);
            browserRef?.kill(); // process.exit below would skip the finally
            process.exit(1);
        }
    })
    .catch((err) => {
        console.error("\nnet crashed:", err.message);
        console.log(`\n${passed}/${passed + failed + 1} checks passed`);
        if (failed) {
            console.log("failures:");
            for (const f of failures) console.log(`  - ${f}`);
        }
        browserRef?.kill(); // process.exit below would skip the finally
        process.exit(1);
    })
    .finally(() => {
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        browserRef?.kill(); // never leave an orphan browser behind (run-9's crash left one)
    });
