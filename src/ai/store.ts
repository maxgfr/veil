/**
 * Page-wide state of on-device AI: what the device supports, which model to
 * offer, what is cached, the download, and whether a model is loaded. The
 * signals outlive the Settings sheet. Light on purpose: the engine, the
 * detection and llm-models' catalog are imported only when an action runs.
 */
import { computed, signal } from "@preact/signals";
import { saveSettings, settings } from "../ui/settings";
import type { Availability } from "./builtin";
import { type CacheStorageLike, deleteAiCaches } from "./caches";
import type { DeviceInfo } from "./device";
import type { AiEngine } from "./engine";
import type { Recommendation } from "./models";
import type { LoadProgress, ModelCacheState } from "./protocol";
import { detectSpeech, speechCache, stopSpeechEngine } from "./speechStore";

export type AiStatus = "idle" | "loading" | "ready" | "error";
export type BuiltinName = "summarizer" | "translator" | "languageDetector";
/** What a built-in model's row shows: its availability, or "unknown" when the probe never answered. */
export type BuiltinState = Availability | "unknown";

/** The device, as last detected; null until the AI settings were shown once. */
export const aiDevice = signal<DeviceInfo | null>(null);
export const aiRecommendation = signal<Recommendation | null>(null);
export const aiDetecting = signal(false);
/** What of each model is cached, per model id (filled as models are looked at). */
export const aiCache = signal<Readonly<Record<string, ModelCacheState>>>({});
/** Progress of the running download or load; null when none runs. */
export const aiProgress = signal<LoadProgress | null>(null);
export const aiStatus = signal<AiStatus>("idle");
export const aiError = signal<string | null>(null);
/** The model loaded (or loading) in the engine. */
export const aiModelId = signal<string | null>(null);
/** A model is loaded and usable: summaries and translation may use it. */
export const aiReady = computed(() => aiStatus.value === "ready" && aiModelId.value !== null);
/** The browser's built-in models (Chrome); null until detected. */
export const aiBuiltin = signal<Readonly<Record<BuiltinName, BuiltinState>> | null>(null);
/** Download progress (0..1) of built-in models being fetched. */
export const aiBuiltinProgress = signal<Readonly<Partial<Record<BuiltinName, number>>>>({});

/**
 * Bytes "Delete all AI data" frees: the weights of every WebLLM model cached
 * (as last detected) and of every Whisper model.
 */
export const aiDataBytes = computed(() => {
  let bytes = 0;
  for (const n of Object.values(aiDevice.value?.cached ?? {})) bytes += n;
  for (const s of Object.values(speechCache.value)) bytes += s.bytes;
  return bytes;
});
/** "Delete all AI data" is running; `error` says what it couldn't delete. */
export const aiWipe = signal<{ busy: boolean; error: string | null }>({
  busy: false,
  error: null,
});

/**
 * Set by `openAiSettings()`: the Settings sheet scrolls to "AI on this device"
 * the next time it opens, then clears it. The caller still opens the sheet.
 */
export const aiSettingsWanted = signal(false);

export function openAiSettings(): void {
  aiSettingsWanted.value = true;
}

function report(err: unknown): void {
  aiError.value = err instanceof Error ? err.message : String(err);
}

/** The model the user picked, else the recommended one that fits. */
export function chosenModel(): string | null {
  return settings.value.ai.model ?? aiRecommendation.value?.fits?.id ?? null;
}

export function selectModel(id: string | null): void {
  saveSettings({ ...settings.value, ai: { ...settings.value.ai, model: id } });
}

/** Language pair the Translator availability is probed with: English to the user's language. */
function probePair(): { sourceLanguage: string; targetLanguage: string } {
  const lang = (globalThis.navigator?.language ?? "en").split("-")[0] || "en";
  return { sourceLanguage: "en", targetLanguage: lang === "en" ? "es" : lang };
}

/**
 * How long one built-in `availability()` may take. Some browsers never settle
 * it (headless Chromium); past this the model shows as "unknown", with a way
 * to check again, rather than holding up the settings.
 */
export const BUILTIN_PROBE_MS = 3000;

