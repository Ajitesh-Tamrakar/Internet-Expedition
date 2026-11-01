// ==================================================================
// Section 9 (contract "Background G — lifecycle, recovery, and
// integration testing") — Tier 1: worker-level acceptance.
//
// Runs the FIVE section-9 acceptance tests at the worker level,
// driving the real extension/background.js through the real bus
// listener (harness.mjs), plus the section-9 static audits:
//
//   AT1  worker restart (a MID-FLIGHT kill — what a real CDP session
//        cannot force: the open channel keeps an MV3 worker alive —
//        plus a wake that re-resolves, and every feature working again)
//   AT2  a missed SESSION_EVENT (the relay never delivered) — the next
//        session check restores the correct state, in both directions
//   AT3  duplicate / out-of-order SESSION_EVENTs — the worker
//        arbitrates through the backend; the final state matches the
//        backend truth
//   AT4  a request that fails because authentication expired — a
//        structured error, the signed-out transition, no crash
//   AT5  SEARCH / LIBRARY / USER / SAVE succeed across a worker restart
//        (the worker-side half of the integration pass; the relay +
//        popup halves are the browser net, browser-integration.mjs)
//
// Audits (the section-9 "Expected behavior" bullets, static + dynamic):
//   no polling timers, no in-memory-only durable state, no token in
//   any storage key or bus response, storage = exactly the two keys.
//
// No bench required — the fake backend stands in for the Django app.
// Run:  node extension/test/worker-lifecycle.test.mjs
// ==================================================================

import { readFileSync } from "node:fs";
import path from "node:path";
import {
    EXT_DIR, NO_RESPONSE, HUNG,
    makeBench, waitFor,
} from "./harness.mjs";

// ------------------------------------------------------------------
// Tiny assertion ledger.
// ------------------------------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function check(name, cond) {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; failures.push(name); console.log(`  FAIL ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MSG = { SAVE: "SAVE", CAPTURE_WEB: "CAPTURE_WEB", SESSION_EVENT: "SESSION_EVENT", SEARCH: "SEARCH", LIBRARY: "LIBRARY", SIGN_OUT: "SIGN_OUT", USER: "USER" };
const EV_IN = { type: "SESSION_EVENT", event: "signed-in" };
const EV_OUT = { type: "SESSION_EVENT", event: "signed-out" };
const state = (bench) => bench.storage.snapshot().session_state;
const keys = (bench) => Object.keys(bench.storage.snapshot()).sort().join(",");
const RESULT = [{
    capture_id: "cap-1", rank: 1, score: 0.87,
    summary_text: "A test summary.", created_at: "2026-10-31T00:00:00Z",
    source_url: "https://example.com/page",
    chunks: [{ source_key: "text:web:0", score: 0.87, text: "A chunk preview…" }],
}];

// A web-shaped v1 envelope (the universal.js shape) with usable text.
const WEB_SAVE = {
    type: MSG.SAVE,
    data: {
        mandatory_fields: { source_url: "https://example.com/page", platform: "web" },
        platform_specific_data: { text_content: "S9 lifecycle test article body.", title: "S9 Test Page", author: "S9" },
    },
};

// Let an async fire-and-forget handler finish: the request count
// reaches `expected`, then a brief rest for trailing microtasks.
async function settle(bench, expected) {
    await waitFor(() => bench.backend.requests.length >= expected);
    await sleep(25);
}

