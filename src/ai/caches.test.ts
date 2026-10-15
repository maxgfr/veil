import { beforeEach, describe, expect, test } from "bun:test";
import { saveSettings, settings } from "../ui/settings";
import { AI_CACHES, type CacheStorageLike, deleteAiCaches, ENGINE_CACHES } from "./caches";
import { WEBLLM_SCOPES } from "./device";
import { SPEECH_CACHE } from "./speechModels";
import { setSpeechEngineSource, speechModelId } from "./speechStore";
import { aiModelId, aiWipe, deleteAllAiData, setAiEngineSource } from "./store";

/** Cache Storage over a set of names; `failing` names throw on delete. */
function storage(
  names: string[],
  failing: string[] = [],
): CacheStorageLike & { names: Set<string> } {
  const set = new Set(names);
  return {
    names: set,
    keys: async () => [...set],
    delete: async (name) => {
      if (failing.includes(name)) throw new Error("quota error");
      return set.delete(name);
    },
  };
}

/** What Veil and the browser hold besides AI: the app shell, a site's own cache. */
const OTHERS = ["veil-3f2a9c1d00aa11bb", "other-app-cache"];
const AI = [...AI_CACHES, "webllm/indexeddb-shadow"];

describe("AI caches", () => {
  test("cover WebLLM's, transformers.js's and the engines' caches", () => {
    for (const name of Object.values(WEBLLM_SCOPES)) expect(AI_CACHES).toContain(name);
    expect(AI_CACHES).toContain(SPEECH_CACHE);
    for (const name of Object.values(ENGINE_CACHES)) expect(AI_CACHES).toContain(name);
  });

  test("every AI cache is deleted, and nothing else", async () => {
    const s = storage([...AI, ...OTHERS]);
    expect(await deleteAiCaches(s)).toEqual([]);
    expect([...s.names]).toEqual(OTHERS);
  });

  test("a cache that can't be deleted is named; the others still go", async () => {
    const s = storage([...AI, ...OTHERS], ["webllm/wasm"]);
    expect(await deleteAiCaches(s)).toEqual(["webllm/wasm (quota error)"]);
    expect([...s.names].sort()).toEqual(["webllm/wasm", ...OTHERS].sort());
  });
});

describe("deleteAllAiData", () => {
  const cancels = { ai: 0, speech: 0 };
  beforeEach(() => {
    cancels.ai = 0;
    cancels.speech = 0;
    const state = async () => ({ cached: false, complete: false, bytes: 0 });
    setAiEngineSource(async () => ({
      load: async () => {},
      cancel: () => {
        cancels.ai++;
      },
      cacheState: state,
      remove: async () => {},
      onCrash: () => () => {},
    }));
    setSpeechEngineSource(async () => ({
      load: async () => {},
      cancel: () => {
        cancels.speech++;
      },
      cacheState: state,
      remove: async () => {},
      onCrash: () => () => {},
    }));
    saveSettings({
      ...settings.value,
      nick: "Ada",
      ai: {
        model: "Qwen3.5-2B-q4f16_1-MLC",
        translateChat: true,
        speechModel: "onnx-community/whisper-small",
      },
    });
    aiModelId.value = "Qwen3.5-2B-q4f16_1-MLC";
    speechModelId.value = "onnx-community/whisper-small";
  });

  test("stops both engines, deletes the AI caches only, and forgets the chosen models", async () => {
    const s = storage([...AI, ...OTHERS]);
    await deleteAllAiData(s);
    expect(cancels).toEqual({ ai: 1, speech: 1 });
    expect([...s.names]).toEqual(OTHERS);
    expect(settings.value.ai).toEqual({ model: null, translateChat: true, speechModel: null });
    expect(settings.value.nick).toBe("Ada");
    expect(aiModelId.value).toBeNull();
    expect(speechModelId.value).toBeNull();
    expect(aiWipe.value).toEqual({ busy: false, error: null });
  });

  test("a partial failure says what couldn't be deleted", async () => {
    const s = storage([...AI, ...OTHERS], ["transformers-cache"]);
    await deleteAllAiData(s);
    expect(aiWipe.value).toEqual({
      busy: false,
      error: "Couldn't delete transformers-cache (quota error).",
    });
    expect([...s.names].sort()).toEqual(["transformers-cache", ...OTHERS].sort());
  });
});
