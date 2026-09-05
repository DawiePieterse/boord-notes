// Boord Notes: capture, browse, and offline-sync farm knowledge.

let currentTags = [];
let pendingPhotos = [];   // [{tempId, blob, filename}] - newly added, not yet synced
let existingPhotos = [];  // [{id, filename}] - already on the server (edit mode only)
let editingEntryId = null;
let editingCreatedAt = null;  // the entry's original capture time, preserved across an edit
let allTagNames = [];

// Short alias - this wraps every note-derived value that gets interpolated
// into an HTML string below. See NB.escapeHtml in shared/api.js.
const esc = (v) => NB.escapeHtml(v);

function isRecorder() { return NB.getRole() === "recorder"; }

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
async function login() {
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.classList.add("hidden");
  try {
    await NB.login(username, password);
    _sessionExpiredShown = false; // fresh session - allow the notice again later
    showApp();
  } catch (e) {
    errEl.textContent = "Invalid username or password";
    errEl.classList.remove("hidden");
  }
}

function logout() {
  NB.logout();
  document.getElementById("app").classList.add("hidden");
  document.getElementById("loginScreen").classList.remove("hidden");
}

// The server rejected our token - it expired, or the server was restarted
// before its signing key was persisted. Say so and send the user back to the
// login screen. Every screen funnels 401s here rather than swallowing them,
// because a dead session and a dead network look identical to the caller and
// only one of them is fixed by waiting.
let _sessionExpiredShown = false;
function sessionExpired() {
  if (_sessionExpiredShown) return; // several screens can 401 in the same tick
  _sessionExpiredShown = true;
  NB.logout();
  document.getElementById("app").classList.add("hidden");
  const loginScreen = document.getElementById("loginScreen");
  loginScreen.classList.remove("hidden");
  const errEl = document.getElementById("loginError");
  errEl.textContent = "Your session has expired - please sign in again.";
  errEl.classList.remove("hidden");
}

// Anything captured on this device is safe in IndexedDB and will sync once
// the session is valid again, so an expired session must never be reported as
// data loss.
function handleApiError(e) {
  if (NB.isAuthError(e)) { sessionExpired(); return "auth"; }
  if (NB.isNetworkError(e)) { _lastNetFailAt = Date.now(); return "offline"; }
  return "error";
}

// navigator.onLine only reports whether the phone has a radio connection, not
// whether the farm server can actually be reached - and out in the orchard
// "WiFi shows connected but nothing answers" is the normal case, not the
// exception. Remembering the last failure lets the capture screen skip a
// lookup that is only going to time out, so saving a note stays instant.
let _lastNetFailAt = 0;
const OFFLINE_MEMORY_MS = 30000;

function serverLikelyReachable() {
  return navigator.onLine && (Date.now() - _lastNetFailAt) > OFFLINE_MEMORY_MS;
}

function noteServerReached() { _lastNetFailAt = 0; }

function showApp() {
  document.getElementById("loginScreen").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  document.getElementById("headerUser").textContent =
    `Signed in as ${NB.getDisplayName() || NB.getRole()} (${NB.getRole()})`;
  document.getElementById("appVersion").textContent = `v${NB.VERSION}`;
  document.getElementById("tabCapture").classList.toggle("hidden", !isRecorder());
  loadTagSuggestions();
  updateUnsyncedBadge();
  showPage("dashboard");
  loadDashboard();
  loadEntries();
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
function showPage(name) {
  document.querySelectorAll(".page").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`page-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
  if (name === "dashboard") loadDashboard();
  if (name === "entries") loadEntries();
  if (name === "settings") loadBackups();
  // Start hunting for a GPS fix as soon as the capture screen opens, so one is
  // usually ready by the time he's finished dictating.
  if (name === "capture") {
    document.getElementById("gpsToggle").checked = NB.getGpsEnabled();
    renderCaptureContext();
    requestLocationFix();
  }
}

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------
async function loadTagSuggestions() {
  try {
    const tags = await NB.api("/api/tags");
    allTagNames = tags.map((t) => t.name);
    document.getElementById("tagSuggestions").innerHTML =
      allTagNames.map((n) => `<option value="${esc(n)}">`).join("");
    const filterSelect = document.getElementById("tagFilter");
    const current = filterSelect.value;
    filterSelect.innerHTML = `<option value="">All tags</option>` +
      tags.map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${t.count})</option>`).join("");
    filterSelect.value = current;
  } catch (e) { handleApiError(e); /* offline - keep the suggestions already loaded */ }
}

