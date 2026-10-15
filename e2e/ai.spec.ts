import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  aiSettings,
  closeSheets,
  createRoom,
  fakeAiWorker,
  fakeBuiltinAi,
  fakeDevice,
  fakeMicSpeaking,
  fakeSpeechSaying,
  fakeSpeechWorker,
  joinRoom,
  type Member,
  member,
  noHorizontalOverflow,
  noWebSpeech,
  openChat,
  say,
  waitLinks,
  waitMembers,
} from "./helpers";

async function download(page: Page, testid: string): Promise<Buffer> {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(testid).click(),
  ]);
  return readFile(await file.path());
}

/** Ada (English) and Bob (German, whose device speaks German), linked in one room. */
async function pair(
  browser: Parameters<typeof member>[0],
  /** More init scripts for Ada, run after the shared fakes. */
  setupA?: (a: Member) => Promise<void>,
): Promise<[Member, Member]> {
  const a = await member(browser, {}, { locale: "en-US" });
  const b = await member(browser, {}, { locale: "de-DE" });
  for (const m of [a, b]) await m.ctx.addInitScript(fakeBuiltinAi);
  await setupA?.(a);
  await a.ctx.addInitScript(fakeSpeechSaying, "hello from ada");
  await b.ctx.addInitScript(fakeSpeechSaying, "Guten Morgen zusammen");
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);
  return [a, b];
}

