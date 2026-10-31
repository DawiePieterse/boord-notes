import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from backup import BACKUPS_DIR, _backup_filenames, create_backup, list_backups

router = APIRouter(prefix="/api/backups", tags=["backups"])


@router.get("")
def get_backups():
    return list_backups()


@router.post("")
def trigger_backup():
    filename = create_backup()
    return {"filename": filename}


@router.get("/{filename}/download")
def download_backup(filename: str):
    # Only a name the list above would show. basename() alone let ".." or
    # "." through: both exist (as directories) under data\backups, so the
    # check passed and FileResponse fell over on a directory with a 500
    # instead of the 404 a wrong name deserves.
    safe_name = os.path.basename(filename)
    if safe_name not in _backup_filenames():
        raise HTTPException(404, "Backup not found")
    path = os.path.join(BACKUPS_DIR, safe_name)
    return FileResponse(path, media_type="application/zip", filename=safe_name)
