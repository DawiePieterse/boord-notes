from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, func, select

from db import get_session
from names import clean_name, refuse_duplicate
from models import Entry, EntryTagLink, Tag

router = APIRouter(prefix="/api/tags", tags=["tags"])


def _live_counts(session: Session) -> dict:
    """{tag id: how many entries you'd actually see filtering by it}.

    Archived entries are excluded deliberately: the count is shown next to
    each tag in the Entries filter, and counting notes that were archived
    made a tag advertise results it would never return. It also kept
    archived-only tags from being removable in Settings, so a tag left
    behind by an archived note could never be tidied away."""
    return dict(session.exec(
        select(EntryTagLink.tag_id, func.count())
        .join(Entry, Entry.id == EntryTagLink.entry_id)
        .where(Entry.archived == False)  # noqa: E712
        .group_by(EntryTagLink.tag_id)
    ).all())


@router.get("")
def list_tags(session: Session = Depends(get_session)):
    """All known tags with how many (non-archived) entries use each - for
    autocomplete while typing and the filter chip list."""
    counts = _live_counts(session)
    tags = session.exec(select(Tag)).all()
    result = [{"name": t.name, "count": counts.get(t.id, 0)} for t in tags]
    result.sort(key=lambda r: r["name"].lower())
    return result


class TagIn(SQLModel):
    name: str


@router.post("")
def create_tag(payload: TagIn, session: Session = Depends(get_session)):
    """Add a tag before any note uses it, from Settings - so a set of
    tags can be laid out up front instead of only ever appearing while a
    note is being written.

    A name that differs from an existing tag only by case is refused rather
    than added - see names.py."""
    name = clean_name(payload.name, "Tag name")
    refuse_duplicate(session.exec(select(Tag.name)).all(), name, "Tag")
    session.add(Tag(name=name))
    session.commit()
    return {"name": name, "count": 0}


@router.delete("/{name}")
def delete_tag(name: str, session: Session = Depends(get_session)):
    """Delete a tag outright - only allowed while no live entry uses it, so
    this can never silently detach a tag from something Andre is still using
    it on. Renaming/merging tags is not supported.

    "Live" matches the count shown in the UI: a tag left over from entries
    that have all been archived counts as unused and can be tidied away. Its
    leftover links are removed with it, since a link to a deleted tag would
    otherwise dangle."""
    tag = session.exec(select(Tag).where(Tag.name == name)).first()
    if not tag:
        raise HTTPException(404, "Tag not found")
    if _live_counts(session).get(tag.id, 0) > 0:
        raise HTTPException(400, "Tag is still used by entries")
    for link in session.exec(select(EntryTagLink).where(EntryTagLink.tag_id == tag.id)).all():
        session.delete(link)
    session.delete(tag)
    session.commit()
    return {"ok": True}
