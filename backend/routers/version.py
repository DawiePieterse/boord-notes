"""What release this server is running. Public, like every Boord app's: the
heartbeat script and Boord Monitor ask it, and so does whoever is looking at
a phone wondering why a screen looks wrong.

Copied from Boord Labour's routers/version.py, with the same field names,
because Boord's heartbeat.ps1 reads tag/state/frontend_version from every
app. Only tag, state and the frontend VERSION line: Boord's own version.py
also reports schema revision, backups and pending updates - port that if
this app grows an update check.

/api/health stays as it is beside this: Sync Now wants the cheapest possible
answer, and this one shells out to git.
"""
import os
import re
import shutil
import subprocess

from fastapi import APIRouter

router = APIRouter(prefix="/api/version", tags=["version"])

# backend/routers/version.py -> the repo root, which is where update_server.bat
# checks out the release tag.
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API_JS = os.path.join(REPO_ROOT, "frontend", "shared", "api.js")
# Anchored to the exact line in api.js, two-space indent and all, so a
# VERSION mentioned in a comment can never be picked up instead.
_VERSION_RE = re.compile(r'^  VERSION: "(.*)",$', re.MULTILINE)


def _frontend_version() -> str:
    try:
        with open(API_JS, encoding="utf-8") as fh:
            m = _VERSION_RE.search(fh.read())
        return m.group(1) if m else ""
    except OSError:
        return ""


def _git(args: list) -> str:
    # The farm PC may have no git on SYSTEM's PATH (update_server.bat finds
    # its own), and a missing git must not turn a version check into a 500.
    git = shutil.which("git")
    if not git:
        return ""
    try:
        proc = subprocess.run([git] + args, cwd=REPO_ROOT,
                              capture_output=True, text=True, timeout=5,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return proc.stdout.strip() if proc.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


@router.get("")
def get_version():
    """state is "release" when HEAD is exactly a tag (what update_server.bat
    checks out), "ahead" when it is past one - tag is then git's describe
    string, e.g. v2.16-3-gabc1234 - and "unknown" with no git or no repo.
    version is the frontend VERSION, the number shown in Settings."""
    tag = _git(["describe", "--tags", "--exact-match"])
    if tag:
        state = "release"
    else:
        tag = _git(["describe", "--tags", "--always"])
        state = "ahead" if tag else "unknown"
    frontend_version = _frontend_version()
    return {"app": "Boord Notes", "version": frontend_version, "tag": tag or None,
            "state": state, "frontend_version": frontend_version}
