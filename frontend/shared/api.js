// Shared helpers used by the Boord Notes app.
// The NB namespace and the nb_* localStorage keys keep their original names
// through the rename on purpose: the keys hold the login token, so renaming
// them would sign every phone out on the update that landed the new name.
// Everything is served from the same origin as the backend, so API_BASE is relative.
const API_BASE = "";

const NB = {
  // Bump on every deploy that touches frontend code. Shown in the header so
  // it's obvious at a glance whether a device's cached copy is actually up
  // to date - the service worker revalidates in the background, so a device
  // picks up new code on its second load (see frontend/app/service-worker.js).
  VERSION: "2.0",

  getToken() { return localStorage.getItem("nb_token"); },
  setToken(t) { localStorage.setItem("nb_token", t); },
  clearToken() { localStorage.removeItem("nb_token"); },

  getRole() { return localStorage.getItem("nb_role"); },
  setRole(r) { localStorage.setItem("nb_role", r); },

  getDisplayName() { return localStorage.getItem("nb_display_name") || ""; },
  setDisplayName(n) { localStorage.setItem("nb_display_name", n); },

  getGpsEnabled() { return localStorage.getItem("nb_gps_enabled") !== "off"; },
  setGpsEnabled(enabled) { localStorage.setItem("nb_gps_enabled", enabled ? "on" : "off"); },

  async login(username, password) {
    const body = new URLSearchParams({ username, password });
    const res = await fetch(`${API_BASE}/api/auth/login`, { method: "POST", body });
    if (!res.ok) throw new Error("Invalid username or password");
    const data = await res.json();
    NB.setToken(data.access_token);
    NB.setRole(data.role);
    NB.setDisplayName(data.display_name || "");
    return data;
  },

  logout() {
    NB.clearToken();
    localStorage.removeItem("nb_role");
    localStorage.removeItem("nb_display_name");
  },

  // True when the request never reached the server (offline, unreachable).
  // fetch() rejects with a TypeError for those.
  isNetworkError(e) {
    return e instanceof TypeError || (!!e && (e.name === "AbortError" || e.name === "TimeoutError"));
  },

  // True when the server actively rejected the session - the token is missing,
  // expired, or was signed with a key the server no longer has. api() puts the
  // status code at the front of the error message. This has to be told apart
  // from a network failure: treating a dead session as "offline" leaves the
  // user looking at empty screens forever with no hint that logging in again
  // would fix it.
  isAuthError(e) {
    return parseInt(String(e && e.message).slice(0, 3), 10) === 401;
  },

  async api(path, { method = "GET", body, isForm = false } = {}) {
    const headers = {};
    const token = NB.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let payload = body;
    if (body && !isForm) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, { method, headers, body: payload });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${text}`);
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
