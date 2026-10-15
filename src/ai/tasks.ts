/**
 * AI tasks on the browser's built-in models (Translator, LanguageDetector): nothing
 * is downloaded by the app and nothing leaves the device.
 * Every task resolves null (or false) when the browser can't do it, and throws only on a real failure.
 */
import { type Availability, availabilityOf, type BuiltinApis, builtinApis } from "./builtin";

export interface TaskDeps {
  builtin: BuiltinApis;
}

/** Below this, a detected language is treated as unknown. */
const MIN_CONFIDENCE = 0.5;

export function defaultTaskDeps(): TaskDeps {
  return { builtin: builtinApis() };
}

/** "en-US" → "en". */
function base(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? tag;
}

const usable = (a: Availability): boolean => a === "available" || a === "downloadable";

/** The base language of `text`, from the built-in detector. */
export async function detectLang(
  text: string,
  deps: TaskDeps = defaultTaskDeps(),
): Promise<string | null> {
  const api = deps.builtin.languageDetector;
  if (!text.trim() || (await availabilityOf(api, undefined)) !== "available" || !api) return null;
  const detector = await api.create();
  try {
    const [top] = await detector.detect(text);
    if (!top || top.confidence < MIN_CONFIDENCE || top.detectedLanguage === "und") return null;
    return base(top.detectedLanguage);
  } finally {
    detector.destroy?.();
  }
}

async function translatorUsable(from: string, to: string, deps: TaskDeps): Promise<boolean> {
  return usable(
    await availabilityOf(deps.builtin.translator, { sourceLanguage: from, targetLanguage: to }),
  );
}

/** Cheap check for showing a "Translate" action. */
export async function canTranslate(
  from: string | null,
  to: string,
  deps: TaskDeps = defaultTaskDeps(),
): Promise<boolean> {
  if (from === null || base(from) === base(to)) return false;
  return translatorUsable(base(from), base(to), deps);
}

/** `text` translated into `to`; `from` null means unknown (detected when possible). */
export async function translate(
  text: string,
  from: string | null,
  to: string,
  deps: TaskDeps = defaultTaskDeps(),
): Promise<string | null> {
  const source = from === null ? await detectLang(text, deps) : base(from);
  const target = base(to);
  if (source === target) return text;
  if (source === null || !deps.builtin.translator) return null;
  if (!(await translatorUsable(source, target, deps))) return null;
  const translator = await deps.builtin.translator.create({
    sourceLanguage: source,
    targetLanguage: target,
  });
  try {
    return await translator.translate(text);
  } finally {
    translator.destroy?.();
  }
}
