import { expect, test } from "@playwright/test";
import { closeSheets, member, noHorizontalOverflow } from "./helpers";

test("home, lobby and room fit a phone screen without horizontal scrolling", async ({
  browser,
}, info) => {
  // Contexts created by hand need the project's device emulation re-applied.
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = info.project.use;
  const a = await member(
    browser,
    {},
    {
      ...(viewport ? { viewport } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(deviceScaleFactor ? { deviceScaleFactor } : {}),
      ...(isMobile !== undefined ? { isMobile } : {}),
      ...(hasTouch !== undefined ? { hasTouch } : {}),
    },
  );
  const page = a.page;
  await page.goto("http://localhost:4173/?nosw");
  await expect(page.getByTestId("new-room")).toBeVisible();
  await noHorizontalOverflow(page);
  const box = await page.getByTestId("new-room").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page.getByTestId("new-room").click();
  await expect(page.getByTestId("enter-room")).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByTestId("nick").fill("Phone");
  await page.getByTestId("enter-room").click();
  await expect(page.getByTestId("room")).toBeVisible();
  await noHorizontalOverflow(page);
  await expect(page.getByTestId("share-sheet")).toBeVisible();
  await noHorizontalOverflow(page);
  await closeSheets(page);
  await page.getByTestId("toggle-chat").click();
  await expect(page.getByTestId("composer")).toBeVisible();
  await noHorizontalOverflow(page);
  for (const id of ["toggle-mic", "toggle-cam", "toggle-chat", "leave"]) {
    const b = await page.getByTestId(id).boundingBox();
    expect(b?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await a.ctx.close();
});
