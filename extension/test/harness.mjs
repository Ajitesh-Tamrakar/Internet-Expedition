// ==================================================================
// Section 9 (contract "Background G — lifecycle, recovery, and
// integration testing") — Tier 1 harness.
//
// Runs the REAL extension/background.js in a node:vm context against:
//
//   - a PERSISTENT chrome.storage.local stub — the same object survives
//     worker deaths, exactly like Chrome's storage (the MV3 worker is
//     stateless; storage is its only durable state);
//   - a FakeBackend — an in-process stand-in for the Django app that
//     models the settled Authentication contract: the access cookie
//     (path /) rides every route, the refresh cookie (path-scoped to
//     the tokens endpoint) rides only the refresh route; the allauth
//     session/refresh/logout semantics (including the 401-after-flush
//     logout) and the DRF data routes;
//   - a recording chrome stub — every onMessage dispatch, every
//     sendResponse payload, every scheduled timer (the no-polling
//     audit is dynamic, not just a grep).
//
// A worker KILL cancels the backend's in-flight requests (a dead MV3
// worker's fetches die with it) and retires that worker's stub; a WAKE
// re-runs the script in a fresh context over the same storage — the
// exact Chrome lifecycle. `onInstalled` fires only on the first spawn
// (an install), never on a restart-wake (top-level re-runs, callbacks
// do not).
//
// No dependencies: node >= 22 (vm, FormData, File, Blob globals).
// ==================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(EXT_DIR, "..");

// The real worker source (the committed file — the code under test).
export function workerSource() {
    return readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
}

// The per-manifest origin constants, read from the source under test —
// assertions about sign_in_url / storage seed track whatever file is
// loaded (committed = the pinned origin; .dev-load = the local origins).
export function readConstants(source) {
    const pick = (name) => {
        const m = source.match(new RegExp(`^const ${name} = "([^"]+)"`, "m"));
        if (!m) throw new Error(`constant ${name} not found in the worker source`);
        return m[1];
    };
    return { API_BASE_URL: pick("API_BASE_URL"), FRONTEND_ORIGIN: pick("FRONTEND_ORIGIN") };
}

// A bus response that never came (a fire-and-forget send, or a hung
// handler at the safety deadline).
export const NO_RESPONSE = { __noResponse: true };
export const HUNG = { __hung: true };

// ------------------------------------------------------------------
// FakeBackend — the Django app, scripted.
// ------------------------------------------------------------------

// The cookie-path rule a real browser applies: a cookie with path P
// attaches to a request path R iff R === P or R starts with P.
function cookieAttaches(cookiePath, reqPath) {
    return reqPath === cookiePath || reqPath.startsWith(cookiePath);
}

// The jar as the worker's requests see it. In the real system the
// cookies live in the browser; here two booleans model "a live token
// for this path is attached". `access` covers every route (the dev
// .env's AUTH_ACCESS_COOKIE_PATH=/ — the carried deployment item),
// `refresh` only the refresh endpoint (the contract's one door).
// `token` models the documented fallback (AUTH_MODE "header"): the
// stored body token authenticates the same routes the access cookie
// does. In the shipped primary mode it is always false.
export class FakeBackend {
    constructor({ user = null, results = [], latency = 5 } = {}) {
        this.jar = { access: false, refresh: false, token: false };
        this.faulty = false; // every route 500s (the "unknown" outcome)
        this.offline = false; // fetch throws (the FETCH_ERROR outcome)
        this.latency = latency;
        this.requests = []; // { method, path, attached, header }
        this.user = user ?? {
            id: 7, display: "s9probe", email: "s9@probe.test",
            first_name: "S9", last_name: "Probe",
            has_usable_password: true, username: "s9probe",
        };
        this.results = results; // the canned /search/ 200 body
        this.captures = []; // created via POST /captures/
        this.inflight = new Set();
    }

    // -- jar transitions (the test's view of the real session) -------
    login() { this.jar.access = true; this.jar.refresh = true; if (this.jar.token) this.jar.token = true; }
    logout() { this.jar.access = false; this.jar.refresh = false; this.jar.token = false; }
    expireAccess() { this.jar.access = false; this.jar.token = false; } // the refresh survives
    killSession() { this.jar.access = false; this.jar.refresh = false; this.jar.token = false; }

