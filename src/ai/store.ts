/**
 * Page-wide state of the browser's built-in AI (Chrome's Summarizer, Translator and
 * LanguageDetector): what is available and what is downloading. The signals outlive the
 * Settings sheet.
 */
import { signal } from "@preact/signals";
import { myLang } from "../ui/language";
import type { Availability } from "./builtin";

export type BuiltinName = "summarizer" | "translator" | "languageDetector";
/** What a built-in model's row shows: its availability, or "unknown" when the probe never answered. */
export type BuiltinState = Availability | "unknown";

export const aiError = signal<string | null>(null);
/** The browser's built-in models; null until detected. */
export const aiBuiltin = signal<Readonly<Record<BuiltinName, BuiltinState>> | null>(null);
/** Download progress (0..1) of built-in models being fetched. */
export const aiBuiltinProgress = signal<Readonly<Partial<Record<BuiltinName, number>>>>({});

/**
 * Set by `openAiSettings()`: the Settings sheet scrolls to the AI settings
 * the next time it opens, then clears it. The caller still opens the sheet.
 */
export const aiSettingsWanted = signal(false);

export function openAiSettings(): void {
  aiSettingsWanted.value = true;
}

function report(err: unknown): void {
  aiError.value = err instanceof Error ? err.message : String(err);
}

/** Language pair the Translator availability is probed with: English to the user's language. */
function probePair(): { sourceLanguage: string; targetLanguage: string } {
  const lang = myLang();
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

let detecting: Promise<void> | null = null;

/** Probes the built-in models (once at a time). */
export function detectBuiltin(): Promise<void> {
  detecting ??= (async () => {
    const { availabilityOf, builtinApis } = await import("./builtin");
    const apis = builtinApis();
    // availabilityOf already maps a rejected probe to "unavailable".
    const [summarizer, translator, languageDetector] = await Promise.all([
      bounded(availabilityOf(apis.summarizer, {})),
      bounded(availabilityOf(apis.translator, probePair())),
      bounded(availabilityOf(apis.languageDetector, {})),
    ]);
    aiBuiltin.value = { summarizer, translator, languageDetector };
  })()
    .catch(report)
    .finally(() => {
      detecting = null;
    });
  return detecting;
}

/** Probes the built-in models again: the "Retry" of a row that couldn't be checked. */
export function recheckBuiltin(): Promise<void> {
  aiBuiltin.value = null;
  return detectBuiltin();
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
