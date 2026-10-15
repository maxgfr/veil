import { expect, type Page, test } from "@playwright/test";
import { closeSheets, member } from "./helpers";

/** The deviceId of a fake input, by label. */
const idOf = (page: Page, label: string) =>
  page.evaluate(
    async (l) =>
      (await navigator.mediaDevices.enumerateDevices()).find((d) => d.label === l)?.deviceId ?? "",
    label,
  );

test("settings list the microphones and test the selected one", async ({ browser }) => {
  const a = await member(browser);
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByRole("button", { name: "Settings" }).click();
  const devices = a.page.getByTestId("device-settings");
  await expect(devices).toBeVisible();
  await devices.getByTestId("mic-test").click();
  // The fake microphone beeps about once a second, silent in between: record the peak over 3 s.
  await expect(a.page.getByTestId("mic-level")).toBeVisible();
  const peak = await a.page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const el = document.querySelector("[data-testid=mic-level]") as Element;
        let max = 0;
        const obs = new MutationObserver(() => {
          max = Math.max(max, Number(el.getAttribute("data-level")));
        });
        obs.observe(el, { attributes: true });
        setTimeout(() => {
          obs.disconnect();
          resolve(max);
        }, 3000);
      }),
  );
  expect(peak).toBeGreaterThan(2);
  const options = await a.page.getByTestId("select-mic").locator("option").allTextContents();
  expect(options).toEqual(["System default", "Fake Audio Input 1", "Fake Audio Input 2"]);
  await a.page.getByTestId("select-mic").selectOption({ label: "Fake Audio Input 2" });
  await expect(a.page.getByTestId("mic-level")).toBeVisible();
  const saved = await a.page.evaluate(
    () => JSON.parse(localStorage.getItem("veil.settings.v1") ?? "{}").audioDevice,
  );
  expect(saved).toBe(await idOf(a.page, "Fake Audio Input 2"));
  await a.ctx.close();
});

test("the microphone chosen in the lobby is the one used in the room", async ({ browser }) => {
  const a = await member(browser);
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByTestId("new-room").click();
  await a.page.getByTestId("lobby-mic").click();
  await a.page.getByTestId("select-mic").selectOption({ label: "Fake Audio Input 1" });
  await expect(a.page.getByTestId("mic-level")).toBeVisible();
  await a.page.getByTestId("enter-room").click();
  await expect(a.page.getByTestId("room")).toHaveAttribute(
    "data-mic-device",
    await idOf(a.page, "Fake Audio Input 1"),
  );
  await a.ctx.close();
});

test("turning the microphone on in a room uses the selected device, and switching applies live", async ({
  browser,
  browserName,
}) => {
  const a = await member(browser);
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByTestId("new-room").click();
  await a.page.getByTestId("enter-room").click();
  await expect(a.page.getByTestId("room")).toBeVisible();
  await closeSheets(a.page);
  const input1 = await idOf(a.page, "Fake Audio Input 1");
  const input2 = await idOf(a.page, "Fake Audio Input 2");

  // Choose before the microphone is on: turning it on must honour the choice (it used the default).
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await a.page.getByTestId("mic-test").click();
  await a.page.getByTestId("select-mic").selectOption({ label: "Fake Audio Input 2" });
  await a.page.keyboard.press("Escape");
  await a.page.getByTestId("toggle-mic").click();
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-mic-device", input2);

  // Switching while the microphone is on applies right away.
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  await a.page.getByTestId("select-mic").selectOption({ label: "Fake Audio Input 1" });
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-mic-device", input1);

  // "System default" follows the system's default microphone (Chromium's "default" alias),
  // not the device picked last on this site.
  await a.page.getByTestId("select-mic").selectOption({ label: "System default" });
  if (browserName === "chromium")
    await expect(a.page.getByTestId("room")).toHaveAttribute("data-mic-device", "default");
  await a.ctx.close();
});

test("a saved microphone that isn't listed can be switched back to the system default", async ({
  browser,
}) => {
  const a = await member(browser);
  // Runs after `member`'s own settings: a microphone this browser doesn't list.
  await a.ctx.addInitScript(() => {
    const key = "veil.settings.v1";
    const s = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...s, audioDevice: "gone-mic" }));
  });
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByRole("button", { name: "Settings" }).click();
  const select = a.page.getByTestId("select-mic");
  await expect(select).toHaveValue("gone-mic");
  await expect(select.locator("option:checked")).toHaveText("Microphone chosen earlier");

  await select.selectOption({ label: "System default" });
  const saved = await a.page.evaluate(
    () => JSON.parse(localStorage.getItem("veil.settings.v1") ?? "{}").audioDevice,
  );
  expect(saved).toBe("");
  await a.ctx.close();
});

test("strong noise reduction runs RNNoise on the microphone, applied live", async ({ browser }) => {
  const a = await member(browser);
  const warnings: string[] = [];
  a.page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await a.page.goto("http://localhost:4173/?nosw");
  await a.page.getByTestId("new-room").click();
  await a.page.getByTestId("enter-room").click();
  await expect(a.page.getByTestId("room")).toBeVisible();
  await closeSheets(a.page);
  await a.page.getByTestId("toggle-mic").click();
  await expect(a.page.getByTestId("toggle-mic")).toHaveAttribute("aria-pressed", "true");
  const device = await a.page.getByTestId("room").getAttribute("data-mic-device");

  // Turned on during the call: its files load only now, and the microphone reopens through it.
  const wasm = a.page.waitForRequest(/\/assets\/noise\/rnnoise(_simd)?-\w+\.wasm$/);
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-noise-reduction", "false");
  await a.page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = a.page.getByTestId("toggle-noise-reduction");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await wasm;
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-noise-reduction", "true");
  await a.page.keyboard.press("Escape");
  await expect(a.page.getByText("Strong noise reduction couldn't start")).toHaveCount(0);
  // Still the same device underneath.
  await expect(a.page.getByTestId("room")).toHaveAttribute("data-mic-device", device ?? "");
  await a.page.waitForTimeout(1000);
  expect(warnings.filter((w) => w.includes("noise reduction failed"))).toEqual([]);
  const saved = await a.page.evaluate(
    () => JSON.parse(localStorage.getItem("veil.settings.v1") ?? "{}").noiseReduction,
  );
  expect(saved).toBe(true);

  expect(a.errors).toEqual([]);
  await a.ctx.close();
});
