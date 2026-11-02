import { expect, test } from "@playwright/test";
import { newRoomKey, roomLink } from "../src/crypto/room";
import { BASE, member } from "./helpers";

// Every maxgfr.github.io site shares this origin's storage: no secret may sit there in clear.
const dump = () => JSON.stringify({ ...localStorage, ...sessionStorage });

test("the TURN password is stored sealed, and comes back after a reload", async ({ browser }) => {
  const a = await member(browser, { persist: true });
  const page = a.page;
  await page.goto(`${BASE}/?nosw`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder("turns:turn.example.com:443").fill("turns:turn.example.com:443");
  await page.getByLabel("TURN username").fill("ana");
  await page.getByLabel("TURN credential").fill("hunter2-turn");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-sheet")).not.toBeVisible();

  const stored = await page.evaluate(dump);
  expect(stored).toContain("turn.example.com");
  expect(stored).not.toContain("hunter2-turn");

  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("TURN credential")).toHaveValue("hunter2-turn");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("settings that cannot be stored say so instead of closing", async ({ browser }) => {
  const a = await member(browser);
  const page = a.page;
  await page.goto(`${BASE}/?nosw`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-not-saved")).toBeVisible();
  await expect(page.getByTestId("settings-sheet")).toBeVisible();
  await a.ctx.close();
});

test("meetings kept in clear by an earlier version are sealed on the next visit", async ({
  browser,
}) => {
  const a = await member(browser);
  const page = a.page;
  const link = roomLink(`${BASE}/`, newRoomKey());
  const start = Date.now() + 86_400_000;
  await page.goto(`${BASE}/?nosw`);
  await page.evaluate((m) => localStorage.setItem("veil.meetings.v1", JSON.stringify([m])), {
    id: "a".repeat(32),
    title: "Legacy sync",
    start,
    minutes: 30,
    link,
  });
  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Legacy sync");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("veil.meetings.v1"))).toBeNull();
  const stored = await page.evaluate(dump);
  expect(stored).not.toContain(new URL(link).hash.slice(1));
  expect(stored).not.toContain("Legacy sync");
  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Legacy sync");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
