import { describe, expect, test } from "bun:test";
import { downloadBudget } from "./device";
import {
  filesBytes,
  formatMb,
  recommendSpeech,
  removeSpeechFiles,
  SPEECH_CACHE,
  SPEECH_MODELS,
  type SpeechBackend,
  type SpeechCachesLike,
  type SpeechDevice,
  speechBackend,
  speechCacheState,
  speechFileUrl,
  speechModel,
  speechPlan,
  WHISPER_BASE,
  WHISPER_SMALL,
  WHISPER_TURBO,
  whisperLanguage,
} from "./speechModels";

const GiB = 1024 ** 3;
const BACKENDS: SpeechBackend[] = ["webgpu-f16", "webgpu", "wasm"];

function model(id: string) {
  const m = speechModel(id);
  if (!m) throw new Error(`${id} missing`);
  return m;
}

function plan(id: string, backend: SpeechBackend) {
  const p = speechPlan(model(id), backend);
  if (!p) throw new Error(`${id} doesn't run on ${backend}`);
  return p;
}

function device(o: Partial<SpeechDevice> = {}): SpeechDevice {
  return { backend: "webgpu-f16", budget: null, cached: {}, ...o };
}

/** The budget device.ts computes for `freeBytes` free on an otherwise empty origin. */
function budgetFor(freeBytes: number) {
  return downloadBudget({ quota: freeBytes, usage: 0 }, 0);
}

const COMMON = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];

describe("speech catalog", () => {
  test("the backend: WebGPU with or without fp16, else WebAssembly", () => {
    expect(speechBackend({ shaderF16: true })).toBe("webgpu-f16");
    expect(speechBackend({ shaderF16: false })).toBe("webgpu");
    expect(speechBackend(null)).toBe("wasm");
  });

  test("base and small: fp16 encoder and q4 decoder on WebGPU with fp16", () => {
    for (const id of [WHISPER_BASE, WHISPER_SMALL]) {
      const p = plan(id, "webgpu-f16");
      expect(p.device).toBe("webgpu");
      expect(p.dtype).toEqual({ model: "fp16", encoder_model: "fp16", decoder_model_merged: "q4" });
      expect(p.files.map((f) => f.path)).toEqual([
        ...COMMON,
        "onnx/encoder_model_fp16.onnx",
        "onnx/decoder_model_merged_q4.onnx",
      ]);
    }
  });

  test("base and small: fp32 encoder and q4 decoder on WebGPU without fp16", () => {
    for (const id of [WHISPER_BASE, WHISPER_SMALL]) {
      const p = plan(id, "webgpu");
      expect(p.device).toBe("webgpu");
      expect(p.dtype).toEqual({ model: "fp32", encoder_model: "fp32", decoder_model_merged: "q4" });
      expect(p.files.slice(-2).map((f) => f.path)).toEqual([
        "onnx/encoder_model.onnx",
        "onnx/decoder_model_merged_q4.onnx",
      ]);
    }
  });

  test("base and small: q8 (quantized) on WebAssembly, never on WebGPU", () => {
    for (const id of [WHISPER_BASE, WHISPER_SMALL]) {
      const p = plan(id, "wasm");
      expect(p.device).toBe("wasm");
      expect(p.dtype).toEqual({ model: "q8", encoder_model: "q8", decoder_model_merged: "q8" });
      expect(p.files.slice(-2).map((f) => f.path)).toEqual([
        "onnx/encoder_model_quantized.onnx",
        "onnx/decoder_model_merged_quantized.onnx",
      ]);
      for (const b of ["webgpu-f16", "webgpu"] as const)
        expect(Object.values(plan(id, b).dtype)).not.toContain("q8");
    }
  });

  test("large-v3 turbo: q4f16 on WebGPU with fp16 only", () => {
    const p = plan(WHISPER_TURBO, "webgpu-f16");
    expect(p.device).toBe("webgpu");
    expect(p.dtype).toEqual({
      model: "q4f16",
      encoder_model: "q4f16",
      decoder_model_merged: "q4f16",
    });
    expect(p.files.map((f) => f.path)).toEqual([
      ...COMMON,
      "onnx/encoder_model_q4f16.onnx",
      "onnx/decoder_model_merged_q4f16.onnx",
    ]);
    expect(speechPlan(model(WHISPER_TURBO), "webgpu")).toBeNull();
    expect(speechPlan(model(WHISPER_TURBO), "wasm")).toBeNull();
  });

  test("sizes are those of the files each backend fetches", () => {
    const sizes = (b: SpeechBackend) =>
      SPEECH_MODELS.map((m) => {
        const p = speechPlan(m, b);
        return p ? formatMb(filesBytes(p.files)) : null;
      });
    expect(sizes("webgpu-f16")).toEqual(["168 MB", "413 MB", "566 MB"]);
    expect(sizes("webgpu")).toEqual(["209 MB", "589 MB", null]);
    expect(sizes("wasm")).toEqual(["80 MB", "252 MB", null]);
    expect(filesBytes(plan(WHISPER_BASE, "wasm").files)).toBe(79_664_191);
  });

  test("files are fetched from, and cached under, their Hugging Face URL", () => {
    expect(speechFileUrl(model(WHISPER_SMALL), "onnx/encoder_model_quantized.onnx")).toBe(
      "https://huggingface.co/onnx-community/whisper-small/resolve/main/onnx/encoder_model_quantized.onnx",
    );
    expect(speechModel("Qwen3.5-2B-q4f16_1-MLC")).toBeUndefined();
  });
});

