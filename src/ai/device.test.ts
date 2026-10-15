import { describe, expect, test } from "bun:test";
import {
  type AdapterLike,
  type CachesLike,
  cachedModels,
  checkSpace,
  detectDevice,
  detectLocalSupport,
  downloadBudget,
  type GpuLike,
  modelCacheState,
  modelFiles,
  RESERVE_MIN_BYTES,
  UNKNOWN_MEMORY_BUDGET_MB,
} from "./device";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function fakeGpu(
  o: Partial<AdapterLike["limits"]> & { shaderF16?: boolean; adapter?: boolean } = {},
): GpuLike {
  return {
    requestAdapter: async () =>
      o.adapter === false
        ? null
        : {
            limits: {
              maxBufferSize: o.maxBufferSize ?? 4 * GiB,
              maxStorageBufferBindingSize: o.maxStorageBufferBindingSize ?? 4 * GiB,
              maxComputeWorkgroupStorageSize: o.maxComputeWorkgroupStorageSize ?? 32 * 1024,
            },
            features: { has: (name: string) => name === "shader-f16" && o.shaderF16 !== false },
            info: { vendor: "fake" },
          },
  };
}

/** WebLLM's Cache API layout, in memory. */
function fakeCaches(entries: Record<string, Record<string, unknown>>): CachesLike {
  return {
    has: async (name) => name in entries,
    open: async (name) => {
      const cache = entries[name] ?? {};
      return {
        match: async (url) => (url in cache ? { json: async () => cache[url] } : undefined),
        keys: async () => Object.keys(cache).map((url) => ({ url })),
      };
    },
  };
}

const files = modelFiles(
  "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC",
  "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_86/base/Qwen3.5-2B-q4f16_1-ctx4k_cs1k-webgpu.wasm",
);
const at = (path: string) => new URL(path, files.modelUrl).href;
const tensorList = {
  records: [
    { dataPath: "params_shard_0.bin", nbytes: 100 },
    { dataPath: "params_shard_1.bin", nbytes: 50 },
  ],
};

describe("detectLocalSupport", () => {
  test("no WebGPU, no adapter", async () => {
    expect(await detectLocalSupport({})).toEqual({ supported: false, reason: "no-webgpu" });
    expect(await detectLocalSupport({ gpu: fakeGpu({ adapter: false }) })).toEqual({
      supported: false,
      reason: "no-adapter",
    });
  });

  test("half the reported RAM is the GPU budget; unknown RAM gets the phone budget", async () => {
    const d = await detectLocalSupport({ gpu: fakeGpu(), deviceMemory: 8 });
    expect(d).toEqual({
      supported: true,
      gpu: {
        vendor: "fake",
        shaderF16: true,
        deviceMemoryGiB: 8,
        memoryBudgetMb: 4096,
        lowResource: false,
      },
    });
    const u = await detectLocalSupport({ gpu: fakeGpu() });
    expect(u.supported && u.gpu.memoryBudgetMb).toBe(UNKNOWN_MEMORY_BUDGET_MB);
    expect(u.supported && u.gpu.deviceMemoryGiB).toBeNull();
  });

  test("adapter limits: below WebLLM's floor is too little memory, below 1 GiB is low-resource", async () => {
    const small = await detectLocalSupport({ gpu: fakeGpu({ maxBufferSize: 128 * MiB }) });
    expect(small.supported).toBe(false);
    expect(!small.supported && small.reason).toBe("too-little-memory");
    const low = await detectLocalSupport({
      gpu: fakeGpu({ maxStorageBufferBindingSize: 512 * MiB }),
    });
    expect(low.supported && low.gpu.lowResource).toBe(true);
    const noF16 = await detectLocalSupport({ gpu: fakeGpu({ shaderF16: false }) });
    expect(noF16.supported && noF16.gpu.shaderF16).toBe(false);
  });
});

