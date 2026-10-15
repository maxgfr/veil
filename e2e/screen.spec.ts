import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  fakeDisplayMedia,
  joinRoom,
  type Member,
  member,
  noHorizontalOverflow,
  waitLinks,
  waitMembers,
} from "./helpers";

/** Decoded frames of the first video under `loc`. */
async function frames(loc: Locator): Promise<number> {
  return loc.evaluate((v) => {
    const video = v as HTMLVideoElement;
    const q = video.getVideoPlaybackQuality?.();
    return q ? q.totalVideoFrames : video.currentTime > 0 ? 1 : 0;
  });
}

function stage(page: Page): Locator {
  return page.locator(".stage-view");
}

async function chooseLayout(page: Page, layout: "auto" | "grid" | "spotlight"): Promise<void> {
  await page.getByTestId("layout").click();
  await page.getByTestId(`layout-${layout}`).click();
}

/** A and B in a call, both cameras on, A sharing its screen. */
async function sharingCall(
  browser: Parameters<typeof member>[0],
  viewport?: { width: number; height: number },
): Promise<[Member, Member]> {
  const a = await member(browser, {}, viewport ? { viewport } : {});
  const b = await member(browser, { persist: true }, viewport ? { viewport } : {});
  await a.ctx.addInitScript(fakeDisplayMedia);
  for (const m of [a, b])
    m.page.on("console", (msg) => {
      if (msg.type() === "error") m.errors.push(msg.text());
    });
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);
  await a.page.getByTestId("toggle-cam").click();
  await b.page.getByTestId("toggle-cam").click();
  await expect(b.page.getByTestId("video-remote")).toBeVisible({ timeout: 20_000 });
  await a.page.getByTestId("toggle-screen").click();
  await expect(b.page.getByTestId("spotlight-video")).toBeVisible({ timeout: 20_000 });
  return [a, b];
}

