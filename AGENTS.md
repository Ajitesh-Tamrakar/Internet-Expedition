# AGENTS.md

This repository is the **SaaS (cloud) version** of Internet Expedition.

## Layout
- `core/` — the single consolidated Django app: models, views, API (`core/api/`), Gemini integration, migrations, workers
- `bookmark/` — Django project (settings, urls)
- `frontend/` — web frontend

## LLM provider
**Gemini only.** The app collects data, sends it to Gemini, and stores the processed content. No other model provider is configured.

## Important: legacy v1 code is NOT in this branch
The previous strictly-local version — the separate `capture` / `process` / `evaluate` / `retrieve` apps, the browser extension, docker/local install scripts — was removed from this branch during the SaaS consolidation. It still exists, fully intact, on the **`v1-reference`** branch and in git history.

- Do not resurrect, copy, or import files from v1 unless explicitly asked to.
- If you need to see how something worked in v1, read it from the branch instead of this tree, e.g. `git show v1-reference:process/pipeline.py`.
- Those files do not exist in this working tree. Do not assume they do.
