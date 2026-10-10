from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, SQLModel, select

from db import get_session, live_counts
from names import clean_name, refuse_duplicate
from models import Block, Entry

router = APIRouter(prefix="/api/blocks", tags=["blocks"])


class BlockIn(SQLModel):
    name: str
    variety: str = ""


def _live_counts(session: Session) -> dict:
    """{block text: number of live notes naming it}."""
    return live_counts(session, Entry.block, where=(Entry.block != "",))


def _clean(payload: BlockIn) -> BlockIn:
    return BlockIn(name=clean_name(payload.name, "Block name"),
                   variety=clean_name(payload.variety, "Block type", required=False))


def _refuse_duplicate(session: Session, name: str, except_id=None) -> None:
    """Ignoring case - "blok 4" beside "Blok 4" would split one block's notes
    across two filters (see names.py)."""
    others = [b.name for b in session.exec(select(Block)).all() if b.id != except_id]
    refuse_duplicate(others, name, "Block")


@router.get("")
def list_blocks(session: Session = Depends(get_session)):
    """The block list with live note counts, plus `unlisted`: block text on
    notes that matches no block on the list - typed before the list existed,
    or a spot rather than a block - so Settings can offer to add them."""
    counts = _live_counts(session)
    blocks = session.exec(select(Block)).all()
    names = {b.name for b in blocks}
    listed = [{"id": b.id, "name": b.name, "variety": b.variety, "count": counts.get(b.name, 0)}
              for b in blocks]
    listed.sort(key=lambda b: b["name"].lower())
    unlisted = [{"name": n, "count": c} for n, c in counts.items() if n not in names]
    unlisted.sort(key=lambda b: b["name"].lower())
    return {"blocks": listed, "unlisted": unlisted}


@router.post("")
def create_block(payload: BlockIn, session: Session = Depends(get_session)):
    payload = _clean(payload)
    _refuse_duplicate(session, payload.name)
    block = Block(name=payload.name, variety=payload.variety)
    session.add(block)
    session.commit()
    session.refresh(block)
    return {"id": block.id, "name": block.name, "variety": block.variety}


@router.put("/{block_id}")
def update_block(block_id: int, payload: BlockIn, session: Session = Depends(get_session)):
    """Edit a block's name or variety. A new name is carried onto every note
    that named the old one, archived notes included - otherwise a typo fixed
    here would strand all the notes already filed under it."""
    block = session.get(Block, block_id)
    if not block:
        raise HTTPException(404, "Block not found")
    payload = _clean(payload)
    _refuse_duplicate(session, payload.name, except_id=block.id)
    if payload.name != block.name:
        for entry in session.exec(select(Entry).where(Entry.block == block.name)).all():
            entry.block = payload.name
            session.add(entry)
    block.name, block.variety = payload.name, payload.variety
    session.add(block)
    session.commit()
    return {"id": block.id, "name": block.name, "variety": block.variety}


@router.delete("/{block_id}")
def delete_block(block_id: int, session: Session = Depends(get_session)):
    """Only while no live note names it, as with tags. Archived notes keep the
    name as plain text, which is all a note ever stored."""
    block = session.get(Block, block_id)
    if not block:
        raise HTTPException(404, "Block not found")
    if _live_counts(session).get(block.name, 0) > 0:
        raise HTTPException(400, "Block is still used by notes")
    session.delete(block)
    session.commit()
    return {"ok": True}
