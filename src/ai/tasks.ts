/**
 * AI tasks on the browser's built-in models (Translator, LanguageDetector, Summarizer): nothing
 * is downloaded by the app and nothing leaves the device.
 * Every task resolves null (or false) when the browser can't do it, and throws only on a real failure.
 */
import { type Availability, availabilityOf, type BuiltinApis, builtinApis } from "./builtin";

export interface TaskDeps {
  builtin: BuiltinApis;
}

/** A transcript line (structurally the recorder's `CaptionLine`). */
export interface Line {
  nick: string;
  ts: number;
  text: string | null;
  lang?: string;
}

export interface MeetingSummary {
  markdown: string;
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

/** The transcript with every line translated into `lang`, or null when nothing can translate. */
export async function transcriptIn(
  lines: Line[],
  lang: string,
  deps: TaskDeps = defaultTaskDeps(),
): Promise<Line[] | null> {
  const target = base(lang);
  if (!deps.builtin.translator) return null;
  const out: Line[] = [];
  for (const line of lines) {
    if (line.text === null || (line.lang !== undefined && base(line.lang) === target)) {
      out.push(line);
      continue;
    }
    const text = await translate(line.text, line.lang ?? null, target, deps);
    // A line the browser can't translate stays in its own language.
    out.push(text === null ? line : { ...line, text, lang: target });
  }
  return out;
}

/** Can the browser summarize ("Summarize" rather than nothing)? */
export async function summaryAvailable(deps: TaskDeps = defaultTaskDeps()): Promise<boolean> {
  return usable(await availabilityOf(deps.builtin.summarizer, undefined));
}

function clock(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function transcriptText(lines: Line[]): string[] {
  return lines.flatMap((l) => (l.text ? [`[${clock(l.ts)}] ${l.nick}: ${l.text}`] : []));
}

/** Meeting notes as Markdown, from the built-in Summarizer. */
export async function summarizeMeeting(
  lines: Line[],
  lang: string,
  opts: { onPartial?: (markdownSoFar: string) => void; signal?: AbortSignal } = {},
  deps: TaskDeps = defaultTaskDeps(),
): Promise<MeetingSummary | null> {
  const api = deps.builtin.summarizer;
  const signal = opts.signal ? { signal: opts.signal } : {};
  const options = {
    type: "key-points",
    format: "markdown",
    length: "long",
    sharedContext: "A meeting transcript.",
    outputLanguage: base(lang),
  } as const;
  if (!api || !usable(await availabilityOf(api, options))) return null;
  const summarizer = await api.create({ ...options, ...signal });
  try {
    const text = transcriptText(lines).join("\n");
    let body = "";
    if (summarizer.summarizeStreaming) {
      for await (const delta of summarizer.summarizeStreaming(text, signal)) {
        body += delta;
        opts.onPartial?.(`## Summary\n\n${body}`);
      }
    } else {
      body = await summarizer.summarize(text, signal);
    }
    const markdown = `## Summary\n\n${body.trim()}\n`;
    opts.onPartial?.(markdown);
    return { markdown };
  } finally {
    summarizer.destroy?.();
  }
}
