from tests.conftest import add_tags


def test_create_tag_shows_as_unused(client):
    r = client.post("/api/tags", json={"name": "  Pruning  "})
    assert r.status_code == 200
    assert r.json() == {"name": "Pruning", "count": 0}
    assert {"name": "Pruning", "count": 0} in client.get("/api/tags").json()


def test_create_tag_refuses_case_duplicate(client):
    add_tags("Pruning")
    r = client.post("/api/tags", json={"name": "pruning"})
    assert r.status_code == 409
    assert "Pruning" in r.json()["detail"]
    assert [t["name"] for t in client.get("/api/tags").json()] == ["Pruning"]


def test_create_tag_refuses_empty_and_overlong(client):
    assert client.post("/api/tags", json={"name": "   "}).status_code == 400
    assert client.post("/api/tags", json={"name": "x" * 61}).status_code == 400
    assert client.get("/api/tags").json() == []
