"""Current conditions for a coordinate, from Open-Meteo (no API key needed).

Deliberately a copy of the harvest app's backend/weather.py rather than a
shared import - the two apps are independent by design (separate process,
separate database, separate repo), and the condition strings are duplicated in
frontend/shared/api.js's weatherIcon() map. If a condition is added here, add
it there too.
"""
import json as _json
import threading
import time as _time
import urllib.request

_WMO_CONDITION = {
    0: "Clear", 1: "Partly Cloudy", 2: "Partly Cloudy", 3: "Overcast",
    45: "Foggy", 48: "Foggy",
    51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
    61: "Rain", 63: "Rain", 65: "Heavy Rain",
    71: "Snow", 73: "Snow", 75: "Heavy Snow",
    80: "Showers", 81: "Showers", 82: "Heavy Showers",
    95: "Storm", 96: "Storm", 99: "Storm",
}


def fetch_weather(lat: float, lon: float) -> dict:
    """Conditions now, or {} if they can't be established. Never raises -
    weather is a nice-to-have and must never be able to fail a capture."""
    try:
        url = (
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&current=temperature_2m,relative_humidity_2m,weather_code"
        )
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = _json.loads(resp.read())
        curr = data.get("current", {})
        code = int(curr.get("weather_code", 0))
        return {
            "temp": curr.get("temperature_2m"),
            "humidity": curr.get("relative_humidity_2m"),
            "condition": _WMO_CONDITION.get(code, "Cloudy"),
        }
    except Exception:
        return {}


# The upstream service only refreshes every ~15 minutes, so a short cache costs
# nothing in accuracy and keeps a burst of captures from making one round trip
# each. Failures are cached briefly too, so a dropped uplink doesn't leave
# every following capture waiting out the 5s timeout.
_CACHE_TTL_SECONDS = 600
_CACHE_TTL_ON_FAILURE_SECONDS = 60
_cache: dict = {}
_cache_lock = threading.Lock()


def fetch_weather_cached(lat: float, lon: float) -> dict:
    # Rounded to ~1km. The coordinates come from a phone being carried around
    # the farm, so a finer key would miss the cache on nearly every note and
    # make each capture wait out a fresh call - measured at ~1.4s, enough to be
    # felt. Upstream resolves to a grid of a few km anyway, so every point on
    # the farm shares one genuine reading and the rest are instant.
    key = (round(lat, 2), round(lon, 2))
    now = _time.monotonic()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now < hit[0]:
            return hit[1]

    weather = fetch_weather(lat, lon)

    ttl = _CACHE_TTL_SECONDS if weather else _CACHE_TTL_ON_FAILURE_SECONDS
    with _cache_lock:
        _cache[key] = (now + ttl, weather)
    return weather
