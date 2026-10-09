from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, func, select

from db import get_session
from models import ActionType, Entry, EntryAction, Photo
from names import clean_name, refuse_duplicate
from routers.entries import _varieties, action_out

router = APIRouter(tags=["actions"])


# ---------------------------------------------------------------------
# Action types - the Prune / Fertilise / Water list. Managed like tags.
# ---------------------------------------------------------------------
class ActionTypeIn(SQLModel):
    name: str


def _live_counts(session: Session) -> dict:
    """{kind: how many actions on live notes use it} - archived notes left
    out, for the same reason as the tag counts (routers/tags.py)."""
    return dict(session.exec(
        select(EntryAction.kind, func.count())
        .join(Entry, Entry.id == EntryAction.entry_id)
        .where(Entry.archived == False)  # noqa: E712
        .group_by(EntryAction.kind)
    ).all())


@router.get("/api/action-types")
def list_action_types(session: Session = Depends(get_session)):
    counts = _live_counts(session)
    types = [{"name": t.name, "count": counts.get(t.name, 0)} for t in session.exec(select(ActionType)).all()]
    types.sort(key=lambda t: t["name"].lower())
    return types


@router.post("/api/action-types")
def create_action_type(payload: ActionTypeIn, session: Session = Depends(get_session)):
    name = clean_name(payload.name, "Action name")
    refuse_duplicate(session.exec(select(ActionType.name)).all(), name, "Action")
    session.add(ActionType(name=name))
    session.commit()
    return {"name": name, "count": 0}


@router.delete("/api/action-types/{name}")
def delete_action_type(name: str, session: Session = Depends(get_session)):
    """Only while no live note uses it. Actions on archived notes keep the
    name as text, which is all an action ever stored."""
    action_type = session.exec(select(ActionType).where(ActionType.name == name)).first()
    if not action_type:
        raise HTTPException(404, "Action not found")
    if _live_counts(session).get(name, 0) > 0:
        raise HTTPException(400, "Action is still used by notes")
    session.delete(action_type)
    session.commit()
    return {"ok": True}


# ---------------------------------------------------------------------
# The To do list, and ticking things off
# ---------------------------------------------------------------------
@router.get("/api/actions")
def list_actions(status: str = "todo", session: Session = Depends(get_session)):
    """Actions on live notes, oldest note first - the longest-waiting job
    leads. Each carries what the To do screen shows of its note."""
    rows = session.exec(
        select(EntryAction, Entry).join(Entry, Entry.id == EntryAction.entry_id)
        .where(Entry.archived == False, EntryAction.status == status)  # noqa: E712
        .order_by(Entry.created_at)
    ).all()
    entry_ids = list({e.id for _, e in rows})
    first_photo: dict = {}
    if entry_ids:
        for p in session.exec(select(Photo).where(Photo.entry_id.in_(entry_ids)).order_by(Photo.id)).all():
            first_photo.setdefault(p.entry_id, p.filename)
    varieties = _varieties(session)
    return [{
        **action_out(a),
        "entry_id": e.id, "entry_title": e.title, "entry_created_at": e.created_at,
        "block": e.block, "variety": varieties.get(e.block, ""),
        "photo": first_photo.get(e.id),
    } for a, e in rows]


class ActionUpdate(SQLModel):
    status: str
    done_at: Optional[datetime] = None
    done_note: str = ""


@router.patch("/api/actions/{action_id}")
def update_action(action_id: str, payload: ActionUpdate, session: Session = Depends(get_session)):
    """Mark an action done (or back to do) without resending its whole note.
    done_at is the phone's own time, so a job ticked off out of signal is
    dated when it was done, not when it synced."""
    action = session.get(EntryAction, action_id)
    if not action:
        raise HTTPException(404, "Action not found")
    if payload.status == "done":
        action.status = "done"
        action.done_at = payload.done_at or datetime.utcnow()
        action.done_note = payload.done_note.strip()
    else:
        action.status, action.done_at, action.done_note = "todo", None, ""
    session.add(action)
    session.commit()
    return action_out(action)