function renderTagChips() {
  document.getElementById("tagChips").innerHTML = currentTags.map((t, i) => `
    <span class="tag-chip">${esc(t)} <button type="button" data-i="${i}" class="remove-tag">&times;</button></span>
  `).join("");
  document.querySelectorAll(".remove-tag").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentTags.splice(parseInt(btn.dataset.i), 1);
      renderTagChips();
    });
  });
}

function addTagFromInput() {
  const input = document.getElementById("tagInput");
  const name = input.value.trim();
  if (name && !currentTags.includes(name)) {
    currentTags.push(name);
    renderTagChips();
  }
  input.value = "";
}

// ---------------------------------------------------------------------
// Photo capture (native camera input, downscaled client-side before storing)
// ---------------------------------------------------------------------
function downscaleImage(file, maxDim = 1600, quality = 0.8) {
  return new Promise((resolve) => {
    const img = new Image();
    // Released as soon as the bitmap is decoded - a capture session can add a
    // lot of photos, and each of these otherwise pins its full-size original
    // in memory for the life of the page.
    const src = URL.createObjectURL(file);
    const done = (result) => { URL.revokeObjectURL(src); resolve(result); };
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => done(blob || file), "image/jpeg", quality);
    };
    img.onerror = () => done(file);
    img.src = src;
  });
}

function renderPhotoThumbs() {
  const existing = existingPhotos.map((p) => `
    <div class="relative">
      <img src="/photos/${encodeURIComponent(p.filename)}" class="w-20 h-20 object-cover rounded-lg border">
      <button type="button" data-existing="${p.id}" class="remove-photo absolute -top-2 -right-2 bg-white rounded-full w-6 h-6 shadow text-red-600 text-xs">&times;</button>
    </div>`).join("");
  const pending = pendingPhotos.map((p) => `
    <div class="relative">
      <img src="${URL.createObjectURL(p.blob)}" class="w-20 h-20 object-cover rounded-lg border">
      <button type="button" data-pending="${p.tempId}" class="remove-photo absolute -top-2 -right-2 bg-white rounded-full w-6 h-6 shadow text-red-600 text-xs">&times;</button>
    </div>`).join("");
  document.getElementById("photoThumbs").innerHTML = existing + pending;
  document.querySelectorAll(".remove-photo").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (btn.dataset.existing) {
        const photoId = parseInt(btn.dataset.existing);
        try {
          await NB.api(`/api/entries/${editingEntryId}/photos/${photoId}`, { method: "DELETE" });
        } catch (e) { NB.toast("Could not remove photo - try again once online"); return; }
        existingPhotos = existingPhotos.filter((p) => p.id !== photoId);
      } else if (btn.dataset.pending) {
        pendingPhotos = pendingPhotos.filter((p) => p.tempId !== btn.dataset.pending);
      }
      renderPhotoThumbs();
    });
  });
}

async function handlePhotoInput(event) {
  const file = event.target.files[0];
  if (!file) return;
  const blob = await downscaleImage(file);
  pendingPhotos.push({ tempId: NB.uuid(), blob, filename: `photo-${Date.now()}.jpg` });
  renderPhotoThumbs();
  event.target.value = "";
}

// ---------------------------------------------------------------------
// Where and what the weather was, at the moment of capture
// ---------------------------------------------------------------------
// The phone's last known position. A GPS fix can take several seconds and can
// be refused or unavailable, so it is warmed up when the Capture screen opens
// and simply used if it's ready at save time. Saving a note NEVER waits on it:
// Andre is standing in an orchard with a thought he wants recorded, and a note
// without coordinates is worth far more than a spinner.
let _lastFix = null;              // {lat, lon, accuracy, at}
let _locationRefused = false;     // permission denied, or no fix out here
const FIX_MAX_AGE_MS = 120000;    // older than this and he's likely moved on

function locationSupported() {
  return "geolocation" in navigator;
}

