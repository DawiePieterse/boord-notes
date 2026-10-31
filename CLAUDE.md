# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Boord Notes is a private farm notebook for two people (Andre and his son). It is an offline-first PWA for iPhones, served by a small FastAPI + SQLite backend on a Windows PC on the farm. It is the third Boord app (beside Boord and Boord Owner), but shares no database or code with them. `MANUAL.md` is the user and admin manual. Read it for behaviour, setup and anything user-facing.

## The Boord suite

This app is one of seven that run together on the farm PC (`bekfontein-server`), each its own repo, process, port and database. They are reached only over Tailscale, and each binds `127.0.0.1` and is published with `tailscale serve`. The same section is in every app's `CLAUDE.md`. When a fact here changes, change it in all seven.

| App | Repo (`DawiePieterse/…`) | What it does | Port | Tailnet address | Mac folder | Farm PC folder |
|---|---|---|---|---|---|---|
| Boord | `Boord` | Harvest capture and picker pay per kg: field tablets, pack-house receiving, admin office. The hub. | 8000 | `https://bekfontein-server.taile32cb0.ts.net/` | `~/Documents/Projects/Boord` | `C:\Boord` |
| Boord Owner | `boordowner` | The owner's view: season vs history, weather, risk, crop estimate, optional AI. | 8010 | `https://bekfontein-server.taile32cb0.ts.net:8443/` | `~/Documents/Projects/BoordOwner` | `C:\BoordOwner` |
| **Boord Notes** (this app) | `boord-notes` | Private farm notebook for Andre and his son, offline-first, optional AI. | 8020 | `https://bekfontein-server.taile32cb0.ts.net:9443/` | `~/Documents/Projects/BoordNotes` | `C:\bekfontein-farm-notebook` |
| Kudde | `Kudde` | Cattle records: animals and their events. | 8030 | `https://bekfontein-server.taile32cb0.ts.net:8030/` | `~/Documents/Projects/Kudde` | `C:\Kudde` |
| Boord Labour | `Boord-labour` | Packhouse time clock: badge scans at the door, hourly pay with overtime. | 8040 | `https://bekfontein-server.taile32cb0.ts.net:8040/` | `~/Documents/Projects/Boord-labour` | `C:\Boord-labour` |
| Boord Monitor | `Boord-monitor` | Watches the PC and the other apps: status page, SLOs, incidents, Web Push alerts, a Restart button; runs the watchdog and heartbeat. | 8050 | `https://bekfontein-server.taile32cb0.ts.net:8050/` | `~/Documents/Projects/Boord-monitor` | `C:\boord-monitor` |
| Boord Packhouse | `boord-packhouse` | After receiving to the truck: sulfur, acid, lines, pre-pack, cold store and PPECB, dispatch. | 8060 | `https://bekfontein-server.taile32cb0.ts.net:8060/` | `~/Documents/Projects/Boord-packhouse` | `C:\Boord-packhouse` |

