import { beforeEach, describe, expect, test } from "bun:test";
import { saveSettings, settings } from "../ui/settings";
import type { ModelCacheState } from "./protocol";
import type { SpeechLoadOptions } from "./speech";
import { WHISPER_SMALL } from "./speechModels";
import {
  ensureSpeechModel,
  loadSpeechModel,
  setSpeechEngineSource,
  speechModelId,
  speechStatus,
} from "./speechStore";

function fakeEngine(state: ModelCacheState, load: () => Promise<void> = async () => {}) {
  const calls = { cacheState: 0, loads: [] as boolean[] };
  setSpeechEngineSource(async () => ({
    load: async (_id: string, opts: SpeechLoadOptions) => {
      calls.loads.push(opts.download);
      await load();
    },
    cancel: () => {},
    cacheState: async () => {
      calls.cacheState++;
      return state;
    },
    remove: async () => {},
    onCrash: () => () => {},
  }));
  return calls;
}

const speechModel = (id: string | null) =>
  saveSettings({ ...settings.value, ai: { ...settings.value.ai, speechModel: id } });

describe("ensureSpeechModel", () => {
  beforeEach(() => {
    speechStatus.value = "idle";
    speechModelId.value = null;
    speechModel(WHISPER_SMALL);
  });

  test("false without a downloaded model, or with one we don't know", async () => {
    const calls = fakeEngine({ cached: true, complete: true, bytes: 1 });
    speechModel(null);
    expect(await ensureSpeechModel()).toBe(false);
    speechModel("Qwen3.5-2B-q4f16_1-MLC");
    expect(await ensureSpeechModel()).toBe(false);
    expect(calls).toEqual({ cacheState: 0, loads: [] });
  });

  test("never downloads: a partial cache is false", async () => {
    const calls = fakeEngine({ cached: true, complete: false, bytes: 1 });
    expect(await ensureSpeechModel()).toBe(false);
    expect(calls.loads).toEqual([]);
  });

  test("loads a fully cached model from the cache only, once for concurrent calls", async () => {
    const calls = fakeEngine({ cached: true, complete: true, bytes: 1 });
    const [a, b] = await Promise.all([ensureSpeechModel(), ensureSpeechModel()]);
    expect([a, b]).toEqual([true, true]);
    expect(calls.loads).toEqual([false]);
    expect(speechModelId.value).toBe(WHISPER_SMALL);
    // Ready: no engine call at all.
    const before = calls.cacheState;
    expect(await ensureSpeechModel()).toBe(true);
    expect(calls.cacheState).toBe(before);
  });

  test("a real load failure rejects", async () => {
    fakeEngine({ cached: true, complete: true, bytes: 1 }, async () => {
      throw new Error("the speech worker crashed");
    });
    await expect(ensureSpeechModel()).rejects.toThrow("the speech worker crashed");
    expect(speechStatus.value).toBe("error");
  });
});

describe("loadSpeechModel", () => {
  test("a click downloads, and makes the model the one captions use", async () => {
    speechStatus.value = "idle";
    speechModelId.value = null;
    speechModel(null);
    const calls = fakeEngine({ cached: false, complete: false, bytes: 0 });
    expect(await loadSpeechModel(WHISPER_SMALL)).toBe(true);
    expect(calls.loads).toEqual([true]);
    expect(settings.value.ai.speechModel).toBe(WHISPER_SMALL);
  });
});
