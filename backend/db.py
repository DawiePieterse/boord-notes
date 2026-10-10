import os
from datetime import datetime, timezone

from sqlalchemy import inspect, text
from sqlmodel import SQLModel, Session, create_engine, func, select

from models import ActionType, Entry, Tag

# NB_DATA_DIR lets the tests (and a preview) point the app at a scratch
# folder; a real install never sets it and gets ../data as before.
DATA_DIR = os.environ.get("NB_DATA_DIR") or os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(DATA_DIR, exist_ok=True)
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
os.makedirs(PHOTOS_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "notebook.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def utcnow() -> datetime:
    """Now in UTC, without a timezone marker - every timestamp in the
    notebook is stored that way (SQLite keeps no zone), and the app pins
    them back to UTC when it reads them. datetime.utcnow() is deprecated."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

# Starter tag suggestions so Andre isn't starting from a completely blank
# list - free-form after this, he can add/drop tags as he actually uses them.
STARTER_TAGS = [
    "Crop Health & Pests", "Fruit Development & Ripening", "Harvest Observations",
    "Weather & Climate Impact", "Worker & Team Notes", "Equipment & Maintenance",
    "Block Maintenance", "Quality & Post-Harvest", "Safety & Incidents",
    "Ideas & Improvements", "General Observations",
]


# The actions the farm team named first; more are added from the Capture
# screen or Settings as they come up.
STARTER_ACTIONS = ["Spray", "Water", "Fertilise", "Prune", "Pick", "Scout"]


def _column_ddl(column, dialect) -> str:
    """ADD COLUMN clause for a model column missing from a live table."""
    ddl = f'"{column.name}" {column.type.compile(dialect)}'
    if column.nullable:
        return ddl
    default = getattr(column.default, "arg", None) if column.default is not None else None
    if default is None or callable(default):
        # Nothing to backfill existing rows with, and SQLite won't accept a
        # NOT NULL column without a default. Adding it nullable keeps the
        # notebook running; a fresh install still gets the strict schema.
        return ddl
    literal = "'{}'".format(str(default).replace("'", "''")) if isinstance(default, str) else str(default)
    return f"{ddl} NOT NULL DEFAULT {literal}"


def _add_missing_columns() -> None:
    """Bring an existing database up to the current models, columns and
    indexes.

    create_all() only ever creates whole tables, so a notebook upgraded in
    place would keep its old columns and every query touching a new field
    would fail with "no such column" - which for this app means Andre's
    existing entries become unreadable. Strictly additive: it never drops or
    alters a column, so downgrading is just running the old code.
    """
    inspector = inspect(engine)
    live_tables = set(inspector.get_table_names())
    for table in SQLModel.metadata.sorted_tables:
        if table.name not in live_tables:
            continue  # create_all() just built it, columns and all
        present = {c["name"] for c in inspector.get_columns(table.name)}
        for column in [c for c in table.columns if c.name not in present]:
            with engine.begin() as conn:
                conn.execute(text(
                    f'ALTER TABLE "{table.name}" ADD COLUMN {_column_ddl(column, engine.dialect)}'))
            print(f"[migration] {table.name}: added column {column.name}")
        present_indexes = {i["name"] for i in inspector.get_indexes(table.name)}
        for index in [i for i in table.indexes if i.name not in present_indexes]:
            index.create(engine)
            print(f"[migration] {table.name}: added index {index.name}")


# Full-text search over notes. FTS5 ships with the SQLite in every CPython
# build this app runs on; should one lack it, the flag stays False and the
# entries route falls back to plain matching, so search never breaks.
FTS_READY = False

_FTS_DDL = [
    'CREATE VIRTUAL TABLE IF NOT EXISTS entry_fts USING fts5('
    'id UNINDEXED, title, body, block, tokenize="unicode61 remove_diacritics 2")',
    'CREATE TRIGGER IF NOT EXISTS entry_fts_ai AFTER INSERT ON entry BEGIN '
    'INSERT INTO entry_fts(id, title, body, block) VALUES (new.id, new.title, new.body, new.block); END',
    'CREATE TRIGGER IF NOT EXISTS entry_fts_ad AFTER DELETE ON entry BEGIN '
    'DELETE FROM entry_fts WHERE id = old.id; END',
    'CREATE TRIGGER IF NOT EXISTS entry_fts_au AFTER UPDATE OF title, body, block ON entry BEGIN '
    'DELETE FROM entry_fts WHERE id = old.id; '
    'INSERT INTO entry_fts(id, title, body, block) VALUES (new.id, new.title, new.body, new.block); END',
]


def ensure_fts() -> None:
    """Create the search index and the triggers that keep it current; fill
    it from the notes already there the first time."""
    global FTS_READY
    try:
        with engine.begin() as conn:
            fresh = conn.exec_driver_sql(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_fts'").first() is None
            for ddl in _FTS_DDL:
                conn.exec_driver_sql(ddl)
            if fresh:
                conn.exec_driver_sql(
                    "INSERT INTO entry_fts(id, title, body, block) SELECT id, title, body, block FROM entry")
                print("[search] full-text index built")
        FTS_READY = True
    except Exception as e:  # noqa: BLE001 - whatever SQLite objects to, search still works
        FTS_READY = False
        print(f"[search] full-text index unavailable ({e}); using plain matching")


def fts_match(q: str):
    """The ids of the notes matching every word of `q` at a word start, as a
    subquery. Each word is quoted, so punctuation in a search can't reach
    the FTS5 query syntax."""
    terms = [t for t in q.split() if t]
    match = " ".join('"{}"*'.format(t.replace('"', '""')) for t in terms)
    return select(text("id")).select_from(text("entry_fts")).where(text("entry_fts MATCH :m")).params(m=match)


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()
    ensure_fts()


def get_session():
    with Session(engine) as session:
        yield session


def live_counts(session: Session, column, *joins, where=()) -> dict:
    """{value of `column`: how many of them are on live notes}, in one
    GROUP BY. `joins` are (model, on-clause) pairs leading from the column's
    table to Entry when it isn't Entry itself.

    Archived notes are excluded deliberately: these counts sit beside each
    tag, block and action in the Entries filters, and counting archived
    notes made a filter advertise results it would never return. It also
    kept a name used only by archived notes from being removable in
    Settings, so one left behind by an archived note could never be tidied
    away."""
    query = select(column, func.count())
    for model, on in joins:
        query = query.join(model, on)
    query = query.where(Entry.archived == False, *where).group_by(column)  # noqa: E712
    return dict(session.exec(query).all())


def seed_defaults() -> None:
    """Starter tags and action types only. No accounts are created: the app has no sign-in, and
    reaching it over the tailnet is the whole of its access control."""
    with Session(engine) as session:
        if not session.exec(select(Tag)).first():
            for name in STARTER_TAGS:
                session.add(Tag(name=name))
        # Seeded separately: a notebook upgraded from before actions existed
        # already has its tags, and still needs the starter actions.
        if not session.exec(select(ActionType)).first():
            for name in STARTER_ACTIONS:
                session.add(ActionType(name=name))

        session.commit()
