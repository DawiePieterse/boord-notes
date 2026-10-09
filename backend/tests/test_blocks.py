from tests.conftest import add_entry


def _blocks(client):
    return client.get("/api/blocks").json()


def test_create_and_list_with_counts_and_unlisted(client):
    assert client.post("/api/blocks", json={"name": " Block 8a ", "variety": " TMR "}).status_code == 200
    add_entry("e1", "Flush", "", "2026-10-01T08:00:00", block="Block 8a")
    add_entry("e2", "Pump", "", "2026-10-02T08:00:00", block="near the pump station")
    data = _blocks(client)
    assert [(b["name"], b["variety"], b["count"]) for b in data["blocks"]] == [("Block 8a", "TMR", 1)]
    assert data["unlisted"] == [{"name": "near the pump station", "count": 1}]


def test_duplicate_name_refused_ignoring_case(client):
    client.post("/api/blocks", json={"name": "Blok 4"})
    r = client.post("/api/blocks", json={"name": "blok 4"})
    assert r.status_code == 409 and "Blok 4" in r.json()["detail"]
    assert client.post("/api/blocks", json={"name": "  "}).status_code == 400


def test_rename_carries_onto_notes(client):
    block_id = client.post("/api/blocks", json={"name": "Blok 4", "variety": "ED"}).json()["id"]
    add_entry("e1", "Spray", "", "2026-10-01T08:00:00", block="Blok 4")
    r = client.put(f"/api/blocks/{block_id}", json={"name": "Block 4", "variety": "ED"})
    assert r.status_code == 200
    entry = client.get("/api/entries/e1").json()
    assert entry["block"] == "Block 4" and entry["variety"] == "ED"


def test_rename_onto_another_block_refused(client):
    client.post("/api/blocks", json={"name": "Block 1"})
    second = client.post("/api/blocks", json={"name": "Block 2"}).json()["id"]
    assert client.put(f"/api/blocks/{second}", json={"name": "block 1"}).status_code == 409


def test_delete_only_when_unused(client):
    used = client.post("/api/blocks", json={"name": "Block 1"}).json()["id"]
    unused = client.post("/api/blocks", json={"name": "Block 2"}).json()["id"]
    add_entry("e1", "Note", "", "2026-10-01T08:00:00", block="Block 1")
    assert client.delete(f"/api/blocks/{used}").status_code == 400
    assert client.delete(f"/api/blocks/{unused}").status_code == 200
    assert [b["name"] for b in _blocks(client)["blocks"]] == ["Block 1"]


def test_entries_filter_by_block_and_variety(client):
    client.post("/api/blocks", json={"name": "Block 1", "variety": "TMR"})
    client.post("/api/blocks", json={"name": "Block 2", "variety": "TMR"})
    client.post("/api/blocks", json={"name": "Block 3", "variety": "ED"})
    add_entry("e1", "One", "", "2026-10-01T08:00:00", block="Block 1")
    add_entry("e2", "Two", "", "2026-10-02T08:00:00", block="Block 2")
    add_entry("e3", "Three", "", "2026-10-03T08:00:00", block="Block 3")
    ids = lambda qs: [e["id"] for e in client.get(f"/api/entries?{qs}").json()]  # noqa: E731
    assert ids("block=Block%201") == ["e1"]
    assert ids("variety=TMR") == ["e2", "e1"]
    assert ids("variety=ED") == ["e3"]
