/**
 * Offline-first service worker. Precaches the hashed build (the list and the
 * version are injected at build time) and serves it cache-first. A new
 * version installs in the background and waits: the page shows "Update
 * available" and only then asks it to take over, so a call is never
 * interrupted by an update.
 *
 * The AI worker (WebLLM, ~2 MB gzip) is the exception: it is not precached
 * but cached on first use in its own cache, which updates keep. WebLLM's own
 * caches (`webllm/*`, the model weights) are never touched here.
 */
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
const AI_CACHE = "veil-ai-engine";
const AI_WORKER = new URL(__AI_WORKER_URL__, sw.location.href).href;

sw.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("veil-") && key !== CACHE && key !== AI_CACHE) await caches.delete(key);
      // Keep only this version's AI worker.
      const ai = await caches.open(AI_CACHE);
      for (const req of await ai.keys()) if (req.url !== AI_WORKER) await ai.delete(req);
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
  if (url.origin + url.pathname === AI_WORKER) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(AI_CACHE);
        const hit = await cache.match(AI_WORKER);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(AI_WORKER, res.clone());
        return res;
      })(),
    );
    return;
  }
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
