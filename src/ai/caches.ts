// The Cache Storage caches on-device AI fills, by name. No dependency: the service
// worker and the page share them.

/** The service worker's caches of the engines, filled on first use. */
export const ENGINE_CACHES = { ai: "veil-ai-engine", speech: "veil-speech-engine" } as const;

/**
 * Every AI cache: WebLLM's (its default names: weights, configs, compiled
 * libraries), transformers.js's (the Whisper weights) and the engines. Any
 * other `webllm/` cache is WebLLM's too.
 */
export const AI_CACHES: readonly string[] = [
  "webllm/model",
  "webllm/config",
  "webllm/wasm",
  "transformers-cache",
  ENGINE_CACHES.ai,
  ENGINE_CACHES.speech,
];

export const WEBLLM_PREFIX = "webllm/";

export interface CacheStorageLike {
  keys(): Promise<readonly string[]>;
  delete(name: string): Promise<boolean>;
}

/**
 * Deletes every AI cache and nothing else; returns what couldn't be deleted,
 * each with why.
 */
export async function deleteAiCaches(storage: CacheStorageLike): Promise<string[]> {
  const names = new Set(AI_CACHES);
  for (const name of await storage.keys()) if (name.startsWith(WEBLLM_PREFIX)) names.add(name);
  const failed: string[] = [];
  for (const name of names) {
    try {
      await storage.delete(name);
    } catch (err) {
      failed.push(`${name} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return failed;
}
