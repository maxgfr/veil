/**
 * What this device offers the on-device model: WebGPU and how much GPU memory
 * a model may take, the free space of the origin, and what WebLLM already
 * cached. Shared by the page and the AI worker; it imports nothing heavy
 * besides llm-models' catalog (load this module lazily).
 */
// First: zod must read its config before llm-models loads it.
import "./zodJitless";
import { type BrowserModel, browserModelCatalog } from "llm-models/browser";
import type { ModelCacheState } from "./protocol";

// ---------------------------------------------------------------------------
// Detection

/** The parts of a WebGPU adapter detection reads (structural, so tests can fake it). */
export interface AdapterLike {
  readonly limits: {
    readonly maxBufferSize: number;
    readonly maxStorageBufferBindingSize: number;
    readonly maxComputeWorkgroupStorageSize: number;
  };
  readonly features: { has(name: string): boolean };
  readonly info?: { readonly vendor?: string; readonly architecture?: string };
}

export interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: "high-performance" | "low-power";
  }): Promise<AdapterLike | null>;
}

/** What the browser exposes: `navigator.gpu` and Chromium's `navigator.deviceMemory` (GiB). */
export interface DetectEnv {
  gpu?: GpuLike | undefined;
  deviceMemory?: number | undefined;
}

export type UnsupportedReason = "no-webgpu" | "no-adapter" | "too-little-memory";

export interface GpuReport {
  vendor: string;
  /** fp16 compute (`shader-f16`): WebLLM's q4f16 builds need it. */
  shaderF16: boolean;
  /** RAM the browser reports (Chromium only, capped at 8 GiB); null when it does not say. */
  deviceMemoryGiB: number | null;
  /** GPU memory a model may take, estimated: WebGPU does not expose it. */
  memoryBudgetMb: number;
  /** The adapter binds less than 1 GiB per storage buffer: only low-resource builds load. */
  lowResource: boolean;
}

export type LocalDetection =
  | { supported: true; gpu: GpuReport }
  | { supported: false; reason: UnsupportedReason; gpu?: GpuReport };

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
/**
 * WebLLM refuses to start below these adapter limits (`detectGPUDevice`: 256 MiB
 * buffers, 128 MiB storage bindings, 32 KiB of workgroup storage) and only a few
 * models load below 1 GiB storage bindings.
 */
export const WEBLLM_MIN_BUFFER = 256 * MiB;
export const WEBLLM_MIN_STORAGE_BINDING = 128 * MiB;
export const WEBLLM_MIN_WORKGROUP_STORAGE = 32 * 1024;
export const WEBLLM_FULL_STORAGE_BINDING = GiB;
/**
 * Share of RAM a model may take when the browser reports RAM. Apple GPUs share
 * RAM with the system; half leaves the OS, the browser and the call their part.
 */
export const GPU_SHARE_OF_RAM = 0.5;
/** Budget when RAM is unknown (Safari never reports it): sized for a phone. */
export const UNKNOWN_MEMORY_BUDGET_MB = 2048;

/** Whether this device can run a model, and how much GPU memory one may take. */
export async function detectLocalSupport(env: DetectEnv): Promise<LocalDetection> {
  if (!env.gpu) return { supported: false, reason: "no-webgpu" };
  const adapter = await env.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return { supported: false, reason: "no-adapter" };
  const limits = adapter.limits;
  const memory =
    typeof env.deviceMemory === "number" && env.deviceMemory > 0 ? env.deviceMemory : null;
  const gpu: GpuReport = {
    vendor: adapter.info?.vendor ?? "",
    shaderF16: adapter.features.has("shader-f16"),
    deviceMemoryGiB: memory,
    memoryBudgetMb:
      memory === null ? UNKNOWN_MEMORY_BUDGET_MB : Math.floor(memory * 1024 * GPU_SHARE_OF_RAM),
    lowResource: limits.maxStorageBufferBindingSize < WEBLLM_FULL_STORAGE_BINDING,
  };
  if (
    limits.maxBufferSize < WEBLLM_MIN_BUFFER ||
    limits.maxStorageBufferBindingSize < WEBLLM_MIN_STORAGE_BINDING ||
    limits.maxComputeWorkgroupStorageSize < WEBLLM_MIN_WORKGROUP_STORAGE
  ) {
    return { supported: false, reason: "too-little-memory", gpu };
  }
  return { supported: true, gpu };
}

// ---------------------------------------------------------------------------
// Space

export interface StorageEstimateLike {
  usage?: number;
  quota?: number;
}
export interface StorageLike {
  estimate(): Promise<StorageEstimateLike>;
}