function bounded(probe: Promise<Availability>): Promise<BuiltinState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BuiltinState>((resolve) => {
    timer = setTimeout(() => resolve("unknown"), BUILTIN_PROBE_MS);
  });
  return Promise.race([probe, late]).finally(() => clearTimeout(timer));
}

async function detectBuiltin(): Promise<void> {
  const { availabilityOf, builtinApis } = await import("./builtin");
  const apis = builtinApis();
  // availabilityOf already maps a rejected probe to "unavailable".
  const [summarizer, translator, languageDetector] = await Promise.all([
    bounded(availabilityOf(apis.summarizer, {})),
    bounded(availabilityOf(apis.translator, probePair())),
    bounded(availabilityOf(apis.languageDetector, {})),
  ]);
  aiBuiltin.value = { summarizer, translator, languageDetector };
}

/** Probes the built-in models again: the "Retry" of a row that couldn't be checked. */
export function recheckBuiltin(): Promise<void> {
  aiBuiltin.value = null;
  return detectBuiltin().catch(report);
}

/**
 * Reads the device, ranks the models and the cache of the ones on offer, and
 * which Whisper model to offer. The built-in models are probed alongside: the
 * model card never waits on them.
 */
export async function detectAi(): Promise<void> {
  if (aiDetecting.value) return;
  aiDetecting.value = true;
  void detectBuiltin().catch(report);
  try {
    const [{ detectDevice }, { recommendLocal }] = await Promise.all([
      import("./device"),
      import("./models"),
    ]);
    const device = await detectDevice();
    const rec = recommendLocal(device);
    aiDevice.value = device;
    aiRecommendation.value = rec;
    const ids = new Set(
      [
        settings.value.ai.model,
        rec.fits?.id,
        rec.best?.id,
        ...rec.alternatives.map((m) => m.id),
      ].filter((id): id is string => !!id),
    );
    await Promise.all([
      rec.unsupported ? [] : Promise.all([...ids].map(refreshCache)),
      detectSpeech(device),
    ]);
  } catch (err) {
    report(err);
  } finally {
    aiDetecting.value = false;
  }
}

export async function refreshCache(id: string): Promise<void> {
  const state = await (await engine()).cacheState(id);
  aiCache.value = { ...aiCache.value, [id]: state };
}

type EngineLike = Pick<AiEngine, "load" | "cancel" | "cacheState" | "remove" | "onCrash">;

/** The page's engine, imported on first use. Tests swap it with `setAiEngineSource`. */
let engine: () => Promise<EngineLike> = async () => (await import("./engine")).getAiEngine();

export function setAiEngineSource(source: () => Promise<EngineLike>): void {
  engine = source;
}

let persistAsked = false;
let crashWatched = false;

/**
 * Downloads what the cache lacks, then loads the model. Only ever called from
 * a click. Resolves whether the model is ready; a failure is in `aiError`.
 */
export function loadModel(id: string): Promise<boolean> {
  // A failure is already in aiError, which the settings show.
  return runLoad(id).then(
    () => aiReady.value && aiModelId.value === id,
    () => false,
  );
}

/** Loads `id`; reports a failure in `aiError` and rethrows it (a cancel resolves). */
async function runLoad(id: string): Promise<void> {
  const ai = await engine();
  if (!crashWatched) {
    crashWatched = true;
    ai.onCrash((err) => {
      aiStatus.value = "error";
      aiError.value = err.message;
      aiModelId.value = null;
      aiProgress.value = null;
    });
  }
  if (!persistAsked) {
    persistAsked = true;
    // Ask once that the browser not evict gigabytes of weights under pressure.
    await globalThis.navigator?.storage?.persist?.();
  }
  if (settings.value.ai.model !== id) selectModel(id);
  aiModelId.value = id;
  aiStatus.value = "loading";
  aiError.value = null;
  aiProgress.value = { progress: 0, text: "" };
  try {
    await ai.load(id, (p) => {
      if (aiModelId.value === id) aiProgress.value = p;
    });
    if (aiModelId.value !== id) return;
    aiStatus.value = "ready";
  } catch (err) {
    if (aiModelId.value !== id) return;
    aiModelId.value = null;
    const cancelled = err instanceof DOMException && err.name === "AbortError";
    aiStatus.value = cancelled ? "idle" : "error";
    if (cancelled) {
      aiError.value = null;
    } else {
      report(err);
      throw err;
    }
  } finally {
    // Another model may have started loading meanwhile: its progress stays.
    if (aiStatus.value !== "loading") aiProgress.value = null;
    await refreshCache(id).catch(report);
  }
}

