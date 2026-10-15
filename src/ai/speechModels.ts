/**
 * Which Whisper model transcribes speech on this device: the three choices,
 * the weights transformers.js fetches for each on this device's backend, and
 * which one to offer. Pure, with no dependency, so the page, the store and
 * the speech worker share it.
 */
import type { ModelCacheState } from "./protocol";

/** transformers.js dtypes: q8 is the `_quantized` build. */
export type SpeechDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";

/**
 * Where Whisper runs: WebGPU with `shader-f16`, WebGPU without it, or
 * WebAssembly when there is no WebGPU adapter.
 */
export type SpeechBackend = "webgpu-f16" | "webgpu" | "wasm";

export interface SpeechFile {
  /** Path in the Hugging Face repo. */
  path: string;
  bytes: number;
}

/** The encoder and merged-decoder builds a model has, with their sizes. */
interface Weights {
  encoder: Partial<Record<SpeechDtype, number>>;
  decoder: Partial<Record<SpeechDtype, number>>;
}

export interface SpeechModel {
  /** The Hugging Face repo, which transformers.js loads by name. */
  id: string;
  /** "Whisper small". */
  label: string;
  /** Configs, tokenizer and processor: fetched whatever the backend. */
  common: readonly SpeechFile[];
  weights: Weights;
  /** Encoder and decoder dtypes per backend; a backend missing here can't run the model. */
  builds: Partial<Record<SpeechBackend, { encoder: SpeechDtype; decoder: SpeechDtype }>>;
}

/** What the "automatic-speech-recognition" pipeline of transformers.js 4.3.0 loads. */
export interface SpeechPlan {
  device: "webgpu" | "wasm";
  /**
   * Per session: `encoder_model` and `decoder_model_merged` are what the
   * sessions load; `model` is the encoder's key when transformers.js lists the
   * files it expects (its session key), so both agree on the file.
   */
  dtype: { model: SpeechDtype; encoder_model: SpeechDtype; decoder_model_merged: SpeechDtype };
  files: SpeechFile[];
}

const DTYPES: readonly SpeechDtype[] = ["fp32", "fp16", "q8", "q4", "q4f16"];

const SUFFIX: Readonly<Record<SpeechDtype, string>> = {
  fp32: "",
  fp16: "_fp16",
  q8: "_quantized",
  q4: "_q4",
  q4f16: "_q4f16",
};

function common(sizes: {
  config: number;
  generation: number;
  preprocessor: number;
  tokenizer: number;
  tokenizerConfig: number;
}): SpeechFile[] {
  return [
    { path: "config.json", bytes: sizes.config },
    { path: "generation_config.json", bytes: sizes.generation },
    { path: "preprocessor_config.json", bytes: sizes.preprocessor },
    { path: "tokenizer.json", bytes: sizes.tokenizer },
    { path: "tokenizer_config.json", bytes: sizes.tokenizerConfig },
  ];
}

const encoderPath = (dtype: SpeechDtype) => `onnx/encoder_model${SUFFIX[dtype]}.onnx`;
const decoderPath = (dtype: SpeechDtype) => `onnx/decoder_model_merged${SUFFIX[dtype]}.onnx`;

export const WHISPER_BASE = "onnx-community/whisper-base";
export const WHISPER_SMALL = "onnx-community/whisper-small";
export const WHISPER_TURBO = "onnx-community/whisper-large-v3-turbo";

/**
 * ONNX Runtime's WebGPU backend handles int8 (q8) weights poorly: on WebGPU,
 * base and small run an fp16 encoder (fp32 without `shader-f16`) and a q4
 * decoder, as transformers.js's WebGPU Whisper examples do; q8 stays for
 * WebAssembly. Sizes are those of the repos' main branch.
 */
const SMALL_BUILDS: SpeechModel["builds"] = {
  "webgpu-f16": { encoder: "fp16", decoder: "q4" },
  webgpu: { encoder: "fp32", decoder: "q4" },
  wasm: { encoder: "q8", decoder: "q8" },
};

/** Smallest first. */
export const SPEECH_MODELS: readonly SpeechModel[] = [
  {
    id: WHISPER_BASE,
    label: "Whisper base",
    common: common({
      config: 2243,
      generation: 3832,
      preprocessor: 339,
      tokenizer: 2_480_466,
      tokenizerConfig: 282_682,
    }),
    weights: {
      encoder: { fp32: 82_468_078, fp16: 41_332_612, q8: 23_201_314 },
      decoder: { q4: 123_602_419, q8: 53_693_315 },
    },
    builds: SMALL_BUILDS,
  },
  {
    id: WHISPER_SMALL,
    label: "Whisper small",
    common: common({
      config: 2227,
      generation: 3893,
      preprocessor: 339,
      tokenizer: 2_480_466,
      tokenizerConfig: 282_683,
    }),
    weights: {
      encoder: { fp32: 352_825_870, fp16: 176_607_756, q8: 92_326_160 },
      decoder: { q4: 233_149_327, q8: 156_750_845 },
    },
    builds: SMALL_BUILDS,
  },
  {
    id: WHISPER_TURBO,
    label: "Whisper large-v3 turbo",
    common: common({
      config: 1332,
      generation: 3897,
      preprocessor: 340,
      tokenizer: 2_480_617,
      tokenizerConfig: 282_843,
    }),
    weights: {
      encoder: { q4f16: 369_974_078 },
      decoder: { q4f16: 193_505_017 },
    },
    // q4f16 needs fp16 compute: WebGPU with shader-f16 only.
    builds: { "webgpu-f16": { encoder: "q4f16", decoder: "q4f16" } },
  },
];