test("a shared screen shows in large, beside the sharer's camera, with its own controls", async ({
  browser,
}) => {
  const [a, b] = await sharingCall(browser);

  // B: the screen in large and whole, and A's face still in the strip.
  const big = b.page.getByTestId("spotlight-video");
  await expect(stage(b.page)).toHaveAttribute("data-layout", "spotlight");
  await expect(b.page.getByTestId("spotlight")).toHaveAttribute("aria-label", "Ada's screen");
  await expect(big).toHaveAttribute("data-fit", "contain");
  await expect.poll(() => frames(big), { timeout: 30_000 }).toBeGreaterThan(10);
  const face = b.page.getByTestId("strip").getByTestId("video-remote");
  await expect(face).toBeVisible();
  await expect.poll(() => frames(face), { timeout: 30_000 }).toBeGreaterThan(10);

  await b.page.getByTestId("spotlight-fullscreen").click();
  await expect.poll(() => b.page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await b.page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => b.page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  await b.page.getByTestId("spotlight-fit").click();
  await expect(big).toHaveAttribute("data-fit", "cover");

  // A: Enlarge on B's camera puts B's face in large; a double-click does the same.
  await a.page.getByTestId("tile-remote").getByTestId("tile-enlarge").click();
  await expect(a.page.getByTestId("spotlight")).toHaveAttribute("aria-label", "Bob");
  await expect(a.page.getByTestId("spotlight-pin")).toHaveAttribute("aria-pressed", "true");
  await a.page.getByTestId("tile-self").dblclick();
  await expect(a.page.getByTestId("spotlight")).toHaveAttribute("aria-label", "Ada (you)");
  await a.page.getByTestId("spotlight-pin").click();
  await expect(a.page.getByTestId("spotlight")).toHaveAttribute("aria-label", "Ada (you)'s screen");
  await expect(a.page.getByText("You're sharing your screen")).toBeVisible();

  // B: Grid puts the screen and the cameras at the same size.
  await chooseLayout(b.page, "grid");
  await expect(stage(b.page)).toHaveAttribute("data-layout", "grid");
  const screenTile = b.page.getByTestId("tile-screen");
  await expect(screenTile.getByTestId("video-screen")).toHaveAttribute("data-fit", "contain");
  const sizes = await Promise.all(
    [screenTile, b.page.getByTestId("tile-remote"), b.page.getByTestId("tile-self")].map(
      async (t) => {
        const box = await t.boundingBox();
        expect(box).not.toBeNull();
        return { w: Math.round(box?.width ?? 0), h: Math.round(box?.height ?? 0) };
      },
    ),
  );
  const [first, ...rest] = sizes;
  for (const s of rest) {
    expect(Math.abs(s.w - (first?.w ?? 0))).toBeLessThanOrEqual(1);
    expect(Math.abs(s.h - (first?.h ?? 0))).toBeLessThanOrEqual(1);
  }
  expect(first?.w).toBeGreaterThan(0);
  await chooseLayout(b.page, "spotlight");
  await expect(stage(b.page)).toHaveAttribute("data-layout", "spotlight");

  // A, the sharer, changes the quality on the fly.
  const motion = a.page
    .getByTestId("spotlight")
    .getByRole("button", { name: "Motion", exact: true });
  await motion.click();
  await expect(motion).toHaveAttribute("aria-pressed", "true");

  // Stop sharing: A back to the grid; B (in Spotlight) keeps one tile in large.
  await a.page.getByTestId("stop-sharing").click();
  await expect(stage(a.page)).toHaveAttribute("data-layout", "grid");
  await expect(a.page.getByTestId("tile-screen")).toHaveCount(0);
  await expect(b.page.getByTestId("spotlight")).toHaveAttribute("aria-label", "Ada", {
    timeout: 20_000,
  });
  await expect(stage(b.page)).toHaveAttribute("data-layout", "spotlight");

  // B's layout choice is kept on the device.
  await b.page.reload();
  await b.page.getByTestId("nick").fill("Bob");
  await b.page.getByTestId("enter-room").click();
  await expect(b.page.getByTestId("room")).toBeVisible();
  await closeSheets(b.page);
  await expect(stage(b.page)).toHaveAttribute("data-layout", "spotlight");
  await expect(b.page.getByTestId("spotlight")).toBeVisible();
  await chooseLayout(b.page, "auto");
  await expect(stage(b.page)).toHaveAttribute("data-layout", "grid");

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("stopping the share brings the grid back for everyone", async ({ browser }) => {
  const [a, b] = await sharingCall(browser);
  await expect(stage(a.page)).toHaveAttribute("data-layout", "spotlight");
  await a.page.getByTestId("stop-sharing").click();
  for (const p of [a.page, b.page]) {
    await expect(stage(p)).toHaveAttribute("data-layout", "grid", { timeout: 20_000 });
    await expect(p.getByTestId("spotlight")).toHaveCount(0);
    await expect(p.getByTestId("tile-screen")).toHaveCount(0);
  }
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("a recording made during a share saves a video", async ({ browser }) => {
  const [a, b] = await sharingCall(browser);
  await a.ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await a.page.evaluate(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("rec-indicator")).toBeVisible();
  // Let a few chunks come in.
  await a.page.waitForTimeout(3000);
  await a.page.getByTestId("toggle-record").click();
  await expect(a.page.getByTestId("recording-sheet")).toBeVisible();
  const [file] = await Promise.all([
    a.page.waitForEvent("download"),
    a.page.getByTestId("recording-video").click(),
  ]);
  const video = await readFile(await file.path());
  expect(video.length).toBeGreaterThan(0);
  expect(video.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});

test("the shared screen fits a 360px phone without overflow", async ({ browser }) => {
  const [a, b] = await sharingCall(browser, { width: 360, height: 740 });
  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId("spotlight")).toBeVisible();
    await expect(p.getByTestId("strip")).toBeVisible();
    await noHorizontalOverflow(p);
  }
  await chooseLayout(b.page, "grid");
  await expect(stage(b.page)).toHaveAttribute("data-layout", "grid");
  await noHorizontalOverflow(b.page);
  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
