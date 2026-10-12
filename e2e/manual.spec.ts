import { expect, test } from "@playwright/test";
import { closeSheets, createRoom, joinRoom, member, say, waitLinks, waitMembers } from "./helpers";

test("manual mode connects two members with codes only, no relay", async ({ browser }) => {
  const offline = { nostr: false, torrent: false, manual: true };
  const a = await member(browser, offline);
  const b = await member(browser, offline);
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);

  await a.page.getByTestId("invite").click();
  await a.page.getByTestId("manual-tab").click();
  await a.page.getByTestId("manual-create").click();
  const offer = await a.page.getByTestId("manual-offer").inputValue({ timeout: 15_000 });
  expect(offer.startsWith("veil1:")).toBe(true);

  await b.page.getByTestId("invite").click();
  await b.page.getByTestId("manual-tab").click();
  await b.page.getByTestId("manual-input").fill(offer);
  await b.page.getByTestId("manual-submit").click();
  const answer = await b.page.getByTestId("manual-answer").inputValue({ timeout: 15_000 });
  expect(answer.startsWith("veil1:")).toBe(true);

  await a.page.getByTestId("manual-input").fill(answer);
  await a.page.getByTestId("manual-submit").click();
  await waitLinks(a.page, 1);
  await waitMembers(a.page, 1);
  await waitMembers(b.page, 1);
  await a.page.keyboard.press("Escape");
  await b.page.keyboard.press("Escape");
  await say(a.page, "no relay involved");
  await expect(b.page.getByTestId("messages")).toContainText("no relay involved", {
    timeout: 15_000,
  });
  await a.ctx.close();
  await b.ctx.close();
});
