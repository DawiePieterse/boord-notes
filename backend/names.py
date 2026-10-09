"""The one set of rules for a tag or block name, shared by every route that
creates one.

Names are compared ignoring case so "pruning" never splits off from
"Pruning" - one tag or block under two spellings means one filter that only
finds half the notes. The comparison is done in Python, not SQL: SQLite's
case folding is ASCII-only and mishandles the Afrikaans diacritics (ë, é)
that dictated notes contain."""
from typing import Iterable, Optional

from fastapi import HTTPException

MAX_NAME = 60


def clean_name(raw: str, label: str, required: bool = True) -> str:
    """Strip it, and refuse an empty (when required) or overlong one."""
    name = (raw or "").strip()
    if required and not name:
        raise HTTPException(400, f"{label} is empty")
    if len(name) > MAX_NAME:
        raise HTTPException(400, f"{label} is too long")
    return name


def same_name(names: Iterable[str], name: str) -> Optional[str]:
    """The existing spelling of `name`, ignoring case, or None."""
    wanted = name.lower()
    return next((n for n in names if n.lower() == wanted), None)


def refuse_duplicate(names: Iterable[str], name: str, label: str) -> None:
    existing = same_name(names, name)
    if existing is not None:
        raise HTTPException(409, f"{label} already exists: {existing}")