function requestLocationFix() {
  if (!locationSupported() || !NB.getGpsEnabled()) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      _locationRefused = false;
      _lastFix = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        at: Date.now(),
      };
      renderCaptureContext();
    },
    () => {
      // Refused, or simply no fix out here. The note saves without one - say
      // so plainly rather than leaving "Finding your location..." spinning
      // forever, which reads like something is still about to happen.
      _locationRefused = true;
      renderCaptureContext();
    },
    // A long timeout is fine because nothing is waiting on this; enableHighAccuracy
    // because "which block" is the whole point and a cell-tower fix won't answer it.
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }
  );
}

function freshFix() {
  return _lastFix && (Date.now() - _lastFix.at) < FIX_MAX_AGE_MS ? _lastFix : null;
}

// Conditions where he is, looked up through the farm server. Only attempted
// when there's a connection: recording the weather at sync time instead would
// describe the wrong moment entirely, so no reading is the honest answer.
async function fetchWeatherFor(fix) {
  if (!fix || !serverLikelyReachable()) return {};
  try {
    const weather = await NB.api(`/api/weather/current?lat=${fix.lat}&lon=${fix.lon}`) || {};
    noteServerReached();
    return weather;
  } catch (e) {
    handleApiError(e);
    return {};
  }
}

// Small line under the capture form telling him what will be stamped on the
// note, so a missing fix is visible before he saves rather than a surprise
// afterwards.
function renderCaptureContext() {
  const el = document.getElementById("captureContext");
  if (!el) return;
  if (!NB.getGpsEnabled()) { el.textContent = "GPS location is off - the note will save without one."; return; }
  if (!locationSupported()) { el.textContent = "This device can't provide a location."; return; }
  const fix = freshFix();
  if (!fix) {
    el.textContent = _locationRefused
      ? "No location available - the note will save without one."
      : "📍 Finding your location...";
    return;
  }
  el.textContent = `📍 Location ready (±${Math.round(fix.accuracy)} m)`
    + (serverLikelyReachable() ? " · weather will be recorded" : " · offline, no weather reading");
}

// ---------------------------------------------------------------------
// Capture form: save (create or edit)
// ---------------------------------------------------------------------
function resetCaptureForm() {
  document.getElementById("entryTitle").value = "";
  document.getElementById("entryBlock").value = "";
  document.getElementById("entryBody").value = "";
  document.getElementById("tagInput").value = "";
  currentTags = [];
  pendingPhotos = [];
  existingPhotos = [];
  editingEntryId = null;
  editingCreatedAt = null;
  document.getElementById("captureFormTitle").textContent = "New Entry";
  document.getElementById("cancelEditBtn").classList.add("hidden");
  renderTagChips();
  renderPhotoThumbs();
}

async function saveEntry() {
  const title = document.getElementById("entryTitle").value.trim();
  const body = document.getElementById("entryBody").value.trim();
  if (!title && !body) { NB.toast("Add a title or some notes first"); return; }
  addTagFromInput(); // capture anything left un-submitted in the tag input

  const id = editingEntryId || NB.uuid();
  const entry = {
    id,
    title,
    body,
    block: document.getElementById("entryBlock").value.trim(),
    tags: currentTags,
    // When this note was WRITTEN, which an edit never changes. Stamping "now"
    // here made a corrected note jump to the top of the list and count as
    // captured today for as long as it sat unsynced - the server ignores the
    // field on an edit, so the two disagreed until the sync landed.
    created_at: editingCreatedAt || new Date().toISOString(),
    synced: false,
  };

  // Stamp where he is and what it's doing, but only on a NEW note - editing
  // one later must not move it to wherever he happens to be sitting. The fix
  // is already in hand (warmed when the screen opened); the weather lookup is
  // the only thing that can be slow, so it is capped hard and skipped
  // entirely when offline. A failure here silently leaves the fields blank.
  if (!editingEntryId) {
    const fix = freshFix();
    if (fix) {
      entry.latitude = fix.lat;
      entry.longitude = fix.lon;
      entry.location_accuracy_m = fix.accuracy;
      // Hard cap: on a good link the server answers from its cache in
      // milliseconds, and no weather reading is worth making him wait with a
      // full crate of thoughts and a phone in his hand.
      const weather = await Promise.race([
        fetchWeatherFor(fix),
        new Promise((resolve) => setTimeout(() => resolve({}), 1500)),
      ]);
      if (weather && weather.temp !== undefined && weather.temp !== null) {
        entry.weather_temp = weather.temp;
        entry.weather_humidity = weather.humidity;
        entry.weather_condition = weather.condition || "";
      }
    }
  }

  await IDB.addEntry(entry);
  for (const p of pendingPhotos) {
    await IDB.addPhoto({ entry_id: id, blob: p.blob, filename: p.filename, synced: false });
  }

  NB.beepSaved();
  NB.toast(editingEntryId ? "Entry updated" : "Note saved");
  resetCaptureForm();
  updateUnsyncedBadge();
  showPage("entries");
  syncLoop();
}

