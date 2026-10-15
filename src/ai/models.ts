/**
 * Which on-device model to offer: llm-models ranks the models the installed
 * WebLLM runs against the GPU memory budget, fp16 support, the adapter's
 * limits and the free space. Pure: the device is read by device.ts. Load this
 * module lazily: it carries llm-models' catalog.
 */
// First: zod must read its config before llm-models loads it.
import "./zodJitless";
import {
  type BrowserModel,
  type BrowserModelNeed,
  listBrowserModels,
  recommendBrowserModel,
} from "llm-models/browser";
import {
  type DeviceInfo,
  downloadBudget,
  downloadBytesOf,
  modelFiles,
  NON_WEIGHT_ALLOWANCE_BYTES,
  type UnsupportedReason,
} from "./device";
// The installed WebLLM's models, extracted at build time (scripts/engine-models.ts).
import { ENGINE_MODELS, type EngineModel } from "./engineModels";
import { isAudioModel } from "./modelIds";

/** Meeting notes ask for structured output, in the meeting's language. */
export const LOCAL_NEEDS: readonly BrowserModelNeed[] = ["json", "multilingual"];
/** Other choices shown besides the recommended one. */
export const MAX_ALTERNATIVES = 3;

export { isAudioModel };

export interface ModelChoice {
  id: string;
  /** "Gemma 4 E2B", "Qwen3.5-2B". */
  label: string;
  /** Bytes of weights to download. */
  downloadBytes: number;
  /** GPU memory the model needs (WebLLM's figure). */
  vramMb: number;
  /** Tokens of context. */
  contextWindow: number;
  /** Why this model, in English. */
  reason: string;
}

export interface Recommendation {
  /** Best model for the device ignoring space (what we'd like). */
  best: ModelChoice | null;
  /** Best model that also fits the download budget (== best when space is fine). */
  fits: ModelChoice | null;
  /** E.g. "Gemma 4 E2B needs 2.9 GB, 2.1 GB free" when best doesn't fit. */
  spaceNote: string | null;
  /** Up to 3 other choices that fit. */
  alternatives: ModelChoice[];
  unsupported: null | UnsupportedReason;
}

/** "gemma-4-E2B-it-q4f16_1-MLC" → "Gemma 4 E2B"; "Qwen3.5-2B-q4f16_1-MLC" → "Qwen3.5-2B". */
export function modelLabel(id: string): string {
  const base = id
    .replace(/-q\d+f\d+(_\d+)?-MLC(-\d+k)?$/, "")
    .replace(/-(it|Instruct|instruct|chat-hf|chat)$/, "");
  const gemma = /^gemma-(.+)$/i.exec(base);
  return gemma ? `Gemma ${(gemma[1] ?? "").split("-").join(" ")}` : base;
}

/** Decimal gigabytes, one decimal: what file managers show. */
export function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** What is left to download of `model`: weights not cached yet, plus its library and tokenizer. */
function remainingBytes(model: BrowserModel, device: DeviceInfo): number {
  const weights = downloadBytesOf(model) ?? 0;
  const cached = device.cached[modelFiles(model.hf_repo, model.model_lib).modelUrl] ?? 0;
  return cached >= weights ? 0 : weights - cached + NON_WEIGHT_ALLOWANCE_BYTES;
}

function choice(model: BrowserModel, engine: EngineModel | undefined, reason: string): ModelChoice {
  return {
    id: model.id,
    label: modelLabel(model.id),
    downloadBytes: downloadBytesOf(model) ?? 0,
    vramMb: Math.ceil(model.vram_required_mb),
    contextWindow: engine?.contextWindow ?? model.context_window ?? 4096,
    reason,
  };
}

const none = (unsupported: UnsupportedReason): Recommendation => ({
  best: null,
  fits: null,
  spaceNote: null,
  alternatives: [],
  unsupported,
});

/**
 * The best model this device runs, and the best that also fits the free
 * space (minus the reserve kept for recordings and files). Without a space
 * estimate, nothing limits the download.
 */
export function recommendLocal(
  device: DeviceInfo,
  catalog: readonly BrowserModel[] = listBrowserModels(),
  engine: readonly EngineModel[] = ENGINE_MODELS,
): Recommendation {
  const { detection } = device;
  if (!detection.supported) return none(detection.reason);
  const { gpu } = detection;
  const engineById = new Map(engine.map((m) => [m.id, m]));
  // llm-models' catalog may list builds newer than the installed WebLLM.
  const runnable = catalog.filter((m) => engineById.has(m.id));
  const options = {
    vram_budget_mb: gpu.memoryBudgetMb,
    needs: [...LOCAL_NEEDS],
    shader_f16: gpu.shaderF16,
    low_resource: gpu.lowResource,
  };
  const bestPick = recommendBrowserModel(options, runnable);
  if (!bestPick) return none("too-little-memory");
  const best = choice(bestPick.model, engineById.get(bestPick.model.id), bestPick.reason);

  const budget = downloadBudget(
    device.estimate,
    Object.values(device.cached).reduce((a, b) => a + b, 0),
  );
  if (!budget) {
    const alternatives = bestPick.alternatives
      .slice(0, MAX_ALTERNATIVES)
      .map((m) => choice(m, engineById.get(m.id), shortReason(m)));
    return { best, fits: best, spaceNote: null, alternatives, unsupported: null };
  }

  // Rank on what is left to download: a cached model costs no space.
  const sized = runnable.map((m) => ({ ...m, download_mb: remainingBytes(m, device) / 1e6 }));
  const byId = new Map(runnable.map((m) => [m.id, m]));
  const fitsPick = recommendBrowserModel(
    // llm-models wants a positive budget; one byte still only fits cached models.
    { ...options, download_budget_mb: Math.max(1, budget.budgetBytes) / 1e6 },
    sized,
  );
  const original = (m: BrowserModel) => byId.get(m.id) ?? m;
  const fits = fitsPick
    ? choice(original(fitsPick.model), engineById.get(fitsPick.model.id), fitsPick.reason)
    : null;
  const alternatives = (fitsPick?.alternatives ?? [])
    .slice(0, MAX_ALTERNATIVES)
    .map((m) => choice(original(m), engineById.get(m.id), shortReason(original(m))));
  const spaceNote =
    fits?.id === best.id
      ? null
      : `${best.label} needs ${formatGb(remainingBytes(bestPick.model, device))}, ${formatGb(budget.freeBytes)} free`;
  return { best, fits, spaceNote, alternatives, unsupported: null };
}

function shortReason(m: BrowserModel): string {
  const size = formatGb(downloadBytesOf(m) ?? 0);
  return `${modelLabel(m.id)} needs ${Math.ceil(m.vram_required_mb)} MB of GPU memory and a ${size} download.`;
}

/**
 * The audio model (Gemma 4 E2B) this device can run and download, by the same
 * rules as `recommendLocal`; null when no build of it fits.
 */
export function audioModelFit(
  device: DeviceInfo,
  catalog: readonly BrowserModel[] = listBrowserModels(),
  engine: readonly EngineModel[] = ENGINE_MODELS,
): ModelChoice | null {
  return recommendLocal(
    device,
    catalog.filter((m) => isAudioModel(m.id)),
    engine,
  ).fits;
}