describe("space", () => {
  test("without an estimate the answer is unknown", () => {
    expect(checkSpace(null, 10, 0)).toEqual({ ok: false, reason: "unknown" });
    expect(checkSpace({ usage: 1 }, 10, 0)).toEqual({ ok: false, reason: "unknown" });
    expect(downloadBudget({ usage: 0, quota: 0 }, 0)).toBeNull();
  });

  test("the reserve is 1 GiB, or what recordings and files already use", () => {
    const free = 3 * GiB;
    expect(downloadBudget({ usage: 0, quota: free }, 0)).toEqual({
      budgetBytes: 2 * GiB,
      freeBytes: free,
      reserveBytes: RESERVE_MIN_BYTES,
    });
    // 2 GiB used, 1.5 of it by cached models: the reserve stays 1 GiB.
    expect(downloadBudget({ usage: 2 * GiB, quota: 5 * GiB }, 1.5 * GiB)?.reserveBytes).toBe(GiB);
    // 2 GiB used by recordings and files: they keep room to double.
    expect(downloadBudget({ usage: 2 * GiB, quota: 5 * GiB }, 0)?.reserveBytes).toBe(2 * GiB);
  });

  test("a download fits only if the reserve is still free afterwards", () => {
    expect(checkSpace({ usage: 0, quota: 3 * GiB }, 2 * GiB, 0)).toEqual({
      ok: true,
      needBytes: 2 * GiB,
      freeBytes: 3 * GiB,
      reserveBytes: GiB,
    });
    expect(checkSpace({ usage: 0, quota: 3 * GiB }, 2 * GiB + 1, 0)).toEqual({
      ok: false,
      reason: "not-enough-space",
      needBytes: 2 * GiB + 1,
      freeBytes: 3 * GiB,
      reserveBytes: GiB,
    });
  });
});

describe("WebLLM cache", () => {
  test("modelFiles spells the URLs as WebLLM does", () => {
    expect(files.modelUrl).toBe(
      "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC/resolve/main/",
    );
    expect(files.libFile).toBe("Qwen3.5-2B-q4f16_1-ctx4k_cs1k-webgpu.wasm");
  });

  test("nothing cached", async () => {
    expect(await modelCacheState(fakeCaches({}), files)).toEqual({
      cached: false,
      complete: false,
      bytes: 0,
    });
    expect(await cachedModels(fakeCaches({}))).toEqual({});
  });

  test("a stopped download is cached but not complete", async () => {
    const caches = fakeCaches({
      "webllm/model": { [at("tensor-cache.json")]: tensorList, [at("params_shard_0.bin")]: 0 },
    });
    expect(await modelCacheState(caches, files)).toEqual({
      cached: true,
      complete: false,
      bytes: 100,
    });
    expect(await cachedModels(caches)).toEqual({ [files.modelUrl]: 100 });
  });

  test("weights, tokenizer and library: complete", async () => {
    const caches = fakeCaches({
      "webllm/model": {
        [at("tensor-cache.json")]: tensorList,
        [at("params_shard_0.bin")]: 0,
        [at("params_shard_1.bin")]: 0,
        [at("tokenizer.json")]: 0,
      },
      "webllm/config": { [at("mlc-chat-config.json")]: { tokenizer_files: ["tokenizer.json"] } },
      "webllm/wasm": { [`https://raw.githubusercontent.com/x/${files.libFile}`]: 0 },
    });
    expect(await modelCacheState(caches, files)).toEqual({
      cached: true,
      complete: true,
      bytes: 150,
    });
  });

  test("a malformed tensor list is an error, not an empty cache", async () => {
    const caches = fakeCaches({ "webllm/model": { [at("tensor-cache.json")]: { records: [1] } } });
    await expect(modelCacheState(caches, files)).rejects.toThrow(/malformed/);
  });
});

describe("detectDevice", () => {
  test("reads the GPU, the estimate and the cache", async () => {
    const d = await detectDevice({
      gpu: fakeGpu(),
      deviceMemory: 4,
      storage: { estimate: async () => ({ usage: 5, quota: 10 }) },
      caches: fakeCaches({
        "webllm/model": { [at("tensor-cache.json")]: tensorList, [at("params_shard_1.bin")]: 0 },
      }),
    });
    expect(d.detection.supported && d.detection.gpu.memoryBudgetMb).toBe(2048);
    expect(d.estimate).toEqual({ usage: 5, quota: 10 });
    expect(d.cached).toEqual({ [files.modelUrl]: 50 });
  });

  test("a browser without storage estimate or caches", async () => {
    const d = await detectDevice({});
    expect(d).toEqual({
      detection: { supported: false, reason: "no-webgpu" },
      estimate: null,
      cached: {},
    });
  });
});
