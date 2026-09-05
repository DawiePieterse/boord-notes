import os

from sqlalchemy import inspect, text
from sqlmodel import SQLModel, Session, create_engine, select

from models import Tag

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(DATA_DIR, exist_ok=True)
PHOTOS_DIR = os.path.join(DATA_DIR, "photos")
os.makedirs(PHOTOS_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "notebook.db")
DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

# Starter tag suggestions so Andre isn't starting from a completely blank
# list - free-form after this, he can add/drop tags as he actually uses them.
STARTER_TAGS = [
    "Crop Health & Pests", "Fruit Development & Ripening", "Harvest Observations",
    "Weather & Climate Impact", "Worker & Team Notes", "Equipment & Maintenance",
    "Block Maintenance", "Quality & Post-Harvest", "Safety & Incidents",
    "Ideas & Improvements", "General Observations",
]


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
    """Bring an existing database up to the current models.

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


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)
    _add_missing_columns()


def get_session():
    with Session(engine) as session:
        yield session


def seed_defaults() -> None:
    """Starter tags only. No accounts are created: the app has no sign-in, and
    reaching it over the tailnet is the whole of its access control."""
    with Session(engine) as session:
        if not session.exec(select(Tag)).first():
            for name in STARTER_TAGS:
                session.add(Tag(name=name))

        session.commit()