describe("whisperLanguage", () => {
  test("the base code of the speaker's tag, when Whisper knows it", () => {
    expect(whisperLanguage("fr-FR")).toBe("fr");
    expect(whisperLanguage("en")).toBe("en");
    expect(whisperLanguage("PT-br")).toBe("pt");
    expect(whisperLanguage("haw")).toBe("haw");
  });

  test("tags Whisper spells differently", () => {
    expect(whisperLanguage("nb-NO")).toBe("no");
    expect(whisperLanguage("iw")).toBe("he");
    expect(whisperLanguage("jv-ID")).toBe("jw");
    expect(whisperLanguage("fil-PH")).toBe("tl");
  });

  test("unknown languages are left to Whisper's detection", () => {
    expect(whisperLanguage("zu-ZA")).toBeUndefined();
    expect(whisperLanguage("")).toBeUndefined();
  });
});

describe("recommendSpeech", () => {
  test("WebGPU with fp16 and room: large-v3 turbo, the two others below, sized for WebGPU", () => {
    const r = recommendSpeech(device());
    expect(r.pick).toEqual({
      id: WHISPER_TURBO,
      label: "Whisper large-v3 turbo",
      downloadBytes: filesBytes(plan(WHISPER_TURBO, "webgpu-f16").files),
      runs: true,
      fits: true,
      reason: "The most accurate: this device runs it on WebGPU.",
    });
    expect(r.others.map((c) => [c.id, formatMb(c.downloadBytes), c.runs, c.reason])).toEqual([
      [WHISPER_BASE, "168 MB", true, "The smallest and fastest, less accurate."],
      [WHISPER_SMALL, "413 MB", true, "Accurate, on any device."],
    ]);
  });

  test("WebGPU without fp16, or no WebGPU: small, and turbo can't be downloaded", () => {
    for (const backend of ["webgpu", "wasm"] as const) {
      const r = recommendSpeech(device({ backend }));
      expect(r.pick.id).toBe(WHISPER_SMALL);
      expect(formatMb(r.pick.downloadBytes)).toBe(backend === "wasm" ? "252 MB" : "589 MB");
      expect(r.pick.reason).toBe(
        "Whisper large-v3 turbo needs WebGPU with fp16; small is accurate and runs on any device.",
      );
      const turbo = r.others.find((c) => c.id === WHISPER_TURBO);
      expect(turbo?.runs).toBe(false);
      expect(turbo?.reason).toBe("Whisper large-v3 turbo needs WebGPU with fp16.");
    }
  });

  test("too little space for turbo: small, with the numbers (device.ts's reserve applies)", () => {
    // 1.5 GB free minus the 1 GiB reserve leaves ~426 MB: small fits, turbo doesn't.
    const r = recommendSpeech(device({ budget: budgetFor(1.5e9) }));
    expect(r.pick.id).toBe(WHISPER_SMALL);
    expect(r.pick.reason).toBe(
      "Whisper large-v3 turbo needs 566 MB, 1500 MB free; small is accurate and runs on any device.",
    );
    expect(r.others.find((c) => c.id === WHISPER_TURBO)?.fits).toBe(false);
  });

  test("room for base only, then not even for base", () => {
    const wasm = (budget: ReturnType<typeof budgetFor>) =>
      recommendSpeech(device({ backend: "wasm", budget }));
    const some = wasm(budgetFor(GiB + 100e6));
    expect(some.pick.id).toBe(WHISPER_BASE);
    expect(some.pick.fits).toBe(true);
    expect(some.pick.reason).toBe(
      `Whisper small needs 252 MB, ${formatMb(GiB + 100e6)} free; base is the smallest.`,
    );
    const none = wasm(budgetFor(GiB + 50e6));
    expect(none.pick.id).toBe(WHISPER_BASE);
    expect(none.pick.fits).toBe(false);
    expect(none.pick.reason).toBe(`Whisper base needs 80 MB, ${formatMb(GiB + 50e6)} free.`);
  });

  test("what is cached costs no space", () => {
    const turbo = filesBytes(plan(WHISPER_TURBO, "webgpu-f16").files);
    const budget = budgetFor(GiB + 100e6);
    expect(recommendSpeech(device({ budget })).pick.id).toBe(WHISPER_BASE);
    const r = recommendSpeech(device({ budget, cached: { [WHISPER_TURBO]: turbo - 50e6 } }));
    expect(r.pick.id).toBe(WHISPER_TURBO);
  });

  test("no space estimate: nothing limits the download", () => {
    for (const backend of BACKENDS)
      expect(recommendSpeech(device({ backend, budget: null })).pick.fits).toBe(true);
  });
});

