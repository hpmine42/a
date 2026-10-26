/* Scano service worker.
 *
 * Two jobs: keep the app usable with no network, and never let a launch end on
 * the browser's own error page. A home-screen app that opens to "could not be
 * opened" is usually a start_url that 404s or a cold launch with nothing
 * cached — so the shell is precached on install and every navigation has an
 * offline fallback that is an actual page.
 */
const CACHE = "scano-v2";
const SHELL = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

const abs = (path) => new URL(path, self.registration.scope).href;

/** Last resort when there is no network and no cached shell. */
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

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // individually, so one 404 does not abort the whole precache
      await Promise.allSettled(SHELL.map((path) => cache.add(abs(path))));
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations go to the network first: a stale shell after a deploy looks
  // like "the update did nothing". The cache is only the fallback.
  const isNavigation =
    request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const fresh = await fetch(request);
          if (fresh.ok) cache.put(request, fresh.clone());
          return fresh;
        } catch {
          return (
            (await cache.match(request)) ||
            (await cache.match(abs("./"))) ||
            new Response(OFFLINE_PAGE, {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          );
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })()
  );
});
