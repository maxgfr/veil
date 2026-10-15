import { describe, expect, test } from "bun:test";
import { SpeechLoader } from "./speech-loader";

/** A pipeline that counts its disposals. */
class FakePipeline {
  disposed = 0;
  constructor(readonly modelId: string) {}
  async dispose(): Promise<void> {
    this.disposed++;
  }
}

/** An open the test finishes by hand. */
function gate() {
  let open: () => void = () => {};
  let fail: (err: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { done, open, fail };
}

const SMALL = "onnx-community/whisper-small";
const BASE = "onnx-community/whisper-base";
const file = (repo: string) =>
  new URL(`https://huggingface.co/${repo}/resolve/main/onnx/encoder_model_quantized.onnx`);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SpeechLoader", () => {
  test("overlapping loads run one after the other and never share download permission", async () => {
    const loader = new SpeechLoader<FakePipeline>();
    const small = gate();
    const opened: string[] = [];
    const allowed: { small: boolean[]; base: boolean[] } = { small: [], base: [] };
    const first = loader.load(SMALL, true, async () => {
      opened.push(SMALL);
      allowed.small.push(loader.allows(file(SMALL)), loader.allows(file(BASE)));
      await small.done;
      return new FakePipeline(SMALL);
    });
    const second = loader.load(BASE, false, async () => {
      opened.push(BASE);
      // Base may not download, and small's late requests aren't allowed either.
      allowed.base.push(loader.allows(file(BASE)), loader.allows(file(SMALL)));
      return new FakePipeline(BASE);
    });
    await tick();
    expect(opened).toEqual([SMALL]);
    small.open();
    const [a, b] = await Promise.all([first, second]);
    expect(opened).toEqual([SMALL, BASE]);
    expect(allowed).toEqual({ small: [true, false], base: [false, false] });
    // Small was replaced: disposed; base is the one loaded.
    expect(a.disposed).toBe(1);
    expect(b.disposed).toBe(0);
    expect(loader.loaded?.modelId).toBe(BASE);
    expect(loader.loaded?.pipeline).toBe(b);
    // Between loads, nothing may download.
    expect(loader.allows(file(SMALL))).toBe(false);
    expect(loader.allows(file(BASE))).toBe(false);
  });

  test("a failed load leaves nothing loaded, takes its permission with it, and the next runs", async () => {
    const loader = new SpeechLoader<FakePipeline>();
    await loader.load(BASE, false, async () => new FakePipeline(BASE));
    const before = loader.loaded?.pipeline;
    const small = gate();
    const failed = loader.load(SMALL, true, async () => {
      await small.done;
      return new FakePipeline(SMALL);
    });
    const next = loader.load(BASE, false, async () => new FakePipeline(BASE));
    small.fail(new Error("network down"));
    await expect(failed).rejects.toThrow("network down");
    expect(before?.disposed).toBe(1);
    expect(loader.allows(file(SMALL))).toBe(false);
    expect((await next).modelId).toBe(BASE);
    expect(loader.loaded?.modelId).toBe(BASE);
  });

  test("unload disposes the loaded pipeline, in turn with loads", async () => {
    const loader = new SpeechLoader<FakePipeline>();
    const p = await loader.load(BASE, false, async () => new FakePipeline(BASE));
    await loader.unload();
    expect(p.disposed).toBe(1);
    expect(loader.loaded).toBeNull();
    await loader.unload();
    expect(p.disposed).toBe(1);
  });
});
