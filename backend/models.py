from datetime import datetime
from typing import Optional

from sqlmodel import Field, SQLModel


class User(SQLModel, table=True):
    """Not an account any more - the app has no sign-in. This survives purely
    as the author record that entries captured before the sign-in was removed
    still point at, so their "captured by Andre" line keeps working.

    password_hash and role are deliberately no longer mapped. The columns are
    still in an existing notebook.db, because the migration in db.py is
    strictly additive and never drops anything, but nothing reads them and
    nothing writes a new row here. A fresh install creates the table empty and
    it stays that way."""
    id: Optional[int] = Field(default=None, primary_key=True)
    username: str = Field(unique=True)
    display_name: str = ""


class Tag(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)


class Block(SQLModel, table=True):
    """The farm's own list of blocks, kept in Notes - not read from the
    harvest app, which stays independent (see Entry.block). Picking from the
    list keeps one block under one spelling, so it can be filtered on.

    An entry still records the block by NAME, as text: notes written before
    the list existed, and spots like "near the pump station", keep working,
    and a note captured offline needs nothing from the server to name its
    block. Renaming a block renames it on its notes too (routers/blocks.py).
    The variety is the block's crop type, e.g. "TMR" - it is looked up from
    here, not stored on each note."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)
    variety: str = ""


class ActionType(SQLModel, table=True):
    """The kinds of action a note can lead to - Prune, Fertilise, Water...
    Like Tag: a starter set, then whatever Andre adds, kept to one spelling
    each (names.py)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str = Field(unique=True, index=True)


class EntryAction(SQLModel, table=True):
    """Something a note says to do, or records as done: "Prune", "Fertilise
    with LAN". A note can carry several. The id comes from the phone, like
    Entry.id, so an action created or ticked off offline syncs without
    duplicating. The kind is stored by name, as a note stores its block."""
    id: str = Field(primary_key=True)
    entry_id: str = Field(foreign_key="entry.id", index=True)
    kind: str
    detail: str = ""           # with what - free text, e.g. "Copper oxychloride 2 kg/ha"
    status: str = "todo"       # "todo" or "done"
    done_at: Optional[datetime] = None
    done_note: str = ""        # what was actually used, if it differed


class EntryTagLink(SQLModel, table=True):
    entry_id: str = Field(foreign_key="entry.id", primary_key=True)
    tag_id: int = Field(foreign_key="tag.id", primary_key=True)


class Entry(SQLModel, table=True):
    """id is a client-generated UUID, not autoincrement - this is what makes
    offline sync safe to retry (idempotent upsert by id), matching the
    harvest app's HarvestRecord.uuid pattern."""
    id: str = Field(primary_key=True)
    title: str = ""
    body: str = ""
    block: str = ""  # free text, e.g. "Block 4 North" - deliberately not an
    # FK into the harvest app's Block table; the two apps are independent,
    # this is just a naming convention for cross-reference.
    # Set only on entries captured while the app had accounts; None since.
    created_by_id: Optional[int] = Field(default=None, foreign_key="user.id")
    created_at: datetime
    updated_at: Optional[datetime] = None
    updated_by_id: Optional[int] = Field(default=None, foreign_key="user.id")
    archived: bool = False  # soft delete - mirrors Worker.active/Block.active.
    # A fat-fingered delete on hard-won farm knowledge must be recoverable.

    # Where Andre was standing when he captured the note, from the phone's own
    # GPS. Optional throughout: the fix can be refused, unavailable indoors, or
    # simply not ready yet, and none of that may block saving a note.
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    location_accuracy_m: Optional[float] = None

    # Conditions at that spot at the moment of capture. Only ever filled in
    # when the phone had a connection at the time - looking it up later would
    # record the weather when the note synced, which for a note about, say,
    # sunburn on fruit would be actively misleading. Blank means "not known",
    # never "nothing to report".
    weather_temp: Optional[float] = None
    weather_humidity: Optional[float] = None
    weather_condition: str = ""


class Photo(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    entry_id: str = Field(foreign_key="entry.id")
    filename: str
    uploaded_at: datetime
    caption: str = ""
