from fastapi import APIRouter

from weather import fetch_weather_cached

router = APIRouter(prefix="/api/weather", tags=["weather"])


@router.get("/current")
def current_weather(lat: float, lon: float):
    """Conditions at the phone's own coordinates, looked up server-side so the
    phone needs nothing beyond the farm server it is already talking to.

    Returns {} rather than an error when the lookup fails - the caller stamps
    whatever it gets onto the entry and carries on, because a note must save
    whether or not the weather is known.
    """
    return fetch_weather_cached(lat, lon)
