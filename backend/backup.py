"""Full data backup: zips the SQLite DB + photos, retains the most recent
MAX_BACKUPS, and runs itself automatically once a day at 02:00 via a
background daemon thread - no scheduling library needed for a single daily
job. The nightly run is skipped if nothing has changed since the last
backup. Backup files never include the app's source code (already in git),
only the data that changes at runtime."""
import os
import re
import sqlite3
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timedelta
from typing import List, Optional

from db import DATA_DIR, DB_PATH, PHOTOS_DIR

BACKUPS_DIR = os.path.join(DATA_DIR, "backups")
os.makedirs(BACKUPS_DIR, exist_ok=True)
MAX_BACKUPS = 14

# Only the files this module writes, by their exact shape. A copy someone
# renamed by hand ("backup_old.zip") used to be listed, counted against
# MAX_BACKUPS and - worst of all - handed to _last_backup_time, where its
# name failed to parse as a timestamp and the nightly thread swallowed the
# error, so no backup was taken again until the file was moved away.
_BACKUP_NAME_RE = re.compile(r"\Abackup_\d{8}_\d{6}\.zip\Z")


def _backup_filenames() -> List[str]:
    return sorted(f for f in os.listdir(BACKUPS_DIR) if _BACKUP_NAME_RE.match(f))


def _prune_old_backups() -> None:
    stale = _backup_filenames()[:-MAX_BACKUPS] if MAX_BACKUPS > 0 else _backup_filenames()
    for name in stale:
        os.remove(os.path.join(BACKUPS_DIR, name))


def create_backup() -> str:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"backup_{timestamp}.zip"
    path = os.path.join(BACKUPS_DIR, filename)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        if os.path.exists(DB_PATH):
            # Never zip the live file: a note saved while the zip is being
            # written would leave a copy SQLite can't open. The online backup
            # API takes a consistent snapshot into a temp file first.
            with tempfile.TemporaryDirectory() as tmp:
                snapshot = os.path.join(tmp, "notebook.db")
                # Closed explicitly, not just committed: sqlite3's context
                # manager leaves the connection open, and Windows will not
                # delete a file a process still has open. The farm PC is
                # Windows, so leaving these for the garbage collector made
                # the temp folder's cleanup fail right after the database
                # had been zipped - Backup Now reported an error, and the
                # nightly zip was left holding the database but no photos.
                src, dst = sqlite3.connect(DB_PATH), sqlite3.connect(snapshot)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
                    src.close()
                zf.write(snapshot, arcname="notebook.db")
        for root, _, files in os.walk(PHOTOS_DIR):
            for f in files:
                full = os.path.join(root, f)
                arcname = os.path.join("photos", os.path.relpath(full, PHOTOS_DIR))
                # Already JPEG-compressed: deflating them again costs CPU
                # for next to no space.
                zf.write(full, arcname=arcname, compress_type=zipfile.ZIP_STORED)
    _prune_old_backups()
    return filename


def list_backups() -> List[dict]:
    result = []
    for name in reversed(_backup_filenames()):
        full = os.path.join(BACKUPS_DIR, name)
        stat = os.stat(full)
        result.append({
            "filename": name,
            "size_bytes": stat.st_size,
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return result


def _seconds_until_next_2am() -> float:
    now = datetime.now()
    target = now.replace(hour=2, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


def _last_backup_time() -> Optional[datetime]:
    names = _backup_filenames()
    if not names:
        return None
    ts = names[-1][len("backup_"):-len(".zip")]
    return datetime.strptime(ts, "%Y%m%d_%H%M%S")


def _data_changed_since(when: datetime) -> bool:
    if os.path.exists(DB_PATH) and datetime.fromtimestamp(os.path.getmtime(DB_PATH)) > when:
        return True
    for root, _, files in os.walk(PHOTOS_DIR):
        for f in files:
            if datetime.fromtimestamp(os.path.getmtime(os.path.join(root, f))) > when:
                return True
    return False


def _scheduler_loop() -> None:
    while True:
        time.sleep(_seconds_until_next_2am())
        try:
            last = _last_backup_time()
            if last is None or _data_changed_since(last):
                create_backup()
        except Exception:
            pass  # don't let one bad night kill the thread - try again tomorrow


def start_backup_scheduler() -> None:
    threading.Thread(target=_scheduler_loop, daemon=True).start()
