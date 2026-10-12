import { expect, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  joinRoom,
  type Member,
  member,
  openChat,
  say,
  waitMembers,
} from "./helpers";

test("three members form a mesh and everyone gets every message", async ({ browser }) => {
  const m = [await member(browser), await member(browser), await member(browser)] as const;
  const link = await createRoom(m[0], "Ada");
  await joinRoom(m[1], link, "Bob");
  await joinRoom(m[2], link, "Cy");
  for (const x of m) await waitMembers(x.page, 2);
  await say(m[2].page, "from Cy");
  for (const x of m.slice(0, 2)) {
    await openChat(x.page);
    await expect(x.page.getByTestId("messages")).toContainText("from Cy");
  }
  for (const x of m) await x.ctx.close();
});

test("a 12-member room relays chat everywhere and rotates keys when someone leaves", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const members: Member[] = [];
  const first = await member(browser);
  members.push(first);
  const link = await createRoom(first, "m0");
  for (let i = 1; i < 12; i++) {
    const x = await member(browser);
    await joinRoom(x, link, `m${i}`);
    members.push(x);
  }
  for (const x of members) await closeSheets(x.page);
  for (const x of members) await waitMembers(x.page, 11, 90_000);

  // Partial mesh: nobody needs a direct link to everyone.
  const links = await Promise.all(
    members.map(async (x) => Number(await x.page.getByTestId("room").getAttribute("data-links"))),
  );
  expect(Math.min(...links)).toBeGreaterThan(0);

  const last = members[11] as Member;
  await say(last.page, "hello twelve");
  for (const x of members.slice(0, 11)) {
    await openChat(x.page);
    await expect(x.page.getByTestId("messages")).toContainText("hello twelve", { timeout: 30_000 });
  }

  // m5 leaves: every remaining member rotates its sender key.
  const leaver = members[5] as Member;
  const stay = members.filter((x) => x !== leaver);
  const before = await Promise.all(
    stay.map((x) => x.page.getByTestId("room").getAttribute("data-key-id")),
  );
  await leaver.page.getByTestId("leave").click();
  await leaver.ctx.close();
  for (const [i, x] of stay.entries()) {
    await waitMembers(x.page, 10, 60_000);
    await expect(x.page.getByTestId("room")).not.toHaveAttribute(
      "data-key-id",
      before[i] as string,
      { timeout: 30_000 },
    );
  }
  await say(stay[0]?.page ?? first.page, "after the departure");
  for (const x of stay.slice(1))
    await expect(x.page.getByTestId("messages")).toContainText("after the departure", {
      timeout: 30_000,
    });
  for (const x of stay) await x.ctx.close();
});