    // -- the kill: a dead worker's in-flight fetches die with it -----
    cancelInflight() {
        for (const op of this.inflight) op.reject(new Error("worker died — request cancelled"));
        this.inflight.clear();
    }

    // The one entry point: fetch(url, init) as the worker makes it.
    request(url, init = {}) {
        const u = new URL(url);
        const rec = { method: init.method || "GET", path: u.pathname + u.search, attached: null, header: Boolean(init.headers && init.headers.Authorization) };
        this.requests.push(rec);

        return new Promise((resolve, reject) => {
            const op = { resolve, reject };
            this.inflight.add(op);
            const t = setTimeout(() => {
                // A kill() cancelled this op — skip the route entirely:
                // a cancelled request must not run (it could mutate the
                // jar after the fact) and must not hold the loop open.
                if (!this.inflight.delete(op)) return;
                try {
                    op.resolve(this.route(rec));
                } catch (err) {
                    op.reject(err);
                }
            }, this.latency);
            if (t.unref) t.unref();
        });
    }

    // A fake response with the surface the worker reads: ok, status, text().
    static json(status, body) {
        const text = JSON.stringify(body);
        return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text) };
    }

    route(rec) {
        const { method, path, header } = rec;
        const attached = {
            access: this.jar.access && cookieAttaches("/", path), // the / path rides everything
            refresh: this.jar.refresh && cookieAttaches("/api/auth/app/v1/tokens/", path),
        };
        rec.attached = attached;
        // The effective credential: the attached access cookie (primary)
        // or the Bearer header (the documented fallback seam).
        const authed = attached.access || (header && this.jar.token);

        if (this.offline) throw new Error("network unreachable (fake offline mode)");
        if (this.faulty) return FakeBackend.json(500, { detail: "Internal Server Error" });

        if (path === "/api/auth/app/v1/auth/session" && method === "GET") {
            if (authed) {
                return FakeBackend.json(200, { status: 200, data: { user: this.user, methods: [] }, meta: { is_authenticated: true } });
            }
            return FakeBackend.json(401, { status: 401, data: { flows: [{ id: "login" }] }, meta: { is_authenticated: false } });
        }

        if (path === "/api/auth/app/v1/tokens/refresh" && method === "POST") {
            if (attached.refresh) {
                // 200 = a fresh access minted into the jar (the rotated
                // refresh lands with it); the body copy is what the
                // fallback mode would read.
                this.jar.access = true;
                this.jar.token = true;
                return FakeBackend.json(200, { status: 200, data: { access_token: "fake-jwt-access" } });
            }
            // Stale / rotated / gone → 400 (the contract's definitive dead).
            return FakeBackend.json(400, { status: 400, errors: [{ message: "The refresh token is invalid, expired, or has been revoked.", code: "refresh_token_invalid", param: "refresh_token" }] });
        }

        if (path === "/api/auth/app/v1/auth/session" && method === "DELETE") {
            // The real endpoint answers 401 in both cases; a live access
            // credential is the tell that the flush actually happened.
            if (authed) {
                this.jar.access = false;
                this.jar.refresh = false;
                this.jar.token = false;
            }
            return FakeBackend.json(401, { status: 401, data: { flows: [{ id: "login" }] }, meta: { is_authenticated: false } });
        }

        if (path.startsWith("/search/") && method === "GET") {
            if (!authed) return FakeBackend.json(401, { detail: "Authentication credentials were not provided." });
            // The real route: a bare JSON array (no wrapper object).
            return FakeBackend.json(200, this.results);
        }

        if (path === "/captures/" && method === "GET") {
            if (!authed) return FakeBackend.json(401, { detail: "Authentication credentials were not provided." });
            return FakeBackend.json(200, this.captures); // the newest-first list
        }

        if (path === "/captures/" && method === "POST") {
            if (!authed) return FakeBackend.json(401, { detail: "Authentication credentials were not provided." });
            const capture = {
                capture_id: `cap-${this.captures.length + 1}`,
                status: "pending", // the backend's creation default (the §8 live check)
                created_at: new Date().toISOString(),
            };
            this.captures.unshift(capture);
            return FakeBackend.json(201, capture);
        }

        return FakeBackend.json(404, { detail: "Not found." });
    }
}

