import { expect, type Page, test } from "@playwright/test";
import { closeSheets, createRoom, joinRoom, member, waitLinks, waitMembers } from "./helpers";

async function frames(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector("[data-testid=video-remote]") as HTMLVideoElement | null;
    if (!v) return 0;
    const q = v.getVideoPlaybackQuality?.();
    return q ? q.totalVideoFrames : v.currentTime > 0 ? 1 : 0;
  });
}

test("a call delivers end-to-end encrypted video both ways", async ({ browser }) => {
  const a = await member(browser);
  const b = await member(browser);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(a.page, 1);

  await a.page.getByTestId("toggle-cam").click();
  await b.page.getByTestId("toggle-cam").click();
  await b.page.getByTestId("toggle-mic").click();

  for (const p of [a.page, b.page]) {
    await expect(p.getByTestId("video-remote")).toBeVisible();
    await expect.poll(() => frames(p), { timeout: 30_000 }).toBeGreaterThan(10);
    await expect(p.getByTestId("e2ee-badge")).toBeVisible();
  }
  const width = await a.page.evaluate(
    () => (document.querySelector("[data-testid=video-remote]") as HTMLVideoElement).videoWidth,
  );
  expect(width).toBeGreaterThan(0);

  // Turning the camera off stops the video on the other side.
  await b.page.getByTestId("toggle-cam").click();
  await expect(a.page.getByTestId("video-remote")).toHaveCount(0, { timeout: 20_000 });
  expect(a.errors).toEqual([]);
  await a.ctx.close();
  await b.ctx.close();
});
