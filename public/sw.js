/* Scano service worker.
 *
 * Three jobs: the app opens with no network at all, a launch never ends on the
 * browser's own error page, and a new deploy is picked up instead of being
 * consulted forever.
 *
 * The important line in here is PRECACHE. It used to be a hand-written list of
 * four icons and the html — which is exactly the shape of "it does not work
 * offline": the shell was cached, the hashed JavaScript it points at was not, so
 * a phone in flight mode got a page that never booted. A hand-written list also
 * goes stale on every deploy, because bundle names change. So the build writes
 * this list (vite.config.ts walks dist/) and the worker keeps all of it.
 */
/* Stamped at build time by vite.config.ts: a new deploy gets a new name, so the
 * old shell is thrown away instead of being consulted forever. */
const BUILD = "__BUILD__";
/* Every file this build needs to start: html, hashed bundles, css, worker,
 * manifest, icons. Written by the build, never by hand. */
const PRECACHE = __PRECACHE__;
const CACHE = `scano-shell-${BUILD}`;
/** Anything else the app fetches after launch, trimmed so it cannot grow forever. */
const RUNTIME = `scano-assets-${BUILD}`;
const MAX_RUNTIME = 60;
/** How long a launch waits for the network before it uses the cached shell. */
const NAV_TIMEOUT = 2500;

const abs = (path) => new URL(path, self.registration.scope).href;

/** Last resort when there is no network and no cached shell either. */
const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Scano — offline</title>
<style>
  html,body{margin:0;height:100%;background:#08090b;color:#f2f3f5;
    font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{height:100%;display:grid;place-content:center;justify-items:center;gap:14px;padding:28px;text-align:center}
  .mark{width:48px;height:64px;border-radius:6px;background:#ffc061}
  h1{margin:0;font-size:17px;letter-spacing:.14em;text-transform:uppercase}
  p{margin:0;max-width:28ch;font-size:14px;line-height:1.5;color:#9aa1ab}
  button{margin-top:6px;min-height:48px;padding:0 24px;border:0;border-radius:999px;
    background:#ffc061;color:#16130c;font:inherit;font-weight:650}
</style></head>
<body><main>
  <div class="mark"></div>
  <h1>Scano</h1>
  <p>No connection, and this launch had nothing cached yet. Reconnect and try again — your pages are never uploaded anywhere.</p>
  <button onclick="location.reload()">Try again</button>
</main></body></html>`;

const offlinePage = () =>
  new Response(OFFLINE_PAGE, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one 404 (a half-published deploy, a renamed icon) does
      // not leave the app with no cache at all. Everything else still lands.
      await Promise.allSettled(PRECACHE.map((path) => cache.add(abs(path))));

      /**
       * A failed precache must not activate.
       *
       * Installing while offline makes every add fail. If that were allowed to
       * "succeed", activate would then delete the cache of the build that *does*
       * work offline — turning "no connection right now" into "this app no
       * longer opens without one". So: no shell, no activate. The previous
       * worker simply keeps serving, and the next launch with a connection
       * installs this build.
       */
      const shellReady = await cache.match(abs("./index.html"));
      const bundles = (await cache.keys()).filter((request) => /\/assets\/.+\.m?js$/.test(request.url));
      if (!shellReady || !bundles.length) throw new Error("scano: precache incomplete, keeping the previous build");
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Keep the runtime cache small.
 *
 * Hashed bundles change name on every deploy; without a ceiling the phone
 * quietly accumulates a copy of every version ever visited. Oldest entries go
 * first (CacheStorage returns them in insertion order).
 */
async function trimRuntime() {
  const cache = await caches.open(RUNTIME);
  const keys = await cache.keys();
  if (keys.length <= MAX_RUNTIME) return;
  await Promise.all(keys.slice(0, keys.length - MAX_RUNTIME).map((key) => cache.delete(key)));
}

/** The cached shell: the exact page if we have it, otherwise the entry point. */
async function shell(request) {
  const cache = await caches.open(CACHE);
  return (
    (await cache.match(request, { ignoreSearch: true })) ||
    (await cache.match(abs("./"))) ||
    (await cache.match(abs("./index.html"))) ||
    null
  );
}

/** Fetch, but never leave a launch hanging on a network that is not there. */
async function fetchWithTimeout(request, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A launch.
 *
 * With no connection the cache answers straight away — waiting out a timeout to
 * discover the obvious is what makes an offline launch feel broken. With a
 * connection the network wins (a stale shell after a deploy looks like "the
 * update did nothing"), and only a slow or failing one falls back to the cache.
 */
async function navigate(request) {
  const offline = self.navigator && self.navigator.onLine === false;
  if (!offline) {
    try {
      const fresh = await fetchWithTimeout(request, NAV_TIMEOUT);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        // Keep the entry point itself fresh too: the next launch may be offline.
        // No query string, so a scatter of deep links cannot fill the cache.
        if (!new URL(request.url).search) {
          void cache.put(request, fresh.clone()).catch(() => undefined);
        }
        return fresh;
      }
      if (fresh) return fresh;
    } catch {
      /* no network, a dead proxy, or a launch that took too long: use the cache */
    }
  }
  return (await shell(request)) || offlinePage();
}

/** Everything that is not a navigation: the cache first, since it is hashed. */
async function asset(request) {
  const runtime = await caches.open(RUNTIME);
  const hit = (await runtime.match(request)) || (await caches.match(request));
  if (hit) return hit;
  try {
    const fresh = await fetch(request);
    if (fresh && fresh.ok) {
      void runtime
        .put(request, fresh.clone())
        .then(trimRuntime)
        .catch(() => undefined);
    }
    return fresh;
  } catch {
    // a missing chunk must not surface as an unhandled rejection in the console
    return new Response("", { status: 504, statusText: "offline" });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isNavigation =
    request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");

  event.respondWith(isNavigation ? navigate(request) : asset(request));
});
