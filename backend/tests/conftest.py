"""Test setup. The data folder is decided when db.py is imported, so the
scratch folder has to be chosen before anything from the app is imported."""
import os
import sys
import tempfile

os.environ["NB_DATA_DIR"] = tempfile.mkdtemp(prefix="nb-test-")
os.environ.pop("ANTHROPIC_API_KEY", None)  # the app must come up without a key
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import json  # noqa: E402
from datetime import datetime  # noqa: E402
from types import SimpleNamespace  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import Session, SQLModel  # noqa: E402

import ai  # noqa: E402
from db import engine  # noqa: E402
from main import app  # noqa: E402
from models import Entry, EntryTagLink, Tag  # noqa: E402


@pytest.fixture
def client():
    """A fresh, empty database per test. Startup events are not run, so no
    backup thread starts and the starter tags are not seeded."""
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    return TestClient(app)


@pytest.fixture(autouse=True)
def reset_usage(monkeypatch):
    monkeypatch.setattr(ai, "_usage", {"day": None, "count": 0})
    monkeypatch.setattr(ai, "_client", None)


class FakeClient:
    """Stands in for anthropic.Anthropic: records what was sent, returns a
    canned reply, never touches the network."""

    def __init__(self, payload: dict, stop_reason: str = "end_turn"):
        self.payload = payload
        self.stop_reason = stop_reason
        self.options: dict = {}
        self.calls: list = []
        self.messages = SimpleNamespace(create=self._create)

    def with_options(self, **kw):
        self.options = kw
        return self

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        return SimpleNamespace(
            stop_reason=self.stop_reason,
            content=[SimpleNamespace(type="text", text=json.dumps(self.payload))],
            usage=SimpleNamespace(input_tokens=10, output_tokens=5,
                                  cache_read_input_tokens=0, cache_creation_input_tokens=0),
        )


@pytest.fixture
def fake_claude(monkeypatch):
    """fake_claude({...}) installs a FakeClient that answers with that JSON."""
    def install(payload: dict, stop_reason: str = "end_turn") -> FakeClient:
        fake = FakeClient(payload, stop_reason)
        monkeypatch.setattr(ai, "_get_client", lambda: fake)
        return fake
    return install


def add_tags(*names: str) -> None:
    with Session(engine) as session:
        for name in names:
            session.add(Tag(name=name))
        session.commit()


def add_entry(entry_id: str, title: str, body: str, created: str, tags=(), block: str = "") -> None:
    with Session(engine) as session:
        session.add(Entry(id=entry_id, title=title, body=body, block=block,
                          created_at=datetime.fromisoformat(created)))
        for name in tags:
            tag = Tag(name=name)
            session.add(tag)
            session.flush()
            session.add(EntryTagLink(entry_id=entry_id, tag_id=tag.id))
        session.commit()
