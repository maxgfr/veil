import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  fakeBuiltinAi,
  fakeSpeechSaying,
  joinRoom,
  type Member,
  member,
  noHorizontalOverflow,
  noWebSpeech,
  openChat,
  say,
  storedSettings,
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

  // Another language picked: the English translation is stale, a new one is made.
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await a.page.getByTestId("language-select").selectOption("fr-FR");
  await a.page.keyboard.press("Escape");
  await expect(action).toHaveText("Translate");
  await action.click();
  await expect(msg.locator(".bubble")).toHaveText("[fr] Wie geht es euch heute?");
  await expect(msg.locator(".bubble")).toHaveAttribute("lang", "fr");

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

test("recording with the microphone on downloads speech recognition in the click, and transcribes", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeSpeechSaying, "hello from ada");
  // Like Chrome: "downloadable" for this site until installed, and installed only in a click.
  await a.ctx.addInitScript(() => {
    const R = (window as unknown as { SpeechRecognition: Record<string, unknown> })
      .SpeechRecognition;
    let installed = false;
    R.available = async () => (installed ? "available" : "downloadable");
    R.install = async () => {
      if (window.event?.type !== "click")
        throw new DOMException("Requires handling a user gesture", "NotAllowedError");
      installed = true;
      return true;
    };
  });
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await expect(a.page.getByTestId("toggle-mic")).toHaveAttribute("aria-pressed", "true");
  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(2000);
  await a.page.getByTestId("toggle-record").click();

  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  const transcript = await download(a.page, "recording-transcript");
  expect(transcript.toString("utf8")).toContain("hello from ada");

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

const heardIn = (page: Page) =>
  page.evaluate(() => (window as unknown as { heardIn?: string[] }).heardIn ?? []);

test("captions use the language picked in Settings, and a new pick restarts them in it", async ({
  browser,
}) => {
  const a = await member(browser, {}, { locale: "en-US" });
  await a.ctx.addInitScript(fakeBuiltinAi);
  await a.ctx.addInitScript(fakeSpeechSaying, "bonjour à tous");
  await a.ctx.addInitScript(storedSettings, { language: "fr-FR" });
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();

  await expect(a.page.getByTestId("live-caption").first()).toContainText("bonjour à tous");
  expect(await heardIn(a.page)).toEqual(["fr-FR"]);

  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  const select = a.page.getByTestId("language-select");
  await expect(select).toHaveValue("fr-FR");
  await a.page.getByTestId("speech-check").click();
  await expect(a.page.getByTestId("ai-builtin-speech")).toContainText("Ready");
  await select.selectOption("de-DE");
  await expect.poll(() => heardIn(a.page)).toEqual(["fr-FR", "de-DE"]);
  // Back to the browser's language.
  await select.selectOption("");
  await expect.poll(() => heardIn(a.page)).toEqual(["fr-FR", "de-DE", "en-US"]);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("speech recognition not yet on this site downloads from Settings, on the click", async ({
  browser,
}) => {
  const a = await member(browser, {}, { locale: "en-US" });
  await a.ctx.addInitScript(fakeSpeechSaying, "hello");
  // Like Chrome: "downloadable" for this site until installed, and installed only from a click.
  await a.ctx.addInitScript(() => {
    const R = (window as unknown as { SpeechRecognition: Record<string, unknown> })
      .SpeechRecognition;
    let installed = false;
    R.available = async () => (installed ? "available" : "downloadable");
    R.install = async () => {
      if (!navigator.userActivation.isActive)
        throw new DOMException("Requires handling a user gesture", "NotAllowedError");
      installed = true;
      return true;
    };
  });
  await createRoom(a, "Ada");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await a.page.getByTestId("speech-check").click();
  await a.page.getByTestId("speech-download").click();
  await expect(a.page.getByTestId("ai-builtin-speech")).toContainText("Ready");

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("while the browser downloads speech recognition, captions say they are getting ready", async ({
  browser,
}) => {
  const a = await member(browser, {}, { locale: "en-US" });
  await a.ctx.addInitScript(fakeSpeechSaying, "hello");
  // The language pack is still downloading: install() doesn't settle.
  await a.ctx.addInitScript(() => {
    const R = (window as unknown as { SpeechRecognition: Record<string, unknown> })
      .SpeechRecognition;
    R.available = async () => "downloading";
    R.install = () => new Promise(() => {});
  });
  await createRoom(a, "Ada");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();

  await expect(a.page.getByTestId("captions-installing")).toContainText(
    "Getting American English speech recognition ready",
  );
  await expect(a.page.getByTestId("captions-listening")).toHaveCount(0);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("without on-device speech recognition, captions say so on both sides", async ({ browser }) => {
  const a = await member(browser, {}, { locale: "en-US" });
  const b = await member(browser, {}, { locale: "de-DE" });
  await a.ctx.addInitScript(noWebSpeech);
  await b.ctx.addInitScript(fakeSpeechSaying, "Guten Morgen");
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);
  await b.page.getByTestId("toggle-captions").click();
  await expect(b.page.getByTestId("captions-listening")).toContainText("Captions on, in German");
  await a.page.getByTestId("toggle-mic").click();
  await a.page.getByTestId("toggle-captions").click();

  const mine = a.page.getByTestId("captions-unavailable");
  await expect(mine).toContainText("can't recognize American English");
  await expect(b.page.getByTestId("captions-unavailable-member")).toHaveText(
    "Ada's browser can't caption their speech.",
  );
  await mine.getByRole("button", { name: "Change language" }).click();
  await expect(a.page.getByTestId("language-select")).toBeVisible();
  await expect(a.page.getByTestId("ai-builtin-speech")).toContainText("Not available");
  await expect(a.page.getByTestId("speech-unavailable")).toBeVisible();

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
