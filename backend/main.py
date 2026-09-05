import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from backup import start_backup_scheduler
from db import PHOTOS_DIR, create_db_and_tables, seed_defaults
from routers import backups, entries, tags, weather

app = FastAPI(title="Boord Notes")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(entries.router)
app.include_router(tags.router)
app.include_router(backups.router)
app.include_router(weather.router)


@app.on_event("startup")
def on_startup():
    create_db_and_tables()
    seed_defaults()
    start_backup_scheduler()


class NoCacheStaticFiles(StaticFiles):
    """The installed PWA can stay open for days, so without this a browser
    can silently keep serving JS/HTML from before the last deploy - screens
    break with no visible error until someone manually clears the cache.
    Forcing revalidation costs one cheap 304 per load and guarantees the
    device picks up new code immediately.

    Scoped to StaticFiles only (not a global app middleware) so it can't
    affect API request handling/concurrency."""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


@app.get("/", include_in_schema=False)
def root_redirect():
    """The app itself lives under /app/, but the address people are handed is
    the bare `https://<machine>.<tailnet>.ts.net:9443/` that `tailscale serve`
    publishes. Without this that address answers `{"detail":"Not Found"}` -
    which on a machine also running Boord and Boord Owner looks exactly like
    the serve mapping pointing at the wrong app, and sends whoever is
    debugging it to `tailscale serve status` for a fault that is not there.

    Registered before the catch-all static mount below, which would otherwise
    match "/" first."""
    return RedirectResponse("/app/")


app.mount("/photos", StaticFiles(directory=PHOTOS_DIR), name="photos")

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
app.mount("/", NoCacheStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
