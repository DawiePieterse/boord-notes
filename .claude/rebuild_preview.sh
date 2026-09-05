#!/bin/zsh
# Rebuild the Boord Notes app's /tmp preview sandbox.
#
# The app itself runs fine in place (backend/.venv, `python run_preview.py`).
# This script exists only for Claude Code's preview runner, which is
# TCC-sandboxed and gets EPERM on anything under ~/Documents - it can't even
# read backend/.venv/pyvenv.cfg, so it cannot start the app where it lives:
#
#   PermissionError: [Errno 1] Operation not permitted:
#   '.../BoordNotes/backend/.venv/pyvenv.cfg'
#
# So everything the preview touches is mirrored into /tmp. Same approach the
# two harvest apps use (see their .claude/rebuild_preview.sh).
#
# Usage:
#   zsh .claude/rebuild_preview.sh stage   # sandboxed shell: mirror repo -> /tmp
#   zsh .claude/rebuild_preview.sh venv    # unsandboxed shell: build venv (pip needs it)
#   zsh .claude/rebuild_preview.sh patch   # either: repoint DATA_DIR/FRONTEND_DIR, write launcher
# Then: preview_start name=notebook (port 8821).
# "venv" is only needed after a /tmp purge; "stage" + "patch" after every code change.
set -e
APP="$(cd "$(dirname "$0")/.." && pwd)"
STEP="${1:-all}"

# cat-based recursive copy: cp/rsync/tar all fail with EPERM on ~/Documents
# here (they read extended attributes), but plain data reads work.
copytree() {
  local src="$1" dst="$2"
  rm -rf "$dst"
  (cd "$src" && find . -type f ! -path "./.venv/*" ! -name "*.pyc" ! -path "*/__pycache__/*" ! -name ".DS_Store") | \
  while IFS= read -r f; do
    mkdir -p "$dst/$(dirname "$f")"
    cat "$src/$f" > "$dst/$f"
  done
}

if [[ "$STEP" == "stage" || "$STEP" == "all" ]]; then
  echo "== staging mirrors into /tmp =="
  copytree "$APP/backend" /tmp/nb_backend
  copytree "$APP/frontend" /tmp/nb_frontend
  cat "$APP/backend/requirements.txt" > /tmp/nb_requirements.txt
  # Work on a COPY of the real data - never let the preview write to the
  # notebook Andre actually uses.
  mkdir -p /tmp/nb_data/photos /tmp/nb_data/backups
  [[ -f "$APP/data/notebook.db" ]] && cat "$APP/data/notebook.db" > /tmp/nb_data/notebook.db
  if [[ -d "$APP/data/photos" ]]; then
    for f in $(cd "$APP/data/photos" && ls); do cat "$APP/data/photos/$f" > "/tmp/nb_data/photos/$f"; done
  fi
fi

if [[ "$STEP" == "venv" || "$STEP" == "all" ]]; then
  if ! /tmp/nb_venv/bin/python3 -c "import fastapi, uvicorn, sqlmodel, passlib, jose, multipart" 2>/dev/null; then
    echo "== creating venv =="
    rm -rf /tmp/nb_venv
    /usr/bin/python3 -m venv /tmp/nb_venv
    /tmp/nb_venv/bin/pip install --quiet --upgrade pip
    /tmp/nb_venv/bin/pip install --quiet -r /tmp/nb_requirements.txt
  else
    echo "== venv already good =="
  fi
fi

if [[ "$STEP" == "patch" || "$STEP" == "all" ]]; then
  echo "== repointing data/frontend dirs at /tmp =="
  /tmp/nb_venv/bin/python3 - <<'PY'
import re
p = "/tmp/nb_backend/db.py"; s = open(p).read()
s = s.replace('DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")',
              'DATA_DIR = "/tmp/nb_data"')
open(p, "w").write(s)
p = "/tmp/nb_backend/main.py"; s = open(p).read()
s = re.sub(r'^FRONTEND_DIR = .*$', 'FRONTEND_DIR = "/tmp/nb_frontend"', s, flags=re.MULTILINE)
open(p, "w").write(s)
PY
  cat > /tmp/nb_launcher.py <<'PY'
import sys, os
sys.path = [p for p in sys.path if p]
port = int(os.environ.get('PORT', '8821'))
import uvicorn
uvicorn.run('main:app', host='127.0.0.1', port=port, loop='asyncio', http='h11',
            app_dir='/tmp/nb_backend')
PY
fi

echo "done ($STEP)"
