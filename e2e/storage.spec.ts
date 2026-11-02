import { expect, test } from "@playwright/test";
import { newRoomKey, roomLink } from "../src/crypto/room";
import { BASE, member } from "./helpers";

// Every maxgfr.github.io site shares this origin's storage: no secret may sit there in clear.
const dump = () => JSON.stringify({ ...localStorage, ...sessionStorage });

test("the TURN password is stored sealed, and comes back after a reload", async ({ browser }) => {
  const a = await member(browser, { persist: true });
  const page = a.page;
  await page.goto(`${BASE}/?nosw`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByPlaceholder("turns:turn.example.com:443").fill("turns:turn.example.com:443");
  await page.getByLabel("TURN username").fill("ana");
  await page.getByLabel("TURN credential").fill("hunter2-turn");
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-sheet")).not.toBeVisible();

  const stored = await page.evaluate(dump);
  expect(stored).toContain("turn.example.com");
  expect(stored).not.toContain("hunter2-turn");

  await page.reload();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("TURN credential")).toHaveValue("hunter2-turn");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("settings that cannot be stored say so instead of closing", async ({ browser }) => {
  const a = await member(browser);
  const page = a.page;
  await page.goto(`${BASE}/?nosw`);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
  });
  await page.getByTestId("settings-save").click();
  await expect(page.getByTestId("settings-not-saved")).toBeVisible();
  await expect(page.getByTestId("settings-sheet")).toBeVisible();
  await a.ctx.close();
});

test("meetings kept in clear by an earlier version are sealed on the next visit", async ({
  browser,
}) => {
  const a = await member(browser);
  const page = a.page;
  const link = roomLink(`${BASE}/`, newRoomKey());
  const start = Date.now() + 86_400_000;
  await page.goto(`${BASE}/?nosw`);
  await page.evaluate((m) => localStorage.setItem("veil.meetings.v1", JSON.stringify([m])), {
    id: "a".repeat(32),
    title: "Legacy sync",
    start,
    minutes: 30,
    link,
  });
  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Legacy sync");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("veil.meetings.v1"))).toBeNull();
  const stored = await page.evaluate(dump);
  expect(stored).not.toContain(new URL(link).hash.slice(1));
  expect(stored).not.toContain("Legacy sync");
  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Legacy sync");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});

test("secrets sealed under the previous device key are sealed again, then the old key is deleted", async ({
  browser,
}) => {
  const a = await member(browser, { persist: true });
  const page = a.page;
  const link = roomLink(`${BASE}/`, newRoomKey());
  await page.goto(`${BASE}/?nosw`);
  // What the previous version stored: its own key in `veil-secrets`, the secrets sealed under it.
  await page.evaluate(
    async ({ meeting }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("veil-secrets", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(key, "device-key");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      const seal = async (plain: string, label: string) => {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ad = new TextEncoder().encode(label);
        const ct = new Uint8Array(
          await crypto.subtle.encrypt(
            { name: "AES-GCM", iv, additionalData: ad },
            key,
            new TextEncoder().encode(plain),
          ),
        );
        const all = new Uint8Array([...iv, ...ct]);
        return btoa(String.fromCharCode(...all))
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");
      };
      const settings = JSON.parse(localStorage.getItem("veil.settings.v1") ?? "{}");
      settings.turn = { urls: "turns:turn.example.com:443", username: "ana", credential: "" };
      localStorage.setItem("veil.settings.v1", JSON.stringify(settings));
      localStorage.setItem("veil.turn.v1", await seal("hunter2-turn", "veil.turn.v1"));
      localStorage.setItem(
        "veil.meetings.v2",
        await seal(JSON.stringify([meeting]), "veil.meetings.v2"),
      );
    },
    {
      meeting: {
        id: "b".repeat(32),
        title: "Old sealed sync",
        start: Date.now() + 86_400_000,
        minutes: 30,
        link,
      },
    },
  );
  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Old sealed sync");
  await expect
    .poll(() =>
      page.evaluate(() => [
        localStorage.getItem("veil.meetings.v2"),
        localStorage.getItem("veil.turn.v1"),
      ]),
    )
    .toEqual([null, null]);
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)))
    .not.toContain("veil-secrets");
  const stored = await page.evaluate(dump);
  expect(stored).not.toContain(new URL(link).hash.slice(1));
  expect(stored).not.toContain("Old sealed sync");
  expect(stored).not.toContain("hunter2-turn");

  await page.reload();
  await expect(page.getByTestId("meeting-title")).toHaveText("Old sealed sync");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByLabel("TURN credential")).toHaveValue("hunter2-turn");
  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