/** A Cache API over a set of URLs. */
function fakeCaches(urls: string[]): SpeechCachesLike & { urls: Set<string> } {
  const set = new Set(urls);
  return {
    urls: set,
    has: async (name) => name === SPEECH_CACHE && set.size > 0,
    open: async () => ({
      match: async (url) => (set.has(url) ? {} : undefined),
      keys: async () => [...set].map((url) => ({ url })),
      delete: async (url) => set.delete(url),
    }),
  };
}

describe("speech cache", () => {
  const base = model(WHISPER_BASE);
  const urls = (id: string, backend: SpeechBackend) =>
    plan(id, backend).files.map((f) => speechFileUrl(model(id), f.path));

  test("nothing, part, or every file of this backend's build", async () => {
    expect(await speechCacheState(fakeCaches([]), base, "wasm")).toEqual({
      cached: false,
      complete: false,
      bytes: 0,
    });
    expect(
      await speechCacheState(fakeCaches(urls(WHISPER_BASE, "wasm").slice(0, 1)), base, "wasm"),
    ).toEqual({ cached: true, complete: false, bytes: 2243 });
    expect(await speechCacheState(fakeCaches(urls(WHISPER_BASE, "wasm")), base, "wasm")).toEqual({
      cached: true,
      complete: true,
      bytes: filesBytes(plan(WHISPER_BASE, "wasm").files),
    });
  });

  test("another backend's build counts as cached, not as complete", async () => {
    const caches = fakeCaches(urls(WHISPER_BASE, "wasm"));
    const state = await speechCacheState(caches, base, "webgpu-f16");
    expect(state.complete).toBe(false);
    expect(state.cached).toBe(true);
    expect(state.bytes).toBe(filesBytes(plan(WHISPER_BASE, "wasm").files));
    // Both builds cached: every file counts once.
    const both = fakeCaches([...urls(WHISPER_BASE, "wasm"), ...urls(WHISPER_BASE, "webgpu-f16")]);
    const s = await speechCacheState(both, base, "webgpu-f16");
    expect(s.complete).toBe(true);
    expect(s.bytes).toBe(
      filesBytes(plan(WHISPER_BASE, "wasm").files) +
        filesBytes(plan(WHISPER_BASE, "webgpu-f16").files.slice(-2)),
    );
  });

  test("remove deletes that model's files of every build and leaves the others", async () => {
    const extra = "https://huggingface.co/onnx-community/whisper-base/resolve/main/README.md";
    const small = urls(WHISPER_SMALL, "wasm");
    const caches = fakeCaches([
      ...urls(WHISPER_BASE, "wasm"),
      ...urls(WHISPER_BASE, "webgpu"),
      extra,
      ...small,
    ]);
    await removeSpeechFiles(caches, base);
    expect([...caches.urls]).toEqual(small);
    expect((await speechCacheState(caches, model(WHISPER_SMALL), "wasm")).complete).toBe(true);
  });
});
