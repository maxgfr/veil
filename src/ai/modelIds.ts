// Model id checks with no dependencies, safe for any chunk to import.

/** Gemma 4 E2B is the only WebLLM model that takes audio in. */
export function isAudioModel(id: string): boolean {
  return id.includes("gemma-4-E2B");
}
