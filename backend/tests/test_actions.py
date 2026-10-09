from sqlmodel import Session

from db import engine
from models import ActionType


def _types(*names):
    with Session(engine) as session:
        for n in names:
            session.add(ActionType(name=n))
        session.commit()


def _note(client, entry_id, actions, **extra):
    r = client.post("/api/entries", json={"id": entry_id, "title": extra.pop("title", "Note"),
                                          "actions": actions, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def test_note_carries_several_actions_and_kinds_join_existing_types(client):
    _types("Prune", "Fertilise")
    out = _note(client, "e1", [
        {"id": "a1", "kind": "prune"},
        {"id": "a2", "kind": "Fertilise", "detail": " LAN ", "status": "done", "done_at": "2026-10-09T07:00:00"},
        {"id": "a3", "kind": "Mulch"},
    ])
    acts = {a["id"]: a for a in out["actions"]}
    assert acts["a1"]["kind"] == "Prune" and acts["a1"]["status"] == "todo"
    assert acts["a2"]["detail"] == "LAN" and str(acts["a2"]["done_at"]).startswith("2026-10-09T07:00")
    assert [a["status"] for a in out["actions"]] == ["todo", "todo", "done"]
    types = {t["name"]: t["count"] for t in client.get("/api/action-types").json()}
    assert types == {"Fertilise": 1, "Mulch": 1, "Prune": 1}


def test_resending_a_note_replaces_its_actions_without_duplicating(client):
    _note(client, "e1", [{"id": "a1", "kind": "Prune"}, {"id": "a2", "kind": "Water"}])
    out = _note(client, "e1", [{"id": "a1", "kind": "Prune", "detail": "lower branches"}])
    assert [(a["id"], a["detail"]) for a in out["actions"]] == [("a1", "lower branches")]


def test_todo_list_and_mark_done(client):
    client.post("/api/blocks", json={"name": "8a", "variety": "TMR"})
    _note(client, "e1", [{"id": "a1", "kind": "Prune"}], block="8a", title="Flush", created_at="2026-10-01T08:00:00")
    _note(client, "e2", [{"id": "a2", "kind": "Water"}], created_at="2026-10-05T08:00:00")
    _note(client, "e3", [{"id": "a3", "kind": "Pick"}])
    client.delete("/api/entries/e3")   # archived notes drop off the list

    todo = client.get("/api/actions").json()
    assert [a["id"] for a in todo] == ["a1", "a2"]
    assert todo[0]["entry_title"] == "Flush" and todo[0]["block"] == "8a" and todo[0]["variety"] == "TMR"

    r = client.patch("/api/actions/a1", json={"status": "done", "done_at": "2026-10-09T10:00:00", "done_note": "Cut back"})
    assert r.status_code == 200 and r.json()["done_note"] == "Cut back"
    assert [a["id"] for a in client.get("/api/actions").json()] == ["a2"]
    assert [a["id"] for a in client.get("/api/actions?status=done").json()] == ["a1"]
    assert client.get("/api/entries/e1").json()["actions"][0]["status"] == "done"

    client.patch("/api/actions/a1", json={"status": "todo"})
    assert {a["id"] for a in client.get("/api/actions").json()} == {"a1", "a2"}
    assert client.patch("/api/actions/nope", json={"status": "done"}).status_code == 404


def test_action_types_add_and_remove_only_when_unused(client):
    assert client.post("/api/action-types", json={"name": "Prune"}).status_code == 200
    assert client.post("/api/action-types", json={"name": "prune"}).status_code == 409
    _note(client, "e1", [{"id": "a1", "kind": "Prune"}])
    assert client.delete("/api/action-types/Prune").status_code == 400
    client.post("/api/action-types", json={"name": "Scout"})
    assert client.delete("/api/action-types/Scout").status_code == 200
    assert [t["name"] for t in client.get("/api/action-types").json()] == ["Prune"]


def test_ask_sees_actions(client):
    import ai
    out = _note(client, "e1", [{"id": "a1", "kind": "Fertilise", "detail": "LAN"},
                               {"id": "a2", "kind": "Water", "status": "done", "done_at": "2026-10-09T07:00:00",
                                "done_note": "2 hours"}])
    text = ai.entry_text(out)
    assert "Actions: Fertilise with LAN (to do); Water (done 2026-10-09, used 2 hours)" in text
