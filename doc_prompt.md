You are documenting ONE Django/frontend app from a codebase for someone who wrote very little of it directly — most of it was built with an AI pair-programmer — and now needs a clear mental map of it. This is a READ-ONLY documentation pass. Do not modify, refactor, fix, or "improve" any code, even if something looks questionable — just note it under Important Rules if it matters for understanding.

APP TO DOCUMENT: extension

SCOPE — READ THIS FIRST:
Only read and analyze files inside the extension folder. Do not open, read, or explain code in any other app or folder. The one exception: you may run a plain text search (e.g. grep -rn "name" .) across the whole repo root purely to check whether a function/class name from extension also appears elsewhere — this is for the Role field below, and it is a name search only, not analysis. Never read or summarize what happens in the other app once found.

Skip test files, __pycache__, node_modules, venv, and any build/dist output.

Produce ONE file: /docs/architecture/ARCHITECTURE_extension.md

STRUCTURE:

## App Overview (top of file, 3–5 lines max)
- What is extension responsible for in the system?
- What are its main inputs and outputs as a whole?
- Where does it sit relative to other apps — what feeds it, what it feeds (name the other apps only, don't explain their internals)?

## Folders (1–3 lines per folder)
Brief note on what each folder holds and why it exists. No file listing yet.

SPECIAL RULE for any "migrations" folder:
1. One-line overview of the folder as a whole.
2. Split files into two groups:
   - Plain schema migrations (only AddField / AlterField / CreateModel / RemoveField / standard ops — no RunPython or RunSQL): list by filename, one sentence each, no deeper detail.
   - Migrations containing RunPython or RunSQL (hand-written logic): treat these as real content. For each: what it does, what bug or gap it was likely fixing, what would break if reverted. A few sentences each.

## Files (go one at a time, depth-first — fully finish one file before starting the next)

For each file:

### File Overview (2–4 sentences)
What is this file, why does it exist, what's its main responsibility, where does it fit in the app.

### Components
A short table: every class/function of note in the file, one line each on its purpose. This is a map, not an explanation.

### Classes (only for files that define real classes — models, serializers, class-based views, etc. Skip this section for files that are just plain functions.)
For each class:
**Purpose** — what it represents/encapsulates
**Responsibilities** — what it handles
**Key methods** — its important methods (detailed below under Functions)

### Functions / Methods
- Trivial (simple getter, one-line helper, obvious pass-through/validator, no real branching): ONE sentence, nothing more.
- Everything else, use exactly this structure every time:
  **Why** — why this function exists, what problem it solves
  **Input** — what it takes in, what each important input means
  **What it does** — main steps/flow, not line-by-line implementation
  **Output** — what it returns or produces
  **Important rules** — real thresholds, filters, validation, fallbacks, sorting, edge cases
  **Role** — where else in extension this is called from. Then, separately: search the rest of the repo (name only, not code reading) for this function/class name — if it appears in another app, note which app by name, one line, nothing more. If nothing found elsewhere, say so briefly.

### Overall Flow for this file
2–4 lines: how this file's components call each other, start to finish (e.g. "entry point → validates → calls X → returns Y").

Once a file is fully covered, move to the next sibling file. Once a folder is fully covered, move to the next sibling folder.

TONE AND LENGTH:
- Plain, everyday English. Briefly explain any technical term the first time it appears.
- Explain WHAT and WHY before HOW — never restate code line-by-line.
- App Overview and Folder sections must be skimmable in under a minute.
- The whole document should be readable in one sitting without feeling like a book — if a section runs long, cut detail, not coverage.
- No filler, no repeated boilerplate phrasing between entries.
