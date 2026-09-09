// Shared helpers used by the Boord Notes app.
// There is no sign-in: api() sends no credentials and nothing is stored per
// user. Reaching the server over the tailnet is the whole of the access
// control - see MANUAL.md chapter 2.
// Everything is served from the same origin as the backend, so API_BASE is relative.
const API_BASE = "";

const NB = {
  // Bump on every deploy that touches frontend code. Shown in the header so
  // it's obvious at a glance whether a device's cached copy is actually up
  // to date - the service worker revalidates in the background, so a device
  // picks up new code on its second load (see frontend/app/service-worker.js).
  VERSION: "2.3",

  // Left behind by the versions that had accounts. Cleared once on load so a
  // phone that used to sign in is not carrying a stale token and role around
  // for the life of the install.
  clearLegacyAuthStorage() {
    ["nb_token", "nb_role", "nb_display_name"].forEach((k) => localStorage.removeItem(k));
  },

  getGpsEnabled() { return localStorage.getItem("nb_gps_enabled") !== "off"; },
  setGpsEnabled(enabled) { localStorage.setItem("nb_gps_enabled", enabled ? "on" : "off"); },

  // True when the request never reached the server (offline, unreachable).
  // fetch() rejects with a TypeError for those.
  isNetworkError(e) {
    return e instanceof TypeError || (!!e && (e.name === "AbortError" || e.name === "TimeoutError"));
  },

  // timeoutMs is opt-in, and deliberately so. Photo sync pushes multi-megabyte
  // uploads over rural signal and must be allowed to take as long as it takes;
  // but a request whose button is disabled until it settles needs a deadline,
  // or one hung connection leaves that button dead for the life of the page.
  // AbortController rather than AbortSignal.timeout(): the farm's phones are
  // not all new enough for the latter, and the service worker already does the
  // same thing this way.
  async api(path, { method = "GET", body, isForm = false, timeoutMs = 0 } = {}) {
    const headers = {};
    let payload = body;
    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method, headers, body: payload, signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`${res.status} ${text}`);
      err.status = res.status;   // so callers can tell a server fault from an unreachable server
      throw err;
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return res.json();
    return res.blob();
  },

  // Maps backend/weather.py's fixed condition strings to a Font Awesome icon
  // class - update both places together if a new condition is added.
  weatherIcon(condition) {
    const icons = {
      "Clear": "fa-sun",
      "Partly Cloudy": "fa-cloud-sun",
      "Overcast": "fa-cloud",
      "Cloudy": "fa-cloud",
      "Foggy": "fa-smog",
      "Drizzle": "fa-cloud-rain",
      "Rain": "fa-cloud-rain",
      "Heavy Rain": "fa-cloud-showers-heavy",
      "Showers": "fa-cloud-rain",
      "Heavy Showers": "fa-cloud-showers-heavy",
      "Snow": "fa-snowflake",
      "Heavy Snow": "fa-snowflake",
      "Storm": "fa-bolt",
    };
    return icons[condition] || "fa-cloud";
  },

  // Everything a note contains is free text typed or dictated on a phone, and
  // most of it is rendered by building HTML strings. Without this, a title as
  // ordinary as `Spray 5" nozzle & filter` renders wrong, and anything that
  // looks like a tag gets interpreted instead of shown. Use on every value
  // interpolated into innerHTML, in both text and attribute positions.
  escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  },

  toast(message) {
    let el = document.getElementById("nb-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "nb-toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove("show"), 2200);
  },

  // Short synthesized confirmation chime (no audio file needed, works fully
  // offline) - plays when an entry is saved locally, before sync even happens.
  _tone(frequency, duration, delay = 0) {
    try {
      const ctx = NB._audioCtx || (NB._audioCtx = new (window.AudioContext || window.webkitAudioContext)());
      if (ctx.state === "suspended") ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      const startAt = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0.2, startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startAt);
      osc.stop(startAt + duration);
    } catch (e) { /* audio isn't critical - never block capture on it */ }
  },
  beepSaved() { NB._tone(660, 0.09); NB._tone(988, 0.14, 0.1); },

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  },
};