async function main() {
    const source = readFileSync(path.join(EXT_DIR, "background.js"), "utf8");
    const relaySource = readFileSync(path.join(EXT_DIR, "content", "relay.js"), "utf8");
    const popupJs = readFileSync(path.join(EXT_DIR, "popup", "popup.js"), "utf8");
    const popupHtml = readFileSync(path.join(EXT_DIR, "popup", "popup.html"), "utf8");

    // ---------------------------------------------------------- audits
    console.log("\n[audit] section-9 static bullets");
    // No timer polling (the popup-state sync is event-driven + checks).
    // Scope: worker + relay + popup. The v1 content scripts carry their
    // presentation timers (toast auto-dismiss) — presentation, not
    // session polling, and byte-identical by contract — out of scope.
    for (const [name, src] of [["background.js", source], ["content/relay.js", relaySource], ["popup/popup.js", popupJs]]) {
        check(`${name}: no setTimeout/setInterval`, !/setTimeout\(|setInterval\(/.test(src));
    }
    check("popup.html: no script with timers", !/setTimeout\(|setInterval\(/.test(popupHtml));

    // No in-memory-only durable state: the module-level `let` bindings
    // are exactly the wake-cache and the bus-installed flag (the const
    // Maps and vocabulary tables re-register / re-run by construction).
    const lets = [...source.matchAll(/^let (\w+)/gm)].map((m) => m[1]);
    check("worker: module-level lets are exactly {configCache, busListenerInstalled}",
        JSON.stringify([...lets].sort()) === JSON.stringify(["busListenerInstalled", "configCache"]));

    // ---------------------------------------------------------- S0: install
    console.log("\n[S0] install");
    const bench = await makeBench({
        // A legacy token from a pre-§4 build must not survive.
        storage: { access_token: "legacy-jwt-abc" },
        backendOpts: { results: RESULT },
    });
    const snap = bench.storage.snapshot();
    check("install seeds api_base_url from the file constant", snap.api_base_url === bench.constants.API_BASE_URL);
    check("install removes any legacy access_token key", !("access_token" in snap));
    check("storage after install: exactly one key", Object.keys(snap).join(",") === "api_base_url");
    check("context menu registered on install", bench.worker.stub.contextMenuCreations.some((c) => c.id === "bookmark-save-web"));

    // ---------------------------------------------------------- AT1: worker restart
    console.log("\n[AT1] worker restart — mid-flight kill, wake, re-resolve");
    bench.backend.login(); // the real session: both cookies live
    await bench.worker.send(EV_IN);
    await waitFor(() => state(bench) === "signed_in");
    check("baseline: a signed-in SESSION_EVENT resolves to signed_in", state(bench) === "signed_in");

    // Mid-flight: a slow search in the air when the worker dies.
    bench.backend.latency = 5000;
    const inFlight = bench.worker.send({ type: MSG.SEARCH, q: "machine learning" });
    await sleep(50); // the fetch is in flight when the kill lands
    const storageBeforeKill = bench.storage.snapshot();
    bench.worker.kill();
    const inFlightResult = await inFlight; // settles into the dead channel
    check("mid-flight kill: the in-flight op settles as a documented failure (no claimed success)",
        inFlightResult.status === "FETCH_ERROR");
    check("mid-flight kill: no state written by the dying worker", JSON.stringify(bench.storage.snapshot()) === JSON.stringify(storageBeforeKill));
    check("mid-flight kill: storage intact (api_base_url + session_state)", keys(bench) === "api_base_url,session_state");
    bench.backend.latency = 5; // the slow-request phase is over

    // The gap: the session dies server-side while the worker is dead —
    // no event, no check. The wake must RE-RESOLVE, not assume.
    bench.backend.killSession();
    bench.worker.spawn(); // the restart-wake: fresh context, same storage
    const userAfterWake = await bench.worker.send({ type: MSG.USER });
    check("wake with a dead session: USER reports UNAUTHENTICATED (the stale signed_in is not trusted)",
        userAfterWake.status === "UNAUTHENTICATED");
    check("wake with a dead session: sign_in_url is the FRONTEND origin's /login",
        userAfterWake.sign_in_url === bench.constants.FRONTEND_ORIGIN + "/login");
    check("wake with a dead session: signed_out written", state(bench) === "signed_out");

    // The session returns (a real login); every feature works again.
    bench.backend.login();
    const u2 = await bench.worker.send({ type: MSG.USER });
    const l2 = await bench.worker.send({ type: MSG.LIBRARY });
    const s2 = await bench.worker.send({ type: MSG.SEARCH, q: "machine learning" });
    const v2 = await bench.worker.send(WEB_SAVE);
    check("after wake + login: USER OK with the real user payload", u2.status === "OK" && u2.user?.email === bench.backend.user.email);
    check("after wake + login: LIBRARY OK (the empty list is a real answer)", l2.status === "OK" && Array.isArray(l2.captures) && l2.captures.length === 0);
    check("after wake + login: SEARCH OK with the results passed through", s2.status === "OK" && s2.results?.[0]?.capture_id === "cap-1");
    check("after wake + login: SAVE OK (the capture created)", v2.status === "OK" && v2.data?.status === "pending");
    check("state is signed_in again after the wake's check", state(bench) === "signed_in");

    // ---------------------------------------------------------- AT2: missed SESSION_EVENT
    console.log("\n[AT2] missed SESSION_EVENT — the next session check restores");
    // Direction 1: the session dies quietly (the relay never told the
    // worker). The stored value is still signed_in — stale.
    bench.backend.killSession();
    check("precondition: no event delivered — the stale state still reads signed_in", state(bench) === "signed_in");
    const u3 = await bench.worker.send({ type: MSG.USER }); // the next check (popup open)
    check("missed logout: the next check reports UNAUTHENTICATED", u3.status === "UNAUTHENTICATED");
    check("missed logout: the state converges to signed_out", state(bench) === "signed_out");

    // Direction 2: a login happens server-side; the worker still
    // believes signed_out.
    bench.backend.login();
    const u4 = await bench.worker.send({ type: MSG.USER });
    check("missed login: the next check reports OK + user", u4.status === "OK" && u4.user?.email === bench.backend.user.email);
    check("missed login: the state converges to signed_in", state(bench) === "signed_in");

    // No spontaneous state: nothing writes between checks (no polling).
    const before = bench.storage.snapshot();
    await sleep(120); // "time passes"
    check("no spontaneous state writes (no polling timer)", JSON.stringify(bench.storage.snapshot()) === JSON.stringify(before));

    // ---------------------------------------------------------- AT3: duplicate / out-of-order SESSION_EVENTs
    console.log("\n[AT3] duplicate / out-of-order SESSION_EVENTs — the backend arbitrates");
    bench.backend.login();

    // Duplicates: three signed-ins, backend live (one re-check each).
    let reqs = bench.backend.requests.length;
    for (let i = 0; i < 3; i++) {
        await bench.worker.send(EV_IN);
        await settle(bench, reqs + 1);
        reqs = bench.backend.requests.length;
    }
    check("duplicate signed-in x3 (live): final state signed_in = backend truth", state(bench) === "signed_in");

    // Out-of-order: a LATE signed-out lands after the signed-in it
    // preceded (the contract §4 settles the immediate write; the
    // stored value is a cache, never proof — the next check arbitrates).
    reqs = bench.backend.requests.length;
    await bench.worker.send(EV_IN); await settle(bench, reqs + 1);
    await bench.worker.send(EV_OUT); await sleep(25); // the immediate write makes no backend call
    check("late signed-out (live session): the last write lands", state(bench) === "signed_out");
    const u5 = await bench.worker.send({ type: MSG.USER }); // the arbitration
    check("late signed-out (live session): the next check arbitrates back to signed_in = backend truth",
        u5.status === "OK" && state(bench) === "signed_in");

    // In order with a dead backend: signed-in (check 401 + refresh 400
    // → signed_out) then a duplicate signed-out (idempotent write).
    bench.backend.killSession();
    reqs = bench.backend.requests.length;
    await bench.worker.send(EV_IN); await settle(bench, reqs + 2);
    await bench.worker.send(EV_OUT); await sleep(25);
    check("signed-in, signed-out (dead session): final state signed_out = backend truth", state(bench) === "signed_out");

    // Malformed events: ignored — no state write, no crash, no response.
    const reqsBeforeMalformed = bench.backend.requests.length;
    const stateBeforeMalformed = state(bench);
    for (const bad of [{ type: "SESSION_EVENT" }, { type: "SESSION_EVENT", event: "signed-in-extra" }, { type: "SESSION_EVENT", event: 42 }, null, 42]) {
        const r = await bench.worker.send(bad);
        check(`malformed ${JSON.stringify(bad ?? null).slice(0, 44)}: no response (fire-and-forget) and no state change`,
            (r === NO_RESPONSE || r === HUNG) && state(bench) === stateBeforeMalformed);
    }
    await sleep(25);
    check("malformed events: no backend calls, no crash", bench.backend.requests.length === reqsBeforeMalformed);

    // A 5xx backend during an event: "unknown" — no fabricated state.
    bench.backend.faulty = true;
    const stateBefore5xx = state(bench);
    await bench.worker.send(EV_IN);
    await settle(bench, reqsBeforeMalformed + 1);
    bench.backend.faulty = false;
    check("5xx backend on signed-in: no state write (a stale cache beats a fabricated one)", state(bench) === stateBefore5xx);

    // ---------------------------------------------------------- AT4: expired authentication
    console.log("\n[AT4] a request that fails because authentication expired");
    bench.backend.login();
    await bench.worker.send(EV_IN); await waitFor(() => state(bench) === "signed_in");

    // Recoverable expiry: the access credential died, the refresh lives.
    bench.backend.expireAccess();
    const reqsBefore401 = bench.backend.requests.length;
    const s3 = await bench.worker.send({ type: MSG.SEARCH, q: "expiring" });
    const paths = bench.backend.requests.slice(reqsBefore401).map((r) => r.method + " " + r.path);
    check("expired access + live refresh: SEARCH recovers and succeeds", s3.status === "OK" && Array.isArray(s3.results));
    check("…with exactly one recovery and one retry (never a loop)",
        JSON.stringify(paths) === JSON.stringify(["GET /search/?q=expiring", "POST /api/auth/app/v1/tokens/refresh", "GET /search/?q=expiring"]));
    check("…and the state is untouched (signed_in — the session was never dead)", state(bench) === "signed_in");

    // Definitive death: both credentials gone.
    bench.backend.killSession();
    for (const [name, msg, expectState] of [
        ["SEARCH", { type: MSG.SEARCH, q: "dead" }, "signed_out"],
        ["LIBRARY", { type: MSG.LIBRARY }, "signed_out"],
        ["USER", { type: MSG.USER }, "signed_out"],
    ]) {
        const r = await bench.worker.send(msg);
        check(`dead session, ${name}: UNAUTHENTICATED + the sign-in URL + signed_out written`,
            r.status === "UNAUTHENTICATED" && r.sign_in_url === bench.constants.FRONTEND_ORIGIN + "/login" && state(bench) === expectState);
    }
    const capturesBeforeSave = bench.backend.captures.length;
    const v3 = await bench.worker.send(WEB_SAVE);
    check("dead session, SAVE: UNAUTHENTICATED + sign-in URL — nothing submitted",
        v3.status === "UNAUTHENTICATED" && v3.sign_in_url === bench.constants.FRONTEND_ORIGIN + "/login" && bench.backend.captures.length === capturesBeforeSave);
    const so = await bench.worker.send({ type: MSG.SIGN_OUT });
    check("dead session, SIGN_OUT: the goal is met by definition (recovery 'gone' → OK), state signed_out, no crash",
        so.status === "OK" && state(bench) === "signed_out");

    // The backend is alive but sick (5xx) / gone (network): the
    // structured error shapes, and NO state write (the contract §4
    // "unknown" rule — the backend didn't answer, nothing is claimed).
    bench.backend.login();
    await bench.worker.send(EV_IN); await waitFor(() => state(bench) === "signed_in");
    bench.backend.faulty = true;
    const s4 = await bench.worker.send({ type: MSG.SEARCH, q: "sick" });
    check("5xx backend: SEARCH returns the structured ERROR (code 500)", s4.status === "ERROR" && s4.code === 500);
    check("5xx backend: no state write", state(bench) === "signed_in");
    bench.backend.faulty = false;
    bench.backend.offline = true;
    const s5 = await bench.worker.send({ type: MSG.LIBRARY });
    check("network failure: LIBRARY returns FETCH_ERROR", s5.status === "FETCH_ERROR");
    bench.backend.offline = false;
    check("network failure: no state write (the stale cache stands until the next check)", state(bench) === "signed_in");

    // ---------------------------------------------------------- AT5: all four ops across a worker restart
    console.log("\n[AT5] SEARCH, LIBRARY, USER, SAVE across a worker restart");
    const runAllFour = async (label) => {
        const u = await bench.worker.send({ type: MSG.USER });
        const l = await bench.worker.send({ type: MSG.LIBRARY });
        const s = await bench.worker.send({ type: MSG.SEARCH, q: "all four" });
        const v = await bench.worker.send(WEB_SAVE);
        const ok = u.status === "OK" && l.status === "OK" && s.status === "OK" && v.status === "OK";
        check(`${label}: USER + LIBRARY + SEARCH + SAVE all OK`, ok);
        return { u, l, s, v };
    };
    bench.backend.login();
    await bench.worker.send(EV_IN); await waitFor(() => state(bench) === "signed_in");
    await runAllFour("before the restart");
    // The idle death (no in-flight op — the ordinary MV3 kill).
    bench.worker.kill();
    bench.worker.spawn();
    await runAllFour("after the restart");
    check("after the restart: storage is exactly the two keys", keys(bench) === "api_base_url,session_state");
    check("after the restart: state signed_in (re-resolved by the ops, not assumed)", state(bench) === "signed_in");
    check("no respawn churn: exactly one install + the two tested restarts", bench.worker.spawns === 3);

    // ---------------------------------------------------------- final ledgers
    console.log("\n[final] the contract's invariants, after everything");
    check("no timer was ever scheduled by the worker (dynamic no-poll proof)", bench.timers.set === 0);
    check("no token value crossed the bus in any response", !bench.responses.some((r) => /eyJ/.test(JSON.stringify(r)) || JSON.stringify(r).includes("access_token")));
    check("no UNAUTHENTICATED response is missing its sign_in_url", bench.responses.filter((r) => r.status === "UNAUTHENTICATED").every((r) => typeof r.sign_in_url === "string" && r.sign_in_url.endsWith("/login")));
    check("no response claims a success that is not OK", bench.responses.every((r) => ["OK", "UNAUTHENTICATED", "ERROR", "FETCH_ERROR"].includes(r.status)));
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
