# Internet Expedition — Pre-Launch Readiness Review

80 issues found by reading the codebase and exercising the running stack (backend, worker,
Postgres/pgvector, Ollama and the frontend were all live during this review; DB state, API
responses and the test suite were queried directly rather than inferred).

**Type** is either:

- **CODE PROBLEM** — the intended behaviour is clear, the implementation doesn't deliver it.
- **DESIGN DECISION ISSUE** — the code does what it was built to do; that choice is now the gap.

IDs are stable discovery numbers, so they stay comparable across passes. Grouped BLOCKER → MAJOR → MINOR.

---

# BLOCKERS

Things that make the product not shippable: the core feature does not work, data is at risk,
or the most common failure is invisible.

---

### B-22 · The vector index is dropped on upgrade and never rebuilt

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `core/migrations/0015_unconstrain_chunk_embedding_dimension.py`, `core/views.py:15-25`

Migration 0015 runs `DROP INDEX IF EXISTS idx_chunks_embedding` and relaxes the column to an
unconstrained `vector`. The index is only ever recreated inside `setup_embedding` →
`_resize_embedding_column`, which is skipped when `embedding_locked` is true. Any install that
upgrades past 0015 loses its vector index permanently. Verified live:

```
\d chunks
Indexes: chunks_pkey, chunks_bookmark_id_9c30be89, idx_chunks_bookmark_id, idx_chunks_type
embedding | vector      -- unconstrained; pgvector cannot index this at all
```

Every search is now a sequential scan of the whole `chunks` table.

**Proposed solution.** Add migration 0017 that reads `config.embedding_dimensions` (falling back
to the length of any existing embedding, else skip) and, when a dimension is known:

```sql
ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(%(dim)s);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw (embedding vector_cosine_ops);
```

Then make index existence an invariant rather than a setup side effect: extract
`ensure_embedding_index(dimension)` into `core/db.py`, call it from `setup_embedding`, from
`reembed`, and from `AppConfig.ready()` on the worker (cheap — `CREATE INDEX IF NOT EXISTS`).
Add a `pgvector_index` row to `/pipeline/status/` so a missing index is visible, not silent.

**Fixed.** Implemented largely as proposed, with two deliberate deviations. Extracted
`ensure_embedding_index(dimension)` (plus a read-only `embedding_index_status()`) into new
`core/db.py` — idempotent: it no-ops if the column/index are already in the target state, so it's
cheap to call on every boot instead of only at setup. Added migration
`core/migrations/0017_rebuild_chunk_embedding_index.py` (`RunPython`) that reads
`config.embedding_dimensions`, falls back to an existing embedding's `vector_dims()` if unset, and
skips cleanly with a logged warning (rather than crashing the migration) if the dimension is unknown
or inconsistent across existing rows. `setup_embedding` (`core/views.py`) and
`process/management/commands/reembed.py` now both call the shared helper instead of duplicating the
DDL, removing `_resize_embedding_column` entirely.

Deviation 1: did not hook `AppConfig.ready()` — it fires on every process start, including each
gunicorn worker, which risks a concurrent-DDL race. Instead added a new
`core/management/commands/ensure_embedding_index.py` command, wired into `docker/entrypoint.sh`
right after `migrate`, which already runs once, single-process, before the `worker` service starts
or gunicorn forks.

Deviation 2: did not add `pgvector_index` to `/pipeline/status/` — that endpoint 403s without
`dev_mode`, which real users never enable (see M-39). Instead added a new, non-dev-gated
`GET /retrieve/status/summary/` (`retrieve/views.py` + `retrieve/urls.py`) returning
`{"pgvector_index": {"present": bool, "dimension": int|null}}` — a minimal slice of M-39's proposed
endpoint, not its full scope; the rest of M-39 (pending/failed counts, banner UI) is still open.

Also resolves M-8 below via the same shared helper.

---

### B-23 · `complete` bookmarks exist with zero embeddings and nothing detects them

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `process/pipeline.py:148-171` (`embedding`), `process/pipeline.py:215-226`

Live DB: **1806 of 1998** chunks belonging to `complete` bookmarks have `embedding IS NULL`. Two
bookmarks — "What is RAG? Completely Explained" (1488 chunks) and "What is Docker? Simply
Explained" (318 chunks) — are `processing_status='complete'` with `processed_at = NULL` and **zero**
embedded chunks. They are permanently invisible to search while the UI reports them as saved and
finished. `processed_at IS NULL` proves they never went through `run_pipeline`'s completion branch,
so some earlier code path (or a manual fix-up) set `complete` directly, and nothing has ever noticed.

**Proposed solution.** Three parts:

1. Make `complete` unreachable without embeddings. In `run_pipeline`, before setting `complete`,
   assert `Chunk.objects.filter(bookmark=b, embedding__isnull=True).count() == 0`; otherwise write
   `failed` with `failed_at='embedding'`. Enforce it in the DB too with a periodic check rather than
   a trigger.
2. Ship a `manage.py repair_embeddings` command that finds every bookmark where
   `processing_status='complete'` and an unembedded chunk exists, and requeues it as `pending`.
   Call it once from migration 0017's `RunPython` so existing installs self-heal.
3. Surface it: add `unembedded_complete_count` to `/pipeline/status/` and a "N saved items aren't
   searchable — re-index" banner on the Search page (not dev-gated, see M-39).

