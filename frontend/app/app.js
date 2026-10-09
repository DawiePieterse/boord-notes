// Boord Notes: capture, browse, and offline-sync farm knowledge.

let currentTags = [];
let pendingPhotos = [];   // [{tempId, blob, filename, url}] - newly added, not yet synced
let existingPhotos = [];  // [{id, filename}] - already on the server (edit mode only)
let editingEntryId = null;
let editingCreatedAt = null;  // the entry's original capture time, preserved across an edit
let allTags = [];       // [{name, count}] - the tag list, from the server or this phone's copy
let allBlocks = [];     // [{id, name, variety, count}] - the block list from Settings
let editingBlockId = null;

// Short alias - this wraps every note-derived value that gets interpolated
// into an HTML string below. See NB.escapeHtml in shared/api.js.
const esc = (v) => NB.escapeHtml(v);

const notesCount = (n) => `${n} ${n === 1 ? "note" : "notes"}`;
const photoUrl = (filename) => `/photos/${encodeURIComponent(filename)}`;
const optionHtml = (value, label = value) => `<option value="${esc(value)}">${esc(label)}</option>`;
const CHEVRON = `<svg class="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg>`;

// Shows or hides one of the full-screen sheets (they are flex containers).
function setOverlay(id, open) {
  const el = document.getElementById(id);
  el.classList.toggle("hidden", !open);
  el.classList.toggle("flex", open);
}

// Rebuilds a <select>'s options, keeping the chosen value while it still
// exists, and hides it when there is nothing to choose between.
function fillSelect(id, placeholder, options, hideWhenEmpty = true) {
  const select = document.getElementById(id);
  const keep = select.value;
  select.innerHTML = optionHtml("", placeholder) + options.map(([v, l]) => optionHtml(v, l)).join("");
  select.value = options.some(([v]) => v === keep) ? keep : "";
  if (hideWhenEmpty) select.classList.toggle("hidden", !options.length);
  select.classList.toggle("on", !!select.value);
}

function showApp() {
  document.getElementById("appVersion").textContent = `v${NB.VERSION}`;
  refreshLists();
  loadAiStatus();
  updateUnsyncedBadge();
  // Capture, not Dashboard: the app is opened to write a note down before it
  // is forgotten, so the textarea and the GPS warm-up should already be there.
  // The other two screens still load in the background so switching tabs is
  // instant.
  showPage("capture");
  loadDashboard();
  loadEntries();
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
const PAGE_TITLES = { dashboard: "Dashboard", entries: "Entries", ask: "Ask the Notes", settings: "Settings" };

function setPageTitle(name) {
  document.getElementById("pageTitle").textContent =
    name === "capture" ? (editingEntryId ? "Edit Note" : "New Note") : PAGE_TITLES[name];
}

function showPage(name) {
  document.querySelectorAll(".page").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`page-${name}`).classList.remove("hidden");
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === name));
  setPageTitle(name);
  window.scrollTo(0, 0);
  if (name === "dashboard") loadDashboard();
  if (name === "entries") loadEntries();
  if (name === "settings") { loadTagsCard(); loadBlocksCard(); loadBackups(); }
  // Start hunting for a GPS fix as soon as the capture screen opens, so one is
  // usually ready by the time he's finished dictating.
  if (name === "capture") {
    document.getElementById("gpsToggle").checked = NB.getGpsEnabled();
    renderCaptureContext();
    requestLocationFix();
  }
}

// ---------------------------------------------------------------------
// Lists kept on the phone. The tag and block lists come from the server, but
// the Capture screen needs them most out in the orchard with no signal - so
// the last good copy is kept here and used whenever the server can't answer.
// ---------------------------------------------------------------------
async function fetchSavedList(path, key) {
  try {
    const data = await NB.api(path);
    try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { /* storage full or blocked */ }
    return { data, fresh: true };
  } catch (e) {
    try { return { data: JSON.parse(localStorage.getItem(key)), fresh: false }; } catch (_) { return { data: null, fresh: false }; }
  }
}

// Fetched when the app opens, comes back to the front, or has just pushed
// notes - not on every sync tick, which would refetch both every 10 seconds.
function refreshLists() {
  loadTags();
  loadBlocks();
}

// ---------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------
// The pickers are redrawn only when the list actually changed: rebuilding a
// picker under a thumb that is halfway through choosing is worse than useless.
async function loadTags() {
  const { data } = await fetchSavedList("/api/tags", "nb_tags_copy");
  if (!data) return allTags;
  if (JSON.stringify(data) !== JSON.stringify(allTags)) {
    allTags = data;
    document.getElementById("tagSuggestions").innerHTML = allTags.map((t) => optionHtml(t.name)).join("");
    fillSelect("tagFilter", "All tags", allTags.map((t) => [t.name, `${t.name} (${t.count})`]), false);
    renderTagChips();
  }
  return allTags;
}

function addCurrentTag(name) {
  if (name && !currentTags.includes(name)) currentTags.push(name);
  renderTagChips();
}

