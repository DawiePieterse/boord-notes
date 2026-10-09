import ai
from routers.ai import TIDY_SYSTEM
from tests.conftest import add_entry, add_tags


# -- status -------------------------------------------------------------

def test_status_off_without_key(client, monkeypatch):
    monkeypatch.setattr(ai, "_api_key", lambda: "")
    r = client.get("/api/ai/status").json()
    assert r["enabled"] is False
    assert r["calls_today"] == 0
    assert r["daily_limit"] == ai.DAILY_LIMIT


def test_status_on_with_key(client, monkeypatch):
    monkeypatch.setattr(ai, "_api_key", lambda: "sk-test")
    assert client.get("/api/ai/status").json()["enabled"] is True


# -- tidy ---------------------------------------------------------------

def test_tidy_snaps_tags(client, fake_claude):
    add_tags("Crop Health & Pests", "Harvest Observations", "Weather & Climate Impact")
    fake = fake_claude({
        "title": "Rooi spinmyt in blok 4",
        "body": "Rooi spinmyt in blok 4. Spuit môre.",
        # misspelt existing tag, a tag already on the note, a new one, and
        # more than four in total
        "suggested_tags": ["crop health & pests", "harvest observations", "Spinmyt",
                           "Weather & Climate Impact", "Extra one", "Extra two"],        "suggested_actions": [],
    })
    r = client.post("/api/ai/tidy", json={
        "title": "", "body": "rooi spinmyt in blok 4 spuit more", "block": "Blok 4",
        "tags": ["Harvest Observations"],
    })
    assert r.status_code == 200, r.text
    tags = r.json()["suggested_tags"]
    assert [t["name"] for t in tags] == ["Crop Health & Pests", "Spinmyt", "Weather & Climate Impact", "Extra one"]
    assert [t["is_new"] for t in tags] == [False, True, False, True]
    assert r.json()["title"] == "Rooi spinmyt in blok 4"
    assert fake.options["max_retries"] == 2
    assert fake.options["timeout"] == 90.0
    assert fake.calls[0]["system"] == TIDY_SYSTEM


def test_tidy_suggests_actions_snapped_to_the_action_list(client, fake_claude):
    from sqlmodel import Session
    from db import engine
    from models import ActionType
    with Session(engine) as session:
        for n in ("Spray", "Water", "Prune"):
            session.add(ActionType(name=n))
        session.commit()
    fake = fake_claude({
        "title": "Spinmyt in blok 4", "body": "Spinmyt in blok 4. Ek het gister natgelei.", "suggested_tags": [],
        # misspelt existing type, one the note already has, a done one, a
        # new kind, a repeat, and more than four in total
        "suggested_actions": [
            {"kind": "spray", "detail": " Abamectin ", "status": "todo"},
            {"kind": "Prune", "detail": "", "status": "todo"},
            {"kind": "Water", "detail": "2 uur", "status": "done"},
            {"kind": "Scout", "detail": "", "status": "todo"},
            {"kind": "SPRAY", "detail": "abamectin", "status": "todo"},
            {"kind": "Mulch", "detail": "", "status": "todo"},
            {"kind": "Pick", "detail": "", "status": "todo"},
        ],
    })
    r = client.post("/api/ai/tidy", json={"body": "spinmyt in blok 4 ek het gister natgelei", "actions": ["prune"]})
    assert r.status_code == 200, r.text
    assert r.json()["suggested_actions"] == [
        {"kind": "Spray", "detail": "Abamectin", "status": "todo", "is_new": False},
        {"kind": "Water", "detail": "2 uur", "status": "done", "is_new": False},
        {"kind": "Scout", "detail": "", "status": "todo", "is_new": True},
        {"kind": "Mulch", "detail": "", "status": "todo", "is_new": True},
    ]
    sent = fake.calls[0]["messages"][0]["content"]
    assert "Existing action types: Prune | Spray | Water" in sent
    assert "Actions already on this note: prune" in sent


def test_tidy_rejects_empty_note(client, fake_claude):
    fake = fake_claude({})
    assert client.post("/api/ai/tidy", json={"body": "   "}).status_code == 400
    assert fake.calls == []


# -- ask ----------------------------------------------------------------