export function speechModel(id: string): SpeechModel | undefined {
  return SPEECH_MODELS.find((m) => m.id === id);
}

/** The backend Whisper gets with this adapter (null: no WebGPU adapter). */
export function speechBackend(adapter: { shaderF16: boolean } | null): SpeechBackend {
  if (!adapter) return "wasm";
  return adapter.shaderF16 ? "webgpu-f16" : "webgpu";
}

function weight(sizes: Partial<Record<SpeechDtype, number>>, dtype: SpeechDtype): number {
  const bytes = sizes[dtype];
  if (bytes === undefined) throw new Error(`no ${dtype} build in the catalog`);
  return bytes;
}

/** What the pipeline loads for `model` on `backend`, or null when the backend can't run it. */
export function speechPlan(model: SpeechModel, backend: SpeechBackend): SpeechPlan | null {
  const build = model.builds[backend];
  if (!build) return null;
  return {
    device: backend === "wasm" ? "wasm" : "webgpu",
    dtype: {
      model: build.encoder,
      encoder_model: build.encoder,
      decoder_model_merged: build.decoder,
    },
    files: [
      ...model.common,
      { path: encoderPath(build.encoder), bytes: weight(model.weights.encoder, build.encoder) },
      { path: decoderPath(build.decoder), bytes: weight(model.weights.decoder, build.decoder) },
    ],
  };
}

export function filesBytes(files: readonly SpeechFile[]): number {
  return files.reduce((n, f) => n + f.bytes, 0);
}

/** Every file of the model the catalog knows, whatever the backend. */
function knownFiles(model: SpeechModel): SpeechFile[] {
  const out = [...model.common];
  for (const dtype of DTYPES) {
    const encoder = model.weights.encoder[dtype];
    const decoder = model.weights.decoder[dtype];
    if (encoder !== undefined) out.push({ path: encoderPath(dtype), bytes: encoder });
    if (decoder !== undefined) out.push({ path: decoderPath(dtype), bytes: decoder });
  }
  return out;
}

/** Decimal megabytes, whole: "80 MB". */
export function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

// ---------------------------------------------------------------------------
// The weights cache (transformers.js's Cache API backend)

/** transformers.js's default `env.cacheKey`. */
export const SPEECH_CACHE = "transformers-cache";

/** Where transformers.js fetches a file from, which is also its cache key. */
export function speechFileUrl(model: SpeechModel, path: string): string {
  return `https://huggingface.co/${model.id}/resolve/main/${path}`;
}

export interface SpeechCacheLike {
  match(url: string): Promise<unknown>;
  keys(): Promise<readonly { readonly url: string }[]>;
  delete(url: string): Promise<boolean>;
}

export interface SpeechCachesLike {
  open(name: string): Promise<SpeechCacheLike>;
  has(name: string): Promise<boolean>;
}

/**
 * What of a model is cached: `complete` when every file the pipeline fetches
 * on `backend` is; `cached` and `bytes` count the files of any backend.
 */
export async function speechCacheState(
  caches: SpeechCachesLike,
  model: SpeechModel,
  backend: SpeechBackend,
): Promise<ModelCacheState> {
  if (!(await caches.has(SPEECH_CACHE))) return { cached: false, complete: false, bytes: 0 };
  const cache = await caches.open(SPEECH_CACHE);
  const hits = new Set<string>();
  let bytes = 0;
  for (const f of knownFiles(model)) {
    if (!(await cache.match(speechFileUrl(model, f.path)))) continue;
    hits.add(f.path);
    bytes += f.bytes;
  }
  const plan = speechPlan(model, backend);
  const complete = plan?.files.every((f) => hits.has(f.path)) ?? false;
  return { cached: hits.size > 0, complete, bytes };
}

/** Deletes every cached file of the model's repo, of any backend, listed or not. */
export async function removeSpeechFiles(
  caches: SpeechCachesLike,
  model: SpeechModel,
): Promise<void> {
  if (!(await caches.has(SPEECH_CACHE))) return;
  const cache = await caches.open(SPEECH_CACHE);
  const prefix = `https://huggingface.co/${model.id}/resolve/`;
  for (const req of await cache.keys()) if (req.url.startsWith(prefix)) await cache.delete(req.url);
}