// Listeners for these chips are bound once, on their containers, in init().
function renderTagChips() {
  document.getElementById("tagChips").innerHTML = currentTags.map((t, i) =>
    `<span class="chip chip-on">${esc(t)}<button type="button" data-i="${i}" aria-label="Remove ${esc(t)}">&times;</button></span>`
  ).join("");
  const pickable = allTags.map((t) => t.name).filter((n) => !currentTags.includes(n));
  document.getElementById("tagPickWrap").classList.toggle("hidden", !pickable.length);
  document.getElementById("tagPick").innerHTML = pickable.map((n) =>
    `<button type="button" class="chip" data-name="${esc(n)}">${esc(n)}</button>`
  ).join("");
}

function addTagFromInput() {
  const input = document.getElementById("tagInput");
  addCurrentTag(input.value.trim());
  input.value = "";
}

// ---------------------------------------------------------------------
// Blocks. A note names its block as text; the list just keeps the spelling
// consistent and knows each block's type (variety).
// ---------------------------------------------------------------------
const OTHER_BLOCK = "__other__";

// Returns the server's full answer (with the unlisted block names) when it
// had one, for the Settings card; the pickers only need the list.
async function loadBlocks() {
  const { data, fresh } = await fetchSavedList("/api/blocks", "nb_blocks_copy");
  if (!data) return null;
  if (JSON.stringify(data.blocks) !== JSON.stringify(allBlocks)) {
    allBlocks = data.blocks;
    renderBlockPicker();
    renderBlockFilters();
  }
  return fresh ? data : null;
}

function varietyOf(blockName) {
  const block = allBlocks.find((b) => b.name === blockName);
  return block ? block.variety : "";
}

// "8a (TMR)" - the variety from the server's answer, or for a note still only
// on this phone, from the block list.
function blockLabel(entry) {
  if (!entry.block) return "";
  const variety = entry.variety || varietyOf(entry.block);
  return variety ? `${entry.block} (${variety})` : entry.block;
}