async function editEntry(entry) {
  editingEntryId = entry.id;
  editingCreatedAt = entry.created_at;
  document.getElementById("entryTitle").value = entry.title;
  document.getElementById("entryBlock").value = entry.block || "";
  document.getElementById("entryBody").value = entry.body;
  currentTags = [...entry.tags];
  existingPhotos = [...entry.photos];
  pendingPhotos = [];
  document.getElementById("captureFormTitle").textContent = "Edit Entry";
  document.getElementById("cancelEditBtn").classList.remove("hidden");
  renderTagChips();
  renderPhotoThumbs();
  closeDetailModal();
  showPage("capture");
}

// ---------------------------------------------------------------------
// Sync loop - mirrors the harvest app's field/app.js pattern: entries
// before their photos (the server's photo endpoint needs the Entry row
// to exist first), never throws, silently retries next tick.
// ---------------------------------------------------------------------
async function syncLoop() {
  if (!navigator.onLine) return;
  let pushedSomething = false;
  let authFailed = false;
  try {
    const unsyncedEntries = await IDB.getUnsyncedEntries();
    for (const entry of unsyncedEntries) {
      try {
        await NB.api("/api/entries", { method: "POST", body: entry });
        await IDB.markEntrySynced(entry.id);
        noteServerReached();
        pushedSomething = true;
      } catch (e) {
        if (NB.isNetworkError(e)) _lastNetFailAt = Date.now();
        // A rejected session will reject every retry too - stop the loop and
        // say so, instead of retrying forever behind a screen that still
        // claims to be signed in.
        if (NB.isAuthError(e)) { authFailed = true; break; }
        /* otherwise leave unsynced, retry next tick */
      }
    }

    if (!authFailed) {
      const syncedIds = new Set((await IDB.getAllEntries()).filter((e) => e.synced).map((e) => e.id));
      const unsyncedPhotos = await IDB.getUnsyncedPhotos();
      for (const photo of unsyncedPhotos) {
        if (!syncedIds.has(photo.entry_id)) continue; // parent entry not synced yet
        try {
          const form = new FormData();
          form.append("file", photo.blob, photo.filename);
          await NB.api(`/api/entries/${photo.entry_id}/photos`, { method: "POST", body: form, isForm: true });
          await IDB.deletePhoto(photo.local_id);
          pushedSomething = true;
        } catch (e) {
          if (NB.isAuthError(e)) { authFailed = true; break; }
          /* otherwise leave unsynced, retry next tick */
        }
      }
    }
  } catch (e) { /* never let a sync failure surface as an error */ }

  if (authFailed) { sessionExpired(); return; }

  updateUnsyncedBadge();
  loadTagSuggestions();

  // Anything that just reached the server changes what both screens should be
  // showing - an entry stops being "(not yet synced)" and starts counting
  // towards the Dashboard. Redraw whichever screen is actually open, so the
  // two never disagree just because the sync landed while the user was
  // looking at one of them.
  if (pushedSomething) refreshVisiblePage();
}

function visiblePageName() {
  const page = [...document.querySelectorAll(".page")].find((p) => !p.classList.contains("hidden"));
  return page ? page.id.replace(/^page-/, "") : null;
}

function refreshVisiblePage() {
  const name = visiblePageName();
  if (name === "dashboard") loadDashboard();
  else if (name === "entries") loadEntries();
}

