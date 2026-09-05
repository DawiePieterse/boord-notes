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