// ---------------------------------------------------------------------------
// Language

/** The 99 languages Whisper knows, by the codes transformers.js accepts. */
const WHISPER_LANGUAGES: ReadonlySet<string> = new Set(
  (
    "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th " +
    "ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr " +
    "pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt " +
    "haw ln ha ba jw su"
  ).split(" "),
);

/** BCP 47 base codes Whisper spells differently. */
const ALIASES: Readonly<Record<string, string>> = { nb: "no", iw: "he", jv: "jw", fil: "tl" };

/** "fr-FR" → "fr"; undefined when Whisper doesn't know it (it then detects the language). */
export function whisperLanguage(tag: string): string | undefined {
  const base = tag.split("-")[0]?.toLowerCase() ?? "";
  const code = ALIASES[base] ?? base;
  return WHISPER_LANGUAGES.has(code) ? code : undefined;
}

// ---------------------------------------------------------------------------
// Recommendation

export interface SpeechDevice {
  backend: SpeechBackend;
  /** The largest download that fits (device.ts's `downloadBudget`); null without an estimate. */
  budget: { budgetBytes: number; freeBytes: number } | null;
  /** Bytes already cached, per model id. */
  cached: Readonly<Record<string, number>>;
}

export interface SpeechChoice {
  id: string;
  label: string;
  /** Bytes this device downloads for it (its backend's build); 0 when it can't run it. */
  downloadBytes: number;
  /** This device can run it. */
  runs: boolean;
  /** What is left to download fits the budget. */
  fits: boolean;
  /** Why this model, in English. */
  reason: string;
}

export interface SpeechRecommendation {
  pick: SpeechChoice;
  /** The two other models, smallest first. */
  others: SpeechChoice[];
}

function size(model: SpeechModel, device: SpeechDevice): number {
  const plan = speechPlan(model, device.backend);
  return plan ? filesBytes(plan.files) : 0;
}

function left(model: SpeechModel, device: SpeechDevice): number {
  return Math.max(0, size(model, device) - (device.cached[model.id] ?? 0));
}

function runs(model: SpeechModel, device: SpeechDevice): boolean {
  return speechPlan(model, device.backend) !== null;
}

function fits(model: SpeechModel, device: SpeechDevice): boolean {
  return device.budget === null || left(model, device) <= device.budget.budgetBytes;
}

function byId(id: string): SpeechModel {
  const m = speechModel(id);
  if (!m) throw new Error(`${id} is not a speech model`);
  return m;
}

/** What stops a model here, or null when nothing does. */
function obstacle(model: SpeechModel, device: SpeechDevice): string | null {
  if (!runs(model, device)) return `${model.label} needs WebGPU with fp16`;
  if (!fits(model, device)) {
    const free = device.budget ? `, ${formatMb(device.budget.freeBytes)} free` : "";
    return `${model.label} needs ${formatMb(left(model, device))}${free}`;
  }
  return null;
}

const STRENGTH: Readonly<Record<string, string>> = {
  [WHISPER_TURBO]: "The most accurate, on WebGPU.",
  [WHISPER_SMALL]: "Accurate, on any device.",
  [WHISPER_BASE]: "The smallest and fastest, less accurate.",
};

function note(model: SpeechModel, device: SpeechDevice): string {
  const stop = obstacle(model, device);
  return stop ? `${stop}.` : (STRENGTH[model.id] ?? "");
}

/**
 * Large-v3 turbo on WebGPU with fp16 when its download fits, else small if it
 * fits, else base (which may not fit either: `fits` says so). Sizes are those
 * of the build this device's backend downloads.
 */
export function recommendSpeech(device: SpeechDevice): SpeechRecommendation {
  const turbo = byId(WHISPER_TURBO);
  const small = byId(WHISPER_SMALL);
  const base = byId(WHISPER_BASE);
  const turboStop = obstacle(turbo, device);
  const smallStop = obstacle(small, device);
  const baseStop = obstacle(base, device);
  const pickModel = !turboStop ? turbo : !smallStop ? small : base;
  const why =
    pickModel === turbo
      ? "The most accurate: this device runs it on WebGPU."
      : pickModel === small
        ? `${turboStop}; small is accurate and runs on any device.`
        : baseStop
          ? `${baseStop}.`
          : `${smallStop}; base is the smallest.`;
  const choice = (m: SpeechModel, reason: string): SpeechChoice => ({
    id: m.id,
    label: m.label,
    downloadBytes: size(m, device),
    runs: runs(m, device),
    fits: fits(m, device),
    reason,
  });
  return {
    pick: choice(pickModel, why),
    others: SPEECH_MODELS.filter((m) => m !== pickModel).map((m) => choice(m, note(m, device))),
  };
}