async function updateUnsyncedBadge() {
  const counts = await IDB.getUnsyncedCounts();
  const total = counts.entries + counts.photos;
  const wrap = document.getElementById("unsyncedBadgeWrap");
  if (total > 0) {
    document.getElementById("unsyncedBadge").textContent = `${total} not yet synced`;
    wrap.classList.remove("hidden");
  } else {
    wrap.classList.add("hidden");
  }
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
// The Dashboard counts what the server knows about PLUS anything still sitting
// unsynced on this device. Without the local half the two screens contradict
// each other - the Entries list has always merged local captures in, so an
// entry saved out on the farm showed up there while the Dashboard went on
// reporting "no entries yet", which is exactly what it looks like when work
// has been lost.
async function loadDashboard() {
  let stats = null;
  let offline = false;
  try {
    stats = await NB.api("/api/entries/stats");
    noteServerReached();
  } catch (e) {
    if (handleApiError(e) === "auth") return;
    offline = true;
  }

  // Exactly the rule the Entries list uses, so the two screens can't disagree:
  // with a server, local means "the unsynced extras on top of it"; without
  // one, this device's store is the whole notebook.
  const local = offline
    ? (await IDB.getAllEntries()).map(localEntryAsServerShape)
    : await localUnsyncedAsEntries();
  const merged = mergeStatsWithLocal(stats, local);

  document.getElementById("statTotal").textContent = merged.total;
  document.getElementById("statWeek").textContent = merged.this_week;
  document.getElementById("statPhotos").textContent = merged.with_photos;
  document.getElementById("statTags").textContent = merged.tags_used;
  document.getElementById("tagBreakdown").innerHTML = merged.tag_breakdown.map(([name, count]) => `
    <div class="flex justify-between"><span>${esc(name)}</span><span class="text-slate-500">${count}</span></div>
  `).join("") || `<div class="text-slate-400">No tags used yet</div>`;
  document.getElementById("recentEntries").innerHTML = merged.recent.map(entryCardHtml).join("") ||
    `<div class="text-slate-400">No entries yet</div>`;
  bindEntryCards("#recentEntries");

  loadUnusedTags();
}

// Folds this device's unsynced entries into the server's figures. Entries the
// server already knows about are skipped by id, so an entry that synced
// between the two reads is never counted twice.
function mergeStatsWithLocal(stats, localEntries) {
  const base = stats || {
    total: 0, this_week: 0, with_photos: 0, tags_used: 0, tag_breakdown: [], recent: [],
  };
  if (!localEntries.length) return base;

  const serverIds = new Set((base.recent || []).map((e) => e.id));
  const extra = localEntries.filter((e) => !serverIds.has(e.id));

  const weekAgo = Date.now() - 7 * 86400000;
  const tagCounts = new Map(base.tag_breakdown || []);
  for (const e of extra) {
    for (const t of e.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  }

  return {
    total: base.total + extra.length,
    this_week: base.this_week + extra.filter((e) => new Date(e.created_at).getTime() >= weekAgo).length,
    with_photos: base.with_photos,
    tags_used: tagCounts.size,
    tag_breakdown: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]),
    recent: [...extra, ...(base.recent || [])]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5),
  };
}

async function loadUnusedTags() {
  const card = document.getElementById("unusedTagsCard");
  if (!isRecorder()) { card.classList.add("hidden"); return; }
  let tags;
  try {
    tags = await NB.api("/api/tags");
  } catch (e) { handleApiError(e); return; } // offline - leave whatever was last shown
  const unused = tags.filter((t) => t.count === 0);
  card.classList.toggle("hidden", unused.length === 0);
  document.getElementById("unusedTagsList").innerHTML = unused.map((t) => `
    <div class="flex justify-between items-center">
      <span>${esc(t.name)}</span>
      <button type="button" data-tag="${esc(t.name)}" class="delete-tag text-red-600 text-xs font-medium">Remove</button>
    </div>
  `).join("");
  document.querySelectorAll(".delete-tag").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await NB.api(`/api/tags/${encodeURIComponent(btn.dataset.tag)}`, { method: "DELETE" });
        loadUnusedTags();
        loadTagSuggestions();
      } catch (e) { NB.toast("Could not remove tag - try again once online"); }
    });
  });
}

// ---------------------------------------------------------------------
// Entries list
// ---------------------------------------------------------------------
function entryCardHtml(e) {
  const photoThumb = e.photos.length
    ? `<img src="/photos/${encodeURIComponent(e.photos[0].filename)}" class="w-12 h-12 object-cover rounded-lg">` : "";
  const tags = e.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join(" ");
  return `
    <button data-id="${esc(e.id)}" class="entry-card w-full text-left bg-white rounded-xl shadow p-3 flex gap-3 items-start">
      ${photoThumb}
      <div class="flex-1 min-w-0">
        <div class="font-semibold text-sm truncate">${esc(e.title) || "(untitled)"}</div>
        <div class="text-xs text-slate-500">${e.block ? esc(e.block) + " · " : ""}${new Date(e.created_at).toLocaleDateString()}</div>
        <div class="mt-1 flex flex-wrap gap-1">${tags}</div>
      </div>
    </button>`;
}

