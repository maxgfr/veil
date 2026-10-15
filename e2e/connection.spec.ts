import { expect, test } from "@playwright/test";
import { BASE, closeSheets, createRoom, joinRoom, member, waitLinks, waitMembers } from "./helpers";

test("the status pill spells out the connection and opens its details", async ({ browser }) => {
  const a = await member(browser);
  const b = await member(browser);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);

  const status = a.page.getByTestId("status");
  await expect(status).toHaveAttribute("data-state", "ok");
  await expect(status).toHaveAccessibleName(/Connected/);
  await status.click();
  const sheet = a.page.getByTestId("connection-sheet");
  await expect(sheet).toBeVisible();
  const peer = sheet.getByTestId("connection-peer");
  await expect(peer).toHaveCount(1);
  await expect(peer).toContainText("Bob");
  await expect(peer).toContainText("Direct");
  await a.page.keyboard.press("Escape");

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("losing the network shows an offline banner in the room and at home", async ({ browser }) => {
  const a = await member(browser);
  await createRoom(a, "Ada");
  const home = await a.ctx.newPage();
  await home.goto(`${BASE}/?nosw`);
  await expect(home.getByTestId("new-room")).toBeVisible();

  await a.ctx.setOffline(true);
  await expect(a.page.getByTestId("offline")).toBeVisible();
  await expect(a.page.getByTestId("status")).toHaveAttribute("data-state", "bad");
  await expect(home.getByTestId("offline")).toBeVisible();

  await a.ctx.setOffline(false);
  await expect(a.page.getByTestId("offline")).toHaveCount(0);
  await expect(home.getByTestId("offline")).toHaveCount(0);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