/** After a download, the origin keeps at least this much free, or as much as Veil already uses. */
export const RESERVE_MIN_BYTES = GiB;
/** WebLLM also caches the model's WebGPU library, tokenizer and config, beyond the weights. */
export const NON_WEIGHT_ALLOWANCE_BYTES = 64 * MiB;

export type SpaceVerdict =
  | {
      ok: true;
      /** Bytes still to download. */
      needBytes: number;
      /** Free space of the origin now. */
      freeBytes: number;
      /** Space kept for recordings and files after the download. */
      reserveBytes: number;
    }
  | { ok: false; reason: "unknown" }
  | {
      ok: false;
      reason: "not-enough-space";
      needBytes: number;
      freeBytes: number;
      reserveBytes: number;
    };

/** Free space minus the reserve: the largest download that fits; null without an estimate. */
export function downloadBudget(
  estimate: StorageEstimateLike | null,
  cachedModelBytes: number,
): { budgetBytes: number; freeBytes: number; reserveBytes: number } | null {
  if (
    !estimate ||
    typeof estimate.usage !== "number" ||
    typeof estimate.quota !== "number" ||
    estimate.quota <= 0
  ) {
    return null;
  }
  const freeBytes = Math.max(0, estimate.quota - estimate.usage);
  // Recordings and files share the origin's quota: keep room for them to double.
  const others = Math.max(0, estimate.usage - cachedModelBytes);
  const reserveBytes = Math.max(RESERVE_MIN_BYTES, others);
  return { budgetBytes: Math.max(0, freeBytes - reserveBytes), freeBytes, reserveBytes };
}

/**
 * Whether a download fits without eating into the space recordings and files
 * need. Without an estimate, nothing proves the space is there: the answer is no.
 */
export function checkSpace(
  estimate: StorageEstimateLike | null,
  remainingBytes: number,
  cachedModelBytes: number,
): SpaceVerdict {
  const budget = downloadBudget(estimate, cachedModelBytes);
  if (!budget) return { ok: false, reason: "unknown" };
  const { freeBytes, reserveBytes } = budget;
  const needBytes = Math.max(0, remainingBytes);
  if (freeBytes - needBytes < reserveBytes) {
    return { ok: false, reason: "not-enough-space", needBytes, freeBytes, reserveBytes };
  }
  return { ok: true, needBytes, freeBytes, reserveBytes };
}

/** Weight bytes of a model, from WebLLM's shard list as llm-models read it (`download_mb` is rounded). */
export function downloadBytesOf(model: BrowserModel): number | null {
  const record = browserModelCatalog().models.find((r) => r.model_id === model.id);
  return (
    record?.weights_bytes ??
    (model.download_mb === null ? null : Math.round(model.download_mb * 1e6))
  );
}

// ---------------------------------------------------------------------------
// WebLLM's cache (default `webllm/*` names, Cache API backend)

export const WEBLLM_SCOPES = {
  model: "webllm/model",
  config: "webllm/config",
  wasm: "webllm/wasm",
} as const;

export interface CacheLike {
  match(url: string): Promise<{ json(): Promise<unknown> } | undefined>;
  keys(): Promise<readonly { readonly url: string }[]>;
}
export interface CachesLike {
  open(name: string): Promise<CacheLike>;
  has(name: string): Promise<boolean>;
}

/** Where WebLLM keeps one model: its weights' base URL and its WebGPU library's file name. */
export interface ModelFiles {
  /** Base URL of the weights, as WebLLM spells it (`…/resolve/main/`). */
  modelUrl: string;
  /** File name of the compiled library (its directory varies with the WebLLM version). */
  libFile: string;
}

