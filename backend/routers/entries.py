import os
import re
import uuid as uuid_lib
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlmodel import Session, SQLModel, select

from db import PHOTOS_DIR, get_session
from models import Entry, EntryTagLink, Photo, Tag, User

router = APIRouter(prefix="/api/entries", tags=["entries"])


class EntryIn(SQLModel):
    id: str
    title: str = ""
    body: str = ""
    block: str = ""
    tags: List[str] = []
    created_at: Optional[datetime] = None
    # Captured on the phone at the moment the note was written, not derived
    # here - see the note on Entry in models.py for why they can't be filled
    # in at sync time.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_accuracy_m: Optional[float] = None
    weather_temp: Optional[float] = None
    weather_humidity: Optional[float] = None
    weather_condition: str = ""


# The id arrives from the phone, and it also becomes part of the photo
# filename on disk - so it has to be something that can't walk out of the
# photos directory or turn into an entry no URL can address. The app always
# sends a UUID; this just refuses everything that isn't shaped like one.
_ID_RE = re.compile(r"\A[A-Za-z0-9_-]{1,64}\Z")


def _validate_entry_id(entry_id: str) -> None:
    if not _ID_RE.match(entry_id or ""):
        raise HTTPException(400, "Invalid entry id")


def _get_or_create_tags(session: Session, names: List[str]) -> List[Tag]:
    tags = []
    for raw in names:
        name = raw.strip()
        if not name:
            continue
        tag = session.exec(select(Tag).where(Tag.name == name)).first()
        if not tag:
            tag = Tag(name=name)
            session.add(tag)
            session.flush()
        tags.append(tag)
    return tags


def _entry_out(session: Session, entry: Entry) -> dict:
    tag_names = session.exec(
        select(Tag.name).join(EntryTagLink, EntryTagLink.tag_id == Tag.id)
        .where(EntryTagLink.entry_id == entry.id)
    ).all()
    photos = session.exec(select(Photo).where(Photo.entry_id == entry.id)).all()
    # Entries captured before the sign-in was removed carry an author; ones
    # captured since do not, and the UI omits the field rather than inventing
    # a name for them. See models.User.
    creator = session.get(User, entry.created_by_id) if entry.created_by_id else None
    return {
        "id": entry.id,
        "title": entry.title,
        "body": entry.body,
        "block": entry.block,
        "tags": sorted(tag_names),
        "created_at": entry.created_at,
        "updated_at": entry.updated_at,
        "created_by": creator.display_name if creator else "",
        "archived": entry.archived,
        "latitude": entry.latitude,
        "longitude": entry.longitude,
        "location_accuracy_m": entry.location_accuracy_m,
        "weather_temp": entry.weather_temp,
        "weather_humidity": entry.weather_humidity,
        "weather_condition": entry.weather_condition,
        "photos": [{"id": p.id, "filename": p.filename, "caption": p.caption} for p in photos],
    }


@router.get("")
def list_entries(q: str = "", tag: str = "", archived: bool = False,
                  session: Session = Depends(get_session)):
    entries = session.exec(select(Entry).where(Entry.archived == archived)).all()
    results = [_entry_out(session, e) for e in entries]
    # Filtered in Python, not SQL LIKE - SQLite's default LIKE collation is
    # ASCII-only case-insensitive and mishandles Afrikaans diacritics (ë, é)
    # that dictated notes will contain. Fine at this data scale.
    if q:
        needle = q.lower()
        results = [r for r in results if needle in r["title"].lower() or needle in r["body"].lower()
                   or needle in r["block"].lower()]
    if tag:
        results = [r for r in results if tag in r["tags"]]
    results.sort(key=lambda r: r["created_at"], reverse=True)
    return results


