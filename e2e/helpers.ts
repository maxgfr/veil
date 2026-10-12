import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
} from "@playwright/test";

export const BASE = "http://localhost:4173";

export interface TestSettings {
  nostr?: boolean;
  torrent?: boolean;
  manual?: boolean;
}

/** Local relay/tracker only, no STUN: tests never touch the public network. */
export function settingsJson(o: TestSettings = {}): string {
  return JSON.stringify({
    nick: "",
    nostr: { enabled: o.nostr ?? true, relays: [`ws://localhost:4173/relay`] },
    torrent: { enabled: o.torrent ?? false, trackers: [`ws://localhost:4173/tracker`] },
    manual: { enabled: o.manual ?? true },
    stun: [],
    turn: null,
    audioDevice: "",
    videoDevice: "",
  });
}

export interface Member {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

export async function member(
  browser: Browser,
  o: TestSettings = {},
  extra: BrowserContextOptions = {},
): Promise<Member> {
  const isChromium = browser.browserType().name() === "chromium";
  const ctx = await browser.newContext({
    ...(isChromium ? { permissions: ["camera", "microphone"] } : {}),
    acceptDownloads: true,
    ...extra,
  });
  await ctx.addInitScript((s) => {
    localStorage.setItem("veil.settings.v1", s);
  }, settingsJson(o));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|TrustedScript|Trusted Types/i.test(m.text())
    )
      errors.push(m.text());
  });
  return { ctx, page, errors };
}

/** Creates a room from the home screen and returns its link. */
export async function createRoom(m: Member, nick: string): Promise<string> {
  await m.page.goto(`${BASE}/?nosw`);
  await m.page.getByTestId("new-room").click();
  await m.page.getByTestId("nick").fill(nick);
  await m.page.getByTestId("enter-room").click();
  await expect(m.page.getByTestId("room")).toBeVisible();
  await closeSheets(m.page);
  return m.page.url();
}

export async function joinRoom(m: Member, link: string, nick: string): Promise<void> {
  await m.page.goto(link);
  await m.page.getByTestId("nick").fill(nick);
  await m.page.getByTestId("enter-room").click();
  await expect(m.page.getByTestId("room")).toBeVisible();
}

/** The invite sheet opens by itself when alone: dismiss any open dialog. */
export async function closeSheets(page: Page): Promise<void> {
  await page.waitForTimeout(1400);
  for (let i = 0; i < 3 && (await page.locator("dialog[open]").count()) > 0; i++)
    await page.keyboard.press("Escape");
}

export async function waitMembers(page: Page, n: number, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("room")).toHaveAttribute("data-members", String(n), { timeout });
}

export async function waitLinks(page: Page, atLeast: number, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => Number(await page.getByTestId("room").getAttribute("data-links")), {
      timeout,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

export async function openChat(page: Page): Promise<void> {
  if ((await page.getByTestId("composer").count()) === 0)
    await page.getByTestId("toggle-chat").click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

export async function say(page: Page, text: string): Promise<void> {
  await openChat(page);
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}
