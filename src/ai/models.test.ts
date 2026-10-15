import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { listBrowserModels } from "llm-models/browser";
import { engineModelsSource, OUT } from "../../scripts/engine-models";
import { type DeviceInfo, type GpuReport, modelFiles, NON_WEIGHT_ALLOWANCE_BYTES } from "./device";
import { ENGINE_MODELS } from "./engineModels";
import { formatGb, modelLabel, recommendLocal } from "./models";

const GiB = 1024 * 1024 * 1024;
const GEMMA = "gemma-4-E2B-it-q4f16_1-MLC";

function device(o: Partial<GpuReport> = {}, rest: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    detection: {
      supported: true,
      gpu: {
        vendor: "fake",
        shaderF16: true,
        deviceMemoryGiB: 8,
        memoryBudgetMb: 4096,
        lowResource: false,
        ...o,
      },
    },
    estimate: { usage: 0, quota: 100 * GiB },
    cached: {},
    ...rest,
  };
}

describe("engine models", () => {
  test("engineModels.ts matches the installed WebLLM (run scripts/engine-models.ts)", () => {
    expect(readFileSync(OUT, "utf8")).toBe(engineModelsSource());
  });

  test("Gemma 4 E2B is there, with its needs", () => {
    expect(ENGINE_MODELS.find((m) => m.id === GEMMA)).toEqual({
      id: GEMMA,
      vramMb: 3388,
      shaderF16: true,
      lowResource: false,
      contextWindow: 4096,
    });
  });
});

describe("labels", () => {
  test("human names", () => {
    expect(modelLabel(GEMMA)).toBe("Gemma 4 E2B");
    expect(modelLabel("Qwen3.5-2B-q4f16_1-MLC")).toBe("Qwen3.5-2B");
    expect(modelLabel("Llama-3.2-1B-Instruct-q4f32_1-MLC")).toBe("Llama-3.2-1B");
    expect(modelLabel("gemma-2b-it-q4f16_1-MLC-1k")).toBe("Gemma 2b");
    expect(formatGb(2.86e9)).toBe("2.9 GB");
  });
});

describe("recommendLocal", () => {
  test("no WebGPU, and nothing fitting the GPU", () => {
    const none = { best: null, fits: null, spaceNote: null, alternatives: [] };
    expect(
      recommendLocal({
        detection: { supported: false, reason: "no-webgpu" },
        estimate: null,
        cached: {},
      }),
    ).toEqual({ ...none, unsupported: "no-webgpu" });
    expect(recommendLocal(device({ memoryBudgetMb: 100 }))).toEqual({
      ...none,
      unsupported: "too-little-memory",
    });
  });

  test("plenty of space: best and fits are the same, with alternatives", () => {
    const r = recommendLocal(device());
    expect(r.unsupported).toBeNull();
    expect(r.best).not.toBeNull();
    expect(r.fits).toEqual(r.best);
    expect(r.spaceNote).toBeNull();
    expect(r.best?.vramMb).toBeLessThanOrEqual(4096);
    expect(r.best?.reason).toContain("4096 MB budget");
    expect(r.alternatives.length).toBe(3);
    expect(r.alternatives.map((a) => a.id)).not.toContain(r.best?.id);
  });

  test("16 GB of RAM, shader-f16, 2.1 GB free: the best that fits, with the numbers", () => {
    const r = recommendLocal(device({}, { estimate: { usage: 0, quota: 2.1e9 } }));
    const budget = 2.1e9 - GiB;
    expect(r.fits?.id).not.toBe(GEMMA);
    expect(r.fits?.id).not.toBe(r.best?.id);
    expect((r.fits?.downloadBytes ?? Infinity) + NON_WEIGHT_ALLOWANCE_BYTES).toBeLessThanOrEqual(
      budget,
    );
    // 1.03 GB budget: Qwen3.5-2B (1.06 GB) and Qwen3-1.7B (0.97 GB plus library and
    // tokenizer) just miss it.
    expect(r.fits?.id).toBe("Qwen2.5-1.5B-Instruct-q4f16_1-MLC");
    expect(r.fits?.label).toBe("Qwen2.5-1.5B");
    expect(r.spaceNote).toBe(
      `${r.best?.label} needs ${formatGb((r.best?.downloadBytes ?? 0) + NON_WEIGHT_ALLOWANCE_BYTES)}, 2.1 GB free`,
    );
    for (const a of r.alternatives)
      expect(a.downloadBytes + NON_WEIGHT_ALLOWANCE_BYTES).toBeLessThanOrEqual(budget);
  });

  test("with a bit more room, Qwen3.5-2B fits", () => {
    const r = recommendLocal(device({}, { estimate: { usage: 0, quota: 2.25e9 } }));
    expect(r.fits?.id).toBe("Qwen3.5-2B-q4f16_1-MLC");
    expect(r.fits?.contextWindow).toBe(4096);
  });

  test("a cached model costs no space", () => {
    const gemma = catalogModel(GEMMA);
    const cached = { [modelFiles(gemma.hf_repo, gemma.model_lib).modelUrl]: 2_797_577_798 };
    // Budget that only Gemma, being cached, fits in.
    const rec = recommendLocal(
      device({ memoryBudgetMb: 3500 }, { estimate: { usage: 2.8e9, quota: 2.8e9 + GiB }, cached }),
      [gemma],
    );
    expect(rec.fits?.id).toBe(GEMMA);
    expect(rec.spaceNote).toBeNull();
  });

  test("no space estimate: nothing limits the download", () => {
    const r = recommendLocal(device({}, { estimate: null }));
    expect(r.fits).toEqual(r.best);
    expect(r.spaceNote).toBeNull();
  });

  test("no shader-f16: q4f32 builds only", () => {
    const r = recommendLocal(device({ shaderF16: false }));
    expect(r.best?.id).toMatch(/q4f32/);
    for (const a of r.alternatives) expect(a.id).not.toMatch(/f16/);
  });
});

function catalogModel(id: string) {
  const m = listBrowserModels().find((x) => x.id === id);
  if (!m) throw new Error(`${id} missing from llm-models`);
  return m;
}

describe("zod config", () => {
  test("importing models.ts makes zod jitless (no `new Function` under Trusted Types)", () => {
    const g = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
    expect(g.__zod_globalConfig?.jitless).toBe(true);
  });
});