test("with little free space, the AI settings offer the best model that fits", async ({
  browser,
}) => {
  const a = await member(browser);
  // 8 GiB of RAM ranks Qwen3.5-4B first (2.4 GB); 2.5 GB free minus the 1 GiB reserve fits Qwen3.5-2B.
  await a.ctx.addInitScript(fakeDevice, { memory: 8, quota: 2.5e9, usage: 0 });
  await createRoom(a, "Ada");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  const space = a.page.getByTestId("ai-space");
  await expect(space).toContainText("Qwen3.5-4B needs 2.4 GB, 2.5 GB free");
  await expect(
    space.getByRole("button", { name: "Use Qwen3.5-2B (1.1 GB)", exact: true }),
  ).toBeVisible();

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("captions: everyone sees who turned them on, and a German line shows translated", async ({
  browser,
}) => {
  const [a, b] = await pair(browser);
  await b.page.getByTestId("toggle-mic").click();

  await a.page.getByTestId("toggle-captions").click();
  await expect(a.page.getByTestId("toggle-captions")).toHaveAttribute("aria-pressed", "true");
  await expect(b.page.getByTestId("captions-indicator")).toHaveAttribute(
    "aria-label",
    "Captions on for Ada",
  );
  await expect(b.page.getByText("Ada turned on captions")).toBeVisible();

  const line = a.page.getByTestId("live-caption").filter({ hasText: "Bob" });
  await expect(line.first()).toContainText("Good morning everyone");
  await expect(line.first()).toContainText("(translated)");

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a chat message in German can be translated and shown in the original again", async ({
  browser,
}) => {
  const [a, b] = await pair(browser);
  await openChat(a.page);
  await say(b.page, "Wie geht es euch heute?");

  await expect(a.page.getByTestId("message").last()).toContainText("Wie geht es euch heute?");
  // Its text changes with the translation: hold on to it by position.
  const msg = a.page.getByTestId("message").last();
  const action = msg.getByTestId("translate-msg");
  await expect(action).toHaveText("Translate");
  await action.click();
  await expect(msg.locator(".bubble")).toHaveText("How are you all today?");
  await expect(action).toHaveText("Show original");
  await action.click();
  await expect(msg.locator(".bubble")).toHaveText("Wie geht es euch heute?");
  // Our own messages offer nothing.
  await expect(b.page.getByTestId("translate-msg")).toHaveCount(0);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a stopped recording makes meeting notes on the device and saves them as Markdown", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeBuiltinAi);
  await a.ctx.addInitScript(fakeSpeechSaying, "hello from ada");
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-cam").click();
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(3000);
  await a.page.getByTestId("toggle-record").click();

  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  // Everything was said in English: nothing to translate.
  await expect(a.page.getByTestId("recording-translated")).toHaveCount(0);
  await a.page.getByTestId("recording-summarize").click();
  const notes = await download(a.page, "recording-summary-save");
  expect(notes.toString("utf8")).toContain("## Summary");
  expect(notes.toString("utf8")).toContain("The meeting covered");

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("a phone screen fits the room with captions on, and the Recording sheet", async ({
  browser,
}) => {
  const a = await member(browser, {}, { viewport: { width: 360, height: 740 } });
  await a.ctx.addInitScript(fakeBuiltinAi);
  await a.ctx.addInitScript(fakeSpeechSaying, "hello from ada, a fairly long caption line");
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();
  await expect(a.page.getByTestId("captions-indicator")).toBeVisible();
  await expect(a.page.getByTestId("live-caption").first()).toBeVisible();
  await noHorizontalOverflow(a.page);

  await a.page.getByTestId("toggle-record").click();
  // The recognizer hears its line every 3 s.
  await a.page.waitForTimeout(3500);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-summary")).toBeVisible();
  await a.page.getByTestId("recording-summarize").click();
  await expect(a.page.getByTestId("recording-summary-save")).toBeVisible();
  await noHorizontalOverflow(a.page);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

const CACHED_MODEL = "Qwen3.5-2B-q4f16_1-MLC";
const aiOps = (page: Page) => page.evaluate(() => (window as unknown as { aiOps: string[] }).aiOps);

test("a downloaded model never loads without a click: chat and captions stay untranslated", async ({
  browser,
}) => {
  const [a, b] = await pair(browser, async (a) => {
    await a.ctx.addInitScript(fakeAiWorker);
    await a.ctx.addInitScript(aiSettings, { model: CACHED_MODEL, translateChat: true });
    // No built-in translator: only a model already loaded could translate.
    await a.ctx.addInitScript(() => {
      delete (window as { Translator?: unknown }).Translator;
    });
  });
  await b.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();
  await openChat(a.page);
  await say(b.page, "Wie geht es euch heute?");

  await expect(a.page.getByTestId("message").last()).toContainText("Wie geht es euch heute?");
  await expect(
    a.page.getByTestId("live-caption").filter({ hasText: "Guten Morgen zusammen" }).first(),
  ).toBeVisible();
  await a.page.waitForTimeout(2000);
  await expect(a.page.getByTestId("translate-msg")).toHaveCount(0);
  await expect(a.page.getByTestId("message").last()).toContainText("Wie geht es euch heute?");
  expect(await aiOps(a.page)).not.toContain("load");

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

const WHISPER_SMALL = "onnx-community/whisper-small";
type SpeechReq = { op: string; modelId?: string; download?: boolean };
const speechReqs = (page: Page) =>
  page.evaluate(() => (window as unknown as { speechReqs: SpeechReq[] }).speechReqs);

test("without speech recognition on the device, captions come from the downloaded Whisper model", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeBuiltinAi);
  await a.ctx.addInitScript(noWebSpeech);
  await a.ctx.addInitScript(fakeMicSpeaking);
  await a.ctx.addInitScript(fakeSpeechWorker, {
    cached: [WHISPER_SMALL],
    text: "hello from whisper",
  });
  await a.ctx.addInitScript(aiSettings, {
    model: null,
    translateChat: false,
    speechModel: WHISPER_SMALL,
  });
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();

  await expect(
    a.page.getByTestId("live-caption").filter({ hasText: "hello from whisper" }).first(),
  ).toBeVisible();
  const reqs = await speechReqs(a.page);
  // Loaded from the cache only: nothing is downloaded without a click.
  expect(reqs.filter((r) => r.op === "load")).toEqual([
    expect.objectContaining({ op: "load", modelId: WHISPER_SMALL, download: false }),
  ]);
  expect(reqs.some((r) => r.op === "transcribe")).toBe(true);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("the AI settings offer Whisper with its size, and download it on a click", async ({
  browser,
}) => {
  const a = await member(browser);
  // WebGPU with shader-f16 and room: large-v3 turbo is recommended.
  await a.ctx.addInitScript(fakeDevice, { memory: 8, quota: 100e9, usage: 0 });
  await a.ctx.addInitScript(fakeSpeechWorker, { cached: [], text: "" });
  await createRoom(a, "Ada");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();

  const speech = a.page.getByTestId("speech-settings");
  await expect(speech).toContainText("Used for captions and recordings");
  const card = speech.getByTestId("speech-model");
  await expect(card).toContainText("Whisper large-v3 turbo");
  await expect(card).toContainText("566 MB download");
  await speech.getByText("Other Whisper models").click();
  // Sized for WebGPU with fp16: an fp16 encoder and a q4 decoder.
  await expect(speech).toContainText("Whisper base");
  await expect(speech).toContainText("168 MB download");
  await expect(speech).toContainText("Whisper small");
  await expect(speech).toContainText("413 MB download");
  await expect(a.page.getByText("Transcribe with Gemma")).toHaveCount(0);
  await expect(a.page.getByText("Requires Gemma 4 E2B")).toHaveCount(0);
  // Nothing loads before the click.
  expect((await speechReqs(a.page)).some((r) => r.op === "load")).toBe(false);

  await card.getByTestId("speech-download").click();
  await expect(card.getByTestId("speech-in-use")).toBeVisible();
  expect((await speechReqs(a.page)).filter((r) => r.op === "load")).toEqual([
    expect.objectContaining({ modelId: "onnx-community/whisper-large-v3-turbo", download: true }),
  ]);
  await card.getByTestId("speech-delete").click();
  await expect(card.getByTestId("speech-download")).toBeVisible();

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("Delete all AI data frees every cached model, after a confirmation, and nothing else", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeDevice, { memory: 8, quota: 100e9, usage: 0 });
  await createRoom(a, "Ada");
  // A WebLLM model (5 MB of weights), the start of a Whisper download, and a cache that isn't AI's.
  await a.page.evaluate(async () => {
    const repo = "https://huggingface.co/mlc-ai/Qwen3.5-2B-q4f16_1-MLC/resolve/main/";
    const model = await caches.open("webllm/model");
    const records = [{ dataPath: "params_shard_0.bin", nbytes: 5_000_000 }];
    await model.put(`${repo}tensor-cache.json`, new Response(JSON.stringify({ records })));
    await model.put(`${repo}params_shard_0.bin`, new Response("weights"));
    const whisper = await caches.open("transformers-cache");
    await whisper.put(
      "https://huggingface.co/onnx-community/whisper-small/resolve/main/config.json",
      new Response("{}"),
    );
    await (await caches.open("keep-me")).put("https://example.com/x", new Response("x"));
  });
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();

  const button = a.page.getByTestId("ai-delete-all-button");
  await expect(button).toHaveText("Delete all AI data (5 MB)");
  await expect(a.page.getByTestId("ai-delete-all")).toContainText("chrome://on-device-internals");
  await button.click();
  await a.page.getByTestId("ai-delete-all-confirm").click();

  await expect(button).toHaveText("Delete all AI data (0 MB)");
  const speech = a.page.getByTestId("speech-model");
  await expect(speech.getByTestId("speech-download")).toHaveText("Download");
  await expect(a.page.getByTestId("speech-delete")).toHaveCount(0);
  await expect(a.page.getByTestId("ai-delete")).toHaveCount(0);
  await expect(a.page.getByTestId("ai-delete-all-error")).toHaveCount(0);
  const left = await a.page.evaluate(() => caches.keys());
  expect(left).toContain("keep-me");
  for (const name of ["webllm/model", "webllm/config", "webllm/wasm", "transformers-cache"])
    expect(left).not.toContain(name);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("every built-in model row shows a status, whatever the browser answers", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const create = async () => ({ destroy() {} });
    // An answer from before the spec, a model Chrome can't run, and a probe that
    // first never answers, then does.
    w.LanguageDetector = { availability: async () => "readily", create };
    w.Summarizer = { availability: async () => "unavailable", create };
    let probes = 0;
    w.Translator = {
      availability: () => (++probes === 1 ? new Promise(() => {}) : Promise.resolve("available")),
      create,
    };
  });
  await createRoom(a, "Ada");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();

  const row = (name: string) => a.page.getByTestId(`ai-builtin-${name}`);
  await expect(row("languageDetector").getByTestId("ai-builtin-status")).toHaveText(
    "Not available",
  );
  await expect(row("summarizer").getByTestId("ai-builtin-status")).toHaveText("Not available");
  await expect(a.page.getByText("Chrome needs its Gemini Nano model")).toBeVisible();
  await expect(row("translator").getByTestId("ai-builtin-status")).toHaveText("Couldn't check");
  await row("translator").getByRole("button", { name: "Retry" }).click();
  await expect(row("translator").getByTestId("ai-builtin-status")).toHaveText("Ready");

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("the Language detection row always shows a status in this browser", async ({ browser }) => {
  const a = await member(browser);
  await createRoom(a, "Ada");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();

  const row = a.page.getByTestId("ai-builtin-languageDetector");
  await expect(row).toBeVisible();
  // A status, or the Download button of a model the browser can fetch.
  await expect(row).toContainText(
    /Ready|Downloads on first use|Downloading…|Not available|Couldn't check|Download/,
  );

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("when the downloaded model fails to load, Summarize still makes notes and says why", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeBuiltinAi);
  await a.ctx.addInitScript(fakeAiWorker);
  await a.ctx.addInitScript(aiSettings, { model: CACHED_MODEL, translateChat: false });
  await a.ctx.addInitScript(fakeSpeechSaying, "hello from ada");
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(3500);
  await a.page.getByTestId("toggle-record").click();

  await a.page.getByTestId("recording-summarize").click();
  const notes = await download(a.page, "recording-summary-save");
  expect(notes.toString("utf8")).toContain("The meeting covered");
  await expect(a.page.getByTestId("recording-model-error")).toContainText("GPU device lost");
  expect(await aiOps(a.page)).toContain("load");

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