function bindEntryCards(containerSelector) {
  document.querySelectorAll(`${containerSelector} .entry-card`).forEach((btn) => {
    btn.addEventListener("click", () => showEntryDetail(btn.dataset.id));
  });
}

// Shapes a locally-stored entry like one from the server, so both screens can
// render it with the same card markup.
function localEntryAsServerShape(local) {
  return {
    id: local.id, title: local.title, body: local.body, block: local.block,
    tags: local.tags || [], created_at: local.created_at, photos: [], archived: false,
    created_by: local.synced ? "" : "(not yet synced)",
    // Carried through so a note captured out on the farm shows its location
    // and conditions straight away, not only once it has reached the server.
    latitude: local.latitude ?? null,
    longitude: local.longitude ?? null,
    location_accuracy_m: local.location_accuracy_m ?? null,
    weather_temp: local.weather_temp ?? null,
    weather_humidity: local.weather_humidity ?? null,
    weather_condition: local.weather_condition || "",
  };
}

async function localUnsyncedAsEntries() {
  return (await IDB.getUnsyncedEntries()).map(localEntryAsServerShape);
}

function matchesFilters(entry, q, tag) {
  if (tag && !(entry.tags || []).includes(tag)) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return [entry.title, entry.body, entry.block]
    .some((field) => (field || "").toLowerCase().includes(needle));
}

async function loadEntries() {
  const q = document.getElementById("searchInput").value.trim();
  const tag = document.getElementById("tagFilter").value;
  let entries = [];
  let offline = false;
  try {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (tag) qs.set("tag", tag);
    entries = await NB.api(`/api/entries?${qs.toString()}`);
    noteServerReached();
  } catch (e) {
    const kind = handleApiError(e);
    if (kind === "auth") return; // already bounced to the login screen
    offline = true;
  }

  // An unfiltered listing from the server is a complete picture of what still
  // exists, so any entry this device has already synced but the server no
  // longer returns has been archived - drop the local copy. Without this it
  // would rise from the dead every time the device went offline, and the
  // store would grow for the life of the device. Skipped when a search or tag
  // filter is on, where "missing from the results" only means "filtered out".
  if (!offline && !q && !tag) {
    const liveIds = new Set(entries.map((e) => e.id));
    for (const local of await IDB.getAllEntries()) {
      if (local.synced && !liveIds.has(local.id)) await IDB.deleteEntry(local.id);
    }
  }

  // With no server, everything this device holds is the whole truth - synced
  // entries included. Previously the local copy was only consulted when the
  // merged list came out empty, so a single unsynced capture made every
  // already-synced entry disappear from the list until the signal came back.
  const local = offline
    ? (await IDB.getAllEntries()).map(localEntryAsServerShape)
    : await localUnsyncedAsEntries();

  // Local records never went through the server's filtering, so apply the
  // same search and tag filter here or they'd ignore it.
  const serverIds = new Set(entries.map((e) => e.id));
  for (const entry of local) {
    if (!serverIds.has(entry.id) && matchesFilters(entry, q, tag)) entries.push(entry);
  }
  entries.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  document.getElementById("entriesList").innerHTML = entries.map(entryCardHtml).join("");
  document.getElementById("entriesEmpty").classList.toggle("hidden", entries.length > 0);
  bindEntryCards("#entriesList");
}

// ---------------------------------------------------------------------
// Entry detail modal
// ---------------------------------------------------------------------
let currentDetailEntry = null;