let ensuring: Promise<boolean> | null = null;

/**
 * Makes the chosen model usable without downloading anything: true when it is
 * loaded, or fully cached and now loaded from the cache; false when it is not
 * (fully) cached. A real load failure rejects. Concurrent calls share one run.
 */
export function ensureModel(): Promise<boolean> {
  if (aiReady.value) return Promise.resolve(true);
  ensuring ??= (async () => {
    const id = chosenModel();
    if (!id) return false;
    const state = await (await engine()).cacheState(id);
    aiCache.value = { ...aiCache.value, [id]: state };
    if (!state.complete) return false;
    await runLoad(id);
    return aiReady.value;
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/** Stops the download; what is cached stays and a later load resumes from it. */
export async function cancelLoad(): Promise<void> {
  const id = aiModelId.value;
  aiModelId.value = null;
  aiStatus.value = "idle";
  aiProgress.value = null;
  (await engine()).cancel();
  if (id) await refreshCache(id).catch(report);
}

export async function removeModel(id: string): Promise<void> {
  if (aiModelId.value === id) {
    aiModelId.value = null;
    aiStatus.value = "idle";
    aiProgress.value = null;
  }
  await (await engine()).remove(id);
  await refreshCache(id);
  if (settings.value.ai.model === id) selectModel(null);
}

/** Has the browser fetch a `downloadable` built-in model. Only ever called from a click. */
export async function downloadBuiltin(name: BuiltinName): Promise<void> {
  const { builtinApis, progressMonitor } = await import("./builtin");
  const apis = builtinApis();
  const monitor = progressMonitor((loaded) => {
    aiBuiltinProgress.value = { ...aiBuiltinProgress.value, [name]: loaded };
  });
  const common = monitor ? { monitor } : {};
  aiBuiltinProgress.value = { ...aiBuiltinProgress.value, [name]: 0 };
  try {
    const session =
      name === "summarizer"
        ? await apis.summarizer?.create(common)
        : name === "translator"
          ? await apis.translator?.create({ ...probePair(), ...common })
          : await apis.languageDetector?.create(common);
    session?.destroy?.();
  } catch (err) {
    report(err);
  } finally {
    const { [name]: _, ...rest } = aiBuiltinProgress.value;
    aiBuiltinProgress.value = rest;
    await detectBuiltin();
  }
}

/** Terminates the AI worker (a download included) and forgets the loaded model. */
async function stopAiEngine(): Promise<void> {
  aiModelId.value = null;
  aiStatus.value = "idle";
  aiProgress.value = null;
  (await engine()).cancel();
}

/**
 * "Delete all AI data", from a click: stops both engines, deletes every AI
 * cache (every WebLLM model, every Whisper model, the cached engines) and
 * nothing else, forgets the chosen models, then detects again. What couldn't
 * be deleted is in `aiWipe.error`. Chrome's built-in models are Chrome's.
 */
export async function deleteAllAiData(
  storage: CacheStorageLike | undefined = globalThis.caches,
): Promise<void> {
  aiWipe.value = { busy: true, error: null };
  let error: string | null = null;
  try {
    await Promise.all([stopAiEngine(), stopSpeechEngine()]);
    const failed = storage ? await deleteAiCaches(storage) : [];
    if (failed.length) error = `Couldn't delete ${failed.join(", ")}.`;
  } catch (err) {
    error = `Couldn't delete the AI data: ${err instanceof Error ? err.message : String(err)}`;
  }
  saveSettings({ ...settings.value, ai: { ...settings.value.ai, model: null, speechModel: null } });
  aiCache.value = {};
  speechCache.value = {};
  aiError.value = null;
  await detectAi();
  aiWipe.value = { busy: false, error };
}
