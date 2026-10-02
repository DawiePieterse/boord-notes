"""Claude-backed helpers for Boord Notes: tidy a dictated note, answer a
question from the notes.

Everything here is an optional extra. Capture and sync never touch this
module, so a missing key, no internet or an API error can only ever disable
the two AI buttons - never a save.

Configuration (all optional except the key):
  ANTHROPIC_API_KEY  or  data/anthropic_key.txt   the API key
  NB_AI_MODEL        model id, default claude-sonnet-5-5
  NB_AI_DAILY_LIMIT  calls per day across both features, default 100
"""
import os
import re
import threading
from datetime import date
from typing import List, Union

from db import DATA_DIR

KEY_FILE = os.path.join(DATA_DIR, "anthropic_key.txt")
MODEL = os.environ.get("NB_AI_MODEL", "claude-sonnet-5-5")
DAILY_LIMIT = int(os.environ.get("NB_AI_DAILY_LIMIT", "100"))

# Roughly 100k tokens of notes. Below this, Ask sends every note; above it, it
# sends the best keyword matches instead (see select_entries).
CONTEXT_CHAR_BUDGET = 400_000


class AiUnavailable(Exception):
    """Raised with a message that is safe to show Andre."""


def _api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key and os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            key = f.read().strip()
    return key


def is_configured() -> bool:
    return bool(_api_key())


# The tailnet is the only access control (no sign-in), so a stray device or a
# runaway script could otherwise spend without limit. In memory on purpose: a
# restart resets it, which is a fine failure mode for a cost guard.
_usage_lock = threading.Lock()
_usage = {"day": None, "count": 0}


def _spend_call() -> None:
    today = date.today()
    with _usage_lock:
        if _usage["day"] != today:
            _usage["day"], _usage["count"] = today, 0
        if _usage["count"] >= DAILY_LIMIT:
            raise AiUnavailable("The daily limit for AI help has been reached. It resets tomorrow.")
        _usage["count"] += 1


def calls_today() -> int:
    with _usage_lock:
        return _usage["count"] if _usage["day"] == date.today() else 0


_client = None


def _get_client():
    global _client
    key = _api_key()
    if not key:
        raise AiUnavailable("AI help is not set up on the server yet.")
    if _client is None or _client.api_key != key:
        import anthropic
        # Timeout and retries are chosen per call (see call_json), so the
        # shared client carries neither.
        _client = anthropic.Anthropic(api_key=key)
    return _client


def call_json(system: Union[str, list], user: Union[str, list], schema: dict, effort: str, *,
              feature: str, max_tokens: int = 16000, max_retries: int = 2, timeout: float = 90.0) -> dict:
    """One request whose reply is constrained to `schema`. Raises AiUnavailable
    with a plain-language message for anything that goes wrong.

    `system` and `user` may each be a plain string or a list of content
    blocks, so a caller can mark a big, stable block with cache_control and
    pay for it once rather than on every question.

    `max_retries` and `timeout` are per call: a retry after the phone has
    already given up only spends money on an answer nobody will see."""
    import json
    import anthropic

    client = _get_client().with_options(max_retries=max_retries, timeout=timeout)
    _spend_call()
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        )
    except anthropic.AuthenticationError:
        raise AiUnavailable("The AI key on the server was rejected. Ask whoever set the server up to check it.")
    except anthropic.RateLimitError:
        raise AiUnavailable("AI help is busy right now. Try again in a minute.")
    except anthropic.APIConnectionError:
        raise AiUnavailable("The server could not reach the AI service. Check its internet connection.")
    except anthropic.APIStatusError as e:
        print(f"[ai] API error {e.status_code}: {e}")
        raise AiUnavailable("AI help hit a problem. Try again in a moment.")

    # Cache hits show up here: `cached` close to `in` means the notes block
    # was reused from a question a few minutes earlier.
    usage = response.usage
    print(f"[ai] {feature}: in={usage.input_tokens} cached={usage.cache_read_input_tokens or 0} "
          f"out={usage.output_tokens}")

    if response.stop_reason == "refusal":
        raise AiUnavailable("The AI declined to help with this one.")
    if response.stop_reason == "max_tokens":
        raise AiUnavailable("The AI ran out of room before finishing. Try a shorter note or question.")
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        return json.loads(text)
    except ValueError:
        raise AiUnavailable("The AI gave an answer the app could not read. Try again.")


# -- choosing which notes to send to Ask --------------------------------

_WORD_RE = re.compile(r"\w+", re.UNICODE)
_STOP = {"die", "en", "van", "het", "is", "in", "op", "te", "vir", "met", "n", "'n", "wat", "hoe",
         "the", "a", "an", "of", "and", "to", "in", "is", "for", "with", "what", "how", "when",
         "do", "we", "our", "on", "it", "at", "by", "be", "are", "was", "ons", "ek", "jy", "moet"}


def _stems(text: str) -> set:
    """Lowercased words cut to 5 characters, so 'spuit', 'spuitery' and
    'gespuit' land near each other. Crude, but it copes with Afrikaans
    compounds well enough for choosing candidates, and the model does the
    actual reading."""
    return {w[:5] for w in _WORD_RE.findall(text.lower()) if len(w) > 2 and w not in _STOP}


def entry_text(e: dict) -> str:
    """One note as the block of text the model reads."""
    lines = [f'<note id="{e["id"]}">', f'Title: {e["title"] or "(untitled)"}',
             f'Written: {str(e["created_at"])[:10]}']
    if e.get("block"):
        lines.append(f'Block/location: {e["block"]}')
    if e.get("tags"):
        lines.append("Tags: " + ", ".join(e["tags"]))
    if e.get("weather_condition") or e.get("weather_temp") is not None:
        bits = [e.get("weather_condition") or ""]
        if e.get("weather_temp") is not None:
            bits.append(f'{e["weather_temp"]:.0f}C')
        lines.append("Weather at the time: " + " ".join(b for b in bits if b))
    captions = [p["caption"] for p in e.get("photos", []) if p.get("caption")]
    if captions:
        lines.append("Photo captions: " + "; ".join(captions))
    lines.append("")
    lines.append(e["body"])
    lines.append("</note>")
    return "\n".join(lines)


def select_entries(question: str, entries: List[dict]) -> List[dict]:
    """Every note if they fit, otherwise the best keyword matches that do.
    Returns them in the order they should be shown (newest first)."""
    sized = [(e, len(entry_text(e))) for e in entries]
    if sum(n for _, n in sized) <= CONTEXT_CHAR_BUDGET:
        return [e for e, _ in sized]
    q = _stems(question)
    scored = sorted(
        sized,
        key=lambda en: (len(q & _stems(en[0]["title"] + " " + en[0]["body"] + " " + en[0].get("block", "")
                                        + " " + " ".join(en[0].get("tags", [])))), str(en[0]["created_at"])),
        reverse=True,
    )
    chosen, used = [], 0
    for e, n in scored:
        if used + n > CONTEXT_CHAR_BUDGET:
            continue
        chosen.append(e)
        used += n
    chosen.sort(key=lambda e: str(e["created_at"]), reverse=True)
    return chosen
