/**
 * Page-wide state of on-device speech recognition (Whisper): which model to
 * offer, what is cached, the download, and whether a model is loaded. The
 * signals outlive the Settings sheet. Light on purpose: the engine and the
 * device's details are imported only when an action runs.
 */
import { computed, signal } from "@preact/signals";
import { saveSettings, settings } from "../ui/settings";
import type { DeviceInfo } from "./device";
import type { LoadProgress, ModelCacheState } from "./protocol";
import type { SpeechEngine } from "./speech";
import {
  recommendSpeech,
  SPEECH_MODELS,
  type SpeechRecommendation,
  speechBackend,
  speechModel,
} from "./speechModels";
import type { AiStatus } from "./store";

/** Which Whisper model to offer this device; null until the AI settings were shown once. */
export const speechRecommendation = signal<SpeechRecommendation | null>(null);
/** What of each Whisper model is cached, per model id. */
export const speechCache = signal<Readonly<Record<string, ModelCacheState>>>({});
/** Progress of the running download or load; null when none runs. */
export const speechProgress = signal<LoadProgress | null>(null);
export const speechStatus = signal<AiStatus>("idle");
export const speechError = signal<string | null>(null);
/** The model loaded (or loading) in the speech engine. */
export const speechModelId = signal<string | null>(null);
/** A Whisper model is loaded and transcribes. */
export const speechReady = computed(
  () => speechStatus.value === "ready" && speechModelId.value !== null,
);

function report(err: unknown): void {
  speechError.value = err instanceof Error ? err.message : String(err);
}

type EngineLike = Pick<SpeechEngine, "load" | "cancel" | "cacheState" | "remove" | "onCrash">;

/** The page's speech engine, imported on first use. Tests swap it with `setSpeechEngineSource`. */
let engine: () => Promise<EngineLike> = async () => (await import("./speech")).getSpeechEngine();

export function setSpeechEngineSource(source: () => Promise<EngineLike>): void {
  engine = source;
}

export function selectSpeechModel(id: string | null): void {
  saveSettings({ ...settings.value, ai: { ...settings.value.ai, speechModel: id } });
}

export async function refreshSpeechCache(id: string): Promise<void> {
  const state = await (await engine()).cacheState(id);
  speechCache.value = { ...speechCache.value, [id]: state };
}

/**
 * Reads what of each Whisper model is cached, then which one this device
 * should download: by its WebGPU adapter and the free space left beside the
 * models already cached (device.ts's reserve rule). A failure is in `speechError`.
 */
export function detectSpeech(device: DeviceInfo): Promise<void> {
  return readSpeech(device).catch(report);
}

async function readSpeech(device: DeviceInfo): Promise<void> {
  await Promise.all(SPEECH_MODELS.map((m) => refreshSpeechCache(m.id)));
  const { downloadBudget } = await import("./device");
  const cached: Record<string, number> = {};
  for (const [id, state] of Object.entries(speechCache.value)) cached[id] = state.bytes;
  let modelBytes = 0;
  for (const n of [...Object.values(device.cached), ...Object.values(cached)]) modelBytes += n;
  speechRecommendation.value = recommendSpeech({
    backend: speechBackend(device.detection.gpu ?? null),
    budget: downloadBudget(device.estimate, modelBytes),
    cached,
  });
}

let persistAsked = false;
let crashWatched = false;

/** Loads `id`; reports a failure in `speechError` and rethrows it (a cancel resolves). */
async function runLoad(id: string, download: boolean): Promise<void> {
  const speech = await engine();
  if (!crashWatched) {
    crashWatched = true;
    speech.onCrash((err) => {
      speechStatus.value = "error";
      speechError.value = err.message;
      speechModelId.value = null;
      speechProgress.value = null;
    });
  }
  if (download && !persistAsked) {
    persistAsked = true;
    // Ask once that the browser not evict the weights under pressure.
    await globalThis.navigator?.storage?.persist?.();
  }
  speechModelId.value = id;
  speechStatus.value = "loading";
  speechError.value = null;
  speechProgress.value = { progress: 0, text: "" };
  try {
    await speech.load(id, {
      download,
      onProgress: (p) => {
        if (speechModelId.value === id) speechProgress.value = p;
      },
    });
    if (speechModelId.value !== id) return;
    speechStatus.value = "ready";
  } catch (err) {
    if (speechModelId.value !== id) return;
    speechModelId.value = null;
    const cancelled = err instanceof DOMException && err.name === "AbortError";
    speechStatus.value = cancelled ? "idle" : "error";
    if (cancelled) {
      speechError.value = null;
    } else {
      report(err);
      throw err;
    }
  } finally {
    // Another model may have started loading meanwhile: its progress stays.
    if (speechStatus.value !== "loading") speechProgress.value = null;
    await refreshSpeechCache(id).catch(report);
  }
}

/**
 * Downloads what the cache lacks, then loads the model, which captions then
 * use. Only ever called from a click. Resolves whether it is ready; a failure
 * is in `speechError`.
 */
export function loadSpeechModel(id: string): Promise<boolean> {
  if (settings.value.ai.speechModel !== id) selectSpeechModel(id);
  // A failure is already in speechError, which the settings show.
  return runLoad(id, true).then(
    () => speechReady.value && speechModelId.value === id,
    () => false,
  );
}

let ensuring: Promise<boolean> | null = null;

/**
 * Makes the chosen Whisper model usable without downloading anything: true
 * when it is loaded, or fully cached and now loaded from the cache; false when
 * none is chosen or it is not (fully) cached. A real load failure rejects.
 * Concurrent calls share one run.
 */
export function ensureSpeechModel(): Promise<boolean> {
  if (speechReady.value) return Promise.resolve(true);
  ensuring ??= (async () => {
    const id = settings.value.ai.speechModel;
    if (!id || !speechModel(id)) return false;
    const state = await (await engine()).cacheState(id);
    speechCache.value = { ...speechCache.value, [id]: state };
    if (!state.complete) return false;
    await runLoad(id, false);
    return speechReady.value;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/** Terminates the speech worker (a download included) and forgets the loaded model. */
export async function stopSpeechEngine(): Promise<void> {
  speechModelId.value = null;
  speechStatus.value = "idle";
  speechProgress.value = null;
  (await engine()).cancel();
}

/** Stops the download; what is cached stays and a later download resumes from it. */
export async function cancelSpeechLoad(): Promise<void> {
  const id = speechModelId.value;
  speechModelId.value = null;
  speechStatus.value = "idle";
  speechProgress.value = null;
  (await engine()).cancel();
  if (id) await refreshSpeechCache(id).catch(report);
}

export async function removeSpeechModel(id: string): Promise<void> {
  if (speechModelId.value === id) {
    speechModelId.value = null;
    speechStatus.value = "idle";
    speechProgress.value = null;
  }
  await (await engine()).remove(id);
  await refreshSpeechCache(id);
  if (settings.value.ai.speechModel === id) selectSpeechModel(null);
}