def test_ask_sends_cached_notes_block_and_drops_invented_sources(client, fake_claude):
    add_entry("e1", "Spuit program", "Spuit blok 4 teen spinmyt in Oktober", "2024-10-03T08:00:00")
    add_entry("e2", "Oes", "Oes begin 12 Februarie", "2025-02-12T08:00:00")
    fake = fake_claude({"answer": "In Oktober.", "source_ids": ["e1", "made-up", "e1"]})
    r = client.post("/api/ai/ask", json={"question": "Wanneer spuit ons blok 4?"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["answer"] == "In Oktober."
    assert [s["id"] for s in body["sources"]] == ["e1"]
    assert body["notes_considered"] == 2 and body["notes_total"] == 2

    call = fake.calls[0]
    content = call["messages"][0]["content"]
    assert len(content) == 2
    assert content[0]["cache_control"] == {"type": "ephemeral"}
    assert content[0]["text"].startswith("<notes>\n") and content[0]["text"].endswith("</notes>")
    assert '<note id="e1">' in content[0]["text"] and '<note id="e2">' in content[0]["text"]
    # newest first, so the block comes out the same for the same notes
    assert content[0]["text"].index('<note id="e2">') < content[0]["text"].index('<note id="e1">')
    assert "cache_control" not in content[1]
    assert content[1]["text"] == "Question: Wanneer spuit ons blok 4?"
    assert call["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "no markdown" in call["system"][0]["text"]


def test_ask_uses_no_retries_and_shorter_timeout(client, fake_claude):
    add_entry("e1", "Spuit", "Spuit blok 4", "2024-10-03T08:00:00")
    fake = fake_claude({"answer": "x", "source_ids": []})
    assert client.post("/api/ai/ask", json={"question": "Spuit?"}).status_code == 200
    assert fake.options == {"max_retries": 0, "timeout": 100.0}


def test_ask_with_no_notes_does_not_call_claude(client, fake_claude):
    fake = fake_claude({"answer": "x", "source_ids": []})
    r = client.post("/api/ai/ask", json={"question": "Enigiets?"})
    assert r.status_code == 200 and r.json()["notes_total"] == 0
    assert fake.calls == []


# -- guards -------------------------------------------------------------

def test_daily_limit(client, fake_claude, monkeypatch):
    monkeypatch.setattr(ai, "DAILY_LIMIT", 2)
    fake_claude({"title": "T", "body": "B", "suggested_tags": [], "suggested_actions": []})
    for _ in range(2):
        assert client.post("/api/ai/tidy", json={"body": "iets"}).status_code == 200
    r = client.post("/api/ai/tidy", json={"body": "iets"})
    assert r.status_code == 503
    assert "daily limit" in r.json()["detail"]
    assert client.get("/api/ai/status").json()["calls_today"] == 2


def test_refusal_is_a_plain_503(client, fake_claude):
    fake_claude({"title": "", "body": "", "suggested_tags": [], "suggested_actions": []}, stop_reason="refusal")
    r = client.post("/api/ai/tidy", json={"body": "iets"})
    assert r.status_code == 503
    assert "declined" in r.json()["detail"]


# -- choosing notes -----------------------------------------------------

def test_select_entries_keyword_fallback(monkeypatch):
    entries = [
        {"id": "a", "title": "Oes", "body": "Oes begin in Februarie", "block": "", "tags": [],
         "created_at": "2025-02-01T00:00:00"},
        {"id": "b", "title": "Spuit", "body": "Spuit blok 4 teen spinmyt", "block": "Blok 4", "tags": [],
         "created_at": "2024-10-01T00:00:00"},
        {"id": "c", "title": "Werkers", "body": "Nuwe span begin Maandag", "block": "", "tags": [],
         "created_at": "2025-03-01T00:00:00"},
    ]
    assert ai.select_entries("spinmyt", entries) == entries  # everything fits
    one = max(len(ai.entry_text(e)) for e in entries)
    monkeypatch.setattr(ai, "CONTEXT_CHAR_BUDGET", one)  # room for one note only
    assert [e["id"] for e in ai.select_entries("Wanneer spuit ons vir spinmyt?", entries)] == ["b"]
