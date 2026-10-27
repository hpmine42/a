import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/**
 * The service worker, actually run.
 *
 * "Works offline" is not a claim a `toMatch` can make: the failure it has to
 * prevent is a cached index.html whose bundle is not in the cache, and only the
 * fetch handler knows the difference. So the real `public/sw.js` is executed in
 * a sandbox with a cache, a network that can be switched off, and the events a
 * browser would fire at it.
 */

const ORIGIN = "https://hpmorgan42.github.io";
const SCOPE = `${ORIGIN}/scano/`;
const SOURCE = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");

/** A build to pretend to be: html, bundles, css, worker, manifest. */
const BUILD = [
  "./index.html",
  "./assets/index-ABC123.js",
  "./assets/index-DEF456.css",
  "./assets/detect.worker-GHI789.js",
  "./manifest.webmanifest",
  "./icon-192.png",
];

type Handler = (event: { waitUntil(p: Promise<unknown>): void; respondWith(r: Promise<Response>): void }) => void;

const key = (request: string | Request): string => (typeof request === "string" ? request : request.url);

class FakeCache {
  readonly store = new Map<string, Response>();

  constructor(private readonly net: (url: string) => Promise<Response>) {}

  async add(request: string | Request): Promise<void> {
    const url = new URL(key(request), SCOPE).href;
    const response = await this.net(url);
    // Cache.add rejects on a non-2xx, exactly like the browser's
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    this.store.set(url, response.clone());
  }

  async put(request: string | Request, response: Response): Promise<void> {
    this.store.set(new URL(key(request), SCOPE).href, response.clone());
  }

  async match(request: string | Request): Promise<Response | undefined> {
    return this.store.get(new URL(key(request), SCOPE).href)?.clone();
  }

  async keys(): Promise<Request[]> {
    return [...this.store.keys()].map((url) => new Request(url));
  }

  async delete(request: string | Request): Promise<boolean> {
    return this.store.delete(new URL(key(request), SCOPE).href);
  }
}

type World = {
  worker: {
    install(): Promise<void>;
    navigate(url: string): Promise<Response>;
    fetch(url: string, init?: RequestInit): Promise<Response>;
    assets(url: string): Promise<Response>;
  };
  caches: Map<string, FakeCache>;
  requests: string[];
  setOnline(online: boolean): void;
};

/**
 * Build a worker out of the real source.
 *
 * `net` stands in for the network: a URL it does not know is a 404, `null` means
 * "connected, but nothing answers" (the flight-mode case a phone actually has),
 * and `hang` means the request is accepted and never answered.
 */
