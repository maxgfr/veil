import { describe, expect, test } from "bun:test";
import type { SpeechRequest, SpeechResponse } from "./protocol";
import { SpeechEngine, type SpeechWorkerLike } from "./speech";
import { WHISPER_BASE, WHISPER_SMALL } from "./speechModels";

type Listener = (event: { data?: unknown; message?: string }) => void;

/** A worker the test answers by hand. */
class FakeWorker implements SpeechWorkerLike {
  sent: SpeechRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  #listeners: Record<string, Listener[]> = { message: [], error: [] };

  postMessage(message: SpeechRequest, transfer: Transferable[] = []): void {
    this.sent.push(message);
    this.transfers.push(transfer);
  }
  addEventListener(type: "message" | "error", listener: Listener): void {
    this.#listeners[type]?.push(listener);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(res: SpeechResponse | Record<string, unknown>): void {
    for (const l of this.#listeners.message ?? []) l({ data: res });
  }
  crash(message: string): void {
    for (const l of this.#listeners.error ?? []) l({ message });
  }
  last(): SpeechRequest {
    const r = this.sent.at(-1);
    if (!r) throw new Error("nothing sent");
    return r;
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const engine = new SpeechEngine({
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

async function loaded(modelId = WHISPER_BASE) {
  const s = setup();
  const p = s.engine.load(modelId, { download: false });
  s.worker().reply({ id: s.worker().last().id, kind: "ok" });
  await p;
  return s;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SpeechEngine", () => {
  test("starts no worker until asked", () => {
    const { engine, workers } = setup();
    expect(workers.length).toBe(0);
    expect(engine.modelId).toBeNull();
    expect(engine.ready).toBe(false);
  });

  test("load says whether it may download, reports progress, then the model is ready", async () => {
    const { engine, worker } = setup();
    const progress: number[] = [];
    const p = engine.load(WHISPER_BASE, {
      download: true,
      onProgress: (x) => progress.push(x.progress),
    });
    expect(engine.modelId).toBe(WHISPER_BASE);
    expect(engine.ready).toBe(false);
    const req = worker().last();
    expect(req).toEqual({ id: req.id, op: "load", modelId: WHISPER_BASE, download: true });
    worker().reply({ id: req.id, kind: "progress", progress: { progress: 0.5, text: "40 MB" } });
    worker().reply({ id: req.id, kind: "progress", progress: { progress: 1, text: "80 MB" } });
    worker().reply({ id: req.id, kind: "ok" });
    await p;
    expect(progress).toEqual([0.5, 1]);
    expect(engine.ready).toBe(true);
    // Loading it again is a no-op; concurrent loads share one request.
    await engine.load(WHISPER_BASE, { download: false });
    expect(worker().sent.length).toBe(1);
  });

  test("a failed load leaves no model", async () => {
    const { engine, worker } = setup();
    const p = engine.load(WHISPER_BASE, { download: false });
    worker().reply({
      id: worker().last().id,
      kind: "error",
      error: { name: "Error", message: "config.json is not downloaded" },
    });
    await expect(p).rejects.toThrow("config.json is not downloaded");
    expect(engine.modelId).toBeNull();
    expect(engine.ready).toBe(false);
  });

  test("transcribe sends a copy of the samples, transferred, in Whisper's language code", async () => {
    const { engine, worker } = await loaded();
    const pcm = new Float32Array([0.1, 0.2]);
    const p = engine.transcribe(pcm, { lang: "fr-FR" });
    const req = worker().last();
    if (req.op !== "transcribe") throw new Error(`sent ${req.op}`);
    expect([...req.pcm]).toEqual([...pcm]);
    expect(req.pcm).not.toBe(pcm);
    expect(req.language).toBe("fr");
    expect(worker().transfers.at(-1)).toEqual([req.pcm.buffer]);
    worker().reply({ id: req.id, kind: "text", text: "bonjour" });
    expect(await p).toBe("bonjour");
    expect(pcm.length).toBe(2);
  });

  test("a language Whisper doesn't know is left out, for it to detect", async () => {
    const { engine, worker } = await loaded();
    void engine.transcribe(new Float32Array(1), { lang: "zu-ZA" });
    const req = worker().last();
    expect(req.op).toBe("transcribe");
    expect("language" in req).toBe(false);
  });

  test("transcribe without a model refuses", async () => {
    const { engine } = setup();
    await expect(engine.transcribe(new Float32Array(1))).rejects.toThrow(/no speech model/);
  });

  test("an abort tells the worker and rejects at once; a late answer is ignored", async () => {
    const { engine, worker } = await loaded();
    const ctrl = new AbortController();
    const p = engine.transcribe(new Float32Array(1), { lang: "en", signal: ctrl.signal });
    const req = worker().last();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().last()).toEqual({ id: worker().last().id, op: "abort", target: req.id });
    worker().reply({ id: req.id, kind: "text", text: "late" });
    await tick();
    // An already aborted signal sends nothing.
    const before = worker().sent.length;
    await expect(
      engine.transcribe(new Float32Array(1), { signal: ctrl.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(worker().sent.length).toBe(before);
  });

  test("cancel terminates the worker; a later load starts a new one", async () => {
    const { engine, workers } = setup();
    const p = engine.load(WHISPER_SMALL, { download: true });
    engine.cancel();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]?.terminated).toBe(true);
    expect(engine.modelId).toBeNull();
    const again = engine.load(WHISPER_SMALL, { download: true });
    expect(workers.length).toBe(2);
    workers[1]?.reply({ id: workers[1].last().id, kind: "ok" });
    await again;
    expect(engine.ready).toBe(true);
  });

  test("a load of another model while one runs cancels the first: only the second ends up loaded", async () => {
    const { engine, workers } = setup();
    const first = engine.load(WHISPER_SMALL, { download: true });
    const second = engine.load(WHISPER_BASE, { download: true });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0]?.terminated).toBe(true);
    expect(workers.length).toBe(2);
    const fresh = workers[1];
    if (!fresh) throw new Error("no second worker");
    expect(fresh.sent).toEqual([
      { id: fresh.last().id, op: "load", modelId: WHISPER_BASE, download: true },
    ]);
    // A late answer of the first worker changes nothing.
    workers[0]?.reply({ id: workers[0].last().id, kind: "ok" });
    expect(engine.modelId).toBe(WHISPER_BASE);
    expect(engine.ready).toBe(false);
    workers[1]?.reply({ id: workers[1].last().id, kind: "ok" });
    await second;
    expect(engine.modelId).toBe(WHISPER_BASE);
    expect(engine.ready).toBe(true);
  });

  test("a crash fails what is pending, is reported, and the next call gets a new worker", async () => {
    const { engine, workers, worker } = await loaded();
    const crashes: string[] = [];
    const off = engine.onCrash((e) => crashes.push(e.message));
    const p = engine.transcribe(new Float32Array(1));
    worker().crash("out of memory");
    await expect(p).rejects.toThrow("out of memory");
    expect(crashes).toEqual(["out of memory"]);
    expect(workers[0]?.terminated).toBe(true);
    expect(engine.ready).toBe(false);
    expect(engine.modelId).toBeNull();
    off();
    const state = engine.cacheState(WHISPER_BASE);
    expect(workers.length).toBe(2);
    workers[1]?.crash("again");
    await expect(state).rejects.toThrow("again");
    expect(crashes).toEqual(["out of memory"]);
  });

  test("messages that are not ours are ignored", async () => {
    const { engine, worker } = setup();
    const p = engine.cacheState(WHISPER_BASE);
    const req = worker().last();
    worker().reply({ hello: "extension" });
    worker().reply({ id: req.id, kind: "delta", delta: "x" });
    await tick();
    worker().reply({
      id: req.id,
      kind: "state",
      state: { cached: true, complete: false, bytes: 10 },
    });
    expect(await p).toEqual({ cached: true, complete: false, bytes: 10 });
    expect(req).toEqual({ id: req.id, op: "cacheState", modelId: WHISPER_BASE });
  });

  test("remove of the loaded model unloads it; unload resets", async () => {
    const { engine, worker } = await loaded();
    const p = engine.remove(WHISPER_BASE);
    expect(engine.ready).toBe(false);
    expect(worker().last()).toEqual({
      id: worker().last().id,
      op: "remove",
      modelId: WHISPER_BASE,
    });
    worker().reply({ id: worker().last().id, kind: "ok" });
    await p;
    const s = await loaded();
    const u = s.engine.unload();
    expect(s.engine.ready).toBe(false);
    expect(s.worker().last().op).toBe("unload");
    s.worker().reply({ id: s.worker().last().id, kind: "ok" });
    await u;
  });
});
