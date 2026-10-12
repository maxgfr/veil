import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  closeSheets,
  createRoom,
  joinRoom,
  member,
  openChat,
  waitLinks,
  waitMembers,
} from "./helpers";

const SIZE = 200 * 1024 * 1024;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

test("a 200 MB file arrives intact, streamed with bounded memory", async ({ browser }) => {
  test.setTimeout(300_000);
  const dir = mkdtempSync(join(tmpdir(), "veil-e2e-"));
  const src = join(dir, "big.bin");
  // Deterministic, incompressible-ish content.
  const buf = Buffer.alloc(SIZE);
  let x = 0x12345678;
  for (let i = 0; i < SIZE; i += 4) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf.writeUInt32LE(x >>> 0, i);
  }
  writeFileSync(src, buf);
  const expected = createHash("sha256").update(buf).digest("hex");

  const a = await member(browser);
  const b = await member(browser);
  // Use private storage (OPFS) instead of the save picker, which cannot be automated.
  await b.ctx.addInitScript(() => {
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const link = await createRoom(a, "Ada");
  await joinRoom(b, link, "Bob");
  await closeSheets(b.page);
  await waitMembers(a.page, 1);
  await waitLinks(b.page, 1);

  await openChat(a.page);
  await openChat(b.page);
  const heapBefore = await b.page.evaluate(
    () =>
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ??
      0,
  );
  await a.page.getByTestId("file-input").setInputFiles(src);
  await b.page.getByTestId("file-accept").click({ timeout: 30_000 });

  let peak = 0;
  const sample = setInterval(async () => {
    const used = await b.page
      .evaluate(
        () =>
          (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0,
      )
      .catch(() => 0);
    peak = Math.max(peak, used);
  }, 500);
  await expect(b.page.locator("[data-testid=file-card][data-state=done]")).toBeVisible({
    timeout: 240_000,
  });
  clearInterval(sample);

  const downloadPromise = b.page.waitForEvent("download");
  await b.page.getByTestId("file-save").click();
  const download = await downloadPromise;
  const saved = join(dir, "received.bin");
  await download.saveAs(saved);
  expect(await sha256File(saved)).toBe(expected);
  // The file never sat in the JS heap: growth stays far below its size.
  if (heapBefore > 0) expect(peak - heapBefore).toBeLessThan(SIZE / 4);
  await a.ctx.close();
  await b.ctx.close();
  rmSync(dir, { recursive: true, force: true });
});