**Fixed.** Implemented all three parts of the proposed solution, plus one addition found during
implementation. In `process/pipeline.py`, `run_pipeline()` now re-checks
`Chunk.objects.filter(bookmark_id=..., embedding__isnull=True)` immediately before writing
`processing_status='complete'`; if any remain, it writes `failed` with `failed_at='embedding'`
instead — a defense-in-depth check at the transition point itself, independent of `embedding()`'s
own internal check. Added `find_unembedded_complete_bookmark_ids(Bookmark)` and
`repair_unembedded_complete_bookmarks(Bookmark)` to `core/db.py` (the same shared-helper file B-22
introduced), taking the `Bookmark` model class as a parameter so the same function runs unchanged
against either the live model or a migration's historical model. New
`process/management/commands/repair_embeddings.py` (`--dry-run` supported) wraps it for manual use,
and migration `core/migrations/0018_repair_unembedded_complete_bookmarks.py` (`RunPython`, same
shape as `0017`) calls it once so existing installs self-heal on upgrade. `GET
/retrieve/status/summary/` (`retrieve/views.py`) now also returns `unembedded_complete_count`, and
`SearchPage.jsx` renders a non-dev-gated warning banner ("N saved items aren't searchable yet —
re-index needed") when it's > 0.

Addition beyond the proposed solution: implementation surfaced a second, currently-live source of
the same defect — `bookmark_note()` (`retrieve/views.py`) re-embeds a single note chunk outside the
pipeline whenever a user edits a note on an already-`complete` bookmark, and previously only logged
a failure there, leaving that one chunk permanently unembedded with no signal. Fixed by retrying
just that chunk's embedding inline (up to 3 attempts, 0.5s apart) before giving up, and returning a
new `note_indexed: bool` field in the response so the caller knows if it didn't take effect
immediately. Deliberately scoped narrow: it does *not* flip `processing_status` or requeue the whole
bookmark (that would force a full pipeline re-run — re-download, re-transcribe, re-tag — over one
failed chunk, the same cost M-17 already flags elsewhere). If all 3 inline retries fail, the
bookmark is still caught by the general repair mechanism below the next time the worker restarts.

Deviation: the proposed solution says add `unembedded_complete_count` to `/pipeline/status/`, but
that endpoint 403s without `dev_mode` (same reasoning as B-22's deviation 2, and M-39). Added it to
`/retrieve/status/summary/` instead, following the precedent B-22 already set there.

Also added a periodic self-heal beyond the one-time migration: `run_worker.py` now calls
`repair_unembedded_complete_bookmarks` on every worker boot (right after its existing
stuck-`processing` reset), since a one-time migration only catches rows that already exist at
upgrade time, not ones created afterward — including by `bookmark_note`, before its own fix above,
or any future bug of the same shape.

---

### B-47 · The primary value proposition mostly doesn't work

**Type:** DESIGN DECISION ISSUE   **Severity:** BLOCKER
**Location:** `frontend/src/pages/SearchPage.jsx:19-20,116-125`, `process/chunk_builders.py`, `retrieve/views.py`

The client bands results at `NORMAL_THRESHOLD = 0.35` / `BROAD_THRESHOLD = 0.65` cosine distance.
Measured against the live library:

| query                                  | best distance | `< 0.35` ("exact") | mode shown         |
| -------------------------------------- | ------------- | -------------------- | ------------------ |
| `docker`                             | 0.7453        | 0                    | **no-match** |
| `how to learn AI`                    | 0.3439        | 1                    | search-normal      |
| `video about negotiating salary`     | 0.4494        | 0                    | approximate        |
| `computer science career advice`     | 0.5856        | 0                    | approximate        |
| `RAG retrieval augmented generation` | 0.4696        | 0                    | approximate        |

Four of five realistic queries never reach the "exact" band, so the user almost always sees the
"APPROXIMATE · no exact matches" fallback. `docker` returns **zero** results despite the library
containing "What is Docker? Simply Explained" (a B-23 casualty). The README's own example phrasing
("that video about negotiating a salary") is exactly what fails.

Two causes compound: thresholds calibrated against nothing, and short keyword queries having no good
target because `context_header()` prepends the same title/author string to every chunk, flattening
the distance spread.

**Proposed solution.**

1. Fix B-23/B-22 first — a meaningful fraction of this is simply missing vectors.
2. Stop hardcoding thresholds. Move banding to the backend as `NORMAL_MAX_DISTANCE` /
   `BROAD_MAX_DISTANCE` constants in `retrieve/views.py`, return a `band` field per result, and have
   `SearchPage` render whatever the backend says. That makes the numbers reachable from
   `run_golden_eval` so they can be tuned against measured Recall@1/MRR instead of guessed.
3. Calibrate: build a ~40-query golden set across the three existing buckets
   (`exact_name`/`paraphrase`/`vague`), run `run_golden_eval`, and set the normal band at the
   distance that captures ≥90% of `exact_name` hits at rank 1. Expect ~0.45–0.55 for
   `nomic-embed-text-v2-moe`, not 0.35.
4. Add a lexical arm for keyword queries: a Postgres `tsvector` index on `chunks.text` and reciprocal
   rank fusion with the vector arm. `docker` is a keyword query; dense retrieval alone will keep
   losing it. The `EvalRun.hybrid_enabled` column already anticipates this.

---

### B-13 · Search returns the entire library on every query — no LIMIT, no cutoff

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `retrieve/views.py:19-33` (`_best_chunks`), `retrieve/views.py:69-137`, `frontend/src/pages/SearchPage.jsx:116-125`
*(consolidates discovery #13, #48)*

```sql
SELECT DISTINCT ON (c.bookmark_id) c.bookmark_id::text, (c.embedding <=> %s::vector)::float, ...
FROM chunks c WHERE c.embedding IS NOT NULL
ORDER BY c.bookmark_id, (c.embedding <=> %s::vector) ASC
```

No `LIMIT`, no distance predicate. Verified live: `"zxqvwk purple elephant tax law mongolia"`
returns **54 results** — every embedded bookmark. The full serialized library (titles, URLs, tags,
highlighted text) crosses the wire on every 500 ms-debounced keystroke, and the `DISTINCT ON` forces
a full scan that defeats any HNSW index even once B-22 is fixed.

**Proposed solution.** Rewrite as a two-stage query that the index can actually serve:

```sql
WITH nearest AS (
    SELECT bookmark_id, embedding <=> %(vec)s::vector AS distance, timestamp_seconds
    FROM chunks
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> %(vec)s::vector      -- HNSW-servable
    LIMIT %(candidate_k)s                        -- e.g. 200
)
SELECT DISTINCT ON (bookmark_id) bookmark_id::text, distance, timestamp_seconds
FROM nearest WHERE distance < %(max_distance)s
ORDER BY bookmark_id, distance
```

then sort by distance and slice to `LIMIT` (default 25) in Python. Apply the tag filter as a join
inside the CTE rather than post-filtering in Python, so tag-filtered searches don't silently return
fewer than `k` results. Add `?limit=` and `?offset=` and return `has_more`.

This also moves the relevance decision out of the browser. Today the two magic numbers that define
"found it" live in a React component (`NORMAL_THRESHOLD`/`BROAD_THRESHOLD`), which means they are
unreachable from `run_golden_eval` and can't be tuned against measured recall — see B-47.

**Fixed.** Implemented as a new `_best_chunks_fast(query_embedding, candidate_k, ef_search)` in
`retrieve/views.py`, using the proposed two-stage CTE shape — `WITH nearest AS (... ORDER BY
embedding <=> ... LIMIT candidate_k)` then `DISTINCT ON (bookmark_id)` over that already-small pool
— wrapped in `transaction.atomic()` with `SET LOCAL hnsw.ef_search` set to match `candidate_k` (200
by default). Verified live: the setting takes effect inside the transaction and reverts after
commit. `_best_chunks()` itself is untouched; `search()` calls the fast path by default and falls
back to the original unbounded query only when `?deep=1` is passed, which keeps
`run_golden_eval.py` (a direct, unmodified caller of `_best_chunks`) unaffected — a before/after
eval run confirmed no regression, though there was no golden set loaded in this DB to produce a
real number either time. `search()` now accepts `?limit=` (default 25, max 100) and `?offset=`, and
returns `has_more`. `SearchPage.jsx` renders a "Deep search — check every saved item, no shortcuts"
button when a search comes back empty or approximate, re-issuing the query with `deep=1`.

Verified live against the running Postgres/pgvector stack: forcing `enable_seqscan=off` confirms
the new query *can* use `idx_chunks_embedding` (Index Scan), but with only ~200 embedded chunks in
this library Postgres correctly prefers a Seq Scan at this table size — expected planner behavior,
not a defect; it will switch over as the library grows. Live sanity checks: a nonsense query that
previously returned every embedded bookmark (54, per this issue) now returns exactly 25 with
`has_more: true`; `?limit=1` returns `has_more: true`; a tag-filtered search still returns matches;
`deep=1&limit=100` returns the full unbounded set.

Deviation 1: did not add a `max_distance` predicate to the CTE (the proposed SQL's `WHERE distance <
%(max_distance)s`). That's a relevance cutoff, not a size cutoff, and conflating the two was
explicitly out of scope for this fix — it belongs with B-47's threshold calibration work instead.

Deviation 2: did not move tag filtering into a SQL join as proposed. It stays a Python post-filter
over whatever the candidate pool contains, with the pool widened to `TAG_FILTERED_CANDIDATE_K =
1000` when tags are present, as a stopgap. This reduces but does not eliminate the risk of a
tag-filtered search silently under-returning once a cap exists — if that's later observed in
practice, it needs the real SQL-join fix this issue originally proposed, not a bigger constant.

Addition beyond the proposed solution: the `deep=1` opt-in fallback wasn't in the original proposed
solution (which only described the fast path). Added so there's a way to intentionally run the old
exhaustive search when the fast path's `candidate_k` genuinely misses something, without raising
`candidate_k` globally for every query.

Also surfaced, unrelated to this fix: no Django migration creates the Postgres `vector` extension
itself (`CREATE EXTENSION vector`) — it must have been enabled manually in the live `bookmark`
database at some point, since a fresh test database doesn't have it and `manage.py test` fails
without it. Worked around it manually to run the test suite; a real migration for this is still
open.

New tests: `SearchPaginationTests` in `retrieve/tests.py` (fixture of 30 embedded bookmarks) —
default search caps at 25 with `has_more: true`; `deep=1&limit=100` returns more than the default
cap. All 9 tests in `retrieve` pass.

---

### B-37 · Failed saves are completely silent

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `extension/content/confirmation.js`, `extension/content/universal.js:79-86`, `extension/content/linkedin.js:394`, `extension/content/youtube.js:127-137`
*(consolidates discovery #37, #38)*

The toast overlay has exactly three panels: `confirmation`, `note`, `setup-required`. There is no
error panel. `universal.js` — the "save any web page" path, which has no on-page button — only reacts
to `status === "OK"` and `setupRequired`. Every other outcome (`FETCH_ERROR` because Docker isn't
running, a 400, a 500 debug page that fails `.json()`) produces **nothing on screen at all**. The
single most likely real-world failure — backend not started — is invisible.

On the platform buttons it's marginally better: `bmSetState(btn, "error")` adds a CSS class, so the
user gets a red icon with no reason and no next step, even though the response carries `code` and
`error`.

**Proposed solution.** Add a fourth `error` panel to `confirmation.js` and a
`window.bmShowError(kind, detail)` entry point, then call it from all four save paths. Map the
response to plain language rather than echoing the backend:

- `FETCH_ERROR` → *"Can't reach Internet Expedition. Is it running? Open http://localhost:8081"* with
  a button that opens the app.
- `code === 503` → existing setup-required panel.
- `code >= 500` → *"Something went wrong saving this. It wasn't saved."* + a `Copy details` button.
- `code === 400` → *"This page couldn't be read."*
  Give the error panel a 10 s dismiss (not 3 s) and no auto-dismiss while hovered. `bmSetState(btn, "error")` should additionally set `aria-label` to the message so it's announced.

---

### B-9 · The worker dies permanently on any unexpected exception, and the UI reports it as healthy

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `process/management/commands/run_worker.py:27-55`, `frontend/src/design-system/composites/WorkerStatusBar.jsx:20-25`
*(consolidates discovery #9, #54)*

```python
try:
    while True:
        ...
except Exception as e:
    self.stdout.write(f'error {str(e)}')
```

The `except` wraps the **entire loop**, not the body. One unexpected error — a dropped DB
connection, an Ollama client raising something a stage didn't catch, a Whisper OOM — writes a single
stdout line and ends the loop. The container process then exits `0`, so `restart: unless-stopped`
may or may not bring it back, and captures keep piling up as `pending` forever.

Meanwhile the Pipeline page renders `{polling ? 'Worker running' : 'Polling paused'}` — where
`polling` is *local React state driven by a toggle switch in the same bar*. There is no heartbeat
anywhere in the system. A dead worker displays a pulsing green "Worker running", and
`concurrency 1 / 1` is a hardcoded prop.

**Proposed solution.**

1. Move the `try/except` **inside** the loop, around the claim + `run_pipeline` call. Log with
   `logger.exception`, mark the in-flight bookmark `failed` with the traceback in
   `processing_error`, `time.sleep(5)`, and continue. Keep an outer handler only for
   `KeyboardInterrupt`/`SystemExit`.
2. Add a real heartbeat: a `worker_heartbeat` row in `Config` (or a one-row `WorkerHeartbeat` model)
   updated with `now()` on every loop tick. Have `/pipeline/status/` return
   `worker: {last_seen, alive: last_seen > now() - 30s}`, and have `WorkerStatusBar` render that
   instead of `polling`. Show a red "Worker not responding — bookmarks aren't being processed" state.
3. Add `restart: always` and a `healthcheck` to the `worker` service that shells out to a
   `manage.py worker_health` command asserting the heartbeat is fresh.

**Fixed.** Implemented parts 1 and 2 of the proposed solution; part 3 (Docker-level healthcheck +
auto-restart) was explicitly descoped after a further scoping pass — see deviation below.
`run_worker.py`'s `try/except` now wraps a single iteration inside `while True:`, scoped around the
claim + `run_pipeline` call, instead of the whole loop. An unhandled exception is logged with
`logger.exception` and, if a bookmark had been claimed, applied against the *same retry-count policy
`run_pipeline()` already uses for ordinary stage failures* (increment `retry_count`; back to `pending`
if `< 3`, else `failed`; `failed_at` set to the stage the bookmark was in, full traceback in
`processing_error`) rather than being marked `failed` outright — so a transient blip still gets the
normal three attempts before the worker gives up on it. `KeyboardInterrupt`/`SystemExit` still break
the loop cleanly; every other path sleeps 5s and keeps going, so one bad bookmark can no longer take
the whole queue down with it.

Deviation 1 (following B-22's precedent of extracting shared state into `core/db.py`): didn't bolt the
heartbeat onto `Config` — added a new one-row `WorkerStatus` model (`core/models.py`, singleton
pattern mirrors `Config`'s own) backed by an `UNLOGGED` table (migration `0019_worker_status.py`, same
`RunPython`/`RunSQL` shape as B-22's `0017`) to keep each write's footprint small, since it's written
on every idle tick and every pipeline stage boundary. `WORKER_ALIVE_THRESHOLD_SEC` is 120s, not the
proposed 30s — deliberately generous so a legitimately slow stage (a large video's extraction) doesn't
falsely read as "not responding."

Addition beyond the proposed solution: the heartbeat isn't only touched once per bookmark claim.
`record_worker_working(bookmark_id)` (`core/db.py`) is also called at every stage boundary inside
`run_pipeline()` (extraction → chunking → tagging → embedding, `process/pipeline.py`), so a worker
that's alive but stuck deep inside one stage eventually goes stale on its own instead of looking
identical to a bookmark that's just legitimately slow. This distinction feeds a second addition:
`InFlightTable`'s existing `stale` badge (elapsed-time only) now has a stronger `stuck` tier (elapsed
*and* the worker's own status has gone stale too) — `stale` alone now just means "this one item is
slow," `stuck` means "the worker itself looks dead."

Deviation 2: didn't add a Docker-level `healthcheck`/`restart: always` (proposed part 3). A failed
Compose healthcheck doesn't by itself make Docker restart a still-running container — that needs a
sidecar watcher (e.g. `willfarrell/autoheal`) or an in-process watchdog, a separate and bigger piece of
work — so it was dropped from this fix's scope rather than shipped half-working.

Also touched, not fixed: `run_worker.py`'s claim block (`select_for_update().filter(...).update(...)`,
the same block M-11 flags as not actually holding a row lock) now sits inside the new try/except and
gained the `record_worker_working` call right after it, but its locking semantics are untouched —
that's M-11's own, separate, still-open bug.

New tests: `core.tests.WorkerStatusTests` (idle/working/stale-freshness/no-row-yet on
`worker_status()`), `process.tests.RunPipelineWorkerStatusTests` (`record_worker_working` called once
per stage), and `process.tests.RunWorkerLoopRetryTests` (an exception mid-`run_pipeline()` requeues as
`pending` with `retry_count` incremented on the first two failures, `failed` on the third). Verified
live against a throwaway pgvector/Postgres container (same B-13-flagged gap: `CREATE EXTENSION vector`
had to be applied by hand, no Docker daemon available in this environment so a disposable Podman
container stood in for it): migration applies cleanly and `worker_status` shows as `u` (unlogged) in
`pg_class`; full suite (`core process retrieve`) passes at the same 11 pre-existing failures as an
unmodified `main` (confirmed by running the suite again after `git stash`), with all 7 new tests green
— no regressions. Did not run the live crash/hang sanity checks from the original verification
checklist (raising inside `extraction()` against a running stack, killing the worker container to
watch the dashboard flip) — no Docker daemon available in this environment; worth doing once back on
the real stack.

---

### B-21 · `dev_wipe` destroys the entire database on an unauthenticated GET

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `core/views.py:177-202`

```python
def dev_wipe(request):
    config = Config.get()
    if not config.dev_mode:
        return JsonResponse({'error': 'dev mode is not enabled'}, status = 403)
    BookmarkTag.objects.all().delete(); Chunk.objects.all().delete()
    Tag.objects.all().delete();        Bookmark.objects.all().delete()
```

No method check, so `GET /setup/dev-wipe/` deletes every bookmark, chunk and tag and resets config.
It is also *not* `@csrf_exempt` (unlike every neighbouring view), so a legitimate POST from the
frontend gets a 403 — meaning the **only** way this endpoint works is the unsafe GET. Any page the
user visits can trigger it with `<img src="http://localhost:8080/setup/dev-wipe/">`, and the backend
binds `0.0.0.0:8080`, so anything on the local network can too. `Config.get()` at line 179 also
raises `DoesNotExist` → 500 when config is missing.

**Proposed solution.** Add `@csrf_exempt` + `if request.method != 'POST': return 405`. Require an
explicit confirmation token in the body (`{"confirm": "wipe"}`) so a bare POST can't do it either.
Wrap `Config.get()` in the same `DoesNotExist` → 404 guard used by `pipeline_status`. Separately,
bind the backend to `127.0.0.1:8080` in `docker-compose.yml` (`ports: ["127.0.0.1:8080:8080"]`) —
a local-first single-user app has no reason to be reachable from the LAN. Same for `5432` and `8082`.

---

### B-12 · The shipped stack runs development servers with `DEBUG=True`

**Type:** DESIGN DECISION ISSUE   **Severity:** BLOCKER
**Location:** `docker-compose.yml:52,56,105`, `Dockerfile.frontend:14`, `bookmark/settings.py:28`
*(consolidates discovery #12, #18)*

`command: python manage.py runserver 0.0.0.0:8080` and `CMD ["npm","run","dev"]`, with
`DJANGO_DEBUG: ${DJANGO_DEBUG:-True}`. Confirmed live: `settings.DEBUG is True`. Consequences that
show up throughout this report: every unhandled exception returns a full HTML debug page (source,
settings, request locals) to whatever called it — including content scripts on linkedin.com and x.com
— the autoreloader restarts the process on any file touch (killing in-flight model pulls, M-53, and
in-flight pipelines, M-10), and the frontend ships unminified through Vite's dev server.

**Proposed solution.**

- Backend: add `gunicorn` to requirements; `command: gunicorn bookmark.wsgi:application --bind 0.0.0.0:8080 --workers 2 --timeout 120`.
- Flip the default: `DJANGO_DEBUG: ${DJANGO_DEBUG:-False}`, and in `settings.py` make
  `DEBUG = env.bool('DJANGO_DEBUG', default=False)` with the legacy `DEBUG` fallback removed (see m-61).
- Frontend: multi-stage `Dockerfile.frontend` — `npm ci && npm run build`, then serve `dist/` from
  `nginx:alpine` with a `try_files $uri /index.html` SPA fallback and `proxy_pass` blocks for
  `/setup/ /pipeline/ /capture/ /retrieve/ /evaluate/` to `backend:8080`. This also removes the
  Vite-proxy regex fragility behind m-44.
- Drop the `- .:/app` bind mounts from `backend` and `worker` so the image is what runs; keep
  `./logs`, `./tmp` and the model caches.
- Add a `docker-compose.dev.yml` overlay that restores `runserver`, `npm run dev`, the bind mounts and
  `DJANGO_DEBUG=True` for development.

---

### B-4 · Every cloud provider is unreachable in the only documented install method

**Type:** DESIGN DECISION ISSUE   **Severity:** BLOCKER
**Location:** `core/secrets.py`, `core/views.py:91-96`, `Dockerfile`

`set_api_key()` uses `keyring`, which requires an OS secret-service backend. There is none inside
`python:3.12-slim`. Verified live:

```
$ docker exec bookmark-backend python -c "import keyring; keyring.set_password('bookmark','openai','x')"
NoKeyringError: No recommended backend was available.
```

The Setup page offers OpenAI / Anthropic / Google, and submitting a key returns
`500 {"error": "Failed to store API key: No recommended backend was available..."}` — shown to the
user via `alert()` (m-52). The decision to use the OS keychain is sound for a local-first app run
natively; it is simply incompatible with the container, which is how everyone actually runs it.

**Proposed solution.** Make the secret store pluggable behind the existing `core/secrets.py`
interface, selected by a `SECRETS_BACKEND` env var that `docker-compose.yml` sets to `file`:

- `keyring` — unchanged, for native installs.
- `file` — write to `/app/tmp/secrets.json` at mode `0600`, encrypted with a Fernet key derived
  from `DJANGO_SECRET_KEY`. Not a hardware-backed keychain, but honest, container-viable, and no
  worse than the Postgres password already sitting in `docker-compose.yml`.

Have `setup_embedding` return a clear message when the chosen backend can't store a key, rather than
leaking the library's exception text. Note that fixing this exposes M-5, M-6 and M-7, which must be
fixed together for the cloud paths to actually work.

---

### B-50 · Changing a model after the readiness check permanently locks in a model that was never downloaded

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `frontend/src/pages/SetupPage.jsx:134-142, 212-217`
*(consolidates discovery #50, #51)*

```js
function scheduleCheck() {
  if (checkScheduled.current) return;
  checkScheduled.current = true;
  setTimeout(() => {
    checkScheduled.current = false;
    // will be triggered via effect
  }, 0);
}
```

There is no such effect. `scheduleCheck()` is called from all five provider/model change handlers
and does nothing. So: run the check with Ollama defaults (`checkState === 'ok'`), then switch the
embedding model to `mxbai-embed-large`. `canComplete` stays true, "Complete setup" succeeds,
`embedding_locked` is set on the first bookmark — and the model was never pulled. Every subsequent
capture fails at the embedding stage with an error the user cannot trace back to setup, and the
recovery path is a Docker CLI command they've never heard of (m-70).

Compounding it: when both providers are cloud, `runCheck` marks every row green immediately without
test-calling the API key, verifying the model id, or downloading Whisper — which *does* need a real
download.

**Proposed solution.**

1. Delete `scheduleCheck()`. Replace it with invalidation: any provider/model/whisper change sets
   `setCheckState('stale')` and clears `checkRows`. Render the stale state as "Configuration changed
   — run the system check again", and make `canComplete` require `checkState === 'ok'` (it already
   does, so this alone closes the hole).
2. Add a real verification endpoint `POST /setup/verify/` that, for the exact selected
   configuration, embeds the string `"test"` and runs a 5-token chat completion, returning
   `{embedding: {ok, dimension, error}, generation: {ok, error}}`. Have `runCheck` call it after
   pulls complete and only then set `ok`. This validates cloud keys and model ids for free, and
   catches a wrong `embedding_dimensions` before it is locked forever.
3. Never mark the whisper row `ok` without a completed `pull-status` entry.

---

### B-14 · Search and other hot paths return HTML stack traces instead of errors

**Type:** CODE PROBLEM   **Severity:** BLOCKER
**Location:** `retrieve/views.py:85`, `core/models.py:159-161` and all `Config.get()` call sites
*(consolidates discovery #14, #73)*

`search()` calls `embed_texts([q], task='query')` with nothing around it. If Ollama is unreachable,
the model isn't pulled, or pgvector errors, the exception escapes the view — and with `DEBUG=True`
(B-12) Django returns a full HTML debug page. `SearchPage` then throws on `res.json()` and shows a
generic message; the user never learns Ollama is down.

`Config.get()` is `cls.objects.get(id=1)` and no migration or startup step creates that row. It is
called unguarded in `process/pipeline.py:61`, `process/embeddings.py:25`, `process/generation.py:24`,
`process/transcription.py:9`, `process/helper_function.py:16`, `retrieve/views.py:133` and
`core/views.py:179`. Any path that runs before setup completes — or after a `dev_wipe` — raises
uncaught `Config.DoesNotExist`.

**Proposed solution.**

1. Wrap the embedding call in `search()`:
   ```python
   try:
       query_vector = embed_texts([q], task='query')[0]
   except Exception:
       logger.exception('query embedding failed')
       return JsonResponse({'error': 'search_unavailable',
                            'message': "Can't reach the local AI model. Is Ollama running?"},
                           status=503)
   ```

   and have `SearchPage` render `data.message` in the existing `Callout`.
2. Add a data migration creating `Config(id=1)` with `setup_complete=False`, so the row always
   exists. Change `Config.get()` to `cls.objects.get_or_create(id=1)[0]` as a belt-and-braces
   default, and stop `dev_wipe` from being able to remove it.
3. Add a project-wide DRF-style exception handler (or a small middleware) that converts any
   unhandled exception on a `/capture/`, `/retrieve/`, `/setup/`, `/pipeline/` or `/evaluate/` path
   into `JsonResponse({'error': 'internal', 'message': ...}, status=500)`, so API clients never
   receive HTML regardless of the `DEBUG` setting.

---

# MAJOR

Frequent user-visible failures, real data/resource problems, and deployability friction that
will generate support load.

---

### M-2 · LinkedIn video posts always fail

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/video_extraction.py:111-115`, `process/chunk_builders.py:300-304`, `capture/views.py:53-61`

`_linkedin_fields` sets `has_video = len(psd.get("videos") or []) > 0`, but `VIDEO_LEAVES` has no
`linkedin` key and neither does `VIDEO_CHUNK_LEAVES`. `extraction()` therefore appends
`"video: no extractor registered for platform 'linkedin'"` and fails the **whole bookmark**, three
times, discarding perfectly good post text that was already captured. Confirmed live on two records.

**Proposed solution.** Two changes:

1. Register a LinkedIn video leaf. `linkedin.js` already collects `video.src`, but LinkedIn serves
   DASH/HLS so those are usually blob URLs. The reliable route is the resolved post permalink through
   yt-dlp, which supports LinkedIn: add
   `extract_video_linkedin(bookmark)` that calls `download_video(bookmark.url, path)` +
   `transcribe_to_segments`, mirroring `extract_video_twitter`, and register
   `'linkedin': chunk_video_twitter`-style flat-text chunking in `VIDEO_CHUNK_LEAVES`.
   Gate it on `platform_metadata['post_url_resolved']` being true — a company-page fallback URL
   (M-26) will never yield a video.
2. Make a missing leaf non-fatal in general. In `extraction()` and `chunking()`, an unregistered
   modality for a platform should log a warning and clear the flag
   (`Bookmark.objects.filter(id=...).update(has_video=False)`) rather than fail the bookmark, so the
   text still gets indexed. Reserve `failed` for modalities that were supposed to work and didn't.

---

### M-19 · Downloaded media leaks and nothing can reclaim it

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/helper_function.py:15-22`, `core/views.py:255-278`, `frontend/src/design-system/composites/TempFolderSection.jsx`
*(consolidates discovery #1, #19, #55)*

```python
def cleanup_temp_file(path):
    if Config.get().dev_mode:
        return
```

With dev mode on, nothing is ever deleted. The live instance holds **42 files / ~1 GB** —
three 232 MB videos, one 194 MB, one 32 MB — for bookmarks that are already `complete` or `failed`.
Even with dev mode off, cleanup only happens in each extractor's `finally`; a worker killed mid-download
(routine, see M-10) leaves an orphan with no owner. Nothing ever sweeps the directory. The Pipeline
page renders the whole inventory and explicitly notes it is "deliberately not joined against the
bookmarks table" — so the product can show you the leak but not fix it.

**Proposed solution.**

1. Stop conditioning correctness on dev mode. Replace the early return with a retention policy:
   always delete on success; on failure keep the file **only** until the bookmark leaves
   `processing` (so a retry can reuse it — see M-17), then delete.
2. Add `manage.py sweep_captures [--max-age-hours 24] [--dry-run]`: for every file in
   `tmp/captures/`, parse the `{uuid}_{modality}.{ext}` name and delete it if the bookmark no longer
   exists, is `complete`, or the file is older than the cutoff. Run it from the worker loop once an
   hour.
3. Give the UI the missing verb: `POST /pipeline/temp/cleanup/` calling the same sweep, wired to a
   "Delete orphaned files (N, X MB)" button in `TempFolderSection`, with a confirm modal.
4. Cap the download itself — pass `max_filesize` to yt-dlp (say 500 MB) so one long video can't
   consume the disk before anything gets a chance to clean up.

---

### M-39 · The user is never told whether indexing succeeded

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `extension/content/confirmation.js:27, 187-190`, `core/views.py:216-278`, `frontend/src/pages/SearchPage.jsx`

The save toast says *"Indexing in background…"* and auto-dismisses after 3 seconds. That is the last
the user ever hears about it. Processing then fails on the live instance for **12 of 76** bookmarks
(~16%), and the only surface that shows a failure is `/pipeline`, which is gated behind `dev_mode`
and returns 403 otherwise. A bookmark can burn three retries, be marked `failed`, and vanish from
search with zero feedback — the user's mental model is "I saved it", and the app quietly disagrees.
This is distinct from B-37, which is about a save that never reached the server; here the save
succeeded and the *processing* failed.

**Proposed solution.**

1. Add a non-dev-gated `GET /retrieve/status/summary/` returning
   `{pending, processing, failed, unembedded_complete}` (the counts `pipeline_status` already
   computes, minus the dev-only detail rows and the temp-file scan).
2. Show it in the Search page header: a quiet "3 items still indexing" pill while work is queued,
   and a persistent "2 items couldn't be indexed — review" link when `failed > 0`, opening a small
   list with per-item "Try again" (the ungated retry from M-3) and "Delete".
3. Change the toast copy from a promise to a fact — *"Saved. Indexing usually takes a minute."* — and
   let the toast reflect a real terminal state when the user is still on the page: poll
   `/retrieve/status/<bookmark_id>/` once at ~30 s and switch the panel to "Ready to search" or the
   error panel from B-37.

---

### M-17 · Any retry re-runs the whole pipeline, re-downloading gigabytes

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `process/pipeline.py:174-227`

On a failure at any stage the bookmark goes back to `pending` with `retry_count += 1`, and the
worker restarts it at `extraction`. A bookmark that fails at *embedding* — e.g. Ollama restarted for
ten seconds — re-downloads its video, re-runs Whisper transcription, and re-runs every LLM tagging
call, up to three times. With the 232 MB videos in the live DB that is ~700 MB of redundant download
and hours of CPU to recover from a transient blip.

**Proposed solution.** Make retries resume rather than restart. `failed_at` already records the stage
and `Bookmark.Stages` already enumerates them:

```python
STAGES = [extraction, chunking, tagging, embedding]
start = STAGES.index(stage_by_name[b.failed_at]) if b.failed_at else 0
for stage in STAGES[start:]:
    ...
```

The stages are already idempotent enough for this: `chunking` deletes existing chunks first,
`embedding` only touches `embedding=None`, and `update_raw_text_key` overwrites. Clear `failed_at`
on success so a later unrelated failure doesn't resume from the wrong place. Separately, distinguish
retryable failures (connection errors, timeouts) from permanent ones (`no video ID found in URL`,
404 on the image) and don't burn three retries on the latter — mark them `failed` immediately.

---

### M-11 · The "claim a pending bookmark" lock does nothing

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/management/commands/run_worker.py:36-47`

```python
process = Bookmark.objects.select_for_update().filter(id=pending.id)
process.update(processing_status='processing', ...)
```

`QuerySet.update()` does not carry the `FOR UPDATE` clause — Django issues a plain `UPDATE`, so no
row lock is taken. The update also has no `processing_status='pending'` predicate, so the claim isn't
conditional. The code reads as protected and isn't. Today only one worker runs, so it's latent; it
becomes real the moment a second worker is added or a restarting worker overlaps the outgoing one.

**Proposed solution.** Make the claim a conditional atomic update and use its row count as the lock:

```python
claimed = Bookmark.objects.filter(id=pending.id, processing_status='pending').update(
    processing_status='processing', processing_started_at=now(), current_step='extraction')
if not claimed:
    continue    # someone else took it
pending.refresh_from_db()
```

No transaction or `select_for_update` needed — a single conditional `UPDATE` is atomic in Postgres.
If concurrency is wanted later, switch the fetch to
`.select_for_update(skip_locked=True).first()` **inside** `transaction.atomic()` and mutate the
model instance, not the queryset.

**Fixed.** Implemented a broader fix than the row-claim patch alone. Fixing just the claim's
atomicity only protects that one specific race; it does nothing about a second class of damage a
stray second worker would also cause — `WorkerStatus` (added in the B-9 fix) is a singleton row
(`WorkerStatus.save()` forces `id = 1`) that the worker writes to on every idle tick and pipeline
stage boundary, so a second worker would stomp on the same row and corrupt the dashboard's liveness
display in a way the claim fix wouldn't otherwise catch. Rather than patch each place that turns out
to assume single-worker as it's discovered, this closes off the whole bug class: a non-blocking
Postgres advisory lock (`pg_try_advisory_lock`), acquired once via new `acquire_worker_singleton_lock()`
(`core/db.py`) at the very start of `run_worker_loop()` — before the stuck-`processing` reset and
`repair_unembedded_complete_bookmarks` run — prevents a second worker process from ever starting at
all. The lock is held for the lifetime of the process's DB connection and released automatically by
Postgres the moment that connection closes (clean exit, crash, or container restart), so a dead
worker never permanently locks out its replacement. It's acquired inside `run_worker_loop()` itself
rather than `handle()`, since `handle()` runs unconditionally in both the autoreloader's outer
supervisor process and its inner child, and only the inner child should actually hold it.

The row-claim itself was fixed exactly as proposed: the claim block is now a single conditional
`Bookmark.objects.filter(id=pending.id, processing_status='pending').update(...)`, using the
affected-row count as the compare-and-swap result (`if not claimed: continue`). The now-redundant
`select_for_update()`/`transaction.atomic()` and the `transaction` import are dropped.

New tests: `core.tests.WorkerSingletonLockTests` — acquiring succeeds on first call; a second,
independent `psycopg2` connection attempting `pg_try_advisory_lock` on the same key returns `False`
while the first connection still holds it; releasing the first lets the second acquire it. Advisory
locks are session-scoped, not transactional, so the lock is explicitly released in `tearDown` to
avoid leaking into other tests.

Verified live against the running Docker stack (Postgres, worker and backend containers all up):
`manage.py test core process` passes, including the new tests, at the same 11 pre-existing failures
as an unmodified `main` (same count the B-9 fix's own run found — no regressions). Exec'ing a second
`run_worker` process into the live `bookmark-worker` container while the first was already running
logged `Another worker is already running (advisory lock held) -- exiting.` and returned before ever
reaching the polling loop, while the original kept ticking undisturbed; `docker compose restart
worker` confirmed the replacement reacquires the lock cleanly with no permanent lockout; the
container's dev-mode autoreloader also picked up the code changes live, mid-session, and restarted
cleanly with no false rejection.

Out of scope, unchanged from the proposed solution: real multi-worker concurrency support (this fix
deliberately keeps that door shut), the narrow edge case where an ORM-transparent mid-run reconnect
could drop the lock tied to the old connection (accepted limitation, not fixed here), and M-17
(retries restart the whole pipeline — separate issue, same file, not touched by this diff).

---

### M-16 · Partially-embedded `failed` bookmarks appear in search results

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/pipeline.py:148-171`, `retrieve/views.py:28`

`embedding()` embeds chunk-by-chunk and accumulates errors. If it dies halfway the bookmark ends up
`failed`, but the chunks it *did* embed stay in the table. `_best_chunks` filters only on
`embedding IS NOT NULL`, never on `processing_status`, so a failed bookmark surfaces in search with a
partial, misleading representation of its content — a video whose first two minutes were transcribed
looks like a full match.

**Proposed solution.** Add `JOIN bookmarks b ON b.id = c.bookmark_id AND b.processing_status = 'complete'`
to the `_best_chunks` CTE (it belongs in the same rewrite as B-13). Then make the failure path clean
up after itself: in `run_pipeline`, when a stage fails terminally, run
`Chunk.objects.filter(bookmark=b).update(embedding=None)` so a later retry re-embeds consistently
rather than mixing vectors from two different runs.

---

### M-24 · No duplicate detection

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `capture/views.py:175-188`, `core/models.py:37`

`Bookmark.url` has no unique constraint and `capture()` does an unconditional
`Bookmark.objects.create`. Live DB has 4 duplicated URLs (`technewsworld.com/story/apples-new-ai-playbook`
appears twice). Each duplicate re-downloads the video, re-runs Whisper, re-runs every tagging call,
and shows up twice in search results. The extension's button also has no idea a post was already
saved, so it always reads "Save".

**Proposed solution.**

1. Normalize on write — strip `utm_*`/`fbclid`/`si` params, drop the fragment, lowercase the host —
   and store it in a new `url_normalized` column with a unique index.
2. In `capture()`, `get_or_create` on `url_normalized`. If it exists and is `complete`, return
   `200 {"status": "already_saved", "bookmark_id": ...}`; if it's `failed`, requeue it as `pending`
   and return `"requeued"`. Backfill and de-duplicate existing rows in the migration, keeping the
   oldest.
3. Have the extension render `already_saved` as a distinct toast ("Already saved · Add note") and
   set the button to its `saved` state.
4. Add `GET /capture/exists/?url=` so the content scripts can render the button in its saved state
   on first paint, which is what makes the feature feel real.

---

### M-74 · Capture accepts payloads that guarantee a useless or failed bookmark

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `capture/views.py:159-191`
*(consolidates discovery #25, #74)*

Verified live against the running backend:

| payload                                                  | result                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| `source_url: ""`                                       | **200 OK**, bookmark created with a blank URL        |
| `platform_specific_data` omitted entirely              | **200 OK**, LinkedIn bookmark with no content at all |
| `platform_specific_data` a string instead of an object | **500** `{"error": "Error creating bookmark"}`     |
| `title` longer than 255 characters                     | **500** `{"error": "Error creating bookmark"}`     |

`Bookmark.title` is `CharField(max_length=255)` and nothing truncates it — `universal.js` passes
`article.title` / `document.title` straight through, so a long-titled page fails to save with an
opaque 500 that the extension then shows as nothing (B-37). The live DB already holds **3 bookmarks
with an empty URL**, which render as clickable results that go nowhere.

**Proposed solution.** Add a validation block before `Bookmark.objects.create`:

```python
url = (mandatory_fields.get("source_url") or "").strip()
if not url or not url.startswith(("http://", "https://")):
    return JsonResponse({"error": "invalid_url",
                         "message": "This page has no saveable link."}, status=400)
if not isinstance(psd, dict):
    return JsonResponse({"error": "invalid_payload"}, status=400)
```

Truncate defensively in the field extractors — `(psd.get("title") or "")[:255] or None` — and do the
same for `author` (`max_length=100`). Reject a payload with no text, image, video, highlight or
screenshot as `400 nothing_to_save` rather than queueing an empty bookmark. Log the real exception
in the `except` block (`logger.exception`) so the opaque 500s are diagnosable. Delete the 3 existing
empty-URL rows in the migration.

---

### M-26 · The LinkedIn permalink chain is fragile end to end

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `extension/content/linkedin.js:257-269, 372-374`, `extension/content/early.js:44-58`, `extension/manifest.json:87-116`
*(consolidates discovery #26, #27, #29, #30)*

Four defects compound into "LinkedIn saves point at the wrong page":

1. **Wrong fallback URL.** When the URN fingerprint match fails, `post_url` falls back to *the first
   anchor containing `/posts/` or `/feed/update/`* anywhere in the post element. On a company-page
   post that is the company's own `…/company/<name>/posts/` link. Live DB has 2 such bookmarks —
   both later failed extraction.
2. **The guard that was supposed to catch this reads a property that doesn't exist.**
   `extractLinkedInPost` returns `{platform_specific_data, mandatory_fields}`, but the check is
   `if (!payload.post_url_resolved)` — always true — and it logs `payload.post_url`, always
   `undefined`.
3. **Mismatched manifest patterns.** `early.js` and `inject.js`'s `web_accessible_resources` entry
   match `https://www.linkedin.com/*`; `linkedin.js` matches `https://*.linkedin.com/*`. On any
   non-`www` LinkedIn host the button renders while the URN interceptor never loads, so every save
   silently takes the bad path above.
4. **The interceptor can lose the race.** `early.js` appends
   `<script src="chrome-extension://…/inject.js">`, which the browser fetches and executes
   asynchronously; `script.async = false` only orders it against other parser-inserted scripts. Whether
   the `fetch`/XHR patch lands before LinkedIn's bundle captures its own reference is timing-dependent
   per page load.

**Proposed solution.**

1. Register `inject.js` as a `"world": "MAIN"` content script at `run_at: "document_start"` in the
   manifest (supported since Chrome 111) and delete `injectPageScript()` from `early.js`. This is the
   only mechanism that actually guarantees ordering, and it removes the `web_accessible_resources`
   entry entirely.
2. Use one match pattern — `https://*.linkedin.com/*` — for `early.js`, `inject.js` and `linkedin.js`.
3. Restrict the DOM fallback to hrefs matching `/feed/update/urn:li:activity:\d+/` and reject
   `/company/` URLs. If nothing matches, **do not save**: show the error toast from B-37 with
   *"Couldn't identify this post — try opening it in its own tab and saving from there"*. A wrong
   bookmark is worse than no bookmark.
4. Fix the guard to read `payload.platform_specific_data.post_url_resolved` and
   `payload.mandatory_fields.source_url`.

---

### M-33 · The context menu silently does nothing on any pre-existing tab

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `extension/background.js:194-209`

```js
chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_WEB", ... });
```

No callback, no `chrome.runtime.lastError` check. If no content script is present in that tab the
message is dropped. That covers **every tab that was already open when the extension was installed** —
i.e. the very first thing a user does after following the README — plus `chrome://`, the PDF viewer,
the Web Store and `file://` pages. The menu item appears, the user clicks it, and nothing happens at
all: no toast, no error, nothing in a console they'd look at.

**Proposed solution.** Add the callback and recover:

```js
chrome.tabs.sendMessage(tab.id, msg, () => {
  if (!chrome.runtime.lastError) return;
  chrome.scripting.executeScript(
    { target: { tabId: tab.id }, files: [...READABILITY_FILES, "content/confirmation.js", "content/universal.js"] },
    () => chrome.runtime.lastError
      ? chrome.notifications.create({ type: "basic", iconUrl: "icons/icon48.png",
          title: "Can't save this page",
          message: "Chrome doesn't allow extensions to read this kind of page." })
      : chrome.tabs.sendMessage(tab.id, msg));
});
```

This needs `"notifications"` added to `permissions`. `scripting` and `activeTab` are already
requested, so the on-demand injection works today.

---

### M-40 · The context menu on YouTube saves the page as `web` and then fails

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `extension/content/universal.js:23-36,59-63`, `extension/background.js:5-12`

`universal.js` matches `<all_urls>`, so it also runs on YouTube/LinkedIn/X, and the context-menu path
always builds `mandatory_fields.platform = "web"` regardless of the site. On a YouTube watch page,
`findEmbeddedVideo()` matches `document.querySelector('video[src]')` and returns a
`blob:https://www.youtube.com/…` URL. The bookmark is stored with `has_video=True` and
`embedded_video_url` set to a blob, `extract_video_web` hands it to yt-dlp, which can't resolve it,
and the bookmark fails three times. The live DB shows this failure class.

**Proposed solution.**

1. Reject unusable video sources in `findEmbeddedVideo()`: `if (src.startsWith('blob:') || src.startsWith('data:')) continue;`
   and only return an `http(s)` URL.
2. Let `universal.js` detect the platform from `location.hostname` using the same map as
   `background.js`, and when it recognises a first-class platform, emit that platform's payload shape
   rather than a `web` one. For YouTube that means `{platform: "youtube", title, author}` — which
   routes to the transcript extractor and actually works. Share one `detectPlatform(url)` helper
   between `universal.js` and `background.js` instead of duplicating the host list.
3. As a backstop, have `_web_fields` in `capture/views.py` ignore non-`http(s)` `embedded_video_url`
   values so a stale extension can't queue an impossible job.

---

### M-34 · Backend host and port are hardcoded in the extension

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `extension/background.js:41,88,113,117`, `extension/popup/popup.js:2`

`http://127.0.0.1:8080` appears in four places and `http://localhost:8081` in the popup, while the
app treats the port as configurable (`Config.server_port`, `BOOKMARK_SERVER_PORT`, the compose port
map). 8080 and 8081 are among the most commonly occupied ports on a developer machine; if the user
has to remap them, the extension breaks with no setting to fix it and no error explaining why. The
extension requests the `storage` permission and never uses it.

**Proposed solution.** Add an options page (`options_ui` in the manifest) with a single "Backend
address" field defaulting to `http://127.0.0.1:8080`, persisted via `chrome.storage.sync`. Replace
the four literals with `await getBackendUrl()`, and derive the app URL for `popup.js` from the same
setting (port + 1, or a second field). Add a "Test connection" button that hits `/health/`. Broaden
`host_permissions` to `http://localhost/*` and `http://127.0.0.1/*` (the former is already there,
the latter is currently pinned to `:8080`).

---

### M-43 · Opening the app at `127.0.0.1:8081` sends the user to Setup every time

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `frontend/src/pages/RootRedirect.jsx:8`, `bookmark/settings.py:185-187`

Every other page fetches relative paths through the Vite proxy; `RootRedirect` alone does
`fetch('http://localhost:8080/setup/status/')` — a real cross-origin request governed by
`CORS_ALLOWED_ORIGINS = ["http://localhost:8081"]`. Verified live:

```
Origin: http://localhost:8081  → access-control-allow-origin: http://localhost:8081
Origin: http://127.0.0.1:8081  → (no header)
```

A user who opens `http://127.0.0.1:8081` gets a blocked fetch, hits the `.catch()`, and is redirected
to `/setup` on every visit even though setup is complete — and `/setup` is a wizard that will happily
try to re-lock their embedding model.

**Proposed solution.** Change the fetch to the relative `'/setup/status/'` like every other page —
that alone fixes it and removes the CORS dependency entirely. Also add `http://127.0.0.1:8081` to
`CORS_ALLOWED_ORIGINS` for anything else that reaches across, and change the `.catch()` to render a
"Can't reach the backend — is it running?" screen with a retry button instead of silently redirecting
to a destructive wizard.

---

### M-53 · Model-pull progress lives in memory and is lost on any restart

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `core/pull_manager.py:6`, `frontend/src/pages/SetupPage.jsx:250-298`

`_pull_status` is a module-level dict and the pull runs in a daemon thread inside the Django process.
Because the backend runs `runserver` with the autoreloader over a bind-mounted source tree (B-12),
any touched file restarts the process, killing the 7.2 GB `gemma4:e2b` download thread and erasing
all progress state. The frontend's `MISSING_LIMIT = 30` then flips the whole check to `error` after
30 seconds with no explanation, and reloading shows `idle` — the user's only option is to restart a
multi-gigabyte download. This is the very first thing a new user does.

**Proposed solution.**

1. Stop inventing progress state. Ollama already tracks what's downloaded: have `pull_status` merge
   the in-memory dict with a live `GET {OLLAMA_BASE_URL}/api/tags` call, so a model that finished
   before the restart reports `done` regardless of process memory. Do the same for Whisper by
   checking for the snapshot directory under the HF cache.
2. Persist in-flight state to a small table (`ModelPull(name, status, percent, updated_at)`) instead
   of a dict, so the frontend can resume after a restart, and so the worker can see it too.
3. Distinguish "no status yet" from "failed". `MISSING_LIMIT` should only fire when the model is
   absent from *both* the status table and `/api/tags`, and the error should say which model and why.
4. B-12 removes the autoreloader, which is what makes this acute.

---

### M-8 · `text-embedding-3-large` breaks setup and leaves the schema half-migrated

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `core/views.py:15-25`, `process/management/commands/reembed.py:44-50`, `core/registry.py:10`

Both `_resize_embedding_column` and `reembed` unconditionally run
`CREATE INDEX … USING hnsw (embedding vector_cosine_ops)`. pgvector's HNSW index supports at most
2000 dimensions, and `text-embedding-3-large` is 3072 — it's in the registry and selectable from the
setup dropdown. The `ALTER` succeeds and the old index has already been dropped, then `CREATE INDEX`
throws and setup returns `500 Failed to size embedding column`, leaving the table unindexed with no
recovery path.

**Proposed solution.** Extract one shared helper used by both call sites, wrapped in a transaction so
a failure rolls back cleanly:

```python
HNSW_MAX_DIMENSIONS = 2000

def ensure_embedding_index(dimension):
    with transaction.atomic(), connection.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS idx_chunks_embedding;")
        cur.execute(f"ALTER TABLE chunks ALTER COLUMN embedding TYPE vector({dimension});")
        if dimension <= HNSW_MAX_DIMENSIONS:
            cur.execute("CREATE INDEX idx_chunks_embedding ON chunks "
                        "USING hnsw (embedding vector_cosine_ops);")
        else:
            logger.warning("dimension %s exceeds HNSW limit; running unindexed", dimension)
```

Better still, drop `text-embedding-3-large` from `EMBEDDING_REGISTRY` — for a personal library it
costs 4× the storage for no measurable recall gain — or use OpenAI's `dimensions=1536` truncation
parameter, which keeps it indexable.

**Fixed.** Resolved together with B-22 (above) via the same shared `core.db.ensure_embedding_index`
helper: it checks `dimension <= HNSW_MAX_DIMENSIONS` (2000) before building the index. Above the cap,
the column still resizes correctly (so setup and `reembed` succeed) but the index build is skipped
with a logged warning — search falls back to a sequential scan for that one model choice instead of
the `500 Failed to size embedding column` this issue described. Both `core/views.py`'s
`setup_embedding` and `process/management/commands/reembed.py` call this helper now, so neither call
site can hit this failure anymore. Kept `text-embedding-3-large` in `EMBEDDING_REGISTRY` rather than
removing it (the doc's alternative suggestion) — the guard makes it safe to select, just unindexed.

---

### M-5 · The OpenAI generation provider fails on every call

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/generation.py:84-91`, `process/ollama_chats.py:19-86`

When `json_schema` is passed, `_chat_openai` sets `response_format={'type':'json_object'}`. The
OpenAI API rejects that request unless the word "json" appears somewhere in the messages, and neither
`generate_tags_for_chunk` nor `generate_hierarchical_tags` mentions it — so every tagging call 400s.
The schema (key names, `minItems`/`maxItems`) is silently discarded.

**Proposed solution.** Use structured outputs properly rather than the legacy JSON mode:

```python
kwargs['response_format'] = {
    'type': 'json_schema',
    'json_schema': {'name': 'response', 'strict': True,
                    'schema': {**json_schema, 'additionalProperties': False}},
}
```

`TAG_LIST_SCHEMA` is already an object with `required`, so it satisfies strict mode as-is. Keep a
fallback to `{'type': 'json_object'}` plus an appended "Respond with JSON." line for models that
don't support `json_schema`. Add a unit test that asserts each provider adapter returns parseable
JSON for `TAG_LIST_SCHEMA` against a mocked client — none of these three adapters has any test.

---

### M-6 · The Anthropic generation provider ignores the schema and always fails parsing

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/generation.py:94-121`, `process/ollama_chats.py:51`

`_chat_anthropic` accepts `json_schema` and never uses it — no tool definition, no prefill, no
instruction. The model returns prose, then `json.loads(content)["tags"]` raises. Every chunk's
tagging fails, and `generate_hierarchical_tags`'s failure propagates out of `tagging()` and fails the
whole bookmark three times.

**Proposed solution.** Use tool-calling, which is Anthropic's structured-output mechanism:

```python
if json_schema is not None:
    kwargs['tools'] = [{'name': 'respond', 'description': 'Return the structured response.',
                        'input_schema': json_schema}]
    kwargs['tool_choice'] = {'type': 'tool', 'name': 'respond'}
response = client.messages.create(model=model, messages=turns, max_tokens=2048, **kwargs)
if json_schema is not None:
    block = next(b for b in response.content if b.type == 'tool_use')
    return json.dumps(block.input)
```

Also drop the `temperature or 1.0` default — 1.0 is a poor default for tag extraction; pass through
`None` and let the API decide, or use the caller's 0.2.

---

### M-7 · Anthropic model IDs in the registry aren't real API identifiers

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `core/registry.py:35-38`

`'claude-haiku-4'` and `'claude-sonnet-4'` are not valid Anthropic API model ids — the API needs
versioned identifiers. Selecting Anthropic 404s on the first request, after setup has reported
everything green (B-50).

**Proposed solution.** Replace with current, valid ids (e.g. `claude-haiku-4-5-20251001` and the
current Sonnet snapshot), and — since this registry is a hand-maintained list of five providers'
model names that will drift — add the `POST /setup/verify/` check from B-50, which catches a bad id
at setup time instead of at first capture. Note the same class of drift applies to the OpenAI and
Google lists.

---

### M-56 · `install.sh` tells the user to load a directory that doesn't exist

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `install.sh:114`

```
echo -e "  3. Click 'Load unpacked' → select ${BOLD}extension/dist/${RESET}"
```

Verified on a fresh `git clone`: there is no `extension/dist`. The README correctly says `extension/`.
A Linux user following the installer's own closing instructions cannot load the extension — and the
installer is the *only* thing the Linux README tells them to run.

**Proposed solution.** Change the line to `extension/` and print the absolute path
(`${REPO_ROOT}/extension`) so it can be pasted into Chrome's file picker. Since the README and the
installer have now drifted twice (this and m-62), have `install.sh` echo a pointer to the README's
"Load the browser extension" section rather than restating the steps.

---

### M-57 · `install.sh` hangs forever if anything fails to come up

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `install.sh:82-93`

Both readiness loops (`until docker inspect …` and `until curl … localhost:8081`) have no timeout and
no retry cap. If `npm install` fails in the frontend image, or port 8081 is already bound, or the
backend crash-loops, the installer prints `Almost ready… ⠋` indefinitely with no diagnosis and no
exit. There is no failure mode in which this script tells the user something is wrong.

**Proposed solution.** Bound both loops and diagnose on timeout:

```bash
deadline=$((SECONDS + 300))
until curl -sf -o /dev/null http://localhost:8081; do
  if (( SECONDS > deadline )); then
    echo; error "Services didn't come up within 5 minutes.
  Check:  docker compose ps
  Logs:   docker compose logs --tail 50 frontend backend
  If a port is in use, edit the ports: section of docker-compose.yml."
  fi
  ...
done
```

Add a pre-flight port check before `docker compose up` (`ss -ltn` / `lsof -i`) for 8080, 8081, 5432
and 8082, and fail early with a clear message — port conflicts are by far the most likely cause.

---

### M-58 · GPU enablement assumes the NVIDIA Container Toolkit, and aborts the install when it's absent

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `install.sh:66-75`, `docker-compose.gpu.yml`

The check is `command -v nvidia-smi && nvidia-smi`, which only proves a **host driver** is present.
`docker-compose.gpu.yml` needs `nvidia-container-toolkit` configured on the Docker daemon. On a
machine with the driver but no toolkit — extremely common — `docker compose up` fails with
`could not select device driver "nvidia" with capabilities: [[gpu]]`, and because the script runs
under `set -euo pipefail` it aborts on that raw Docker error with no explanation and no CPU fallback.
There is no ROCm/AMD path and no Apple Silicon path.

**Proposed solution.** Test the thing you actually depend on, and fall back instead of aborting:

```bash
gpu_works() {
  docker run --rm --gpus all ubuntu:22.04 nvidia-smi &>/dev/null
}
COMPOSE_FILES="-f docker-compose.yml"
if gpu_works; then
  info "NVIDIA GPU + container toolkit detected — enabling GPU acceleration"
  COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.gpu.yml"
elif command -v nvidia-smi &>/dev/null; then
  warn "NVIDIA GPU found but the container toolkit isn't configured — running on CPU."
  warn "To enable GPU: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
fi
if ! docker compose $COMPOSE_FILES up -d --build; then
  [[ $COMPOSE_FILES == *gpu* ]] && { warn "GPU startup failed — retrying on CPU"; docker compose -f docker-compose.yml up -d --build; }
fi
```

For Apple Silicon, document that Docker Desktop cannot pass through the GPU and point Mac users at a
native `brew install ollama` + `OLLAMA_BASE_URL=http://host.docker.internal:11434` variant — that is
the difference between usable and unusable on a Mac.

---

### M-59 · No hardware, disk, RAM or timing expectations are documented

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `README.md`

The default configuration pulls `gemma4:e2b` (7.2 GB), `nomic-embed-text-v2-moe` (~1 GB), a Whisper
model, plus the Postgres/Ollama/Node images — roughly 12–15 GB. On Mac and Windows the README path is
a bare `docker compose up -d --build` with no GPU compose file, so Ollama always runs on CPU inside
the Docker VM, where a 5.1B-parameter model doing per-chunk tagging plus Whisper transcription is
extremely slow. None of this appears anywhere: no disk requirement, no RAM requirement, no "this will
be slow without a GPU", no indication that a 20-minute YouTube video might take a long time to index.
The README's only timing statement is "Give it a minute after saving something."

**Proposed solution.** Add a "Before you start" section: ~20 GB free disk, 16 GB RAM recommended /
8 GB minimum, and an explicit note that without an NVIDIA GPU processing runs on CPU and a long video
can take many minutes. Offer a smaller default profile (`llama3.2:3b` + `whisper-tiny`) for
CPU-only machines and have the setup wizard recommend it when `_detect_gpu()` returns `None` — that
data is already collected in `core/metrics.py`. Replace "Give it a minute" with something honest, and
give the user a way to see progress (M-39).

---

### M-64 · The test suite does not pass

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `process/tests.py`

```
$ docker exec bookmark-backend python manage.py test
Ran 26 tests in 0.029s
FAILED (failures=4, errors=7)
```

All 11 share one root cause: the tests subclass `SimpleTestCase`, but the code under test
(`chunk_*`, `extract_image`, `extract_screenshot`) hits the database, which `SimpleTestCase` forbids.
`capture/tests.py`, `core/tests.py` and `retrieve/tests.py` are empty stubs. There are no tests for
search, the worker loop, the API surface, the provider adapters, or the extension. With the suite
red, nobody can distinguish a new regression from the existing noise — which is how most of the
issues in this report survived.

**Proposed solution.** Change `SimpleTestCase` → `TestCase` in the affected classes (the fixtures
already use `SimpleNamespace` bookmarks, so the DB-touching ones need real `Bookmark.objects.create`
rows). Then add the coverage that would have caught the blockers:

- `retrieve`: a search over a seeded library asserting `LIMIT` is honoured, that a nonsense query
  returns zero results, and that `failed` bookmarks are excluded.
- `process`: a `run_pipeline` test asserting a bookmark never reaches `complete` with unembedded
  chunks, and that a retry resumes at `failed_at`.
- `capture`: the four payload cases from M-74 as parametrized API tests.
- `generation`: each provider adapter returns parseable JSON for `TAG_LIST_SCHEMA` against a mock.
  Wire it into CI (`.github/workflows/test.yml`) with a `pgvector/pgvector:pg16` service so red stays
  visible.

---

### M-66 · The search-feedback loop is write-only

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `retrieve/views.py:133-135`, `evaluate/models.py:62-82`, `evaluate/views.py:241-274`

`search()` creates a `SearchFeedback` row with only `query_text` and `shown_bookmark_id`. Nothing in
the codebase ever sets `feedback`, `clicked_bookmark` or `clicked_rank` — there is no endpoint and no
UI control. Verified live after 6 searches: `total=6, with_feedback=0, with_click=0`. So the "Live
feedback queue" (described as *'Real searches marked "not what I expected"'*) is permanently empty,
`yes_pct`/`no_pct` are permanently `0%`, and `feedback_promote` is unreachable because
`feedback_list` only returns rows where `feedback='no'`. Given B-47, feedback on retrieval quality is
exactly the signal this project most needs, and the plumbing is 80% built.

**Proposed solution.** Close the loop:

1. Return the `SearchFeedback` row id in the search response.
2. Add `POST /retrieve/feedback/<pk>/` accepting `{feedback: 'yes'|'no', clicked_bookmark_id?, clicked_rank?}`.
3. In `SearchPage`, fire `clicked_bookmark_id` + `clicked_rank` from `ResultCard`'s open handler, and
   add a one-line "Did you find it?  👍 👎" row under the results header that posts `feedback`.
4. Only create the row once per settled query, not per request (see m-67).

---

### M-10 · The worker runs under Django's autoreloader in the shipped container

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `process/management/commands/run_worker.py:14`, `docker-compose.yml:101,110-114`

`autoreload.run_with_reloader(self.run_worker_loop)` is a development facility, and compose
bind-mounts the whole repo (`.:/app`). Any touched Python file restarts the worker — mid-pipeline,
mid-download, mid-transcription. In-flight bookmarks are abandoned in `processing` until the next
boot resets them, and partially-downloaded media is orphaned (M-19).

**Proposed solution.** Call `self.run_worker_loop()` directly and gate the reloader behind an env
flag used only by the dev overlay:

```python
if os.environ.get('WORKER_AUTORELOAD') == '1':
    autoreload.run_with_reloader(self.run_worker_loop)
else:
    self.run_worker_loop()
```

Add graceful shutdown — a `SIGTERM` handler that sets a `stop` flag checked at the top of the loop
and finishes the current bookmark — so `docker compose restart` stops leaving `processing` orphans.
Removing the bind mount (B-12) is the other half of this.

---

### M-42 · Large screenshots silently exceed the upload limit

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `extension/background.js:197`, `extension/content/universal.js:71`, `bookmark/settings.py:197`

`chrome.tabs.captureVisibleTab({format:'jpeg', quality:80})` on a large or high-DPI display produces a
data URI that, base64-encoded alongside the full article text, can exceed
`DATA_UPLOAD_MAX_MEMORY_SIZE = 10MB`. Django returns a `RequestDataTooBig` page (HTML, because DEBUG
is on), `response.json()` throws inside `postJSON`, and the extension reports `FETCH_ERROR` — which
per B-37 shows nothing at all. The user saves an article on a 4K monitor and it just doesn't appear.

**Proposed solution.** Downscale before sending. In `universal.js`, draw the captured data URI onto an
`OffscreenCanvas` capped at 1600 px wide and re-encode at `quality 0.7` — that reliably lands under
1 MB and loses nothing a VLM needs. Also cap `text_content` at ~200 000 characters (the chunker
already windows it, and no article is legitimately longer). Keep the 10 MB server limit as a
backstop, but return a JSON `413 {"error": "payload_too_large"}` via the exception handler from B-14
so the extension can say something useful.

---

### M-72 · The entrypoint swallows a fatal extension failure

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `docker/entrypoint.sh:6-16`

```python
for ext in ['pgcrypto', 'vector']:
    try:
        ...CREATE EXTENSION IF NOT EXISTS {ext};
    except Exception:
        pass
print('[bookmark] Extensions ready.')
```

If the `vector` extension can't be created, the script prints "Extensions ready", migrations then
fail or the column ends up wrong, and the user meets a confusing pgvector error much later with no
connection to the cause. The entrypoint also runs `migrate` on *every* container start, including
one-off `docker exec` style runs (verified: `manage.py check` in a fresh container ran migrations
first), which combined with the autoreloader means migrations run far more often than intended.

**Proposed solution.** Let the `vector` failure be fatal — it genuinely is:

```bash
python manage.py shell -c "
from django.db import connection
with connection.cursor() as cur:
    cur.execute('CREATE EXTENSION IF NOT EXISTS pgcrypto;')
    cur.execute('CREATE EXTENSION IF NOT EXISTS vector;')
" || { echo '[bookmark] FATAL: could not enable the pgvector extension. Is the db image pgvector/pgvector:pg16?' >&2; exit 1; }
```

Keep `pgcrypto` tolerant (it's optional). Gate the migration step on the command actually being a
long-running server (`case "$1$2" in *runserver*|*gunicorn*|*run_worker*) migrate ;; esac`) so
one-off commands don't re-migrate, and let only the `backend` service migrate — the worker should
wait on the backend's healthcheck, which it already does.

---

### M-79 · Unbounded container logs

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `process/management/commands/run_worker.py:30`, `docker-compose.yml`

The worker prints `Checking for pending bookmarks...` every 5 seconds forever (confirmed in
`docker logs bookmark-worker`) and the backend logs a `GET /health/` line every 10 seconds from the
compose healthcheck. No service declares a `logging:` block, so Docker's `json-file` driver keeps
everything with no `max-size`. For a product whose premise is "leave it running on your own
computer", that is a permanent, silent disk leak — roughly 17 000 lines/day from the idle worker
alone.

**Proposed solution.** Drop the idle print to `logger.debug` (or emit only on state change), silence
the healthcheck line by pointing the compose healthcheck at a path excluded from access logging (or
by moving to gunicorn, which lets you filter it), and add to every service:

```yaml
logging:
  driver: json-file
  options: { max-size: "10m", max-file: "3" }
```

---

### M-65 · `requirements.txt` is an unfiltered freeze with unpinned provider SDKs

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `requirements.txt`

Eleven packages are imported nowhere in the project (verified by grep): `langchain-core`,
`langchain-protocol`, `langsmith`, `typer`, `rich`, `jsonpatch`, `xxhash`, `uuid_utils`, `tenacity`,
`orjson`, `defusedxml`. Meanwhile the packages that matter most are the *unpinned* ones —
`anthropic`, `openai`, `google-genai`, `keyring`, `psutil`, `faster-whisper>=1.1.1`,
`yt-dlp>=2025.1.1`. `docker compose up --build` reinstalls from this file, so a breaking release of
any provider SDK silently changes what a user gets, and two people building on different days get
different stacks. That is the wrong way round: the unused packages are pinned and the load-bearing
ones float.

**Proposed solution.** Split into `requirements.in` (direct dependencies, with intentional bounds)
compiled to a fully-pinned, hash-locked `requirements.txt` via `pip-compile`. Pin the provider SDKs
to compatible-release ranges (`anthropic~=0.40`, `openai~=1.60`, `google-genai~=1.0`). Keep
`yt-dlp` deliberately loose — it *must* float to keep working against YouTube — but pin it in the
lockfile and refresh it on a schedule rather than at every user's build. Drop the eleven unused
packages; `langchain-core` alone pulls a large transitive tree into the image.

---

### M-75 · Only the first image of a multi-image post is ever processed

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `process/image_description.py:35-40, 50-71`

```python
'twitter':  lambda psd: (psd.get('images') or [None])[0],
'linkedin': lambda psd: (psd.get('images') or [None])[0],
```

The content scripts collect *every* image URL, and `capture/views.py` sets `has_image` from
`len(images) > 0`, but extraction only ever describes `images[0]`. A LinkedIn carousel or a
four-image tweet contributes exactly one image description to the index; the rest is captured, stored
in `platform_metadata`, and ignored. For image-heavy platforms the VLM description *is* the searchable
content, so this is lost recall, not lost polish.

**Proposed solution.** Change the resolvers to return a list, cap it (say 4 images per bookmark to
bound VLM cost), and have `extract_image` loop — writing `raw_text["image"]` as a list of
descriptions. `chunk_image` then creates one `IMAGE` chunk per description with an incrementing
`chunk_index` instead of the current hardcoded `0`, which is exactly the shape `chunk_video_youtube`
already uses. `raw_text_payload` already tolerates arbitrary values per key.

---

### M-76 · Pinterest pins are described from the grid thumbnail

**Type:** CODE PROBLEM   **Severity:** MAJOR
**Location:** `extension/content/pinterest.js:38-56`, `process/image_description.py:36`

`extractPin` reads `img.src` from the feed grid, which on Pinterest is a lazy-loaded ~236 px
thumbnail. It also captures `image_srcset` — containing the higher-resolution candidates — but
`IMAGE_URL_RESOLVERS['pinterest']` only reads `image_url`, so `image_srcset` is stored and never used.
Every pin is therefore described by the VLM from a thumbnail, and since pins have no other text, that
description is the entire searchable content of the bookmark.

**Proposed solution.** Parse `srcset` in `extractPin` and pick the largest candidate as `image_url`,
keeping the original as `image_url_thumb`. Pinterest's CDN paths are also predictable
(`/236x/` → `/originals/`), so add that as a second-chance rewrite in `download_image` with a
fallback to the srcset pick if the rewritten URL 404s.

---

### M-3 · Bookmarks stay permanently failed after the bug that broke them is fixed

**Type:** DESIGN DECISION ISSUE   **Severity:** MAJOR
**Location:** `process/pipeline.py:174-227`, `core/views.py:281-302`

The live DB contains `https://b2.example.com/article` failed with
`"video: no chunker registered for platform 'web'"` — a bug that **has since been fixed**
(`chunk_video_web` was added in commit `efe7ae8`). The record is still `failed`, still shows the
stale error, and will never be retried. `pipeline_retry` exists but is gated behind `dev_mode` and
returns 403 otherwise, so an ordinary user has no way to recover anything, ever. Every bug fixed in
the pipeline leaves a permanent tail of dead bookmarks in every existing install.

**Proposed solution.** Ungate retry: expose `POST /retrieve/bookmarks/<pk>/retry/` (not dev-gated)
and surface failures in the main Search UI (see M-39) with a "Try again" button. Add a
`manage.py retry_failed [--stage extraction] [--older-than …]` command and call it once from any
migration that fixes a pipeline bug, so existing installs self-heal on upgrade — the same pattern
recommended for B-23. Record a `pipeline_version` integer on `Bookmark` so a retry sweep can target
"everything that failed under a version older than N".

---

# MINOR

Correctness and polish issues that don't block launch but each cost a user or a maintainer time.

---

### m-15 · `fallback_triggered` is hardcoded `False`

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `retrieve/views.py:131`, `frontend/src/design-system/composites/FallbackBanner.jsx`
The search response sets `p["fallback_triggered"] = False` unconditionally and returns no fallback
signal to the client, yet a `FallbackBanner` component exists for exactly this state — the frontend
currently infers it from client-side banding instead.
**Fix:** when B-13/B-47 move banding server-side, set the metric from the real outcome
(`p["fallback_triggered"] = (band == "broad")`) and return `band` in the payload so the metrics DB
and the UI agree on what happened.

### m-20 · `set_dev_mode` accepts any method and reads only form-encoded data

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `core/views.py:204-208`
`enabled = request.POST.get('enabled') == 'true'` with no method check: `GET /setup/set-dev-mode/`
silently sets `dev_mode=False`, and a JSON body — what a `fetch` naturally sends — is invisible and
also silently disables it. Either way it responds `{"dev_mode": false}` as if that were the request.
**Fix:** require POST (405 otherwise), parse `json.loads(request.body)`, 400 on a missing or
non-boolean `enabled`, and return the value actually read back from the DB.

### m-28 · `source_url` is assigned to an implicit global in `linkedin.js`

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/content/linkedin.js:279`
`source_url = post_url;` — no `const`/`let`, so it creates a global on the isolated world shared with
`universal.js` and `confirmation.js`. If `extractLinkedInPost` throws before reassignment, a stale
value from a previous post survives.
**Fix:** `const source_url = post_url;`. Wrap the whole content script in an IIFE (as
`confirmation.js` already does) and add `'use strict'` so the next one of these is a `ReferenceError`
instead of a silent global.

### m-31 · Stale in-code note claims the manifest isn't wired

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/content/early.js:23-28`, `extension/content.js`
`* REQUIRED manifest.json wiring (you don't have this yet, see chat reply):` is a leftover authoring
note referring to a conversation. The wiring exists. It also describes `content.js` as "the existing
button/DOM logic", which is no longer true — that logic is in `content/linkedin.js`, and root
`extension/content.js` is a 37-byte `console.log` stub not referenced by the manifest at all.
**Fix:** rewrite the header to describe what the file does now, and delete `extension/content.js`.

### m-32 · Context-menu labels don't match the README

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/background.js:186-192`, `README.md` ("How to Use It")
The README tells users to choose **"Save to Internet Expedition"**, and for selected text **"Save
highlight to Internet Expedition"**. The code registers exactly one item titled **"Save to Bookmark"**
with `contexts: ["page","selection"]`. Users look for menu entries that don't exist, under a product
name that was clearly renamed without updating the extension.
**Fix:** register two items matching the README — `contexts: ["page"]` titled "Save to Internet
Expedition" and `contexts: ["selection"]` titled "Save highlight to Internet Expedition" — and pass
`info.selectionText` only for the second. Sweep the remaining "Bookmark" strings in
`bmSetState`'s aria labels while you're there.

### m-35 · `handleTwitter` is unreachable code documenting an unbuilt feature

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `extension/background.js:60-67, 91-114, 153-180`
The Twitter branch routes to `handleGeneric` with a comment explaining that `handleTwitter` "is
intentionally NOT used yet" because the backend only parses JSON, and that it also reads the wrong
payload path. ~50 lines of unreachable code (`handleTwitter`, `postFormData`, `downloadMedia`) ship
with the extension.
**Fix:** delete all three functions and the switch branch, and move the note to an issue. The backend
already downloads Twitter images server-side via `requests`, so the multipart path isn't needed.

### m-36 · A stray log file ships inside the extension folder

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/hp-check.log`
The README instructs users to "Load unpacked" `extension/`, so this checked-in log is packaged with
the extension.
**Fix:** `git rm extension/hp-check.log` and add `*.log` (already present in `.gitignore` — it was
committed before the rule).

### m-41 · `findLeadImage` measures images in a detached document

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/content/universal.js:13-21`, called from line 49-50
When Readability succeeds, `imageSearchRoot` is the `<body>` of a `DOMParser` document. Images in a
detached, never-rendered document always report `naturalWidth === naturalHeight === 0`, so the
`reduce` comparing areas is always `0 >= 0` and returns the first image. The comment "see open
question #3" is an unresolved authoring note in shipping code.
**Fix:** rank by the `width`/`height` **attributes** and the URL's own size hints, which survive
serialization, or resolve each candidate against the live document via
`document.querySelector(\`img[src="${src}"]\`)`before measuring. In practice`og:image`wins first almost always, so simplest is to drop the largest-image branch and return`null`.

### m-44 · `/pipeline/` with a trailing slash serves a Django 404

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `frontend/vite.config.js:11`, `frontend/src/App.jsx:16`
The Vite proxy forwards the whole `/pipeline/` prefix to Django, but the React route is `/pipeline`.
Verified live: `GET localhost:8081/pipeline` → 200 (React), `GET localhost:8081/pipeline/` → 404
Django HTML. The `^/setup/(?!$)` pattern shows this collision was already hit once for `/setup`.
**Fix:** namespace the API. Mount every backend route under `/api/` in `bookmark/urls.py`, proxy the
single `/api` prefix, and delete the regex gymnastics. Serving the built frontend from nginx (B-12)
removes the Vite proxy from production entirely.

### m-45 · No catch-all route — unknown paths render a blank page

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `frontend/src/App.jsx:12-18`
`<Routes>` declares five paths and no `path="*"`. Any typo or stale link renders an empty white
document with no way back.
**Fix:** add `<Route path="*" element={<Navigate to="/" replace />} />`.

### m-46 · Backend-unreachable is reported as "dev mode is off"

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `frontend/src/hooks/useDevModeGuard.js:11`
`.catch(() => setStatus('denied'))` collapses "the backend is down" into "dev mode is disabled", so
the Pipeline and Retrieval Quality pages tell the user to enable a setting that is already enabled.
**Fix:** add a third state — `'unreachable'` — and render "Can't reach the backend" with a retry
button, matching the fix for M-43.

### m-49 · A hardcoded "DEV" badge ships to every user

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `frontend/src/pages/SearchPage.jsx:287`
`<Badge tone="warning" size="xs" className="ml-1.5 uppercase">dev</Badge>` — not conditional on
anything. The main search screen permanently reads "Internet Expedition / Search [DEV]". (The
Pipeline page's badge at `PipelinePage.jsx:214` is legitimate — that page *is* dev-gated.)
**Fix:** delete it, or wrap it in `{devMode && …}` — `SearchPage` already fetches `dev_mode` into
`showPipeline`.

### m-52 · `alert()` is the error surface for the setup wizard

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `frontend/src/pages/SetupPage.jsx:394, 398`
The final, irreversible step of the product (`embedding_locked` is permanent) reports failure through
a raw browser `alert()` containing the backend's exception text — e.g. the `NoKeyringError` string
from B-4. Every other error in the app uses the `Callout` component.
**Fix:** add a `setupError` state, render it in a `Callout tone="error"` above the Complete button,
and map known error codes to plain language. Keep the raw text behind a "Details" disclosure.

### m-60 · Windows and Mac users never get GPU acceleration

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `README.md` (Windows Step 5 / Mac Step 4), `install.sh:66-73`
Only the Linux `install.sh` path composes in `docker-compose.gpu.yml`. The Windows instructions are a
bare `docker compose up -d --build`, so a Windows machine with an NVIDIA GPU and WSL2 passthrough
available silently runs on CPU with no note that a flag exists.
**Fix:** document `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build` as
the Windows GPU variant with a one-line prerequisite check, and fold this into the M-59 hardware
section.

### m-61 · No `.env.example`, and two conflicting env-var naming schemes

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `bookmark/settings.py:27-28, 98-102`, `docker-compose.yml`, `.env` (gitignored)
Verified on a fresh clone: no `.env`, no `.env.example`, no mention of environment configuration in
the README. `settings.py` reads every value under two names — `DJANGO_SECRET_KEY`/`SECRET_KEY`,
`DJANGO_DEBUG`/`DEBUG`, `DB_NAME`/`NAME`, `DB_PASSWORD`/`PASSWORD` — while compose sets only the
`DJANGO_*`/`DB_*` forms and the local `.env` sets only the bare ones. The developer's `.env` therefore
has no effect under Docker (compose's `change-this-in-production` default wins). Django does boot
without `.env` (verified), so this is discoverability rather than a crash.
**Fix:** pick one scheme (`DJANGO_*` / `DB_*`), delete the fallbacks, commit a documented
`.env.example`, and have compose read it via `env_file:`. Generate a real `DJANGO_SECRET_KEY` in
`install.sh` on first run and write it to `.env` rather than shipping a default that says
"change-this-in-production" and never gets changed.

### m-62 · `bookmark-cli` describes behaviour that doesn't happen

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `bookmark-cli:39-40`
`"First run: Ollama is pulling models in the background. … Run 'bookmark logs ollama' to watch progress."` Nothing pulls models at container start — they're pulled from the setup wizard via
`/setup/pull-models/`. A user who runs `bookmark start` and checks the logs sees nothing.
**Fix:** replace with "Open http://localhost:8081 and complete setup to download the AI models."

### m-63 · `.gitignore` line 1 is a corrupted paste of scraped content

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `.gitignore:1`

```
Reason 2: Roku Gains Content Strength__pycache__
```

A scraped headline was pasted over the first rule, so that line matches nothing; `__pycache__` is
only ignored thanks to a duplicate rule further down. Separately, `.design-sync/` is listed in
`.gitignore` but is already tracked, so it ships to every user in a fresh clone (verified).
**Fix:** repair line 1, de-duplicate the rules, and `git rm -r --cached .design-sync ds-bundle .ds-sync` so the ignore rules take effect. Also drop `frontend/README.md` from `.gitignore` — ignoring
a README is almost certainly unintended.

### m-67 · `SearchFeedback` rows are written on every debounced keystroke

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `retrieve/views.py:133-135`, `frontend/src/pages/SearchPage.jsx:159`
With dev mode on, every `/retrieve/search/` call inserts a row. The 500 ms debounce still fires
mid-typing, so one query writes several partial rows ("doc", "docker st", "docker stuff") — and those
become the `total_searches` denominator for the yes/no percentages on the Retrieval Quality page.
**Fix:** don't log from the search endpoint. Log from the explicit feedback endpoint added in M-66,
which by construction only fires for a settled query. Failing that, dedupe on
`(query_text, searched_at within 30s)` and drop rows that are a strict prefix of a later one.

### m-68 · No way to trigger an eval run from the UI

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `frontend/src/pages/RetrievalQualityPage.jsx`, `evaluate/urls.py`
The page fetches `/evaluate/runs/`, golden-set status and feedback, but there is no "Run eval"
control and no endpoint to start one. The only way to produce an `EvalRun` is
`docker exec bookmark-backend python manage.py run_golden_eval`, documented nowhere. The page shows
an empty runs table forever (verified: `/evaluate/runs/` → `{"runs": []}`). Given B-47, this harness
is the tool most needed and it's unreachable.
**Fix:** add `POST /evaluate/runs/` that starts the eval in a background thread (same pattern as
`pull_manager`) and returns a run id, plus a "Run evaluation" button and progress row in
`EvalRunsSection`. Refactor `run_golden_eval.handle` into a callable so the command and the endpoint
share one implementation.

### m-69 · `run_golden_eval` records provenance that contradicts what ran

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `evaluate/management/commands/run_golden_eval.py:46-48`
`prefix_enabled=False` is hardcoded, but `embed_texts` *does* apply the nomic
`search_query:`/`search_document:` prefixes for the default model. `chunk_size=None` is recorded even
though `CHUNK_TARGET_WORDS` sits in the same module as the `CHUNK_OVERLAP_WORDS` that *is* recorded.
The whole point of the harness is attributing score changes to config changes.
**Fix:** import `CHUNK_TARGET_WORDS` and pass it; derive `prefix_enabled` from
`EMBEDDING_MODEL_FAMILY.get(config.embedding_model_name) in FAMILY_PREFIXES`. Add the distance
thresholds from B-47 to `EvalRun` too, since those are about to become tunable.

### m-70 · `reembed` — the documented recovery path — is undocumented and mis-quoted

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `core/views.py:83-89`, `process/management/commands/reembed.py`, `README.md`
When the embedding model is locked, `setup_embedding` tells the user to
`Run 'python manage.py reembed --provider <provider> --model <model>'`. They're running everything in
Docker, so the real command is `docker exec bookmark-backend python manage.py reembed …`. `reembed`
appears nowhere in the README and has no UI entry point, so "I picked the wrong embedding model" —
the exact situation B-50 creates — is effectively unrecoverable for a non-technical user.
**Fix:** correct the message to the `docker exec` form, document it in a README "Troubleshooting"
section, and add a "Change embedding model (re-indexes everything)" action behind a confirm dialog on
the Setup page that calls a new `POST /setup/reembed/` running the same code path in a background
thread with progress reported through `pull-status`-style polling.

### m-71 · `_UPLOAD_CACHE` makes golden-set upload/confirm a restart-fragile handshake

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `evaluate/views.py:19, 187, 213`
The validated upload is stashed in a module-level dict between `/golden-set/upload/` and
`/golden-set/confirm/`. Any backend restart between the two loses it and `confirm` returns
`400 No validated golden set to confirm`. Worse, `golden_set_confirm` runs
`GoldenSetEntry.objects.all().delete()` before inserting, so confirming against a stale or partial
cache silently destroys the previous golden set.
**Fix:** the client already receives `preview_entries`; have `/upload/` return the **full** validated
list and require `/confirm/` to post it back, deleting the module-level cache entirely. Wrap
delete+insert in the `transaction.atomic()` that's already there (it is) and refuse to confirm an
empty list. Consider versioning golden sets instead of destroying the previous one.

### m-77 · `content_type` is sent by every content script and read by nothing

**Type:** CODE PROBLEM   **Severity:** MINOR
**Location:** `extension/content/twitter.js:92`, `pinterest.js:45-49`, `linkedin.js:272-277`, `youtube.js:109`, `capture/views.py`
Every extractor builds a `content_type` object in `mandatory_fields` and `capture()` never reads it —
modality flags are derived independently from `platform_specific_data`. Twitter and Pinterest
hardcode `{image: true, video: false, text: true}` regardless of the actual post. It's dead payload
that reads like a contract, and `_write_capture_log` even has a `content_type` column it always
writes `None` into.
**Fix:** delete `content_type` from all four content scripts and drop the unused column from
`capture_log`.

### m-78 · `bmSetState` is copy-pasted into four content scripts

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `extension/content/linkedin.js:10-32`, `youtube.js:5-27`, `twitter.js:17-39`, `pinterest.js:9-31`
The same 23-line function is duplicated four times as a top-level `function` declaration in the
shared isolated world. The copies currently agree, but nothing enforces it — and the error-state
behaviour that B-37 requires has to be changed in four places.
**Fix:** move it into a `content/shared.js` listed first in each platform's `js` array (content
scripts in one entry share a scope), exposing `window.bmSetState`. Same treatment for the duplicated
save-button SVG markup.

### m-80 · Django admin is routed but unusable

**Type:** DESIGN DECISION ISSUE   **Severity:** MINOR
**Location:** `bookmark/urls.py:21`, `core/admin.py`, `capture/admin.py`, `process/admin.py`, `retrieve/admin.py`
`path('admin/', admin.site.urls)` is exposed and `/admin/` is in the middleware exempt list, but
nothing ever creates a superuser and the README never mentions it — the route serves a login page
nobody can pass. All four `admin.py` files register nothing, so even with a superuser it would show
no models. It's attack surface with no function.
**Fix:** either remove the route from `urls.py` and drop `django.contrib.admin` from
`INSTALLED_APPS`, or commit to it — register `Bookmark`, `Chunk`, `Tag` and `Config` with useful
`list_display`/`search_fields`, and have `entrypoint.sh` create a superuser from
`DJANGO_SUPERUSER_*` env vars. Removing it is the better fit for a single-user local app.

---

# If I could only fix 5 things before calling this v1

Chosen for what stops a first-time user from succeeding, drawn only from BLOCKER/MAJOR.

**1. Make search actually find things — B-22 + B-23 + B-13, then recalibrate B-47.**
Restore the vector index, requeue the `complete`-but-unembedded bookmarks (1806 chunks are dead
weight in the live DB right now), add `LIMIT` + a server-side distance cutoff, then set the
thresholds against a measured golden set rather than a guess. Everything else in this product is in
service of one sentence — "find it again just by describing what you remember" — and today a query
for `docker` returns nothing while a query for gibberish returns the entire library. Nothing else on
this list matters if this stays broken.

**2. Tell the user when something fails — B-37, plus the visible half of B-9 and M-3.**
Add the error panel to the toast, wire it to all four save paths, replace the fake "Worker running"
indicator with a real heartbeat, and surface failed bookmarks with a retry button outside dev mode.
Right now the most likely failure in the world — Docker isn't running — produces *no feedback
whatsoever*, and ~16% of the live library failed processing without the user ever being told.

**3. Stop the worker from dying silently, and stop retries from being ruinous — B-9 + M-17 + M-11.**
Move the `try/except` inside the loop so one bad bookmark can't end the queue forever, make the
claim a conditional atomic `UPDATE` instead of a `select_for_update` that does nothing, and resume
retries from `failed_at` instead of re-downloading a 232 MB video three times. These are small, local
changes to one file and one function, and they turn the processing pipeline from fragile into boring.

**4. Ship a production stack and close the drive-by wipe — B-12 + B-21.**
`runserver` + `npm run dev` + `DEBUG=True` means every error hands out a stack trace with settings and
locals, to content scripts running on linkedin.com. And `dev_wipe` deletes the entire database on an
unauthenticated **GET**, on a port bound to `0.0.0.0`. Gunicorn, an nginx-served frontend,
`DEBUG=False` by default, `127.0.0.1` port bindings, and a method check on `dev_wipe` — the last of
which is three lines.

**5. Make setup unable to lock in a broken configuration — B-50 + B-4.**
Delete the no-op `scheduleCheck()` and invalidate the readiness check when the model changes; add the
`/setup/verify/` round-trip that actually embeds a string and runs a completion before letting the
user press the button that permanently locks `embedding_locked`. Fix the secret store so the cloud
providers the wizard offers can be configured at all in Docker (and with them M-5/M-6/M-7, or remove
those providers from the registry until they work). The first five minutes decide whether anyone gets
to minute six, and today the wizard can end in a state where every future capture fails with an error
that points nowhere.