async function showEntryDetail(id) {
  let entry;
  try {
    entry = await NB.api(`/api/entries/${id}`);
  } catch (e) {
    if (handleApiError(e) === "auth") return;
    // The server hasn't got this one yet (or can't be reached), but if it was
    // captured on this device we can still show it. Opening an entry you can
    // see listed must never dead-end on "check connection".
    const local = (await IDB.getAllEntries()).find((l) => l.id === id);
    if (!local) { NB.toast("Could not load entry - check connection"); return; }
    entry = localEntryAsServerShape(local);
    const photos = await IDB.getPhotosForEntry(id);
    entry.localPhotoUrls = photos.map((p) => URL.createObjectURL(p.blob));
  }
  currentDetailEntry = entry;
  document.getElementById("detailTitle").textContent = entry.title || "(untitled)";
  document.getElementById("detailMeta").textContent =
    `${new Date(entry.created_at).toLocaleString()}${entry.created_by ? " · " + entry.created_by : ""}`;
  document.getElementById("detailBlock").textContent = entry.block ? `📍 ${entry.block}` : "";
  renderDetailContext(entry);
  document.getElementById("detailTags").innerHTML = entry.tags.map((t) => `<span class="tag-chip">${esc(t)}</span>`).join("");
  document.getElementById("detailBody").textContent = entry.body;
  // A locally-held entry's photos haven't been uploaded, so they have no
  // server filename yet - render them straight from the stored Blob.
  document.getElementById("detailPhotos").innerHTML = entry.localPhotoUrls
    ? entry.localPhotoUrls.map((url) => `<img src="${esc(url)}" class="w-full rounded-lg border">`).join("")
    : entry.photos.map((p) => `<img src="/photos/${encodeURIComponent(p.filename)}" class="w-full rounded-lg border">`).join("");
  document.getElementById("detailActions").classList.toggle("hidden", !isRecorder());
  document.getElementById("detailModal").classList.remove("hidden");
  document.getElementById("detailModal").classList.add("flex");
}

// Where the note was taken and what it was doing at the time. Both are
// optional and independent - a note can have a position but no weather (saved
// out of signal), so each is shown only when it's actually there rather than
// printing a placeholder that reads like a real reading.
function renderDetailContext(entry) {
  const el = document.getElementById("detailContext");
  if (!el) return;
  const parts = [];

  if (entry.weather_condition || entry.weather_temp !== null && entry.weather_temp !== undefined) {
    const icon = NB.weatherIcon(entry.weather_condition);
    const bits = [];
    if (entry.weather_temp !== null && entry.weather_temp !== undefined) bits.push(`${Math.round(entry.weather_temp)}°C`);
    if (entry.weather_condition) bits.push(entry.weather_condition);
    if (entry.weather_humidity !== null && entry.weather_humidity !== undefined) bits.push(`${entry.weather_humidity}% humidity`);
    parts.push(`<span><i class="fa-solid ${icon}"></i> ${bits.join(" · ")}</span>`);
  }

  if (entry.latitude !== null && entry.latitude !== undefined
      && entry.longitude !== null && entry.longitude !== undefined) {
    const lat = entry.latitude.toFixed(5);
    const lon = entry.longitude.toFixed(5);
    const accuracy = entry.location_accuracy_m
      ? ` (±${Math.round(entry.location_accuracy_m)} m)` : "";
    // Opens in whatever map app the phone uses - the practical reason to
    // record a position at all is being able to walk back to that tree.
    parts.push(
      `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}"`
      + ` target="_blank" rel="noopener" class="text-blue-700 underline">`
      + `📍 ${lat}, ${lon}</a>${accuracy}`);
  }

  el.innerHTML = parts.join(" &nbsp;·&nbsp; ");
  el.classList.toggle("hidden", parts.length === 0);
}

function closeDetailModal() {
  document.getElementById("detailModal").classList.add("hidden");
  document.getElementById("detailModal").classList.remove("flex");
  currentDetailEntry = null;
}

