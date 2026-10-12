import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { closeSheets, createRoom, joinRoom, member, waitLinks, waitMembers } from "./helpers";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

test("a files room has no camera or microphone, and moves files through its Files view", async ({
  browser,
}) => {
  const a = await member(browser);
  const b = await member(browser);
  for (const m of [a, b]) {
    await m.ctx.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
  }
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByTestId("send-files").click();
  // The lobby asks for nothing but a name.
  await expect(a.page.getByTestId("lobby-mic")).toHaveCount(0);
  await a.page.getByTestId("nick").fill("Ada");
  await a.page.getByTestId("enter-room").click();
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-mode", "files");
  await closeSheets(a.page);
  const link = a.page.url();
  expect(link).toContain("#files/");
  for (const id of ["toggle-mic", "toggle-cam"])
    await expect(a.page.getByTestId(id)).toHaveCount(0);
  await expect(a.page.getByTestId("dropzone")).toBeVisible();

  await joinRoom(b, link, "Bob");
  await expect(b.page.getByTestId("room")).toHaveAttribute("data-mode", "files");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);

  const data = Buffer.from(Array.from({ length: 1024 * 1024 + 9 }, (_, i) => (i * 11) & 255));
  await a.page
    .getByTestId("files-input")
    .setInputFiles({ name: "notes.bin", mimeType: "application/octet-stream", buffer: data });
  const panel = b.page.getByTestId("files-panel");
  await expect(panel.getByText("From Ada")).toBeVisible({ timeout: 20_000 });
  await panel.getByTestId("file-accept").click();
  await expect(panel.locator("[data-testid=file-card][data-state=done]")).toBeVisible({
    timeout: 30_000,
  });
  const download = b.page.waitForEvent("download");
  await panel.getByTestId("file-save").click();
  expect(sha(readFileSync(await (await download).path()))).toBe(sha(data));
  await expect(a.page.getByTestId("files-panel").getByTestId("file-card")).toContainText(
    "Delivered to 1",
  );
  await a.ctx.close();
  await b.ctx.close();
});

test("in a call room, an offered file shows a badge and the Files panel lists it", async ({
  browser,
}) => {
  const a = await member(browser);
  const b = await member(browser);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);
  await a.page.getByTestId("toggle-files").click();
  await a.page.getByTestId("files-input").setInputFiles({
    name: "slides.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(2048, 1),
  });
  // Bob is looking at the chat: the Files button gets a badge.
  await expect(b.page.getByTestId("toggle-files").locator(".badge")).toHaveText("1", {
    timeout: 20_000,
  });
  await b.page.getByTestId("toggle-files").click();
  await expect(b.page.getByTestId("files-panel")).toContainText("slides.pdf");
  await expect(b.page.getByTestId("toggle-files").locator(".badge")).toHaveCount(0);
  await a.ctx.close();
  await b.ctx.close();
});
