import base64
import io
import wave

import ai
import speech


def wav(seconds, rate=16000, channels=1):
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * channels * int(rate * seconds))
    return out.getvalue()


def setup(monkeypatch, replies=None):
    """A key, a fresh daily count, and Google replaced by a list of canned
    transcripts. Returns the list of request bodies sent."""
    sent = []
    replies = iter(replies or [])

    def post(key, body):
        sent.append(body)
        return {"results": [{"alternatives": [{"transcript": next(replies)}]}]}

    monkeypatch.setattr(speech, "_api_key", lambda: "test-key")
    monkeypatch.setattr(speech, "_usage", {"day": None, "seconds": 0})
    monkeypatch.setattr(speech, "_post", post)
    return sent


def send(client, audio):
    return client.post("/api/ai/transcribe", files={"file": ("note.wav", audio, "audio/wav")})


def test_sends_afrikaans_and_returns_text(client, monkeypatch):
    sent = setup(monkeypatch, ["rooi spinmyt in blok vier"])
    r = send(client, wav(2))
    assert r.status_code == 200
    assert r.json() == {"text": "rooi spinmyt in blok vier"}
    assert sent[0]["config"]["languageCode"] == "af-ZA"


def test_long_recording_is_split_and_joined_in_order(client, monkeypatch):
    sent = setup(monkeypatch, ["een", "twee", "drie"])
    r = send(client, wav(120))
    assert r.json()["text"] == "een twee drie"
    lengths = [len(base64.b64decode(b["audio"]["content"])) / 32000 for b in sent]
    assert lengths == [55, 55, 10]


def test_silence_is_empty_text(client, monkeypatch):
    setup(monkeypatch)
    monkeypatch.setattr(speech, "_post", lambda key, body: {})
    assert send(client, wav(1)).json() == {"text": ""}


def test_bad_audio_is_refused_before_google(client, monkeypatch):
    sent = setup(monkeypatch)
    assert send(client, b"not audio").status_code == 400
    assert send(client, wav(1, rate=44100)).status_code == 400
    assert send(client, wav(1, channels=2)).status_code == 400
    assert send(client, wav(306)).status_code == 400
    assert sent == []


def test_daily_minutes_limit(client, monkeypatch):
    setup(monkeypatch, ["een"])
    monkeypatch.setattr(speech, "DAILY_SECONDS", 3)
    assert send(client, wav(2)).status_code == 200
    r = send(client, wav(2))
    assert r.status_code == 503
    assert "daily limit" in r.json()["detail"]


def test_no_key(client, monkeypatch):
    monkeypatch.setattr(speech, "_api_key", lambda: "")
    assert send(client, wav(1)).status_code == 503


def test_status_reports_voice_apart_from_claude(client, monkeypatch):
    monkeypatch.setattr(ai, "_api_key", lambda: "")
    monkeypatch.setattr(speech, "_api_key", lambda: "test-key")
    r = client.get("/api/ai/status").json()
    assert r["enabled"] is False
    assert r["voice"] is True