async function archiveCurrentEntry() {
  if (!currentDetailEntry) return;
  if (!confirm(`Archive "${currentDetailEntry.title || "this entry"}"? It can be restored later if needed.`)) return;
  const entryId = currentDetailEntry.id;
  try {
    await NB.api(`/api/entries/${entryId}`, { method: "DELETE" });
  } catch (e) {
    if (handleApiError(e) === "auth") return;
    NB.toast("Could not archive - check connection");
    return;
  }
  // Drop this device's copy too, so the entry doesn't come back the next time
  // the app runs offline and reads the local store.
  await IDB.deleteEntry(entryId);
  NB.toast("Entry archived");
  closeDetailModal();
  updateUnsyncedBadge();
  loadEntries();
  loadDashboard();
}

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------
async function changePassword() {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  const errEl = document.getElementById("settingsError");
  errEl.classList.add("hidden");

  if (!currentPassword || !newPassword) {
    errEl.textContent = "Fill in both the current and new password.";
    errEl.classList.remove("hidden");
    return;
  }
  if (newPassword !== confirmPassword) {
    errEl.textContent = "New password and confirmation don't match.";
    errEl.classList.remove("hidden");
    return;
  }
  if (newPassword.length < 8) {
    errEl.textContent = "New password should be at least 8 characters.";
    errEl.classList.remove("hidden");
    return;
  }

  try {
    await NB.api("/api/auth/change-password", {
      method: "POST",
      body: { current_password: currentPassword, new_password: newPassword },
    });
    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("confirmPassword").value = "";
    NB.toast("Password changed");
  } catch (e) {
    if (handleApiError(e) === "auth") return; // session died, not a bad password
    errEl.textContent = String(e.message || e).startsWith("400")
      ? "Current password is incorrect."
      : "Could not change password - check connection and try again.";
    errEl.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadBackups() {
  const card = document.getElementById("backupsCard");
  if (!isRecorder()) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  let backups;
  try {
    backups = await NB.api("/api/backups");
  } catch (e) {
    if (handleApiError(e) === "auth") return;
    document.getElementById("backupsList").innerHTML = `<div class="text-slate-400">Could not load - check connection</div>`;
    return;
  }
  document.getElementById("backupsList").innerHTML = backups.map((b) => `
    <div class="flex justify-between items-center border-t border-slate-100 pt-2">
      <div>
        <div>${new Date(b.created_at).toLocaleString()}</div>
        <div class="text-xs text-slate-400">${formatBytes(b.size_bytes)}</div>
      </div>
      <button type="button" data-filename="${esc(b.filename)}" class="download-backup text-blue-700 text-xs font-medium">Download</button>
    </div>
  `).join("") || `<div class="text-slate-400">No backups yet</div>`;
  document.querySelectorAll(".download-backup").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        const blob = await NB.api(`/api/backups/${encodeURIComponent(btn.dataset.filename)}/download`);
        NB.downloadBlob(blob, btn.dataset.filename);
      } catch (e) { NB.toast("Could not download - try again once online"); }
    });
  });
}

async function triggerBackup() {
  const btn = document.getElementById("backupNowBtn");
  btn.disabled = true;
  btn.textContent = "Backing up...";
  try {
    await NB.api("/api/backups", { method: "POST" });
    NB.toast("Backup created");
    await loadBackups();
  } catch (e) {
    NB.toast("Backup failed - check connection and try again");
  } finally {
    btn.disabled = false;
    btn.textContent = "Backup Now";
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function init() {
  document.getElementById("loginBtn").addEventListener("click", login);
  document.getElementById("loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => showPage(btn.dataset.tab)));

  document.getElementById("tagInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); }
  });
  document.getElementById("photoInput").addEventListener("change", handlePhotoInput);
  document.getElementById("gpsToggle").addEventListener("change", (e) => {
    NB.setGpsEnabled(e.target.checked);
    if (e.target.checked) {
      _locationRefused = false;
      requestLocationFix();
    } else {
      _lastFix = null;
      _locationRefused = false;
    }
    renderCaptureContext();
  });
  document.getElementById("saveEntryBtn").addEventListener("click", saveEntry);
  document.getElementById("cancelEditBtn").addEventListener("click", resetCaptureForm);

  document.getElementById("searchInput").addEventListener("keyup", loadEntries);
  document.getElementById("tagFilter").addEventListener("change", loadEntries);

  document.getElementById("closeDetailBtn").addEventListener("click", closeDetailModal);
  document.getElementById("editEntryBtn").addEventListener("click", () => currentDetailEntry && editEntry(currentDetailEntry));
  document.getElementById("archiveEntryBtn").addEventListener("click", archiveCurrentEntry);

  document.getElementById("changePasswordBtn").addEventListener("click", changePassword);
  document.getElementById("backupNowBtn").addEventListener("click", triggerBackup);

  setInterval(syncLoop, 10000);
  window.addEventListener("online", syncLoop);

  if (NB.getToken()) {
    showApp();
  } else {
    document.getElementById("loginScreen").classList.remove("hidden");
  }
  syncLoop();
}

document.addEventListener("DOMContentLoaded", init);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