@router.get("/stats")
def entry_stats(session: Session = Depends(get_session)):
    entries = session.exec(select(Entry).where(Entry.archived == False)).all()  # noqa: E712
    week_ago = datetime.utcnow() - timedelta(days=7)
    with_photos_ids = set(session.exec(select(Photo.entry_id)).all())
    tag_counts: dict = {}
    for e in entries:
        for name in session.exec(
            select(Tag.name).join(EntryTagLink, EntryTagLink.tag_id == Tag.id)
            .where(EntryTagLink.entry_id == e.id)
        ).all():
            tag_counts[name] = tag_counts.get(name, 0) + 1
    recent = sorted(entries, key=lambda e: e.created_at, reverse=True)[:5]
    return {
        "total": len(entries),
        "this_week": sum(1 for e in entries if e.created_at >= week_ago),
        "with_photos": sum(1 for e in entries if e.id in with_photos_ids),
        "tags_used": len(tag_counts),
        "tag_breakdown": sorted(tag_counts.items(), key=lambda kv: kv[1], reverse=True),
        "recent": [_entry_out(session, e) for e in recent],
    }


@router.get("/{entry_id}")
def get_entry(entry_id: str, session: Session = Depends(get_session)):
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    return _entry_out(session, entry)


@router.post("")
def upsert_entry(payload: EntryIn, session: Session = Depends(get_session)):
    """Create or edit - same endpoint for both (upsert by client-generated
    id), matching the harvest app's upsert_worker/upsert_team/upsert_block
    convention. Idempotent: a retried sync POST for the same id just
    overwrites with the same data, safe on flaky rural signal."""
    _validate_entry_id(payload.id)
    now = datetime.utcnow()
    existing = session.get(Entry, payload.id)
    if existing:
        # Where and under what conditions a note was captured describes a
        # moment that has already happened, so an edit never moves them - a
        # correction typed at the house that evening must not restamp the note
        # with the kitchen's coordinates and tonight's weather. They are set
        # once, when the entry is first created.
        existing.title = payload.title
        existing.body = payload.body
        existing.block = payload.block
        existing.updated_at = now
        entry = existing
    else:
        entry = Entry(id=payload.id, title=payload.title, body=payload.body, block=payload.block,
                       created_at=payload.created_at or now,
                       latitude=payload.latitude, longitude=payload.longitude,
                       location_accuracy_m=payload.location_accuracy_m,
                       weather_temp=payload.weather_temp, weather_humidity=payload.weather_humidity,
                       weather_condition=payload.weather_condition)
    session.add(entry)
    session.flush()

    for link in session.exec(select(EntryTagLink).where(EntryTagLink.entry_id == entry.id)).all():
        session.delete(link)
    for t in _get_or_create_tags(session, payload.tags):
        session.add(EntryTagLink(entry_id=entry.id, tag_id=t.id))

    session.commit()
    return _entry_out(session, entry)


@router.delete("/{entry_id}")
def archive_entry(entry_id: str, session: Session = Depends(get_session)):
    entry = session.get(Entry, entry_id)
    if entry:
        entry.archived = True
        session.add(entry)
        session.commit()
    return {"ok": True}


@router.post("/{entry_id}/photos")
async def upload_photo(entry_id: str, file: UploadFile, caption: str = "",
                        session: Session = Depends(get_session)):
    _validate_entry_id(entry_id)
    entry = session.get(Entry, entry_id)
    if not entry:
        raise HTTPException(404, "Entry not found")
    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    if ext not in (".jpg", ".jpeg", ".png", ".webp"):
        raise HTTPException(400, "Unsupported image type")
    filename = f"{entry_id}-{uuid_lib.uuid4().hex[:8]}{ext}"
    with open(os.path.join(PHOTOS_DIR, filename), "wb") as f:
        f.write(await file.read())
    photo = Photo(entry_id=entry_id, filename=filename, uploaded_at=datetime.utcnow(), caption=caption)
    session.add(photo)
    session.commit()
    session.refresh(photo)
    return {"ok": True, "photo_id": photo.id, "filename": filename}


@router.delete("/{entry_id}/photos/{photo_id}")
def delete_photo(entry_id: str, photo_id: int, session: Session = Depends(get_session)):
    photo = session.get(Photo, photo_id)
    if photo and photo.entry_id == entry_id:
        path = os.path.join(PHOTOS_DIR, photo.filename)
        if os.path.exists(path):
            os.remove(path)
        session.delete(photo)
        session.commit()
    return {"ok": True}
