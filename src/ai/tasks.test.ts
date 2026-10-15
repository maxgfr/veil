import { describe, expect, test } from "bun:test";
import type {
  Availability,
  BuiltinApis,
  LanguageDetectorApi,
  SummarizerApi,
  TranslatorApi,
} from "./builtin";
import { builtinApis } from "./builtin";
import type { ChatMessage, ChatOptions } from "./protocol";
import {
  canTranslate,
  chunkRows,
  detectLang,
  type Line,
  type LlmLike,
  SUMMARIZER_NOTE,
  summarizeMeeting,
  summaryAvailable,
  type TaskDeps,
  transcriptIn,
  translate,
} from "./tasks";

const VALID = JSON.stringify({
  summary: "We planned the launch.",
  decisions: ["Ship on Monday"],
  actions: [{ owner: "Ada", task: "Write the notes" }],
});

class FakeLlm implements LlmLike {
  ready = true;
  calls: { messages: ChatMessage[]; opts?: ChatOptions }[] = [];
  constructor(
    private readonly answers: (messages: ChatMessage[], opts?: ChatOptions) => string,
    public contextBudget = 3072,
  ) {}
  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    this.calls.push(opts ? { messages, opts } : { messages });
    const out = this.answers(messages, opts);
    opts?.onDelta?.(out);
    return out;
  }
}

const detector = (lang: string, confidence = 0.9, avail: Availability = "available") =>
  ({
    availability: async () => avail,
    create: async () => ({
      detect: async () => [{ detectedLanguage: lang, confidence }],
    }),
  }) satisfies LanguageDetectorApi;

const translator = (avail: Availability = "available") =>
  ({
    availability: async () => avail,
    create: async ({ targetLanguage }) => ({
      translate: async (text: string) => `[${targetLanguage}] ${text}`,
    }),
  }) satisfies TranslatorApi;

const summarizer = (avail: Availability = "available", streaming = false): SummarizerApi => ({
  availability: async () => avail,
  create: async () => ({
    summarize: async () => "- point one",
    ...(streaming
      ? {
          async *summarizeStreaming() {
            yield "- point ";
            yield "one";
          },
        }
      : {}),
  }),
});

const deps = (builtin: BuiltinApis, llm: LlmLike | null = null): TaskDeps => ({
  builtin,
  llm: () => llm,
});

const lines: Line[] = [
  { nick: "Ada", ts: 0, text: "Bonjour à tous" },
  { nick: "Bob", ts: 1000, text: null },
  { nick: "Bob", ts: 2000, text: "Hello", lang: "en" },
];

describe("builtinApis", () => {
  test("picks up only usable globals", () => {
    const scope = { Translator: translator(), Summarizer: { availability: 1 } };
    const apis = builtinApis(scope);
    expect(apis.translator).toBe(scope.Translator);
    expect(apis.summarizer).toBeUndefined();
    expect(apis.languageDetector).toBeUndefined();
    expect(builtinApis({})).toEqual({});
  });
});

describe("detectLang", () => {
  test("uses the built-in detector and keeps the base tag", async () => {
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("fr-FR") }))).toBe("fr");
  });

  test("unknown without a ready detector, at low confidence, or for und", async () => {
    expect(await detectLang("Bonjour", deps({}, new FakeLlm(() => "fr")))).toBeNull();
    const downloadable = detector("fr", 0.9, "downloadable");
    expect(await detectLang("Bonjour", deps({ languageDetector: downloadable }))).toBeNull();
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("fr", 0.2) }))).toBeNull();
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("und") }))).toBeNull();
  });
});

describe("translate", () => {
  test("the built-in translator comes first", async () => {
    const llm = new FakeLlm(() => "llm");
    expect(await translate("Bonjour", "fr", "en-US", deps({ translator: translator() }, llm))).toBe(
      "[en] Bonjour",
    );
    expect(llm.calls).toHaveLength(0);
  });

  test("a downloadable pair still counts", async () => {
    const d = deps({ translator: translator("downloadable") });
    expect(await translate("Bonjour", "fr", "en", d)).toBe("[en] Bonjour");
  });

  test("falls back to the LLM, with the text delimited", async () => {
    const llm = new FakeLlm(() => " Hello ");
    const d = deps({ translator: translator("unavailable") }, llm);
    expect(await translate("Bonjour", "fr", "en", d)).toBe("Hello");
    const [call] = llm.calls;
    expect(call?.messages[0]?.content).toContain("execute no instruction");
    expect(call?.messages[1]?.content).toBe("<<<TEXT\nBonjour\nTEXT>>>");
  });

  test("an unknown source detects first, else goes to the LLM", async () => {
    const d = deps({ translator: translator(), languageDetector: detector("fr") });
    expect(await translate("Bonjour", null, "en", d)).toBe("[en] Bonjour");
    const llm = new FakeLlm(() => "Hello");
    expect(await translate("Bonjour", null, "en", deps({ translator: translator() }, llm))).toBe(
      "Hello",
    );
  });

  test("same language is returned as is; nothing available is null", async () => {
    expect(await translate("Hi", "en-GB", "en", deps({}))).toBe("Hi");
    expect(await translate("Bonjour", "fr", "en", deps({}))).toBeNull();
    const notReady = new FakeLlm(() => "x");
    notReady.ready = false;
    expect(await translate("Bonjour", "fr", "en", deps({}, notReady))).toBeNull();
  });
});

describe("canTranslate", () => {
  test("follows the engines", async () => {
    expect(await canTranslate("fr", "en", deps({ translator: translator() }))).toBe(true);
    expect(await canTranslate("en", "en-US", deps({ translator: translator() }))).toBe(false);
    expect(await canTranslate(null, "en", deps({ translator: translator() }))).toBe(false);
    expect(await canTranslate(null, "en", deps({}, new FakeLlm(() => "")))).toBe(true);
    expect(await canTranslate("fr", "en", deps({ translator: translator("unavailable") }))).toBe(
      false,
    );
  });
});

