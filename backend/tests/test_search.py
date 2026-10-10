"""Full-text search (FTS5) and an action's day (due_on)."""
import db
from tests.conftest import add_entry


def test_full_text_search(client):
    # The fixture recreates the entry table; the index and its triggers are
    # rebuilt here so the test sees what a real startup builds.
    with db.engine.begin() as conn:
        for t in ("entry_fts_ai", "entry_fts_ad", "entry_fts_au"):
            conn.exec_driver_sql(f"DROP TRIGGER IF EXISTS {t}")
        conn.exec_driver_sql("DROP TABLE IF EXISTS entry_fts")
    add_entry("e1", "Spuitprogram", "Rooi spinmyt in blok 4. Spuit môre.", "2026-10-01T08:00:00")
    db.ensure_fts()
    assert db.FTS_READY
    try:
        add_entry("e2", "Flush op 8b", "Gé die bome water", "2026-10-02T08:00:00", block="8b")
        ids = lambda q: [e["id"] for e in client.get(f"/api/entries?q={q}").json()]  # noqa: E731
        assert ids("spuit") == ["e1"]            # a word start, any case
        assert ids("more") == ["e1"]             # without the accent finds môre
        assert ids("GE") == ["e2"]               # and the other way round
        assert ids("spuit blok") == ["e1"]       # every word must match
        assert ids("8b") == ["e2"]
        assert ids('"weird) OR') == []           # punctuation is quoted, not syntax
        client.post("/api/entries", json={"id": "e2", "title": "Flush op 8b", "body": "Niks", "block": "8b"})
        assert ids("water") == []                # the index follows an edit
    finally:
        db.FTS_READY = False


def test_action_due_on(client):
    client.post("/api/entries", json={"id": "e3", "title": "t",
                                      "actions": [{"id": "a3", "kind": "Prune", "due_on": "2026-11-01"}]})
    assert client.get("/api/actions?status=todo").json()[0]["due_on"] == "2026-11-01"
    r = client.patch("/api/actions/a3", json={"due_on": None}).json()
    assert r["due_on"] is None and r["status"] == "todo"
    r = client.patch("/api/actions/a3", json={"due_on": "2026-12-01"}).json()
    assert r["due_on"] == "2026-12-01" and r["status"] == "todo"
    r = client.patch("/api/actions/a3", json={"status": "done"}).json()
    assert r["status"] == "done" and r["due_on"] == "2026-12-01"
