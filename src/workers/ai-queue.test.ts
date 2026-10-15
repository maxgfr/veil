import { describe, expect, test } from "bun:test";
import { GenerationQueue } from "./ai-queue";

/** A generation the test finishes by hand. */
function gate() {
  let open: (v: string) => void = () => {};
  const done = new Promise<string>((r) => {
    open = r;
  });
  return { done, open };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("GenerationQueue", () => {
  test("runs requests one at a time, in order", async () => {
    const q = new GenerationQueue(async () => {});
    const order: string[] = [];
    const a = gate();
    const pa = q.run(1, async () => {
      order.push("a");
      return a.done;
    });
    const pb = q.run(2, async () => {
      order.push("b");
      return "b";
    });
    await tick();
    expect(order).toEqual(["a"]);
    a.open("a");
    expect(await pa).toBe("a");
    expect(await pb).toBe("b");
    expect(order).toEqual(["a", "b"]);
  });

  test("aborting a queued request answers it at once and leaves the running one alone", async () => {
    let interrupts = 0;
    const q = new GenerationQueue(async () => {
      interrupts++;
    });
    const summary = gate();
    const ps = q.run(1, () => summary.done);
    let transcribed = false;
    const pt = q.run(2, async () => {
      transcribed = true;
      return "t";
    });
    await tick();
    await q.abort(2);
    await expect(pt).rejects.toMatchObject({ name: "AbortError" });
    expect(interrupts).toBe(0);
    expect(q.wanted(1)).toBe(true);
    summary.open("full summary");
    expect(await ps).toBe("full summary");
    await tick();
    expect(transcribed).toBe(false);
  });

  test("aborting the running request interrupts the engine and the next one runs", async () => {
    let interrupts = 0;
    const q = new GenerationQueue(async () => {
      interrupts++;
    });
    const a = gate();
    const pa = q.run(1, async () => {
      const text = await a.done;
      if (!q.wanted(1)) throw new DOMException("Aborted", "AbortError");
      return text;
    });
    const pb = q.run(2, async () => "b");
    await tick();
    await q.abort(1);
    expect(interrupts).toBe(1);
    expect(q.wanted(1)).toBe(false);
    a.open("cut");
    await expect(pa).rejects.toMatchObject({ name: "AbortError" });
    expect(await pb).toBe("b");
  });

  test("aborting an unknown or finished request does nothing", async () => {
    let interrupts = 0;
    const q = new GenerationQueue(async () => {
      interrupts++;
    });
    expect(await q.run(1, async () => "x")).toBe("x");
    await q.abort(1);
    await q.abort(42);
    expect(interrupts).toBe(0);
  });
});
