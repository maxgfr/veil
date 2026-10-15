import { describe, expect, test } from "bun:test";
import { AiEngine, type WorkerLike } from "./engine";
import type { AiRequest, AiResponse } from "./protocol";

const QWEN = "Qwen3.5-2B-q4f16_1-MLC";
const GEMMA = "gemma-4-E2B-it-q4f16_1-MLC";

type Listener = (event: { data?: unknown; message?: string }) => void;

/** A worker the test answers by hand. */
class FakeWorker implements WorkerLike {
  sent: AiRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  #listeners: Record<string, Listener[]> = { message: [], error: [] };

  postMessage(message: AiRequest, transfer: Transferable[] = []): void {
    this.sent.push(message);
    this.transfers.push(transfer);
  }
  addEventListener(type: "message" | "error", listener: Listener): void {
    this.#listeners[type]?.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(res: AiResponse | Record<string, unknown>): void {
    for (const l of this.#listeners.message ?? []) l({ data: res });
  }
  crash(message: string): void {
    for (const l of this.#listeners.error ?? []) l({ message });
  }
  last(): AiRequest {
    const r = this.sent.at(-1);
    if (!r) throw new Error("nothing sent");
    return r;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const engine = new AiEngine({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  const worker = () => {
    const w = workers.at(-1);
    if (!w) throw new Error("no worker");
    return w;
  };
  return { engine, workers, worker };
}

async function loaded(modelId = QWEN) {
  const s = setup();
  const p = s.engine.load(modelId);
  s.worker().reply({ id: s.worker().last().id, kind: "ok" });
  await p;
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("AiEngine", () => {
  test("starts no worker until asked; no model, no budget", () => {
    const { engine, workers } = setup();
    expect(workers.length).toBe(0);
    expect(engine.modelId).toBeNull();
    expect(engine.ready).toBe(false);
    expect(engine.contextBudget).toBe(0);
  });

  test("load reports progress, then the model is ready with 75% of its context", async () => {
    const { engine, worker } = setup();
    const progress: number[] = [];
    const p = engine.load(QWEN, (x) => progress.push(x.progress));
    expect(engine.modelId).toBe(QWEN);
    expect(engine.ready).toBe(false);
    const req = worker().last();
    expect(req).toEqual({ id: req.id, op: "load", modelId: QWEN });
    worker().reply({ id: req.id, kind: "progress", progress: { progress: 0.5, text: "half" } });
    worker().reply({ id: req.id, kind: "progress", progress: { progress: 1, text: "done" } });
    worker().reply({ id: req.id, kind: "ok" });
    await p;
    expect(progress).toEqual([0.5, 1]);
    expect(engine.ready).toBe(true);
    expect(engine.contextBudget).toBe(3072);
    // Loading it again is a no-op.
    await engine.load(QWEN);
    expect(worker().sent.length).toBe(1);
  });

  test("a failed load leaves no model", async () => {
    const { engine, worker } = setup();
    const p = engine.load(QWEN);
    worker().reply({
      id: worker().last().id,
      kind: "error",
      error: { name: "Error", message: "no GPU" },
    });
    await expect(p).rejects.toThrow("no GPU");
    expect(engine.modelId).toBeNull();
    expect(engine.ready).toBe(false);
  });

  test("chat streams deltas and resolves the full text; the schema goes along", async () => {
    const { engine, worker } = await loaded();
    const deltas: string[] = [];
    const schema = { type: "object", properties: { summary: { type: "string" } } };
    const p = engine.chat([{ role: "user", content: "hi" }], {
      schema,
      maxTokens: 50,
      temperature: 0.2,
      onDelta: (d) => deltas.push(d),
    });
    const req = worker().last();
    expect(req).toEqual({
      id: req.id,
      op: "chat",
      messages: [{ role: "user", content: "hi" }],
      schema,
      maxTokens: 50,
      temperature: 0.2,
    });
    worker().reply({ id: req.id, kind: "delta", delta: "Hel" });
    worker().reply({ id: req.id, kind: "delta", delta: "lo" });
    worker().reply({ id: req.id, kind: "text", text: "Hello" });
    expect(await p).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  test("chat without a model refuses", async () => {
    const { engine } = setup();
    await expect(engine.chat([{ role: "user", content: "hi" }])).rejects.toThrow(/no model/);
  });

  test("an abort tells the worker and rejects at once; late answers are ignored", async () => {
    const { engine, worker } = await loaded();
    const ctrl = new AbortController();
    const deltas: string[] = [];
    const p = engine.chat([{ role: "user", content: "hi" }], {
      signal: ctrl.signal,
      onDelta: (d) => deltas.push(d),
    });
    const chat = worker().last();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().last()).toEqual({ id: worker().last().id, op: "abort", target: chat.id });
    worker().reply({ id: chat.id, kind: "delta", delta: "late" });
    expect(deltas).toEqual([]);
    // An already aborted signal sends nothing.
    const before = worker().sent.length;
    await expect(
      engine.chat([{ role: "user", content: "x" }], { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().sent.length).toBe(before);
  });

  test("cancel terminates the worker; a later load starts a new one", async () => {
    const { engine, workers } = setup();
    const p = engine.load(QWEN);
    engine.cancel();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]?.terminated).toBe(true);
    expect(engine.modelId).toBeNull();
    const again = engine.load(QWEN);
    expect(workers.length).toBe(2);
    workers[1]?.reply({ id: workers[1].last().id, kind: "ok" });
    await again;
    expect(engine.ready).toBe(true);
  });

  test("a crash fails what is pending, is reported, and the next call gets a new worker", async () => {
    const { engine, workers, worker } = await loaded();
    const crashes: string[] = [];
    const off = engine.onCrash((e) => crashes.push(e.message));
    const p = engine.chat([{ role: "user", content: "hi" }]);
    worker().crash("GPU device lost");
    await expect(p).rejects.toThrow("GPU device lost");
    expect(crashes).toEqual(["GPU device lost"]);
    expect(workers[0]?.terminated).toBe(true);
    expect(engine.ready).toBe(false);
    expect(engine.modelId).toBeNull();
    off();
    const state = engine.cacheState(QWEN);
    expect(workers.length).toBe(2);
    workers[1]?.crash("again");
    await expect(state).rejects.toThrow("again");
    expect(crashes).toEqual(["GPU device lost"]);
  });

  test("messages that are not ours are ignored", async () => {
    const { engine, worker } = setup();
    const p = engine.cacheState(QWEN);
    const req = worker().last();
    worker().reply({ hello: "extension" });
    worker().reply({ id: req.id, kind: "bogus" });
    await tick();
    worker().reply({
      id: req.id,
      kind: "state",
      state: { cached: true, complete: false, bytes: 10 },
    });
    expect(await p).toEqual({ cached: true, complete: false, bytes: 10 });
    expect(req).toEqual({ id: req.id, op: "cacheState", modelId: QWEN });
  });

  test("transcribe sends a copy of the samples, transferred, with the language", async () => {
    const { engine, worker } = await loaded(GEMMA);
    const pcm = new Float32Array([0.1, 0.2]);
    const p = engine.transcribe(pcm, { lang: "fr" });
    const req = worker().last();
    expect(req.op).toBe("transcribe");
    if (req.op !== "transcribe") throw new Error("unreachable");
    expect([...req.pcm]).toEqual([...pcm]);
    expect(req.pcm).not.toBe(pcm);
    expect(req.lang).toBe("fr");
    expect(worker().transfers.at(-1)).toEqual([req.pcm.buffer]);
    worker().reply({ id: req.id, kind: "text", text: "bonjour" });
    expect(await p).toBe("bonjour");
    expect(pcm.length).toBe(2);
  });

  test("remove of the loaded model unloads it; unload resets", async () => {
    const { engine, worker } = await loaded();
    const p = engine.remove(QWEN);
    expect(engine.ready).toBe(false);
    expect(engine.modelId).toBeNull();
    worker().reply({ id: worker().last().id, kind: "ok" });
    await p;
    const s = await loaded();
    const u = s.engine.unload();
    expect(s.engine.ready).toBe(false);
    expect(s.worker().last().op).toBe("unload");
    s.worker().reply({ id: s.worker().last().id, kind: "ok" });
    await u;
  });

  test("loading another model replaces the first", async () => {
    const { engine, worker } = await loaded();
    const p = engine.load(GEMMA);
    expect(engine.modelId).toBe(GEMMA);
    expect(engine.ready).toBe(false);
    worker().reply({ id: worker().last().id, kind: "ok" });
    await p;
    expect(engine.ready).toBe(true);
    expect(engine.contextBudget).toBe(3072);
  });
});
