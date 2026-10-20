# AGENTS.md

Internet Expedition **SaaS backend**: a single Django app that ingests saved web
content (text, images, video, audio, screenshots), processes it with **Gemini**,
and stores the generated context + embeddings for later search.

## What exists here, and what doesn't
- Tree = `bookmark/` (Django project: settings, urls) + `core/` (models, API, Gemini provider, embedding builder, search, tests, migrations).
- **There is no frontend in this tree.** The v1 web UI, browser extension, docker files, and install scripts were removed from this branch.
- **v1 is the `main` branch** — the remote default — and the local `v1-reference` branch points at the same commit. A fresh clone of this repo lands on v1, not the SaaS code.
- v1 files (`capture/`, `process/`, `evaluate/`, `retrieve/`, `extension/`, ...) **do not exist in this tree** — don't assume they do, don't resurrect them. To read v1: `git show v1-reference:process/pipeline.py`.
- **`README.md` and `assets/` are stale v1 docs** (docker setup, browser extension, port 8081, "nothing leaves your computer"). Trust the code, not the README.
- No CI, Dockerfile, or deploy config in the tree.

## Running it
- Python 3.11 venv at `venv/` (built from `requirements.txt`); run everything as `venv/bin/python`.
- `.env` (gitignored) is required: `GEMINI_API_KEY` has **no default** — settings crash without it. DB settings default to `postgres`/`postgres` @ `localhost:5432`, database `bookmark`; the `.env` in this checkout points at a Supabase project via `DB_*` vars. Settings read real environment vars *first* (`read_env(overwrite=False)`), so `DB_HOST=… venv/bin/python manage.py test core` overrides `.env` without editing it.
- **Tests need a running Postgres with pgvector** (migration `0001` runs `CREATE EXTENSION vector`; needs a privileged user — Supabase works out of the box):
  `venv/bin/python manage.py test core`
  All tests are offline (Gemini is mocked) but still need the DB. Against a **remote** DB (e.g. Supabase) the full suite takes ~90s — every ORM query is a network round-trip; a local Postgres runs it in seconds. Don't kill a slow run.
- `manage.py runserver` listens on `$PORT` (default 8080 — `manage.py` patches the default).
- `requirements.txt` still carries v1's local-ML deps (`faster-whisper`, `ollama`, `transformers`, `opencv`, ...). The SaaS code only imports `google-genai`, `pgvector`, `langchain-text-splitters`, `requests`, and the DRF/allauth stack.

## API contract — easy to get wrong
- The URL slot is **dual-purpose**: `POST /capture-context/<capture_id>/` and `POST /capture-embedding/<capture_id>/` take the **Capture** id in the URL (request body ignored). GET/PATCH/DELETE on the same slot use the context's / row's own id, or the `?capture_id=` query form. Wired via a custom `ContextRouter` in `core/api/urls.py` — read it before touching routing.
- Pipeline order: `POST /captures/` → `POST /capture-context/<id>/` (Gemini) → `POST /capture-embedding/<id>/` (400 if no context exists). `PATCH /capture-context/` = reprocess. All context fields are read-only.
- The 1536-dim `embedding` vector is never serialized to clients (metadata only).
- Auth is JWT-only (dj_rest_auth + simplejwt); every core endpoint requires `IsAuthenticated`; email verification is `mandatory` (in tests it lands in Django's mail outbox).

## Search — `GET /search/` (in `core/search.py` + `SearchViewSet`)
- A GET-only `GenericViewSet` registered on the **plain** `router` in `core/api/urls.py` (the ContextRouter is only for the dual-purpose POST trick). Read-only: no DB rows are written.
- `?q=` (text to search for) is required — missing/blank → 400. `?k=` (max captures, positive int) and `?min_score=` (finite float, floor on the capture's best-chunk score) are optional and **off by default: every capture is returned** — intentional, so callers can evaluate the score distribution before picking a threshold. Don't add default limits.
- `k`/`min_score` apply at **capture** level only (ranked by best-chunk score); a capture that enters carries *all* of its chunks, each with its own score, best-first.
- Heavy lifting lives in the plain function `core/search.py::search_captures(user, query, k, min_score, provider)` — DRF-free by the same convention as `embedding_builder.py`: one paced provider call embeds the query (~4.5s minimum) → pgvector cosine computed **in Postgres** (vectors are never fetched into Python) → rows grouped by capture → metadata joined from `captures` + `capture_context`.
- Result fields per capture: `capture_id`, `rank`, `score` (cosine similarity — higher = better, *not* a percentage), `summary_text`, `created_at`, `chunks[]` (`source_key`, per-chunk `score`, `text` preview truncated to 200 chars by `PREVIEW_CHARS`). The vector never appears in the response; full chunk text is retrievable via `GET /capture-embedding/`.
- The query filters rows by `vector_dims(embedding) == len(query_vector)` **before** annotating `CosineDistance`: pgvector errors on mixed dimensions, and legacy 3072-dim rows (pre-1536 switch) must be skipped, not crash the search. The `vector_dims` `Func` needs an explicit `output_field=IntegerField()` — without it Django inherits the `VectorField` type and tries to prepare the int as a vector.
- The ranking is a full result set with no `LIMIT` → sequential scan (pgvector HNSW index scans require `ORDER BY ... LIMIT`). Fine at personal scale. The 1536-dim request (under the 2000-dim HNSW cap) deliberately keeps an index *possible* for a future LIMIT-based query variant.

## Gemini provider (`core/api/gemini.py`) — don't "fix" blindly
- The only LLMs used: `gemini-3.5-flash-lite` (text/image/video/audio) and `gemini-embedding-2`, requested at `EMBED_DIMENSIONS` (1536, via Matryoshka `output_dimensionality`; the model supports 768/1536/3072). `EMBED_DIMENSIONS` is the single source of truth: `embedding_builder` enforces it at write time, search matches stored rows against it.
- The 4.5s pacing between calls + 429 retry is **intentional** free-tier quota protection (15 req/min per project) — an N-source capture takes ≈4.5s·N, and every search pays one call.
- The 8192-token embedding window: character pre-split → `count_tokens` validation → re-split until it fits (`generate_embeddings`).

## Conventions
- `core/embedding_builder.py` and `core/search.py` are plain functions by design — no DRF/request objects — so the same code can run from the API viewset or a management command (the embedding builder has one: `build_capture_embeddings`; search is viewset-only for now). Builds are idempotent, all-or-nothing (slow API calls happen *before* one transaction).
- Migration history was **reset** to a single `0001_initial` (commit `d904b82`) after the capture-only model reset. Older migrations exist only in git history / v1 — don't reference or re-add them. (Stale `.pyc` files in `core/migrations/__pycache__/` are just build artifacts.)
- All Gemini calls are mocked in tests (`FakeProvider` / `MagicMock`). The search *helper* tests run real pgvector cosine math in Postgres using tiny vectors (the column is dimension-unconstrained); the search *API* tests patch `core.api.views.search_captures`.
