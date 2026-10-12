# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Boord Notes is a private farm notebook for two people (Andre and his son). It is an offline-first PWA for iPhones, served by a small FastAPI + SQLite backend on a Windows PC on the farm. It is the third Boord app (beside Boord and Boord Owner), but shares no database or code with them. `MANUAL.md` is the user and admin manual. Read it for behaviour, setup and anything user-facing.

## Commands

All backend commands run from `backend/`.

```sh
# Install dependencies
pip install -r requirements.txt -r requirements-dev.txt

# Run locally on scratch data, then open http://localhost:8821/app/
NB_DATA_DIR=/tmp/nb-dev python -m uvicorn main:app --port 8821

# Tests: no API key or network needed
python -m pytest -q
python -m pytest tests/test_actions.py::test_todo_list_and_mark_done -q   # a single test

# Smoke test in headless Chromium, phone and desktop sizes (needs Node and playwright)
# Run with the server above already running
node ../scripts/smoke_test.js

# Rebuild Tailwind (needs Node), then commit the result
sh ../scripts/build_css.sh

# Rebuild the training-guide PDF from its HTML source (needs WeasyPrint)
sh ../docs/guide/build.sh
```

CI (`.github/workflows/ci.yml`) runs three checks:
- pytest
- the Playwright smoke test
- a check that `frontend/shared/tailwind.css` matches a fresh `build_css.sh` run

So after adding a Tailwind class the app didn't use before, rebuild the CSS and commit it.

`NB_DATA_DIR` points the app at a scratch data folder. Without it, the app uses the real `data/` folder next to `backend/`. The tests set `NB_DATA_DIR` themselves (`tests/conftest.py`), and give each test a fresh database.

On the owner's Mac, Claude's preview runner can't read the repo under `~/Documents`. `.claude/rebuild_preview.sh` mirrors the app into `/tmp` for `.claude/launch.json`.

## Architecture

### Offline-first sync
The phone is the source of truth until a note syncs.

- **Saving:** `frontend/app/app.js` saves every note to IndexedDB (`idb.js`) first.
- **Syncing:** `syncLoop` then runs every 10 s and on the `online` event, one pass at a time. Each pass sends:
  - entries to `POST /api/entries`, an idempotent upsert keyed by a UUID the phone makes
  - then their photos
  - then any queued "mark done" ticks
- **Actions:** a note's actions travel inside its payload. The server replaces them as a whole, by their phone-made ids.
- **Ticks on synced notes:** marking done an action on a note the server already has is queued in `localStorage` (`nb_done_queue`) and sent with `PATCH /api/actions/{id}`.
- **Lists:** the tag, block and action-type lists are cached in `localStorage` (`fetchSavedList`), so the pickers work with no signal.

**Never bump `DB_VERSION` in `idb.js`.** Its upgrade handler drops and recreates the stores, which deletes every note not yet synced. Put new per-note data inside the entry record instead.

### No accounts
There is no sign-in. Reaching the server over Tailscale is the only access control: it binds `127.0.0.1:8020` and is published with `tailscale serve` on `:9443`. Don't add auth assumptions. The AI daily call limit exists because anyone on the tailnet can call the API.

### Data model rules
These rules span models, routers and frontend:

- **Notes store names, not foreign keys.** A note stores its block and each action's kind as text, not as a link to `Block` or `ActionType`. Old free-text notes and offline capture keep working that way. Renaming a block rewrites the block text on its notes (`routers/blocks.py`).
- **Names ignore capitals.** Tag, block and action-type names are compared ignoring case, in Python rather than SQL, because SQLite's case folding mishandles Afrikaans diacritics. The shared rules are in `backend/names.py`. Tags and action kinds typed on a note snap to the existing spelling.
- **Archiving is a soft delete** (`Entry.archived`). "Live" counts exclude archived notes (`db.live_counts`). Remove is only offered on names no live note uses.
- **Capture-time fields are set once.** Location and weather are recorded when a note is first created, and an edit never changes them.
- **Timestamps are naive UTC.** `db.utcnow()` produces them, and the client reads them as UTC with `NB.parseServerDate`. Backup times are the exception: they are the farm PC's local time.

### Migrations are additive only
`db.create_db_and_tables()` runs at startup. It:
- runs `create_all`
- adds any model column missing from an existing table
- creates missing indexes
- sets up the FTS5 search table and its triggers (`ensure_fts`)

It never drops or alters anything, so downgrading is just running the old code. New model fields need defaults that suit existing rows. Search falls back to substring matching when FTS5 is unavailable.

### AI help (optional)
`backend/ai.py` makes a single structured-output call (`call_json`). `routers/ai.py` defines the prompts and schemas for AI Tidy up and Ask AI.

- **Key:** read from `ANTHROPIC_API_KEY` or `data/anthropic_key.txt`. Without a key, the two AI features stay hidden and everything else works.
- **Model:** `NB_AI_MODEL` (default `claude-sonnet-5-5`).
- **Daily limit:** `NB_AI_DAILY_LIMIT`.
- **Tests:** they use the `fake_claude` fixture and never touch the network. Fake replies must include every field the schema requires.

### Frontend constraints
- **No CDNs.** The phones are on the tailnet only and can't reach the public internet. Everything is served from `frontend/`.
- **Icons are inline SVG.** The Font Awesome font in `shared/fontawesome/` is a subset with only a few glyphs, now used for weather. A class for a glyph that isn't in the subset renders as a blank box.
- **No build step for JS.** The JS is plain (no framework). Only Tailwind is built.
- **Static files are served `no-cache`.** On top of that, the service worker caches the app shell.

### Versions and releases
- **Any change to frontend code needs two version bumps:**
  - `VERSION` in `frontend/shared/api.js` (shown in Settings)
  - `CACHE` in `frontend/app/service-worker.js`, so installed phones fetch the new files
- **Merging to `main` does not deploy.** The farm runs `update_server.bat`. It force-fetches tags, picks the newest `v*` tag by version order, and checks the GPG signature against the fingerprint in `data\release_key.fpr` before checking it out. Releases are signed tags made by the owner.
- **User-facing changes also go into `MANUAL.md`.** If screens change, update the training guide too: `docs/guide/training-guide.html`, with screenshots in `docs/guide/img/`, rebuilt to `Boord_Notes_Training_Guide.pdf`.

## Conventions

Comments are long on purpose. They explain *why* the code is the way it is, usually a farm-specific constraint: weak signal, one-handed use in an orchard, the tailnet-only phones. Keep that style, and don't strip those comments as noise.
