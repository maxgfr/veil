import { expect, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  fakeBuiltinAi,
  joinRoom,
  type Member,
  member,
  noHorizontalOverflow,
  openChat,
  say,
  waitLinks,
  waitMembers,
} from "./helpers";

/** Ada (English) and Bob (German), linked in one room. */
async function pair(browser: Parameters<typeof member>[0]): Promise<[Member, Member]> {
  const a = await member(browser, {}, { locale: "en-US" });
  const b = await member(browser, {}, { locale: "de-DE" });
  for (const m of [a, b]) await m.ctx.addInitScript(fakeBuiltinAi);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);
  return [a, b];
}

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

test("a phone screen fits the room, and the Recording sheet", async ({ browser }) => {
  const a = await member(browser, {}, { viewport: { width: 360, height: 740 } });
  await a.ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await createRoom(a, "Ada");
  await closeSheets(a.page);
  await a.page.getByTestId("toggle-mic").click();
  await noHorizontalOverflow(a.page);

  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(1500);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
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
    // An answer from before the spec, and a probe that first never answers, then does.
    w.LanguageDetector = { availability: async () => "readily", create };
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
