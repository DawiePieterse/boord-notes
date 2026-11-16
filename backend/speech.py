"""Afrikaans speech to text, through Google Cloud Speech-to-Text.

Apple's keyboard dictation has no Afrikaans (it hears Afrikaans as South
African English), and a web app can't change that, so the phone records the
note itself and this module turns it into text. Like ai.py it is an optional
extra: without a key the record button stays hidden and nothing else changes.

The audio is only passed through. Nothing here writes it to disk.

Configuration (all optional except the key):
  GOOGLE_SPEECH_API_KEY  or  data/google_speech_key.txt   the API key
  NB_VOICE_DAILY_MINUTES  minutes of audio per day, default 60
"""
import base64
import io
import json
import math
import os
import threading
import urllib.error
import urllib.request
import wave
from datetime import date
from typing import List

from ai import AiUnavailable
from db import DATA_DIR

KEY_FILE = os.path.join(DATA_DIR, "google_speech_key.txt")
DAILY_SECONDS = int(os.environ.get("NB_VOICE_DAILY_MINUTES", "60")) * 60
URL = "https://speech.googleapis.com/v1/speech:recognize"
LANGUAGE = "af-ZA"
RATE = 16000

# The phone stops recording at five minutes; a little over that in bytes.
MAX_BYTES = 10_000_000
MAX_SECONDS = 305
# Google's synchronous call refuses audio over about a minute.
# ponytail: cuts on the clock, so a word landing on a 55 s boundary can be
# split. Long notes are rare; cut at the quietest moment if it shows up.
PIECE_SECONDS = 55


def _api_key() -> str:
    key = os.environ.get("GOOGLE_SPEECH_API_KEY", "").strip()
    if not key and os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            key = f.read().strip()
    return key


def is_configured() -> bool:
    return bool(_api_key())


# Counted in seconds of audio, because that is what Google bills. The tailnet
# is the only access control, so this is what stops a stray device spending
# without limit. In memory on purpose, like the limit in ai.py.
_usage_lock = threading.Lock()
_usage = {"day": None, "seconds": 0}


def _spend(seconds: int) -> None:
    today = date.today()
    with _usage_lock:
        if _usage["day"] != today:
            _usage["day"], _usage["seconds"] = today, 0
        if _usage["seconds"] + seconds > DAILY_SECONDS:
            raise AiUnavailable("The daily limit for voice notes has been reached. It resets tomorrow.")
        _usage["seconds"] += seconds


def _read_wav(audio: bytes) -> bytes:
    """The raw samples of a WAV in the one format the phone records. ValueError
    for anything else, before any of it can be sent and billed."""
    try:
        with wave.open(io.BytesIO(audio)) as w:
            if (w.getnchannels(), w.getsampwidth(), w.getframerate()) != (1, 2, RATE):
                raise ValueError("wrong audio format")
            return w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        raise ValueError("not a WAV file") from e


def _post(key: str, body: dict) -> dict:
    """One request to Google. The key travels in a header rather than the URL
    so it can never end up in a log line."""
    request = urllib.request.Request(
        URL, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": key},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")
        print(f"[speech] Google error {e.code}: {detail[:500]}")
        if e.code in (401, 403) or "API_KEY_INVALID" in detail:
            raise AiUnavailable("The speech key on the server was rejected. Ask whoever set the server up to check it.")
        if e.code == 429:
            raise AiUnavailable("Voice notes are busy right now. Try again in a minute.")
        raise AiUnavailable("Voice notes hit a problem. Try again in a moment.")
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AiUnavailable("The server could not reach the speech service. Check its internet connection.")


def _pieces(pcm: bytes) -> List[bytes]:
    size = PIECE_SECONDS * RATE * 2
    return [pcm[i:i + size] for i in range(0, len(pcm), size)]


def transcribe(audio: bytes) -> str:
    """The Afrikaans text of a WAV recording, "" when nothing was said.
    ValueError for audio that isn't ours; AiUnavailable with a sentence that
    is safe to show the farmer for anything that goes wrong."""
    pcm = _read_wav(audio)
    seconds = math.ceil(len(pcm) / (RATE * 2))
    if seconds > MAX_SECONDS:
        raise ValueError("recording too long")
    key = _api_key()
    if not key:
        raise AiUnavailable("Voice notes are not set up on the server yet.")
    _spend(seconds)
    words = []
    for piece in _pieces(pcm):
        reply = _post(key, {
            "config": {"encoding": "LINEAR16", "sampleRateHertz": RATE, "languageCode": LANGUAGE},
            "audio": {"content": base64.b64encode(piece).decode("ascii")},
        })
        for result in reply.get("results", []):
            alternatives = result.get("alternatives") or [{}]
            words.append(alternatives[0].get("transcript", "").strip())
    return " ".join(w for w in words if w)