function world(
  options: {
    precache?: string[];
    net?: (url: string) => Response | "hang" | null;
    online?: boolean;
    navTimeout?: number;
  } = {}
): World {
  const precache = options.precache ?? BUILD;
  const requests: string[] = [];
  const caches = new Map<string, FakeCache>();
  const listeners = new Map<string, Handler>();
  let online = options.online ?? true;
  let network = options.net ?? defaultNet();

  function defaultNet() {
    return (url: string): Response | null =>
      url.endsWith(".html") || url.endsWith("/scano/")
        ? new Response(fileFor(url), { status: 200, headers: { "content-type": "text/html" } })
        : BUILD.includes(new URL(url).pathname.replace(/^\/scano\//, "./")) ||
            new URL(url).pathname.startsWith("/scano/")
          ? new Response(`asset ${url}`, { status: 200 })
          : new Response("not found", { status: 404 });
  }

  function fileFor(_url: string): string {
    return '<!doctype html><html><body><div id="boot">opening</div></body></html>';
  }

  const net = async (url: string): Promise<Response> => {
    requests.push(url);
    const result = network(url);
    if (result === "hang") {
      return new Promise<Response>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("hang")), 30_000);
        timer.unref?.();
      });
    }
    if (result === null) throw new TypeError("Failed to fetch");
    return result;
  };

  const cacheApi = {
    async open(name: string) {
      if (!caches.has(name)) caches.set(name, new FakeCache(net));
      return caches.get(name)!;
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name: string) {
      return caches.delete(name);
    },
    async match(request: string | Request) {
      for (const cache of caches.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
  };

  const fire = (
    type: string,
    init: { request?: Request; onRespond?: (p: Promise<Response>) => void }
  ) => {
    const pending: Promise<unknown>[] = [];
    const event = {
      request: init.request,
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      respondWith: (p: Promise<Response>) => {
        pending.push(p);
        init.onRespond?.(p);
      },
    };
    listeners.get(type)?.(event as never);
    return Promise.all(pending);
  };

  const self = {
    registration: { scope: SCOPE },
    location: { origin: ORIGIN },
    clients: { claim: async () => undefined },
    skipWaiting: () => undefined,
    navigator: { get onLine() { return online; } },
    addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
  };

  const fetchSpy = (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const signal = init?.signal;
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    const answer = net(url);
    // a real fetch is cancelled by the abort signal; without that, a launch on
    // a dead network could not return at all — which is what the timeout is for
    return new Promise<Response>((resolvePromise, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")));
      answer.then(resolvePromise, reject);
    });
  };

  let source = SOURCE.replace(/__BUILD__/g, "testbuild").replace(
    "__PRECACHE__",
    JSON.stringify(precache)
  );
  if (options.navTimeout) {
    source = source.replace("const NAV_TIMEOUT = 2500;", `const NAV_TIMEOUT = ${options.navTimeout};`);
  }

  runInNewContext(source, {
    self,
    caches: cacheApi,
    fetch: fetchSpy,
    Response,
    Request,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  });

  const nav = (url: string) =>
    new Request(url, { method: "GET", headers: { accept: "text/html" } });

  return {
    caches,
    requests,
    setOnline: (value: boolean) => (online = value),
    setNetwork: (fn: (url: string) => Response | "hang" | null) => (network = fn),
    worker: {
      async install() {
        await fire("install", {});
        await fire("activate", {});
      },
      async navigate(url: string) {
        let out: Response | undefined;
        await fire("fetch", { request: nav(url), onRespond: (p) => void p.then((r) => (out = r)) });
        return out!;
      },
      async fetch(url: string, init?: RequestInit) {
        let out: Response | undefined;
        await fire("fetch", {
          request: new Request(url, init),
          onRespond: (p) => void p.then((r) => (out = r)),
        });
        return out!;
      },
      async assets(url: string) {
        let out: Response | undefined;
        await fire("fetch", {
          request: new Request(url, { headers: { accept: "*/*" } }),
          onRespond: (p) => void p.then((r) => (out = r)),
        });
        return out!;
      },
    },
  } as World & { setNetwork(fn: (url: string) => Response | "hang" | null): void };
}

describe("offline", () => {
  it("keeps every file of the build, so a cold start does not load half an app", async () => {
    const w = world();
    await w.worker.install();

    const shell = [...w.caches.values()].flatMap((cache) => [...cache.store.keys()]);
    expect(shell.some((url) => url.endsWith("/scano/index.html"))).toBe(true);
    // the bundles index.html points at — this is the part a hand-written SHELL
    // list never had, and the reason the app opened to a page that never booted
    expect(shell.some((url) => url.endsWith("/assets/index-ABC123.js"))).toBe(true);
    expect(shell.some((url) => url.endsWith("/assets/index-DEF456.css"))).toBe(true);
    expect(shell.some((url) => url.endsWith("/assets/detect.worker-GHI789.js"))).toBe(true);
    expect(shell.some((url) => url.endsWith("/manifest.webmanifest"))).toBe(true);
  });

  it("opens the cached app with no connection at all, without asking the network", async () => {
    const w = world();
    await w.worker.install();
    w.setOnline(false);
    const before = w.requests.length;

    const response = await w.worker.navigate(`${SCOPE}?launch=home-screen`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="boot"');
    // flight mode: no request is made at all, so no timeout to sit through
    expect(w.requests.length).toBe(before);
  });

  it("serves the bundles it precached while offline", async () => {
    const w = world();
    await w.worker.install();
    w.setOnline(false);

    for (const file of BUILD.filter((f) => f.startsWith("./assets/"))) {
      const response = await w.worker.assets(new URL(file, SCOPE).href);
      expect(response.status).toBe(200);
    }
  });

  it("does not sit on a network that accepts the request and never answers", async () => {
    const w = world({ navTimeout: 40 });
    await w.worker.install();
    // connected according to the phone, dead proxy in reality
    (w as unknown as { setNetwork(fn: () => "hang"): void }).setNetwork(() => "hang");

    const started = Date.now();
    const response = await w.worker.navigate(SCOPE);
    const took = Date.now() - started;

    expect(await response.text()).toContain('id="boot"');
    expect(took).toBeLessThan(2000);
  });

  it("still shows a page when a launch finds nothing cached", async () => {
    const w = world({ online: false });
    const response = await w.worker.navigate(SCOPE);

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Try again");
    expect(html).toContain("Scano");
  });

  it("survives one missing file in the precache list", async () => {
    const w = world({ precache: [...BUILD, "./icon-deleted.png"] });
    await w.worker.install();

    const shell = [...w.caches.values()].flatMap((cache) => [...cache.store.keys()]);
    expect(shell.some((url) => url.endsWith("/assets/index-ABC123.js"))).toBe(true);
    // and a launch still works afterwards
    w.setOnline(false);
    expect((await w.worker.navigate(SCOPE)).status).toBe(200);
  });

  it("keeps the working build when the install itself is offline", async () => {
    const w = world();
    await w.worker.install(); // the build that works, already installed

    // a new deploy, reached while the phone has no connection at all
    const offlineInstall = world({ net: () => null });
    const failure = await offlineInstall.worker.install().then(
      () => null,
      (error: { message?: string }) => error
    );
    expect(failure).toBeTruthy();
    expect(String(failure?.message)).toMatch(/precache incomplete/);

    // the old worker still answers launches — the app did not lose offline
    const response = await w.worker.navigate(SCOPE);
    expect(await response.text()).toContain('id="boot"');
  });

  it("throws the previous build away instead of consulting it forever", async () => {
    const w = world();
    await w.worker.install();
    // a cache from an older deploy
    const old = await (w as unknown as { caches: Map<string, FakeCache> }).caches;
    old.set("scano-shell-20250101000000", new FakeCache(async () => new Response("old")));

    await w.worker.install();

    expect([...old.keys()].some((name) => name.startsWith("scano-shell-2025"))).toBe(false);
  });
});
