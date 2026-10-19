"""GET /api/version: the shape Boord's heartbeat.ps1 and Boord Monitor read
from every sibling app, so a renamed field breaks them silently."""
import re

from routers import version


def test_version_shape(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    data = r.json()
    assert data["app"] == "Boord Notes"
    assert data["state"] in ("release", "ahead", "unknown")
    with open(version.API_JS, encoding="utf-8") as fh:
        expected = re.search(r'^  VERSION: "(.*)",$', fh.read(), re.MULTILINE).group(1)
    assert data["frontend_version"] == expected != ""
    assert data["version"] == expected


def test_version_states(client, monkeypatch):
    # On a release checkout --exact-match names the tag.
    monkeypatch.setattr(version, "_git", lambda args: "v2.16" if "--exact-match" in args else "")
    assert client.get("/api/version").json()["state"] == "release"
    assert client.get("/api/version").json()["tag"] == "v2.16"
    # Past the last tag: the describe string, and "ahead".
    monkeypatch.setattr(version, "_git",
                        lambda args: "" if "--exact-match" in args else "v2.16-3-gabc1234")
    data = client.get("/api/version").json()
    assert (data["tag"], data["state"]) == ("v2.16-3-gabc1234", "ahead")
    # No git at all: still answers, never a 500.
    monkeypatch.setattr(version, "_git", lambda args: "")
    data = client.get("/api/version").json()
    assert (data["tag"], data["state"]) == (None, "unknown")


def test_health_unchanged(client):
    assert client.get("/api/health").json() == {"ok": True}