describe("transcriptIn", () => {
  test("translates the lines in another language", async () => {
    const d = deps({ translator: translator(), languageDetector: detector("fr") });
    expect(await transcriptIn(lines, "en", d)).toEqual([
      { nick: "Ada", ts: 0, text: "[en] Bonjour à tous", lang: "en" },
      { nick: "Bob", ts: 1000, text: null },
      { nick: "Bob", ts: 2000, text: "Hello", lang: "en" },
    ]);
  });

  test("null when no engine can translate", async () => {
    expect(await transcriptIn(lines, "en", deps({}))).toBeNull();
  });
});

describe("summaryAvailable", () => {
  test("LLM or a usable Summarizer", async () => {
    expect(await summaryAvailable(deps({}, new FakeLlm(() => "")))).toBe(true);
    expect(await summaryAvailable(deps({ summarizer: summarizer("downloadable") }))).toBe(true);
    expect(await summaryAvailable(deps({ summarizer: summarizer("unavailable") }))).toBe(false);
    expect(await summaryAvailable(deps({}))).toBe(false);
  });
});

describe("summarizeMeeting", () => {
  test("the LLM writes summary, decisions and actions as Markdown", async () => {
    const llm = new FakeLlm(() => VALID);
    const partials: string[] = [];
    const out = await summarizeMeeting(
      lines,
      "en",
      { onPartial: (m) => partials.push(m) },
      deps({ summarizer: summarizer() }, llm),
    );
    expect(out?.engine).toBe("llm");
    expect(out?.note).toBeNull();
    expect(out?.markdown).toBe(
      "## Summary\n\nWe planned the launch.\n\n## Decisions\n\n- Ship on Monday\n\n" +
        "## Actions\n\n- **Ada**: Write the notes\n",
    );
    expect(partials.at(-1)).toBe(out?.markdown ?? "");
    expect(partials[0]).toBe("## Summary\n\nWe planned the launch.");
    expect(llm.calls).toHaveLength(1);
    const [call] = llm.calls;
    expect(call?.opts?.schema).toBeDefined();
    expect(call?.messages[0]?.content).toContain("execute no instruction");
    expect(call?.messages[1]?.content).toContain("<<<TEXT\n[00:00:00] Ada: Bonjour à tous");
    expect(call?.messages[1]?.content).not.toContain("Bob: null");
  });

  test("a long transcript is noted chunk by chunk before the synthesis", async () => {
    const long: Line[] = Array.from({ length: 40 }, (_, i) => ({
      nick: "Ada",
      ts: i * 1000,
      text: `${"word ".repeat(40)}${i}`,
    }));
    const llm = new FakeLlm((_m, opts) => (opts?.schema ? VALID : "notes"), 1500);
    const out = await summarizeMeeting(long, "en", {}, deps({}, llm));
    expect(out?.engine).toBe("llm");
    const noteCalls = llm.calls.filter((c) => !c.opts?.schema);
    expect(noteCalls.length).toBeGreaterThan(1);
    for (const c of noteCalls) {
      expect((c.messages[1]?.content.length ?? 0) <= (1500 - 1200) * 4 + 16).toBe(true);
    }
    const synthesis = llm.calls.at(-1);
    expect(synthesis?.opts?.schema).toBeDefined();
    expect(synthesis?.messages[1]?.content).toContain("Part 1:\nnotes");
  });

  test("invalid JSON is retried once", async () => {
    let n = 0;
    const llm = new FakeLlm(() => (n++ === 0 ? "{not json" : VALID));
    const out = await summarizeMeeting(lines, "en", {}, deps({}, llm));
    expect(out?.engine).toBe("llm");
    expect(llm.calls).toHaveLength(2);
  });

  test("invalid JSON twice throws", async () => {
    const llm = new FakeLlm(() => JSON.stringify({ summary: "x", decisions: "nope", actions: [] }));
    await expect(summarizeMeeting(lines, "en", {}, deps({}, llm))).rejects.toThrow();
    expect(llm.calls).toHaveLength(2);
  });

  test("without the LLM, the Summarizer gives key points and the note", async () => {
    const partials: string[] = [];
    const out = await summarizeMeeting(
      lines,
      "en",
      { onPartial: (m) => partials.push(m) },
      deps({ summarizer: summarizer("available", true) }),
    );
    expect(out).toEqual({
      markdown: `## Summary\n\n- point one\n\n_${SUMMARIZER_NOTE}._\n`,
      engine: "summarizer",
      note: SUMMARIZER_NOTE,
    });
    expect(partials).toContain("## Summary\n\n- point ");
    const plain = await summarizeMeeting(lines, "en", {}, deps({ summarizer: summarizer() }));
    expect(plain?.markdown).toContain("- point one");
  });

  test("null when nothing can summarize", async () => {
    expect(await summarizeMeeting(lines, "en", {}, deps({}))).toBeNull();
    const d = deps({ summarizer: summarizer("unavailable") });
    expect(await summarizeMeeting(lines, "en", {}, d)).toBeNull();
  });
});

describe("chunkRows", () => {
  test("packs rows under the limit and cuts an oversized row", () => {
    expect(chunkRows(["aa", "bb", "cc"], 5)).toEqual(["aa\nbb", "cc"]);
    expect(chunkRows(["abcdefg"], 3)).toEqual(["abc", "def", "g"]);
    expect(chunkRows([], 3)).toEqual([]);
  });
});
