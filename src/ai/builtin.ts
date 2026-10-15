/**
 * Narrow types over the browser's built-in AI (Chrome's `Summarizer`, `Translator` and `LanguageDetector`).
 * Each model runs on the device; a `downloadable` one is fetched by the browser on the first `create()`.
 */

export type Availability = "unavailable" | "downloadable" | "downloading" | "available";

/** The `monitor` handle: download progress of a built-in model, `loaded` in 0..1. */
export interface CreateMonitor {
  addEventListener(type: "downloadprogress", listener: (e: { loaded: number }) => void): void;
}

interface CreateCommon {
  monitor?: (m: CreateMonitor) => void;
  signal?: AbortSignal;
}

export interface SummarizerOptions {
  type?: "key-points" | "tldr" | "teaser" | "headline";
  format?: "markdown" | "plain-text";
  length?: "short" | "medium" | "long";
  sharedContext?: string;
  expectedInputLanguages?: string[];
  outputLanguage?: string;
}

export interface SummarizerSession {
  summarize(text: string, opts?: { context?: string; signal?: AbortSignal }): Promise<string>;
  summarizeStreaming?(
    text: string,
    opts?: { context?: string; signal?: AbortSignal },
  ): AsyncIterable<string>;
  destroy?(): void;
}

export interface SummarizerApi {
  availability(opts?: SummarizerOptions): Promise<Availability>;
  create(opts?: SummarizerOptions & CreateCommon): Promise<SummarizerSession>;
}

export interface TranslatorPair {
  sourceLanguage: string;
  targetLanguage: string;
}

export interface TranslatorSession {
  translate(text: string, opts?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}

export interface TranslatorApi {
  availability(opts: TranslatorPair): Promise<Availability>;
  create(opts: TranslatorPair & CreateCommon): Promise<TranslatorSession>;
}

export interface DetectedLanguage {
  detectedLanguage: string;
  confidence: number;
}

export interface LanguageDetectorSession {
  detect(text: string, opts?: { signal?: AbortSignal }): Promise<DetectedLanguage[]>;
  destroy?(): void;
}

export interface LanguageDetectorApi {
  availability(opts?: { expectedInputLanguages?: string[] }): Promise<Availability>;
  create(opts?: CreateCommon): Promise<LanguageDetectorSession>;
}

export interface BuiltinApis {
  summarizer?: SummarizerApi;
  translator?: TranslatorApi;
  languageDetector?: LanguageDetectorApi;
}

function isApi<T>(v: unknown): v is T {
  return (
    (typeof v === "function" || (typeof v === "object" && v !== null)) &&
    typeof (v as { availability?: unknown }).availability === "function" &&
    typeof (v as { create?: unknown }).create === "function"
  );
}

/** The built-in AI globals present in `scope`, each only if it looks usable. */
export function builtinApis(scope: object = globalThis): BuiltinApis {
  const g = scope as { Summarizer?: unknown; Translator?: unknown; LanguageDetector?: unknown };
  const out: BuiltinApis = {};
  if (isApi<SummarizerApi>(g.Summarizer)) out.summarizer = g.Summarizer;
  if (isApi<TranslatorApi>(g.Translator)) out.translator = g.Translator;
  if (isApi<LanguageDetectorApi>(g.LanguageDetector)) out.languageDetector = g.LanguageDetector;
  return out;
}

/** The availability as reported, or "unavailable" when the API is missing or the probe throws. */
export async function availabilityOf<O>(
  api: { availability(opts: O): Promise<Availability> } | undefined,
  opts: O,
): Promise<Availability> {
  if (!api) return "unavailable";
  try {
    return await api.availability(opts);
  } catch {
    // A probe that throws (bad language tag, policy) means the same as "unavailable".
    return "unavailable";
  }
}

/** A `monitor` that reports download progress (0..1) to `onProgress`. */
export function progressMonitor(onProgress?: (loaded: number) => void): CreateCommon["monitor"] {
  if (!onProgress) return undefined;
  return (m) => m.addEventListener("downloadprogress", (e) => onProgress(e.loaded));
}
