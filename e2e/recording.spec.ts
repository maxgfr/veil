import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { closeSheets, createRoom, joinRoom, member, waitLinks, waitMembers } from "./helpers";

/**
 * No save picker (files go to private storage), and an on-device speech
 * recognizer that hears "hello from ada" shortly after it starts.
 */
function fakeSpeech(): void {
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  class FakeRecognition {
    static available = async () => "available";
    static install = async () => true;
    continuous = false;
    interimResults = false;
    lang = "";
    processLocally = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    private timer: ReturnType<typeof setTimeout> | undefined;
    start(): void {
      this.timer = setTimeout(() => {
        const result = Object.assign([{ transcript: "hello from ada" }], { isFinal: true });
        this.onresult?.({ resultIndex: 0, results: [result] });
      }, 300);
    }
    stop(): void {
      clearTimeout(this.timer);
      this.onend?.();
    }
    abort(): void {
      this.stop();
    }
  }
  (window as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
}

async function download(page: Page, testid: string): Promise<Buffer> {
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId(testid).click(),
  ]);
  const path = await file.path();
  return readFile(path);
}

test("a recording gives everyone a REC indicator and saves video, audio and a transcript", async ({
  browser,
}) => {
  const a = await member(browser);
  const b = await member(browser);
  await a.ctx.addInitScript(fakeSpeech);
  await b.ctx.addInitScript(fakeSpeech);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);

  await a.page.getByTestId("toggle-cam").click();
  await a.page.getByTestId("toggle-mic").click();
  await b.page.getByTestId("toggle-cam").click();
  await expect(a.page.getByTestId("video-remote")).toBeVisible({ timeout: 20_000 });

  await a.page.getByTestId("toggle-record").click();
  await expect(b.page.getByTestId("rec-indicator")).toHaveAttribute(
    "aria-label",
    "Ada is recording",
  );
  await expect(b.page.getByText("Ada started recording")).toBeVisible();
  await expect(a.page.getByTestId("rec-indicator")).toBeVisible();

  // Let a few chunks and the caption come in.
  await a.page.waitForTimeout(3000);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  await expect(b.page.getByTestId("rec-indicator")).toHaveCount(0, { timeout: 20_000 });

  const video = await download(a.page, "recording-video");
  expect(video.length).toBeGreaterThan(0);
  expect(video.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  const audio = await download(a.page, "recording-audio");
  expect(audio.length).toBeGreaterThan(0);
  const transcript = await download(a.page, "recording-transcript");
  expect(transcript.toString("utf8")).toContain("Ada: hello from ada");

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a new recording releases the previous one's files, and the new files still work", async ({
  browser,
}) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeSpeech);
  await a.ctx.addInitScript(() => {
    const w = window as { revoked?: string[] };
    const revoke = URL.revokeObjectURL.bind(URL);
    w.revoked = [];
    URL.revokeObjectURL = (url) => {
      w.revoked?.push(url);
      revoke(url);
    };
  });
  await createRoom(a, "Ada");
  await closeSheets(a.page);
  await a.page.getByTestId("toggle-cam").click();
  await a.page.getByTestId("toggle-mic").click();
  const revoked = () => a.page.evaluate(() => (window as { revoked?: string[] }).revoked ?? []);

  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(1500);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  const first = await a.page.getByTestId("recording-video").getAttribute("href");
  expect(first).toMatch(/^blob:/);
  expect(await revoked()).not.toContain(first);
  await a.page.keyboard.press("Escape");
  await expect(a.page.getByTestId("recording-sheet")).toBeHidden();

  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(1500);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  const second = await a.page.getByTestId("recording-video").getAttribute("href");
  expect(second).not.toBe(first);
  expect(await revoked()).toContain(first);
  expect(await revoked()).not.toContain(second);
  const video = await download(a.page, "recording-video");
  expect(video.subarray(0, 4).toString("hex")).toBe("1a45dfa3");

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("leaving while the recording is stopping still offers its files", async ({ browser }) => {
  const a = await member(browser);
  await a.ctx.addInitScript(fakeSpeech);
  await createRoom(a, "Ada");
  await closeSheets(a.page);
  await a.page.getByTestId("toggle-cam").click();
  await a.page.getByTestId("toggle-mic").click();

  await a.page.getByTestId("toggle-record").click();
  await a.page.waitForTimeout(1500);
  // Stop, then Leave before the files are written.
  await a.page.evaluate(() => {
    for (const id of ["toggle-record", "leave"])
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.click();
  });
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  await expect(a.page.getByTestId("recording-leave")).toBeVisible();
  await expect(a.page.getByTestId("recording-video")).toHaveAttribute("href", /^blob:/);
  await expect(a.page.getByTestId("recording-audio")).toHaveAttribute("href", /^blob:/);
  const video = await download(a.page, "recording-video");
  expect(video.length).toBeGreaterThan(0);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
