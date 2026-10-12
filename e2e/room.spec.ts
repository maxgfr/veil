import { expect, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  joinRoom,
  member,
  openChat,
  say,
  waitLinks,
  waitMembers,
} from "./helpers";

test("two members chat end to end and see the same verification emojis", async ({ browser }) => {
  const a = await member(browser);
  const b = await member(browser);
  const link = await createRoom(a, "Ada");
  expect(link).toMatch(/#[A-Za-z0-9_-]{43}$/);
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitMembers(b.page, 1);
  await waitLinks(a.page, 1);

  await say(b.page, "hello from Bob <b>not bold</b>");
  await openChat(a.page);
  await expect(a.page.getByTestId("messages")).toContainText("hello from Bob <b>not bold</b>");
  // Rendered as text, never as markup.
  await expect(a.page.locator("[data-testid=messages] b")).toHaveCount(0);
  await say(a.page, "hi Bob");
  await expect(b.page.getByTestId("messages")).toContainText("hi Bob");
  // Delivery receipt on Ada's message.
  await expect(a.page.locator(".msg.mine .receipt .tabular")).toHaveText("1");

  const sas = async (page: typeof a.page) => {
    await page.getByTestId("status").click();
    await page.getByTestId("verify").first().click();
    const text = await page.getByTestId("sas").innerText();
    await page.keyboard.press("Escape");
    return text;
  };
  const [sa, sb] = [await sas(a.page), await sas(b.page)];
  expect(sa.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(4);
  expect(sa).toBe(sb);

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a wrong passphrase never reaches the room", async ({ browser }) => {
  const a = await member(browser);
  const b = await member(browser);
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByTestId("new-room").click();
  await a.page.getByTestId("nick").fill("Ada");
  await a.page.getByPlaceholder("Leave empty if there is none").fill("correct horse battery");
  await a.page.getByTestId("enter-room").click();
  await expect(a.page.getByTestId("room")).toBeVisible();
  const link = a.page.url();
  await b.page.goto(link);
  await b.page.getByTestId("nick").fill("Eve");
  await b.page.getByPlaceholder("Leave empty if there is none").fill("wrong guess");
  await b.page.getByTestId("enter-room").click();
  await expect(b.page.getByTestId("room")).toBeVisible();
  await b.page.waitForTimeout(6000);
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-members", "0");
  await expect(b.page.getByTestId("room")).toHaveAttribute("data-members", "0");
  await a.ctx.close();
  await b.ctx.close();
});