function varieties() {
  return [...new Set(allBlocks.map((b) => b.variety).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

const blockPickRow = () => document.getElementById("blockPickRow");
const blockTextRow = () => document.getElementById("blockTextRow");
const blockPickerInUse = () => !blockPickRow().classList.contains("hidden");

function getCaptureBlock() {
  const select = document.getElementById("entryBlockSelect");
  if (blockPickerInUse() && select.value !== OTHER_BLOCK) return select.value;
  return document.getElementById("entryBlock").value.trim();
}

function setCaptureBlock(name) {
  const select = document.getElementById("entryBlockSelect");
  const input = document.getElementById("entryBlock");
  const listed = blockPickerInUse() && (!name || allBlocks.some((b) => b.name === name));
  if (blockPickerInUse()) select.value = listed ? name : OTHER_BLOCK;
  input.value = listed ? "" : name;
  blockTextRow().classList.toggle("hidden", listed);
}

// Grouped by type, so the iPhone's picker wheel reads "TMR: 8a, 8b...".
function renderBlockPicker() {
  const select = document.getElementById("entryBlockSelect");
  const keep = getCaptureBlock();
  blockPickRow().classList.toggle("hidden", !allBlocks.length);
  document.getElementById("entryBlock").placeholder =
    allBlocks.length ? "Where, e.g. near the pump station" : "Block or location (optional)";
  const groups = new Map();
  for (const b of allBlocks) {
    const key = b.variety || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const options = (list) => list.map((b) => optionHtml(b.name)).join("");
  const ordered = [...groups.keys()].sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
  select.innerHTML = optionHtml("", "None") +
    ordered.map((v) => v
      ? `<optgroup label="${esc(v)}">${options(groups.get(v))}</optgroup>`
      : options(groups.get(v))).join("") +
    optionHtml(OTHER_BLOCK, "Somewhere else…");
  setCaptureBlock(keep);
}

function renderBlockFilters() {
  const types = varieties();
  fillSelect("blockFilter", "All blocks", allBlocks.map((b) => [b.name, b.name]));
  fillSelect("varietyFilter", "All types", types.map((v) => [v, v]));
  document.getElementById("varietySuggestions").innerHTML = types.map((v) => optionHtml(v)).join("");
}

function onBlockSelectChange() {
  const other = document.getElementById("entryBlockSelect").value === OTHER_BLOCK;
  const input = document.getElementById("entryBlock");
  blockTextRow().classList.toggle("hidden", !other);
  if (other) input.focus();
  else input.value = "";
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

const thumbHtml = (src, data) =>
  `<div class="thumb"><img src="${esc(src)}" alt=""><button type="button" ${data} aria-label="Remove photo">&times;</button></div>`;

// The remove buttons are handled once, on #photoThumbs, in init().
function renderPhotoThumbs() {
  document.getElementById("photoThumbs").innerHTML =
    existingPhotos.map((p) => thumbHtml(photoUrl(p.filename), `data-existing="${p.id}"`)).join("") +
    pendingPhotos.map((p) => thumbHtml(p.url, `data-pending="${p.tempId}"`)).join("");
}

// A pending photo's preview URL pins its blob in memory, so it is made once,
// when the photo is added, and released when the photo leaves the form.
function dropPendingPhotos(keep = () => false) {
  for (const p of pendingPhotos) if (!keep(p)) URL.revokeObjectURL(p.url);
  pendingPhotos = pendingPhotos.filter(keep);
}

async function removePhoto(btn) {
  if (btn.dataset.existing) {
    const photoId = parseInt(btn.dataset.existing);
    try {
      await NB.api(`/api/entries/${editingEntryId}/photos/${photoId}`, { method: "DELETE" });
    } catch (e) { NB.toast(NB.errorMessage(e, "Could not remove photo")); return; }
    existingPhotos = existingPhotos.filter((p) => p.id !== photoId);
  } else if (btn.dataset.pending) {
    dropPendingPhotos((p) => p.tempId !== btn.dataset.pending);
  }
  renderPhotoThumbs();
}

// Camera / album / file are three separate <input>s (see index.html): only one
// of them may carry `capture`, because that attribute is what sends the phone
// straight to the camera and leaves no route to the album.
const PHOTO_INPUT_IDS = {
  camera: "photoInputCamera",
  album: "photoInputAlbum",
  file: "photoInputFile",
};

const openPhotoSourceSheet = () => setOverlay("photoSourceSheet", true);
const closePhotoSourceSheet = () => setOverlay("photoSourceSheet", false);

function pickPhotoSource(source) {
  closePhotoSourceSheet();
  const input = document.getElementById(PHOTO_INPUT_IDS[source]);
  if (input) input.click();
}

async function handlePhotoInput(event) {
  // Every source funnels through here. Whatever the picker hands over - a
  // camera JPEG, a HEIC from the album, a PNG off the file system - comes out
  // of downscaleImage as a JPEG blob and is stored under a .jpg name, which is
  // what the server's upload route accepts.
  const files = Array.from(event.target.files || []);
  event.target.value = "";
  for (const file of files) {
    const blob = await downscaleImage(file);
    pendingPhotos.push({ tempId: NB.uuid(), blob, filename: `photo-${Date.now()}.jpg`, url: URL.createObjectURL(blob) });
  }
  if (files.length) renderPhotoThumbs();
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
  if (!fix || !NB.serverLikelyReachable()) return {};
  try {
    return await NB.api(`/api/weather/current?lat=${fix.lat}&lon=${fix.lon}`) || {};
  } catch (e) {
    return {};
  }
}

// Small line under the capture form telling him what will be stamped on the
// note, so a missing fix is visible before he saves rather than a surprise
// afterwards.
function renderCaptureContext() {
  const el = document.getElementById("captureContext");
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
    + (NB.serverLikelyReachable() ? " · weather will be recorded" : " · offline, no weather reading");
}

// ---------------------------------------------------------------------
// Capture form: save (create or edit)
// ---------------------------------------------------------------------
function resetCaptureForm() {
  document.getElementById("entryTitle").value = "";
  setCaptureBlock("");
  document.getElementById("entryBody").value = "";
  document.getElementById("tagInput").value = "";
  currentTags = [];
  document.getElementById("tagPickWrap").open = false;
  dropPendingPhotos();
  existingPhotos = [];
  hideTidyResult();
  document.getElementById("tidyHint").textContent = "";
  editingEntryId = null;
  editingCreatedAt = null;
  setPageTitle("capture");
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
    block: getCaptureBlock(),
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
  setCaptureBlock(entry.block || "");
  document.getElementById("entryBody").value = entry.body;
  currentTags = [...entry.tags];
  existingPhotos = [...entry.photos];
  dropPendingPhotos();
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
// One pass at a time: the 10-second timer, the "online" event and a save can
// each start one, and two passes over a slow link would upload the same
// multi-megabyte photo twice. A server that just failed to answer is left
// alone until NB.api's offline memory lapses.
let syncing = false;

async function syncLoop() {
  if (syncing || !NB.serverLikelyReachable()) return;
  syncing = true;
  let pushedSomething = false;
  try {
    const unsyncedEntries = await IDB.getUnsyncedEntries();
    for (const entry of unsyncedEntries) {
      try {
        await NB.api("/api/entries", { method: "POST", body: entry });
        await IDB.markEntrySynced(entry.id);
        pushedSomething = true;
      } catch (e) {
        /* leave unsynced, retry next tick */
      }
    }

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
        /* leave unsynced, retry next tick */
      }
    }
  } catch (e) { /* never let a sync failure surface as an error */ }
  syncing = false;

  updateUnsyncedBadge();

  // Anything that just reached the server changes what both screens should be
  // showing - an entry stops being "(not yet synced)" and starts counting
  // towards the Dashboard. Redraw whichever screen is actually open, so the
  // two never disagree just because the sync landed while the user was
  // looking at one of them.
  if (pushedSomething) {
    refreshLists();   // new tags, and counts, that came in with the notes
    refreshVisiblePage();
  }
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
  try {
    stats = await NB.api("/api/entries/stats");
  } catch (e) { /* offline - this phone's own notes are the whole picture */ }
  const merged = mergeStatsWithLocal(stats, await localEntries(!stats));

  document.getElementById("statTotal").textContent = merged.total;
  document.getElementById("statWeek").textContent = merged.this_week;
  document.getElementById("statPhotos").textContent = merged.with_photos;
  document.getElementById("statTags").textContent = merged.tags_used;
  document.getElementById("tagBreakdown").innerHTML = merged.tag_breakdown.map(([name, count]) =>
    `<div class="row"><span class="row-label">${esc(name)}</span><span class="row-detail">${count}</span></div>`
  ).join("") || `<div class="empty">No tags used yet</div>`;
  document.getElementById("recentEntries").innerHTML = merged.recent.map(entryCardHtml).join("") ||
    `<div class="empty">No notes yet</div>`;
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
    this_week: base.this_week + extra.filter((e) => NB.serverTimeMs(e.created_at) >= weekAgo).length,
    with_photos: base.with_photos,
    tags_used: tagCounts.size,
    tag_breakdown: [...tagCounts.entries()].sort((a, b) => b[1] - a[1]),
    recent: [...extra, ...(base.recent || [])].sort(byNewest).slice(0, 5),
  };
}

// Settings rows: a name, a detail on the right, and - only while no note uses
// it - a Remove button, since the server refuses to delete one still in use.
function settingsRowHtml(label, sub, count, removeData, extra = "") {
  return `
    <div class="row">
      <span class="row-label">${esc(label)}${sub ? ` <span class="row-sub">· ${esc(sub)}</span>` : ""}</span>
      ${count ? `<span class="row-detail">${notesCount(count)}</span>`
              : `<button type="button" class="link-red text-[15px]" ${removeData}>Remove</button>`}
      ${extra}
    </div>`;
}

async function loadTagsCard() {
  const tags = await loadTags();
  document.getElementById("tagsList").innerHTML =
    tags.map((t) => settingsRowHtml(t.name, "", t.count, `data-remove-tag="${esc(t.name)}"`)).join("") ||
    `<div class="empty">No tags yet</div>`;
}

async function removeTag(name) {
  try {
    await NB.api(`/api/tags/${encodeURIComponent(name)}`, { method: "DELETE" });
    loadTagsCard();
  } catch (e) { NB.toast(NB.errorMessage(e, "Could not remove tag")); }
}

async function createTag() {
  const input = document.getElementById("newTagInput");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const btn = document.getElementById("newTagBtn");
  btn.disabled = true;
  try {
    await NB.api("/api/tags", { method: "POST", body: { name }, timeoutMs: 15000 });
    input.value = "";
    NB.toast(`Tag "${name}" added`);
    loadTagsCard();
  } catch (e) {
    NB.toast(NB.errorMessage(e, "Could not add tag"));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Settings: the block list
// ---------------------------------------------------------------------
// The buttons in these lists are handled once, on their containers, in init().
let lastBlocksData = null;

async function loadBlocksCard() {
  const data = await loadBlocks();
  if (!data) return; // offline - leave whatever was last shown
  lastBlocksData = data;
  document.getElementById("blocksList").innerHTML = data.blocks.map((b) => settingsRowHtml(
    b.name, b.variety, b.count, `data-remove-block="${b.id}"`,
    `<button type="button" class="link text-[15px]" data-edit-block="${b.id}">Edit</button>`,
  )).join("") || `<div class="empty">No blocks yet - add the first one below.</div>`;

  document.getElementById("unlistedWrap").classList.toggle("hidden", !data.unlisted.length);
  document.getElementById("unlistedList").innerHTML = data.unlisted.map((u) => `
    <div class="row">
      <span class="row-label">${esc(u.name)} <span class="row-sub">· ${notesCount(u.count)}</span></span>
      <button type="button" class="link text-[15px]" data-list-block="${esc(u.name)}">Add to List</button>
    </div>`).join("");
}

function editBlock(id) {
  const block = lastBlocksData.blocks.find((b) => String(b.id) === id);
  editingBlockId = block.id;
  document.getElementById("blockNameInput").value = block.name;
  document.getElementById("blockVarietyInput").value = block.variety;
  document.getElementById("blockFormTitle").textContent = `Edit ${block.name} - a new name moves onto its notes`;
  document.getElementById("blockSaveBtn").textContent = "Save Block";
  document.getElementById("blockCancelBtn").classList.remove("hidden");
  document.getElementById("blockNameInput").focus();
}

async function removeBlock(id) {
  try {
    await NB.api(`/api/blocks/${id}`, { method: "DELETE" });
    if (String(editingBlockId) === id) resetBlockForm();
    loadBlocksCard();
  } catch (e) { NB.toast(NB.errorMessage(e, "Could not remove block")); }
}

// Typed on notes before the list existed: the name goes into the form, so
// the type can be filled in before it is added.
function listBlock(name) {
  resetBlockForm();
  document.getElementById("blockNameInput").value = name;
  document.getElementById("blockVarietyInput").focus();
}

function resetBlockForm() {
  editingBlockId = null;
  document.getElementById("blockNameInput").value = "";
  document.getElementById("blockVarietyInput").value = "";
  document.getElementById("blockFormTitle").textContent = "Add a block";
  document.getElementById("blockSaveBtn").textContent = "Add Block";
  document.getElementById("blockCancelBtn").classList.add("hidden");
}

async function saveBlock() {
  const name = document.getElementById("blockNameInput").value.trim();
  const variety = document.getElementById("blockVarietyInput").value.trim();
  if (!name) { document.getElementById("blockNameInput").focus(); return; }
  const btn = document.getElementById("blockSaveBtn");
  btn.disabled = true;
  try {
    await NB.api(editingBlockId ? `/api/blocks/${editingBlockId}` : "/api/blocks", {
      method: editingBlockId ? "PUT" : "POST", body: { name, variety }, timeoutMs: 15000,
    });
    NB.toast(editingBlockId ? `Block ${name} saved` : `Block ${name} added`);
    resetBlockForm();
    loadBlocksCard();
    // A rename changes the block shown on notes already on screen.
    loadEntries();
  } catch (e) {
    NB.toast(NB.errorMessage(e, "Could not save block"));
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------
// Entries list
// ---------------------------------------------------------------------
const NOTE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8"/><path d="M8 17h5"/></svg>`;

// One note as a list row. Opening it is handled for every list at once, by a
// single listener on the document for .entry-card (see init()).
function entryCardHtml(e) {
  const thumb = e.photos.length
    ? `<img src="${esc(photoUrl(e.photos[0].filename))}" class="list-thumb" alt="">`
    : `<div class="list-thumb-empty">${NOTE_ICON}</div>`;
  const tags = e.tags.map((t) => `<span class="chip-sm">${esc(t)}</span>`).join("");
  const unsynced = e.created_by === UNSYNCED ? `<span class="badge-unsynced text-[11px] px-2 py-0">Not synced</span>` : "";
  return `
    <button data-id="${esc(e.id)}" class="entry-card row tappable items-start">
      ${thumb}
      <span class="row-label">
        <span class="block font-semibold truncate">${esc(e.title) || "(untitled)"}</span>
        <span class="block row-sub truncate">${e.block ? esc(blockLabel(e)) + " · " : ""}${NB.fmtDate(e.created_at)}</span>
        ${tags || unsynced ? `<span class="flex flex-wrap gap-1 mt-1">${unsynced}${tags}</span>` : ""}
      </span>
      <span class="self-center">${CHEVRON}</span>
    </button>`;
}

const byNewest = (a, b) => NB.serverTimeMs(b.created_at) - NB.serverTimeMs(a.created_at);
const UNSYNCED = "(not yet synced)";

// Shapes a locally-stored entry like one from the server, so both screens can
// render it with the same card markup.
function localEntryAsServerShape(local) {
  return {
    id: local.id, title: local.title, body: local.body, block: local.block,
    tags: local.tags || [], created_at: local.created_at, photos: [], archived: false,
    created_by: local.synced ? "" : UNSYNCED,
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

// The notes this phone holds that a screen must add to the server's: with a
// server, only the ones not yet synced; without one, everything here is the
// whole notebook. The Dashboard and the Entries list both use this, so the
// two can't disagree.
async function localEntries(offline) {
  return (await IDB.getAllEntries()).filter((e) => offline || !e.synced).map(localEntryAsServerShape);
}

function matchesFilters(entry, q, tag, block, variety) {
  if (tag && !(entry.tags || []).includes(tag)) return false;
  if (block && entry.block !== block) return false;
  if (variety && varietyOf(entry.block) !== variety) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return [entry.title, entry.body, entry.block]
    .some((field) => (field || "").toLowerCase().includes(needle));
}

async function loadEntries() {
  const q = document.getElementById("searchInput").value.trim();
  const tag = document.getElementById("tagFilter").value;
  const block = document.getElementById("blockFilter").value;
  const variety = document.getElementById("varietyFilter").value;
  const filtered = Boolean(q || tag || block || variety);
  let entries = [];
  let offline = false;
  try {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (tag) qs.set("tag", tag);
    if (block) qs.set("block", block);
    if (variety) qs.set("variety", variety);
    entries = await NB.api(`/api/entries?${qs.toString()}`);
  } catch (e) {
    offline = true;
  }

  // An unfiltered listing from the server is a complete picture of what still
  // exists, so any entry this device has already synced but the server no
  // longer returns has been archived - drop the local copy. Without this it
  // would rise from the dead every time the device went offline, and the
  // store would grow for the life of the device. Skipped when a search or tag
  // filter is on, where "missing from the results" only means "filtered out".
  if (!offline && !filtered) {
    const liveIds = new Set(entries.map((e) => e.id));
    for (const local of await IDB.getAllEntries()) {
      if (local.synced && !liveIds.has(local.id)) await IDB.deleteEntry(local.id);
    }
  }

  // With no server, everything this device holds is the whole truth - synced
  // entries included. Previously the local copy was only consulted when the
  // merged list came out empty, so a single unsynced capture made every
  // already-synced entry disappear from the list until the signal came back.
  const local = await localEntries(offline);

  // Local records never went through the server's filtering, so apply the
  // same search and tag filter here or they'd ignore it.
  const serverIds = new Set(entries.map((e) => e.id));
  for (const entry of local) {
    if (!serverIds.has(entry.id) && matchesFilters(entry, q, tag, block, variety)) entries.push(entry);
  }
  entries.sort(byNewest);

  document.getElementById("entriesList").innerHTML = entries.map(entryCardHtml).join("");
  document.getElementById("entriesEmpty").textContent = filtered ? "No notes match." : "No notes yet.";
  document.getElementById("entriesEmpty").classList.toggle("hidden", entries.length > 0);
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
    `${NB.fmtDateTime(entry.created_at)}${entry.created_by ? " · " + entry.created_by : ""}`;
  document.getElementById("detailBlock").textContent = entry.block ? `📍 ${blockLabel(entry)}` : "";
  renderDetailContext(entry);
  document.getElementById("detailTags").innerHTML = entry.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  document.getElementById("detailBody").textContent = entry.body;
  // A locally-held entry's photos haven't been uploaded, so they have no
  // server filename yet - render them straight from the stored Blob.
  document.getElementById("detailPhotos").innerHTML = (entry.localPhotoUrls || entry.photos.map((p) => photoUrl(p.filename)))
    .map((src) => `<img src="${esc(src)}" class="w-full aspect-square object-cover rounded-[10px]" alt="">`).join("");
  setOverlay("detailModal", true);
}

// Where the note was taken and what it was doing at the time. Both are
// optional and independent - a note can have a position but no weather (saved
// out of signal), so each is shown only when it's actually there rather than
// printing a placeholder that reads like a real reading.
function renderDetailContext(entry) {
  const el = document.getElementById("detailContext");
  const parts = [];

  if (entry.weather_condition || entry.weather_temp != null) {
    const icon = NB.weatherIcon(entry.weather_condition);
    const bits = [];
    if (entry.weather_temp != null) bits.push(`${Math.round(entry.weather_temp)}°C`);
    if (entry.weather_condition) bits.push(entry.weather_condition);
    if (entry.weather_humidity != null) bits.push(`${entry.weather_humidity}% humidity`);
    parts.push(`<span><i class="fa-solid ${icon}"></i> ${bits.join(" · ")}</span>`);
  }

  if (entry.latitude != null && entry.longitude != null) {
    const lat = entry.latitude.toFixed(5);
    const lon = entry.longitude.toFixed(5);
    const accuracy = entry.location_accuracy_m
      ? ` (±${Math.round(entry.location_accuracy_m)} m)` : "";
    // Opens in whatever map app the phone uses - the practical reason to
    // record a position at all is being able to walk back to that tree.
    parts.push(
      `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}"`
      + ` target="_blank" rel="noopener" class="link">`
      + `📍 ${lat}, ${lon}</a>${accuracy}`);
  }

  el.innerHTML = parts.join(" &nbsp;·&nbsp; ");
  el.classList.toggle("hidden", parts.length === 0);
}

function closeDetailModal() {
  setOverlay("detailModal", false);
  // A note still only on this phone showed its photos from blob URLs.
  (currentDetailEntry?.localPhotoUrls || []).forEach((url) => URL.revokeObjectURL(url));
  currentDetailEntry = null;
}

async function archiveCurrentEntry() {
  if (!currentDetailEntry) return;
  if (!confirm(`Archive "${currentDetailEntry.title || "this entry"}"? It can be restored later if needed.`)) return;
  const entryId = currentDetailEntry.id;
  try {
    await NB.api(`/api/entries/${entryId}`, { method: "DELETE" });
  } catch (e) {
    NB.toast(NB.errorMessage(e, "Could not archive"));
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
// AI help (optional): Tidy up a dictated note, Ask the saved notes.
// Both need the server AND its internet connection, so unlike capture they
// simply say so when they can't run. Neither ever saves anything by itself.
// ---------------------------------------------------------------------
let tidySuggestion = null;   // {title, body, suggested_tags} awaiting Use this / Keep mine

async function loadAiStatus() {
  let enabled;
  try {
    const status = await NB.api("/api/ai/status");
    enabled = !!(status && status.enabled);
  } catch (e) { return; }  // offline - leave the buttons as they were
  document.getElementById("tidyWrap").classList.toggle("hidden", !enabled);
  document.getElementById("tabAsk").classList.toggle("hidden", !enabled);
}

// A 503 from /api/ai/* carries a sentence written for Andre; anything else is
// a network fault or a bug and gets a generic line.
const aiErrorMessage = (e) => NB.errorMessage(e, "AI help isn't working right now. Your notes are safe.");

const AI_TIMEOUT_MS = 120000;

function hideTidyResult() {
  tidySuggestion = null;
  document.getElementById("tidyResult").classList.add("hidden");
}

async function runTidy() {
  const body = document.getElementById("entryBody").value.trim();
  const hint = document.getElementById("tidyHint");
  if (!body) { NB.toast("Write or dictate some notes first"); return; }
  if (!NB.serverLikelyReachable()) { hint.textContent = "Needs a connection - try again later."; return; }
  const btn = document.getElementById("tidyBtn");
  btn.disabled = true;
  btn.textContent = "Tidying...";
  hint.textContent = "";
  hideTidyResult();
  let suggestion;
  try {
    suggestion = await NB.api("/api/ai/tidy", {
      method: "POST", timeoutMs: AI_TIMEOUT_MS,
      body: {
        title: document.getElementById("entryTitle").value.trim(),
        body,
        block: getCaptureBlock(),
        tags: currentTags,
      },
    });
  } catch (e) {
    hint.textContent = aiErrorMessage(e);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = "Tidy up";
  }
  tidySuggestion = suggestion;
  document.getElementById("tidyTitle").textContent = suggestion.title;
  document.getElementById("tidyBody").textContent = suggestion.body;
  const tags = suggestion.suggested_tags;
  document.getElementById("tidyTagsWrap").classList.toggle("hidden", !tags.length);
  document.getElementById("tidyTags").innerHTML = tags.map((t) =>
    `<button type="button" class="chip" data-name="${esc(t.name)}">+ ${esc(t.name)}${t.is_new ? " (new)" : ""}</button>`
  ).join("");
  document.getElementById("tidyResult").classList.remove("hidden");
}

function acceptTidy() {
  if (!tidySuggestion) return;
  document.getElementById("entryTitle").value = tidySuggestion.title;
  document.getElementById("entryBody").value = tidySuggestion.body;
  hideTidyResult();
}

async function runAsk() {
  const question = document.getElementById("askInput").value.trim();
  if (!question) { NB.toast("Type a question first"); return; }
  if (!NB.serverLikelyReachable()) {
    showAskResult("Asking needs a connection to the server - try again when you have signal.", [], "");
    return;
  }
  const btn = document.getElementById("askBtn");
  btn.disabled = true;
  btn.textContent = "Looking through the notes...";
  try {
    const r = await NB.api("/api/ai/ask", { method: "POST", body: { question }, timeoutMs: AI_TIMEOUT_MS });
    const foot = r.notes_considered < r.notes_total
      ? `Searched the ${r.notes_considered} most relevant of ${r.notes_total} notes.`
      : `Searched all ${r.notes_total} notes.`;
    showAskResult(r.answer, r.sources, foot);
  } catch (e) {
    showAskResult(aiErrorMessage(e), [], "");
  } finally {
    btn.disabled = false;
    btn.textContent = "Ask";
  }
}

function showAskResult(answer, sources, foot) {
  document.getElementById("askAnswer").textContent = answer;
  document.getElementById("askSourcesWrap").classList.toggle("hidden", !sources.length);
  document.getElementById("askSources").innerHTML = sources.map((s) => `
    <button data-id="${esc(s.id)}" class="entry-card row tappable">
      <span class="row-label truncate">${esc(s.title) || "(untitled)"}</span>
      <span class="row-detail">${NB.fmtDate(s.created_at)}</span>${CHEVRON}
    </button>`).join("");
  document.getElementById("askFoot").textContent = foot;
  document.getElementById("askResult").classList.remove("hidden");
}

// ---------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadBackups() {
  // If the phone froze the page mid-backup, triggerBackup's finally never ran
  // and the button is still greyed out. Opening Settings is the one moment we
  // know the user is looking at it, so it is where the button gets un-stuck.
  const btn = document.getElementById("backupNowBtn");
  btn.disabled = false;
  btn.textContent = "Back Up Now";
  let backups;
  try {
    backups = await NB.api("/api/backups");
  } catch (e) {
    document.getElementById("backupsList").innerHTML = `<div class="empty">Could not load - check connection</div>`;
    return;
  }
  // Not NB.fmtDateTime: a backup's created_at is the zip file's mtime in the
  // farm PC's LOCAL time (backend/backup.py), not a UTC database timestamp,
  // so pinning it to UTC would push it two hours late. The PC and the phones
  // share the farm's timezone, so reading it as local is right.
  document.getElementById("backupsList").innerHTML = backups.map((b) => `
    <div class="row">
      <span class="row-label">${new Date(b.created_at).toLocaleString()}
        <span class="block row-sub">${formatBytes(b.size_bytes)}</span></span>
      <button type="button" data-download="${esc(b.filename)}" class="link text-[15px]">Download</button>
    </div>`).join("") || `<div class="empty">No backups yet</div>`;
}

async function downloadBackup(filename) {
  try {
    const blob = await NB.api(`/api/backups/${encodeURIComponent(filename)}/download`);
    NB.downloadBlob(blob, filename);
  } catch (e) { NB.toast(NB.errorMessage(e, "Could not download")); }
}

// Zipping the database and every photo is not instant on the farm PC, so the
// button has to stay disabled while it runs - which makes it the one control
// in the app that a request going missing can kill outright. Without a
// deadline the await never settles, the finally never runs, and the button is
// left greyed out for the life of the page; on an installed PWA that page
// survives for days, so "Backup Now does nothing" outlives any number of
// retries. Long enough for a real backup of a season of photos, short enough
// that a dead connection gives the button back.
const BACKUP_TIMEOUT_MS = 120000;

async function triggerBackup() {
  const btn = document.getElementById("backupNowBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "Backing up...";
  try {
    await NB.api("/api/backups", { method: "POST", timeoutMs: BACKUP_TIMEOUT_MS });
    NB.toast("Backup created");
    await loadBackups();
  } catch (e) {
    // "Check connection" was the answer to every failure here, which sends
    // whoever is standing at the PC off to look at the wifi for a fault that
    // is on the disk. A backup can fail because the drive is full or the
    // photos folder isn't writable, and that has to be distinguishable.
    console.error("Backup failed:", e);
    if (e && e.name === "AbortError") {
      NB.toast("Backup timed out - it may still be finishing on the server");
    } else if (NB.isNetworkError(e)) {
      NB.toast("Backup failed - can't reach the server");
    } else {
      NB.toast(`Backup failed on the server (${e && e.status ? e.status : "error"}) - see the server window`);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Back Up Now";
  }
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function init() {
  NB.clearLegacyAuthStorage();
  document.querySelectorAll(".tab-btn").forEach((btn) => btn.addEventListener("click", () => showPage(btn.dataset.tab)));

  document.getElementById("tagInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTagFromInput(); }
  });
  document.getElementById("addTagBtn").addEventListener("click", () => {
    addTagFromInput();
    // Back into the box, so the next tag can be typed straight away - and a
    // tap with the box still empty shows where the name goes.
    document.getElementById("tagInput").focus();
  });
  // Lists drawn as HTML strings get one listener each, on their container,
  // rather than one per button re-bound on every redraw.
  const onTap = (id, selector, fn) => document.getElementById(id).addEventListener("click", (e) => {
    const el = e.target.closest(selector);
    if (el) fn(el);
  });
  onTap("tagChips", "button[data-i]", (b) => { currentTags.splice(parseInt(b.dataset.i), 1); renderTagChips(); });
  onTap("tagPick", "[data-name]", (b) => addCurrentTag(b.dataset.name));
  onTap("tidyTags", "[data-name]", (b) => { addCurrentTag(b.dataset.name); b.remove(); });
  onTap("photoThumbs", "button", removePhoto);
  onTap("tagsList", "[data-remove-tag]", (b) => removeTag(b.dataset.removeTag));
  onTap("blocksList", "[data-remove-block]", (b) => removeBlock(b.dataset.removeBlock));
  onTap("blocksList", "[data-edit-block]", (b) => editBlock(b.dataset.editBlock));
  onTap("unlistedList", "[data-list-block]", (b) => listBlock(b.dataset.listBlock));
  onTap("backupsList", "[data-download]", (b) => downloadBackup(b.dataset.download));
  document.addEventListener("click", (e) => {
    const card = e.target.closest(".entry-card");
    if (card) showEntryDetail(card.dataset.id);
  });

  document.getElementById("newTagBtn").addEventListener("click", createTag);
  document.getElementById("newTagInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createTag(); }
  });
  document.getElementById("addPhotoBtn").addEventListener("click", openPhotoSourceSheet);
  document.getElementById("photoSourceCancel").addEventListener("click", closePhotoSourceSheet);
  document.getElementById("photoSourceSheet").addEventListener("click", (e) => {
    if (e.target.id === "photoSourceSheet") closePhotoSourceSheet();  // tap the backdrop
  });
  document.getElementById("detailModal").addEventListener("click", (e) => {
    if (e.target.id === "detailModal") closeDetailModal();
  });
  document.querySelectorAll(".photo-source").forEach((btn) => {
    btn.addEventListener("click", () => pickPhotoSource(btn.dataset.source));
  });
  Object.values(PHOTO_INPUT_IDS).forEach((id) => {
    document.getElementById(id).addEventListener("change", handlePhotoInput);
  });
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
  document.getElementById("tidyBtn").addEventListener("click", runTidy);
  document.getElementById("tidyAcceptBtn").addEventListener("click", acceptTidy);
  document.getElementById("tidyDismissBtn").addEventListener("click", hideTidyResult);
  document.getElementById("askBtn").addEventListener("click", runAsk);
  document.getElementById("cancelEditBtn").addEventListener("click", resetCaptureForm);

  // Searched once typing pauses, not on every key - each search is a full
  // listing from the server, and over weak signal they would pile up.
  let searchTimer;
  document.getElementById("searchInput").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadEntries, 300);
  });
  ["tagFilter", "blockFilter", "varietyFilter"].forEach((id) => {
    document.getElementById(id).addEventListener("change", (e) => {
      e.target.classList.toggle("on", !!e.target.value);
      loadEntries();
    });
  });
  document.getElementById("entryBlockSelect").addEventListener("change", onBlockSelectChange);
  document.getElementById("blockSaveBtn").addEventListener("click", saveBlock);
  document.getElementById("blockCancelBtn").addEventListener("click", resetBlockForm);

  document.getElementById("closeDetailBtn").addEventListener("click", closeDetailModal);
  document.getElementById("editEntryBtn").addEventListener("click", () => currentDetailEntry && editEntry(currentDetailEntry));
  document.getElementById("archiveEntryBtn").addEventListener("click", archiveCurrentEntry);

  document.getElementById("backupNowBtn").addEventListener("click", triggerBackup);

  setInterval(syncLoop, 10000);
  window.addEventListener("online", syncLoop);
  // Back from the background: pick up tags and blocks added on another phone.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshLists();
  });

  showApp();
  syncLoop();
}

document.addEventListener("DOMContentLoaded", init);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}
