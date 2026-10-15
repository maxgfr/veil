import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { parseRoomLink, parseRoomMode } from "../src/crypto/room";
import { member, noHorizontalOverflow } from "./helpers";

/** Tomorrow's date as the date input takes it, and 10:00 local as an iCalendar UTC time. */
function tomorrowAtTen(page: Page): Promise<{ date: string; dtstart: string; dtend: string }> {
  return page.evaluate(() => {
    const t = new Date(Date.now() + 86_400_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 10, 0);
    const utc = (d: Date) => `${d.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
    return {
      date: `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`,
      dtstart: utc(start),
      dtend: utc(new Date(start.getTime() + 45 * 60_000)),
    };
  });
}

/** Undoes RFC 5545 line folding. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

test("schedule a meeting: a room link, an .ics, an Upcoming row that joins and goes away", async ({
  browser,
}) => {
  const a = await member(
    browser,
    {},
    { permissions: ["camera", "microphone", "clipboard-read", "clipboard-write"] },
  );
  const page = a.page;
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  await page.goto("http://localhost:4173/?nosw");
  // Nothing scheduled: no Upcoming list at all.
  await expect(page.getByTestId("new-room")).toBeVisible();
  await expect(page.getByTestId("upcoming")).toHaveCount(0);

  await page.getByTestId("schedule").click();
  const sheet = page.getByTestId("schedule-sheet");
  await expect(sheet.getByTestId("schedule-form")).toBeVisible();
  await expect(sheet.getByTestId("schedule-duration")).toHaveValue("30");
  await expect(sheet.getByLabel("Title (optional)")).toBeVisible();
  await expect(sheet.getByLabel("Date")).toBeVisible();
  await expect(sheet.getByLabel("Start time")).toBeVisible();

  const when = await tomorrowAtTen(page);
  await sheet.getByLabel("Title (optional)").fill("Design review, Q4; final");
  await sheet.getByLabel("Date").fill(when.date);
  await sheet.getByLabel("Start time").fill("10:00");
  await sheet.getByLabel("Duration").selectOption("45");
  await sheet.getByTestId("schedule-create").click();

  await expect(sheet.getByTestId("schedule-done")).toBeVisible();
  const link = await sheet.getByTestId("schedule-link").inputValue();
  // An ordinary room link, nothing about the meeting in it.
  const key = parseRoomLink(link);
  expect(key?.length).toBe(32);
  expect(parseRoomMode(link)).toBe("call");
  expect(link.startsWith("http://localhost:4173/?nosw#")).toBe(true);
  expect(link).not.toContain("Design");
  expect(link).not.toContain(when.date);

  await sheet.getByRole("button", { name: "Copy" }).click();
  await expect(sheet.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  const download = page.waitForEvent("download");
  await sheet.getByTestId("schedule-ics").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("design-review-q4-final.ics");
  const ics = readFileSync(await file.path(), "utf8");
  expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  const lines = unfold(ics).split("\r\n");
  expect(lines).toContain("SUMMARY:Design review\\, Q4\\; final");
  expect(lines).toContain(`DTSTART:${when.dtstart}`);
  expect(lines).toContain(`DTEND:${when.dtend}`);
  expect(lines).toContain(`URL:${link}`);
  expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).toContain(link);

  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).not.toBeVisible();
  await expect(page.getByTestId("meeting")).toHaveCount(1);

  // Saved on this device: still there after a reload.
  await page.reload();
  const row = page.getByTestId("meeting");
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId("meeting-title")).toHaveText("Design review, Q4; final");
  await expect(row.getByTestId("meeting-when")).toContainText("45 min");

  const again = page.waitForEvent("download");
  await row.getByTestId("meeting-ics").click();
  expect(unfold(readFileSync(await (await again).path(), "utf8"))).toContain(`URL:${link}`);

  // Join opens the lobby of that room, as opening the link does.
  await row.getByTestId("meeting-join").click();
  await expect(page.getByTestId("enter-room")).toBeVisible();
  await expect(page.getByTestId("lobby-mic")).toBeVisible();
  expect(new URL(page.url()).hash).toBe(new URL(link).hash);

  await page.goto("http://localhost:4173/?nosw");
  await expect(page.getByTestId("meeting")).toHaveCount(1);
  await page.getByTestId("meeting").getByTestId("meeting-remove").click();
  await expect(page.getByTestId("upcoming")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("new-room")).toBeVisible();
  await expect(page.getByTestId("upcoming")).toHaveCount(0);

  expect(a.errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await a.ctx.close();
});

test("a files meeting opens a files lobby, and a past time is refused", async ({ browser }) => {
  const a = await member(browser);
  const page = a.page;
  await page.goto("http://localhost:4173/?nosw");
  await page.getByTestId("schedule").click();
  const sheet = page.getByTestId("schedule-sheet");
  await expect(sheet.getByTestId("schedule-form")).toBeVisible();
  await sheet.getByLabel("Date").fill("2020-01-01");
  await sheet.getByTestId("schedule-create").click();
  await expect(sheet.getByRole("alert")).toHaveText("Pick a start time in the future.");

  const when = await tomorrowAtTen(page);
  await sheet.getByLabel("Date").fill(when.date);
  await sheet.getByLabel("Room").selectOption("files");
  await sheet.getByTestId("schedule-create").click();
  const link = await sheet.getByTestId("schedule-link").inputValue();
  expect(parseRoomLink(link)).not.toBeNull();
  expect(parseRoomMode(link)).toBe("files");
  await page.keyboard.press("Escape");
  await expect(sheet).not.toBeVisible();

  const row = page.getByTestId("meeting");
  await expect(row.getByTestId("meeting-title")).toHaveText("Veil meeting");
  await expect(row.getByTestId("meeting-when")).toContainText("Files");
  await row.getByTestId("meeting-join").click();
  await expect(page.getByTestId("enter-room")).toBeVisible();
  await expect(page.getByTestId("lobby-mic")).toHaveCount(0);
  expect(page.url()).toContain("#files/");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("scheduling fits a 360 px screen without horizontal scrolling", async ({ browser }) => {
  const a = await member(browser, {}, { viewport: { width: 360, height: 740 } });
  const page = a.page;
  await page.goto("http://localhost:4173/?nosw");
  await page.getByTestId("schedule").click();
  const sheet = page.getByTestId("schedule-sheet");
  await expect(sheet.getByTestId("schedule-form")).toBeVisible();
  await noHorizontalOverflow(page);
  const when = await tomorrowAtTen(page);
  await sheet.getByLabel("Title (optional)").fill("A".repeat(120));
  await sheet.getByLabel("Date").fill(when.date);
  await sheet.getByTestId("schedule-create").click();
  await expect(sheet.getByTestId("schedule-done")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("meeting")).toBeVisible();
  await noHorizontalOverflow(page);
  for (const id of ["meeting-join", "meeting-copy", "meeting-ics", "meeting-remove"]) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(360);
  }
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