**How they depend on each other:**
- **Boord is the hub.** Its `data/boord.db` is opened read-only by Owner (harvest, lots, blocks, suppliers), Labour (the worker register, and Boord's `data/photos` for faces), Monitor (tablet station, last sync and outbox) and Packhouse (received lots, blocks, suppliers, workers).
  - Boord is that database's only writer and migrates it at startup.
  - Owner, Labour and Packhouse refuse to boot if a column they read disappears. A Boord migration that drops or renames a column needs those apps updated in step.
- **Labour's badges are Boord's.** The badge QR holds exactly `worker.id` (`Boord/frontend/admin/print-badge.html`), and Labour and Packhouse vendor Boord's `frontend/shared/`.
- **Boord reads Owner and Packhouse.** The Admin Planner (Boord 3.50) opens Owner's `data/owner.db` read-only for the season's latest estimate, and Packhouse's `data/packhouse.db` for receivers, packs and delivery notes (Boord's Reports and Dashboard already read the latter). Optional: a missing database drops those figures with a message, never the screen. Owner's `yieldestimate`/`yieldestimateblock` and Packhouse's `receiver`, `packaging` and `deliverynote` columns it reads must stay.
- **Owner asks Notes.** The "Ask the farm notes" bridge calls Notes' `/api/ai/ask` at `OWNER_NOTES_URL` (`http://127.0.0.1:8020`) and can share Notes' `data/anthropic_key.txt`.
- **Monitor keeps the others running.** Since Monitor 2.0 its `watchdog.ps1` (restarts an app that stops answering) and `heartbeat.ps1` (pings healthchecks.io) cover all seven, as the scheduled tasks "Boord Watchdog" and "Boord Heartbeat". Until then they lived in Boord's repo; Boord's copies are now forwarders to Monitor's.
  - **The app table is Monitor's `apps.json`, the one copy.** Monitor's `backend/apps.py`, `watchdog.ps1` and `heartbeat.ps1` all read it. Adding or moving an app is one line there plus the port table above; the `tailscale serve` ports are also in Boord's MANUAL.md.
  - The watchdog stands down while any app's updater (its `updater` in `apps.json`) or an installer runs, and its `-Restart "<Name>"` is what Monitor's Restart button runs. It exits 2 when it stands down.
- **Monitor watches everything.** It shows each app's up/down state and `/api/version`, Tailscale and the PC, keeps uptime history, SLOs and incidents, and pushes an alert after three failed checks in a row.
  - Every app's `/api/version` keeps the same field names (`tag`, `state`, `frontend_version`), because Monitor and the heartbeat read them all.
  - An off-site copy of the monitor on the owner's Mac alerts when the whole farm PC is unreachable.
- **Kudde and Notes stand alone.** No other app reads their data. They are only watched and restarted.

**What they share by convention, not code:**
- One release key: fingerprint `67C64CFDD584DD140E58AF6E329C9B9DD0562A9D` in each app's `data\release_key.fpr`.
- Releases are signed tags, made from an up-to-date `main` on the Mac and installed by each app's updater on the farm PC.
- `stop_server.ps1` stops each server, never a bare `schtasks /end`. Labour's copy is the reference.
- Each installer adds a Git `safe.directory` exception so SYSTEM's Git can read the repo folder.
- Python 3.9-compatible code, plain JS with no CDNs (the phones are tailnet-only), and `VERSION` plus the service-worker `CACHE` bumped with every frontend change.
- Fixes to the copied deployment files (`install.ps1`, the updaters, `stop_server.ps1`, `release.sh`) flow between the repos.

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
- **Tag only from an up-to-date `main`, and never move a tag.** This repo has no `release.sh`, so nothing checks that `VERSION` matches the tag. `v2.16` was signed in a stale clone and points at `2776f99` (a September commit with `VERSION` "2.3"). The fix was a new release, 2.17, because re-pointing a released tag leaves servers already on it stuck. Before `git tag -s`, run `git pull --ff-only origin main` and check the `VERSION` line.
- **The updater stops the server with `stop_server.ps1`, never a bare `schtasks /end`.** Ending the task ends only the launcher. The uvicorn it started keeps port 8020, the new release can't bind it, and the old server goes on answering. Before 2.18 that hid 2.17 behind an older server on the farm PC. `stop_server.ps1` (adapted from Boord Labour's) waits for the port to come free and stops a leftover only if it runs from this repo's `.venv`. The updater runs it before copying and migrating `notebook.db`, and its "came back up" check asks `/api/version`, which an older server doesn't answer. `tests/test_updater.py` holds that order.
- **`install.ps1` adds the repo folder to Git's machine-wide `safe.directory`.** The server runs as SYSTEM, and the folder belongs to the admin account that cloned it, so Git refused it as "dubious ownership" and `/api/version` reported `"tag": null`. The block is copied from Boord Monitor's `install.ps1`. On the farm PC the folder is `C:\bekfontein-farm-notebook`, not a name like `boord-notes`.
- **User-facing changes also go into `MANUAL.md`.** If screens change, update the training guide too: `docs/guide/training-guide.html`, with screenshots in `docs/guide/img/`, rebuilt to `Boord_Notes_Training_Guide.pdf`.

