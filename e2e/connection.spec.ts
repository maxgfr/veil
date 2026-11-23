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

const freshKey = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

test("a browser that can't open rooms says so in the lobby", async ({ browser }) => {
  const a = await member(browser);
  await a.ctx.addInitScript(() => {
    delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
  });
  await a.page.goto(`${BASE}/?nosw#${freshKey()}`);
  await expect(a.page.getByTestId("lobby-error")).toContainText(
    "This browser can't open Veil rooms",
  );
  await expect(a.page.getByTestId("enter-room")).toBeDisabled();
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("junk appended to a link still opens the room", async ({ browser }) => {
  const a = await member(browser);
  const b = await member(browser);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, `${link}?fbclid=x`, "Bob");
  await waitMembers(a.page, 1);
  await waitMembers(b.page, 1);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a cut link says so at home", async ({ browser }) => {
  const a = await member(browser);
  await a.page.goto(`${BASE}/?nosw#${freshKey().slice(0, 30)}`);
  await expect(a.page.getByTestId("home-error")).toHaveText(
    "This link looks incomplete. Ask for it again.",
  );
  await a.ctx.close();
});

test("another room's link opened in a room asks before leaving", async ({ browser }) => {
  const a = await member(browser);
  const link = await createRoom(a, "Ada");
  const here = new URL(link).hash;
  // The same room's link changes nothing.
  await a.page.evaluate((h) => {
    location.hash = `${h}?fbclid=x`;
  }, here);
  await a.page.waitForTimeout(300);
  await expect(a.page.getByTestId("other-room")).toHaveCount(0);

  const other = freshKey();
  await a.page.evaluate((k) => {
    location.hash = k;
  }, other);
  await expect(a.page.getByTestId("other-room")).toBeVisible();
  await expect(a.page.getByTestId("room")).toBeVisible();
  await a.page.getByTestId("open-other-room").click();
  await expect(a.page.getByTestId("enter-room")).toBeVisible();
  expect(new URL(a.page.url()).hash).toBe(`#${other}`);
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