// ------------------------------------------------------------------
// Persistent storage — the one object that survives worker deaths.
// ------------------------------------------------------------------

export class StorageStub {
    constructor(initial = {}) {
        this.data = { ...initial };
    }
    snapshot() {
        return { ...this.data };
    }
}

// A per-CHROME storage.local with the promise surface the worker uses
// (get(string | string[]) / set(object) / remove(key | keys[])).
function makeStorageLocal(persistent) {
    return {
        async get(keys) {
            if (keys === undefined) return { ...persistent.data };
            if (typeof keys === "string") {
                const out = {};
                if (keys in persistent.data) out[keys] = persistent.data[keys];
                return out;
            }
            if (Array.isArray(keys)) {
                const out = {};
                for (const k of keys) if (k in persistent.data) out[k] = persistent.data[k];
                return out;
            }
            throw new Error(`storage.get: unsupported key form ${typeof keys}`);
        },
        async set(items) {
            Object.assign(persistent.data, items);
        },
        async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) delete persistent.data[k];
        },
    };
}

// ------------------------------------------------------------------
// Per-worker chrome stub — recording, retire-able on kill.
// ------------------------------------------------------------------

export class ChromeStub {
    constructor({ storage, timers, consoleLines, responses }) {
        this.dead = false;
        this.timers = timers; // the shared timer ledger (dynamic no-poll audit)
        this.consoleLines = consoleLines;
        this.responses = responses; // the shared response ledger
        this.onInstalledFired = false;
        this.onInstalledListeners = [];
        this.onMessageListeners = [];
        this.contextMenuCreations = [];

        this.chrome = {
            runtime: {
                id: "oijkpjikiabildophmlfeihojjpghmed",
                lastError: null,
                onMessage: { addListener: (fn) => this.onMessageListeners.push(fn) },
                onInstalled: { addListener: (fn) => this.onInstalledListeners.push(fn) },
                sendMessage: (msg) => {
                    // A self-posted runtime message (the keepalive's {})
                    // reaches this worker's own listener, exactly as in
                    // Chrome; a dead worker drops it.
                    if (this.dead) return;
                    for (const fn of this.onMessageListeners) fn(msg, { id: this.chrome.runtime.id }, () => {});
                },
            },
            storage: { local: makeStorageLocal(storage) },
            contextMenus: {
                create: (item) => this.contextMenuCreations.push(item),
                onClicked: { addListener: () => {} },
            },
            tabs: {
                sendMessage: () => {},
                captureVisibleTab: () => {},
                create: () => {},
            },
        };
    }
    retire() {
        this.dead = true;
    }
}

// ------------------------------------------------------------------
// WorkerProcess — one MV3 service-worker lifetime.
// ------------------------------------------------------------------

export class WorkerProcess {
    constructor({ source, backend, storage, timers, consoleLines, responses, constants }) {
        this.source = source;
        this.backend = backend;
        this.storage = storage;
        this.timers = timers;
        this.consoleLines = consoleLines;
        this.responses = responses;
        this.constants = constants;
        this.alive = false;
        this.spawns = 0;
    }

