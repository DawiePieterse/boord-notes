"""Backups: the zip holds the database and the photos, the list and the
download only ever name this module's own files, and a stray file in the
folder can't stop the nightly run."""
import os
import zipfile
from datetime import datetime

import backup
from tests.conftest import add_entry


def _clear_backups():
    for name in os.listdir(backup.BACKUPS_DIR):
        os.remove(os.path.join(backup.BACKUPS_DIR, name))


def test_backup_holds_database_and_photos(client):
    _clear_backups()
    add_entry("e1", "Spuit", "Blok 4", "2026-10-01T08:00:00")
    with open(os.path.join(backup.PHOTOS_DIR, "e1-abc.jpg"), "wb") as fh:
        fh.write(b"\xff\xd8photo")
    try:
        r = client.post("/api/backups")
        assert r.status_code == 200, r.text
        name = r.json()["filename"]
        with zipfile.ZipFile(os.path.join(backup.BACKUPS_DIR, name)) as zf:
            assert sorted(zf.namelist()) == ["notebook.db", os.path.join("photos", "e1-abc.jpg")]
        # The snapshot's connections are closed, so the temp folder it was
        # taken in is gone (on Windows an open connection stops its removal).
        assert backup._last_backup_time() is not None
        listed = client.get("/api/backups").json()
        assert [b["filename"] for b in listed] == [name]
        r = client.get(f"/api/backups/{name}/download")
        assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    finally:
        os.remove(os.path.join(backup.PHOTOS_DIR, "e1-abc.jpg"))
        _clear_backups()


def test_download_refuses_anything_but_a_listed_backup(client):
    _clear_backups()
    assert client.get("/api/backups/..%2Fnotebook.db/download").status_code == 404
    assert client.get("/api/backups/../download").status_code == 404
    assert client.get("/api/backups/backup_nope.zip/download").status_code == 404


def test_stray_file_does_not_break_the_nightly_check(client):
    _clear_backups()
    stray = os.path.join(backup.BACKUPS_DIR, "backup_old_copy.zip")
    with open(stray, "wb") as fh:
        fh.write(b"not really a zip")
    try:
        assert backup._backup_filenames() == []
        assert backup._last_backup_time() is None     # so tonight's backup still runs
        assert client.get("/api/backups").json() == []
        with open(os.path.join(backup.BACKUPS_DIR, "backup_20260101_020000.zip"), "wb") as fh:
            fh.write(b"")
        assert backup._last_backup_time() == datetime(2026, 1, 1, 2, 0, 0)
    finally:
        _clear_backups()
