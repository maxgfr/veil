import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  aiSettings,
  closeSheets,
  createRoom,
  fakeAiWorker,
  fakeBuiltinAi,
  fakeDevice,
  fakeSpeechSaying,
  joinRoom,
  type Member,
  member,
  noHorizontalOverflow,
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
