import { beforeEach, describe, expect, test } from "bun:test";
import { saveSettings, settings } from "../ui/settings";
import type { ModelCacheState } from "./protocol";
import { aiModelId, aiStatus, ensureModel, setAiEngineSource } from "./store";

const MODEL = "Qwen3.5-2B-q4f16_1-MLC";

function fakeEngine(state: ModelCacheState, load: () => Promise<void> = async () => {}) {
  const calls = { load: 0, cacheState: 0 };
  setAiEngineSource(async () => ({
    load: async () => {
      calls.load++;
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

describe("ensureModel", () => {
  beforeEach(() => {
    aiStatus.value = "idle";
    aiModelId.value = null;
    saveSettings({ ...settings.value, ai: { ...settings.value.ai, model: MODEL } });
  });

  test("false without a chosen model", async () => {
    saveSettings({ ...settings.value, ai: { ...settings.value.ai, model: null } });
    const calls = fakeEngine({ cached: true, complete: true, bytes: 1 });
    expect(await ensureModel()).toBe(false);
    expect(calls.load).toBe(0);
  });

  test("never downloads: a partial cache is false", async () => {
    const calls = fakeEngine({ cached: true, complete: false, bytes: 1 });
    expect(await ensureModel()).toBe(false);
    expect(calls.load).toBe(0);
  });

  test("loads a fully cached model, once for concurrent calls", async () => {
    const calls = fakeEngine({ cached: true, complete: true, bytes: 1 });
    const [a, b] = await Promise.all([ensureModel(), ensureModel()]);
    expect([a, b]).toEqual([true, true]);
    expect(calls).toEqual({ load: 1, cacheState: 2 });
    expect(aiModelId.value).toBe(MODEL);
    // Ready: no engine call at all.
    expect(await ensureModel()).toBe(true);
    expect(calls.load).toBe(1);
  });

  test("a real load failure rejects", async () => {
    fakeEngine({ cached: true, complete: true, bytes: 1 }, async () => {
      throw new Error("WebGPU device lost");
    });
    await expect(ensureModel()).rejects.toThrow("WebGPU device lost");
    expect(aiStatus.value).toBe("error");
  });
});