/** WebLLM's `cleanModelUrl`: a Hugging Face repo URL becomes `<repo>/resolve/main/`. */
export function modelFiles(hfRepo: string, modelLib: string): ModelFiles {
  let url = hfRepo.endsWith("/") ? hfRepo : `${hfRepo}/`;
  if (!/.+\/resolve\/.+\//.test(url)) url += "resolve/main/";
  return { modelUrl: new URL(url).href, libFile: modelLib.slice(modelLib.lastIndexOf("/") + 1) };
}

interface Shard {
  dataPath: string;
  nbytes: number;
}

function shardsOf(json: unknown): Shard[] {
  const records =
    typeof json === "object" && json !== null && "records" in json ? json.records : undefined;
  if (!Array.isArray(records)) throw new Error("tensor-cache.json in the cache has no records");
  return records.map((r: unknown): Shard => {
    if (
      typeof r !== "object" ||
      r === null ||
      !("dataPath" in r) ||
      typeof r.dataPath !== "string" ||
      !("nbytes" in r) ||
      typeof r.nbytes !== "number"
    ) {
      throw new Error("tensor-cache.json in the cache has a malformed record");
    }
    return { dataPath: r.dataPath, nbytes: r.nbytes };
  });
}

function tokenizerFile(config: unknown): string | null {
  const files =
    typeof config === "object" && config !== null && "tokenizer_files" in config
      ? config.tokenizer_files
      : [];
  if (!Array.isArray(files)) return null;
  // WebLLM's asyncLoadTokenizer: tokenizer.json first, else tokenizer.model.
  if (files.includes("tokenizer.json")) return "tokenizer.json";
  if (files.includes("tokenizer.model")) return "tokenizer.model";
  return null;
}

async function openIfPresent(caches: CachesLike, name: string): Promise<CacheLike | null> {
  return (await caches.has(name)) ? caches.open(name) : null;
}

/** Cached weight bytes of the models whose tensor lists are in `model`. */
async function cachedShardBytes(
  model: CacheLike,
  keys: ReadonlySet<string>,
  listUrl: string,
): Promise<{ bytes: number; all: boolean } | null> {
  const list = await model.match(listUrl);
  if (!list) return null;
  let bytes = 0;
  let all = true;
  for (const s of shardsOf(await list.json())) {
    if (keys.has(new URL(s.dataPath, listUrl).href)) bytes += s.nbytes;
    else all = false;
  }
  return { bytes, all };
}

/** What of a model is cached, read the way WebLLM lays its caches out. */
export async function modelCacheState(
  caches: CachesLike,
  files: ModelFiles,
): Promise<ModelCacheState> {
  const empty: ModelCacheState = { cached: false, complete: false, bytes: 0 };
  const model = await openIfPresent(caches, WEBLLM_SCOPES.model);
  if (!model) return empty;
  const keys = new Set((await model.keys()).map((r) => r.url));
  const shards = await cachedShardBytes(
    model,
    keys,
    new URL("tensor-cache.json", files.modelUrl).href,
  );
  if (!shards) return empty;
  const config = await openIfPresent(caches, WEBLLM_SCOPES.config);
  const configHit = config
    ? await config.match(new URL("mlc-chat-config.json", files.modelUrl).href)
    : undefined;
  const tokenizer = configHit ? tokenizerFile(await configHit.json()) : null;
  const hasTokenizer = tokenizer !== null && keys.has(new URL(tokenizer, files.modelUrl).href);
  const wasm = await openIfPresent(caches, WEBLLM_SCOPES.wasm);
  const hasLib = wasm
    ? (await wasm.keys()).some((r) => r.url.endsWith(`/${files.libFile}`))
    : false;
  return {
    cached: shards.bytes > 0,
    complete: shards.all && hasTokenizer && hasLib,
    bytes: shards.bytes,
  };
}

/**
 * Weight bytes WebLLM cached, per model (keyed by `ModelFiles.modelUrl`). They
 * are part of the origin's usage but don't count against the reserve.
 */
export async function cachedModels(caches: CachesLike): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const model = await openIfPresent(caches, WEBLLM_SCOPES.model);
  if (!model) return out;
  const urls = (await model.keys()).map((r) => r.url);
  const keys = new Set(urls);
  for (const url of urls) {
    if (!url.endsWith("/tensor-cache.json")) continue;
    const bytes = (await cachedShardBytes(model, keys, url))?.bytes ?? 0;
    if (bytes > 0) out[new URL("./", url).href] = bytes;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The device, as recommendLocal reads it

export interface DeviceInfo {
  detection: LocalDetection;
  /** `navigator.storage.estimate()`, or null when the browser does not tell. */
  estimate: StorageEstimateLike | null;
  /** Weight bytes WebLLM already cached (part of `estimate.usage`), per `ModelFiles.modelUrl`. */
  cached: Readonly<Record<string, number>>;
}

export interface DeviceEnv extends DetectEnv {
  storage?: StorageLike | undefined;
  caches?: CachesLike | undefined;
}

interface BrowserGlobals {
  navigator?: { gpu?: GpuLike; deviceMemory?: number; storage?: StorageLike };
  caches?: CachesLike;
}

function browserEnv(): DeviceEnv {
  const g: BrowserGlobals = globalThis;
  return {
    gpu: g.navigator?.gpu,
    deviceMemory: g.navigator?.deviceMemory,
    storage: g.navigator?.storage,
    caches: g.caches,
  };
}

/** Reads the GPU, the free space and the model cache. */
export async function detectDevice(env: DeviceEnv = browserEnv()): Promise<DeviceInfo> {
  const detection = await detectLocalSupport(env);
  const estimate = env.storage ? await env.storage.estimate() : null;
  const cached = env.caches ? await cachedModels(env.caches) : {};
  return { detection, estimate, cached };
}
