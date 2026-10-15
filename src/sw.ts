/**
 * Offline-first service worker. Precaches the hashed build (the list and the
 * version are injected at build time) and serves it cache-first. A new
 * version installs in the background and waits: the page shows "Update
 * available" and only then asks it to take over, so a call is never
 * interrupted by an update.
 *
 * The AI worker (WebLLM, ~2 MB gzip) is the exception: it is not precached
 * but cached on first use in its own cache, which updates keep. So is the
 * speech worker with ONNX Runtime's files (tens of MB), in another. The
 * model weights (WebLLM's `webllm/*`, transformers.js's `transformers-cache`)
 * are never touched here.
 */
import { ENGINE_CACHES } from "./ai/caches";

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
const abs = (url: string) => new URL(url, sw.location.href).href;
/** Cached on first use: each cache, with the only URLs this version keeps in it. */
const ON_FIRST_USE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [ENGINE_CACHES.ai, new Set([abs(__AI_WORKER_URL__)])],
  [ENGINE_CACHES.speech, new Set([__SPEECH_WORKER_URL__, ...__ORT_URLS__].map(abs))],
]);

/** The first-use cache `url` belongs in, if any. */
function firstUseCache(url: string): string | null {
  for (const [name, urls] of ON_FIRST_USE) if (urls.has(url)) return name;
  return null;
}

sw.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("veil-") && key !== CACHE && !ON_FIRST_USE.has(key))
          await caches.delete(key);
      // Keep only this version's engines.
      for (const [name, urls] of ON_FIRST_USE) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) if (!urls.has(req.url)) await cache.delete(req);
      }
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
  const key = url.origin + url.pathname;
  const engine = firstUseCache(key);
  if (engine) {
    e.respondWith(
      (async () => {
        const cache = await caches.open(engine);
        const hit = await cache.match(key);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) await cache.put(key, res.clone());
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