## Installing and deploying

### Where it lives

| | |
|---|---|
| Your Mac (the only clone to release from) | `~/Documents/Projects/BoordNotes` |
| Farm PC folder | `C:\bekfontein-farm-notebook` |
| Farm PC scheduled task | "Boord Notes Server", runs as SYSTEM at boot |
| Port on the farm PC | `127.0.0.1:8020` |
| Address on the tailnet | `https://bekfontein-server.taile32cb0.ts.net:9443/` |

### First install on the farm PC (once)

Only for a new PC or a reinstall. An app that is already running is updated, not reinstalled.

1. Open a Command Prompt and clone the repo into the folder above:
   ```bat
   git clone https://github.com/DawiePieterse/boord-notes.git C:\bekfontein-farm-notebook
   ```
2. In `C:\bekfontein-farm-notebook`, double-click **`install.bat`** and accept the administrator prompt.
   It installs Python if needed, builds the app's environment, writes the launcher, registers the scheduled task and starts the server. Re-running it is safe and keeps the data.
3. Tell the updater which release key to trust. In the same folder, type it exactly like this, with the redirect first:
   ```bat
   >data\release_key.fpr echo 67C64CFDD584DD140E58AF6E329C9B9DD0562A9D
   ```
4. Publish it on the tailnet, in a Command Prompt opened as administrator:
   ```bat
   tailscale serve --bg --https=9443 http://localhost:8020
   ```
5. If the installer did not already add it, let SYSTEM's Git read the folder, as administrator (forward slashes):
   ```bat
   git config --system --add safe.directory C:/bekfontein-farm-notebook
   ```
6. Check it from your Mac: `curl -s https://bekfontein-server.taile32cb0.ts.net:9443/api/version` should show the release tag.

### Deploying a change (every release)

Merging to `main` changes nothing on the farm. A release is a signed tag, and the farm PC installs it when its updater runs.

1. **Merge the PR on GitHub.** A frontend change must already bump `VERSION` in `frontend/shared/api.js` and the service worker's `CACHE`.
2. **On your Mac, bring the clone up to date.** This step is what stops a tag landing on an old commit:
   ```sh
   cd ~/Documents/Projects/BoordNotes && git checkout main && git pull --ff-only origin main
   git log -1 --format='%h %s'                  # the merge you expect
   grep -m1 'VERSION:' frontend/shared/api.js   # the version you are releasing
   ```
3. **Sign and push the tag** (`vX.Y` must equal `VERSION`):
   ```sh
   git tag -s vX.Y -m "Boord Notes X.Y" && git verify-tag vX.Y && git push origin vX.Y
   ```
   This repo has no `release.sh`, so nothing else checks `VERSION` against the tag. Check it in step 2.
   Never move or reuse a released tag. Fix a wrong one with the next version.
4. **On the farm PC**, in `C:\bekfontein-farm-notebook`, double-click **`update_server.bat`**. It verifies the signature, stops the server with `stop_server.ps1`, installs dependencies, copies and migrates the database, and starts it again. If it stops with an error, nothing has changed. Read the message; never check the tag out by hand.
5. **If the release changed `install.ps1`** (its notes say "run install.bat once more"), double-click `install.bat` as well. The updater does not rewrite the launcher or the task.
6. **Check from your Mac:** `curl -s https://bekfontein-server.taile32cb0.ts.net:9443/api/version` should show `"tag":"vX.Y","state":"release"`.
7. **Close and reopen the app on Andre's and Devin's phones (fully, not just backgrounded) so they load the new version. Settings shows the version.**

## Conventions

Comments are long on purpose. They explain *why* the code is the way it is, usually a farm-specific constraint: weak signal, one-handed use in an orchard, the tailnet-only phones. Keep that style, and don't strip those comments as noise.