    // Run the script in a fresh context. Top-level re-runs on every
    // spawn (fresh configCache, fresh handler maps, the bus listener
    // re-registers) — the MV3 wake.
    spawn() {
        if (this.alive) throw new Error("worker already alive");
        this.spawns += 1;
        const stub = new ChromeStub({
            storage: this.storage, timers: this.timers,
            consoleLines: this.consoleLines, responses: this.responses,
        });
        const realFetch = globalThis.fetch;
        const fetchStub = (url, init) =>
            typeof url === "string" && url.startsWith("data:")
                ? realFetch(url, init) // the worker's sanctioned data-URL conversion
                : this.backend.request(url, init);

        const sandbox = {
            chrome: stub.chrome,
            fetch: fetchStub,
            console: {
                log: (...a) => this.consoleLines.push(a.map(String).join(" ")),
                warn: (...a) => this.consoleLines.push("WARN " + a.map(String).join(" ")),
                error: (...a) => this.consoleLines.push("ERROR " + a.map(String).join(" ")),
                info: (...a) => this.consoleLines.push(a.map(String).join(" ")),
            },
            // The web globals the worker touches (host classes, so
            // instanceof survives the vm boundary).
            FormData, File, Blob, URL, URLSearchParams,
            TextEncoder, TextDecoder, structuredClone,
            // Recording timers: the dynamic no-polling audit. Scheduling
            // one is recorded AND run (fast), so a legitimate timer would
            // still work — the assertion is that the worker never schedules.
            setTimeout: (fn, ms) => { this.timers.set += 1; return setTimeout(fn, Math.min(ms ?? 0, 1)); },
            setInterval: (fn, ms) => { this.timers.set += 1; return setInterval(fn, Math.max(ms ?? 0, 60_000)); },
            clearTimeout: (id) => clearTimeout(id),
            clearInterval: (id) => clearInterval(id),
        };
        sandbox.globalThis = sandbox;
        this.context = vm.createContext(sandbox);
        this.stub = stub;
        vm.runInContext(this.source, this.context, { filename: "background.js" });
        this.alive = true;
        return this;
    }

    // The install: the first spawn + the onInstalled callbacks (seed +
    // legacy-key cleanup + the context menu). Never re-fired on a
    // restart-wake.
    async install() {
        this.spawn();
        for (const fn of this.stub.onInstalledListeners) await fn();
        this.stub.onInstalledFired = true;
        return this;
    }

    // The MV3 kill: in-flight requests cancelled, this worker's stub
    // retired (its continuations may still run against the dead stub —
    // their effects are recorded as post-kill orphans, exactly as a
    // real dead worker's in-flight channel dies with it).
    kill() {
        this.backend.cancelInflight();
        this.stub.retire();
        this.alive = false;
        this.context = null;
    }

    // Post a bus message to the worker (any sender). Resolves with the
    // sendResponse payload, NO_RESPONSE (fire-and-forget / dropped),
    // or HUNG (no response by the safety deadline).
    send(message, sender = {}, { timeout = 5000 } = {}) {
        if (!this.alive) return Promise.reject(new Error("worker is not alive"));
        const listener = this.stub.onMessageListeners[0];
        if (!listener) return Promise.resolve(NO_RESPONSE);
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                if (value && value.__noResponse !== true) this.responses.push(value);
                resolve(value);
            };
            const sendResponse = (value) => finish(value === undefined ? NO_RESPONSE : value);
            const keepOpen = listener(message, { id: this.stub.chrome.runtime.id, ...sender }, sendResponse);
            if (keepOpen !== true) {
                // Fire-and-forget (or ignored): resolve on the next tick —
                // the handler may still run its async body afterwards.
                setTimeout(() => finish(NO_RESPONSE), 0);
            }
            setTimeout(() => finish(HUNG), timeout);
        });
    }
}

// A ready-to-run bench: the real source, one backend, one persistent
// storage, shared ledgers, a worker in the installed state.
export async function makeBench(opts = {}) {
    const source = opts.source ?? workerSource();
    const constants = readConstants(source);
    const backend = new FakeBackend({ latency: opts.latency ?? 5, ...opts.backendOpts });
    const storage = new StorageStub(opts.storage ?? { api_base_url: constants.API_BASE_URL });
    const timers = { set: 0 };
    const consoleLines = [];
    const responses = [];
    const worker = new WorkerProcess({ source, backend, storage, timers, consoleLines, responses, constants });
    await worker.install();
    return { source, constants, backend, storage, timers, consoleLines, responses, worker };
}

// Await until pred(snapshot) is true (the async event handlers settle
// on the host loop; a short poll is the wait primitive).
export async function waitFor(pred, { timeout = 5000, tick = 5 } = {}) {
    const start = Date.now();
    for (;;) {
        const value = pred();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error("waitFor: deadline exceeded");
        await new Promise((r) => setTimeout(r, tick));
    }
}
