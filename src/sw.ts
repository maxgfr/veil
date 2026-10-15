/**
 * Offline-first service worker. Precaches the hashed build (the list and the
 * version are injected at build time) and serves it cache-first. A new
 * version installs in the background and waits: the page shows "Update
 * available" and only then asks it to take over, so a call is never
 * interrupted by an update.
 *
 * Earlier versions downloaded on-device models (WebLLM's `webllm/*`,
 * transformers.js's `transformers-cache`): activating deletes them.
 */

// A module: these interfaces stay local rather than merge with the DOM's.
export {};

interface SwScope {
  addEventListener(type: "install", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "activate", fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  location: Location;
}

interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void;
}

interface FetchEvent extends ExtendableEvent {
  request: Request;
  respondWith(r: Promise<Response> | Response): void;
}

const sw = self as unknown as SwScope;
const CACHE = `veil-${__SW_VERSION__}`;
const PRECACHE = __PRECACHE__;
/** What an older version left behind: its build and the on-device models. */
const stale = (key: string) =>
  (key.startsWith("veil-") && key !== CACHE) ||
  key.startsWith("webllm/") ||
  key === "transformers-cache";

sw.addEventListener("install", (e) => {
  // Past the HTTP cache: a shell cached minutes earlier names scripts the new deploy removed.
  const fresh = PRECACHE.map((url) => new Request(url, { cache: "reload" }));
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(fresh)));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (stale(key)) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (e) => {
  if ((e.data as { type?: string } | null)?.type === "skip-waiting") void sw.skipWaiting();
});

sw.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== sw.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Navigations (any #room fragment, any query) get the app shell.
      if (req.mode === "navigate") {
        const shell = (await cache.match("./")) ?? (await cache.match("./index.html"));
        if (shell) return shell;
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      return hit ?? fetch(req);
    })(),
  );
});
