// App-shell cache so the Boord Notes PWA still loads (and can capture new
// entries) with zero signal. Data (entries, tags, photos) always goes over
// the network when available - this only guarantees the UI itself is
// installable/offline. See idb.js/app.js for the actual offline-capture and
// sync logic.
const CACHE_PREFIX = "nb-app-";
const CACHE = "nb-app-v10";
const REVALIDATE_TIMEOUT_MS = 10000;
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./idb.js",
  "./manifest.json",
  "../shared/styles.css",
  "../shared/api.js",
  "../shared/tailwind.js",
  // The icon font and its stylesheet. Both have to be listed: the font is
  // only ever requested by the CSS, so without it here the icons would be
  // missing offline in exactly the way vendoring them was meant to fix.
  "../shared/fontawesome/fa-subset.css",
  "../shared/fontawesome/fa-solid-900-subset.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE).map((k) => caches.delete(k))
    ))
  );
  self.clients.claim();
});

// Stale-while-revalidate: answer instantly from cache so a phone with no
// signal still gets the whole UI, but refresh the cached copy in the
// background whenever the server IS reachable.
//
// This was previously cache-first with no revalidation, which pinned a device
// to whatever JS it first downloaded - the server's no-cache headers never got
// a say, because the request never reached it. A fix could sit on the farm PC
// for weeks while Andre's phone quietly ran the old code, and the only remedy
// was renaming the cache on every single deploy. Renaming still forces an
// immediate update; this just means forgetting to is no longer permanent.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/photos/")) return; // never cache API/photo data
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Page loads are cached by path only, so a query string can't cause a miss.
  const cacheKey = event.request.mode === "navigate" ? url.origin + url.pathname : event.request;

  // waitUntil keeps the worker alive until the refreshed copy is actually
  // written; the deadline stops background fetches piling up on an
  // unreachable network, where they never settle and starve the app of
  // connections.
  const revalidateAbort = new AbortController();
  const revalidateTimer = setTimeout(() => revalidateAbort.abort(), REVALIDATE_TIMEOUT_MS);
  const update = fetch(event.request, { signal: revalidateAbort.signal })
    .then(async (res) => {
      if (res.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(cacheKey, res.clone());
      }
      return res;
    })
    .catch(() => null) // offline: the cached copy below is the answer
    .finally(() => clearTimeout(revalidateTimer));
  event.waitUntil(update);

  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(cacheKey))
      .then((cached) => cached || update.then((res) => res || Response.error()))
  );
});
