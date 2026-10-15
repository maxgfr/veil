import { describe, expect, test } from "bun:test";
import { AudioTranscriber, type PcmEngine, SAMPLE_RATE, Segmenter } from "./audioCaptions";
import type { Caption } from "./captions";

const FRAME_MS = 100;
const FRAME = (SAMPLE_RATE * FRAME_MS) / 1000;

function frame(level: number): Float32Array {
  return new Float32Array(FRAME).fill(level);
}

/** `ms` of voice (level 0.1) or silence. */
function frames(kind: "voice" | "silence", ms: number): Float32Array[] {
  return Array.from({ length: ms / FRAME_MS }, () => frame(kind === "voice" ? 0.1 : 0));
}

function run(segmenter: Segmenter, input: Float32Array[]) {
  return input.flatMap((f) => segmenter.push(f));
}

const seconds = (pcm: Float32Array) => pcm.length / SAMPLE_RATE;

describe("segmenter", () => {
  test("silence yields nothing", () => {
    expect(run(new Segmenter(), frames("silence", 5000))).toEqual([]);
  });

  test("speech ends after 700 ms of silence, trimmed to its last voiced frame", () => {
    const s = new Segmenter();
    const out = run(s, [...frames("silence", 500), ...frames("voice", 2000)]);
    expect(out).toEqual([]);
    expect(run(s, frames("silence", 600))).toEqual([]);
    const [segment, ...rest] = run(s, frames("silence", 100));
    expect(rest).toEqual([]);
    expect(segment && seconds(segment.pcm)).toBe(2);
    expect(segment?.offsetMs).toBe(500);
  });

  test("a pause shorter than the hangover stays in the segment", () => {
    const out = run(new Segmenter(), [
      ...frames("voice", 1000),
      ...frames("silence", 600),
      ...frames("voice", 1000),
      ...frames("silence", 700),
    ]);
    expect(out.map((s) => seconds(s.pcm))).toEqual([2.6]);
  });

  test("segments under 1 s are dropped", () => {
    const out = run(new Segmenter(), [
      ...frames("voice", 900),
      ...frames("silence", 700),
      ...frames("voice", 1000),
      ...frames("silence", 700),
    ]);
    expect(out.map((s) => [seconds(s.pcm), s.offsetMs])).toEqual([[1, 1600]]);
  });

  test("long speech is cut every 28 s", () => {
    const out = run(new Segmenter(), [...frames("voice", 60_000), ...frames("silence", 700)]);
    expect(out.map((s) => [seconds(s.pcm), s.offsetMs])).toEqual([
      [28, 0],
      [28, 28_000],
      [4, 56_000],
    ]);
  });

  test("flush ends the current segment", () => {
    const s = new Segmenter();
    run(s, frames("voice", 1500));
    expect(s.flush()?.pcm.length).toBe(1.5 * SAMPLE_RATE);
    expect(s.flush()).toBeNull();
  });
});

function fakeEngine(reply: (pcm: Float32Array) => Promise<string>) {
  const calls: { seconds: number; lang?: string; signal?: AbortSignal }[] = [];
  const engine: PcmEngine = {
    transcribe(pcm, opts) {
      calls.push({ seconds: seconds(pcm), ...opts });
      return reply(pcm);
    },
  };
  return { engine, calls };
}

function setup(engine: PcmEngine, track: MediaStreamTrack | null = {} as MediaStreamTrack) {
  const sent: Caption[] = [];
  let feed: (f: Float32Array) => void = () => {};
  let closes = 0;
  const t = new AudioTranscriber({
    track: () => track,
    engine,
    lang: "de-DE",
    send: (c) => sent.push(c),
    now: () => 10_000,
    open: async (_track, onFrame) => {
      feed = onFrame;
      return () => {
        closes++;
      };
    },
  });
  const speak = (ms: number) => {
    for (const f of [...frames("voice", ms), ...frames("silence", 700)]) feed(f);
  };
  return { t, sent, speak, closes: () => closes };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("audio transcriber", () => {
  test("sends each spoken segment's text with its language and start time", async () => {
    const { engine, calls } = fakeEngine(async () => "  guten Tag  ");
    const { t, sent, speak } = setup(engine);
    await t.start();
    speak(1500);
    await tick();
    expect(calls.map((c) => [c.seconds, c.lang])).toEqual([[1.5, "de-DE"]]);
    expect(sent).toEqual([{ ts: 10_000, text: "guten Tag", lang: "de-DE" }]);
  });

  test("empty transcriptions are not sent, failures are survived", async () => {
    let n = 0;
    const { engine } = fakeEngine(async () => {
      n++;
      if (n === 1) return "   ";
      if (n === 2) throw new Error("model crashed");
      return "ok";
    });
    const { t, sent, speak } = setup(engine);
    await t.start();
    speak(1000);
    await tick();
    speak(1000);
    await tick();
    speak(1000);
    await tick();
    expect(sent.map((c) => c.text)).toEqual(["ok"]);
  });

  test("one transcription at a time, the backlog capped to the newest three", async () => {
    const releases: (() => void)[] = [];
    const { engine, calls } = fakeEngine(
      (pcm) => new Promise((resolve) => releases.push(() => resolve(`${seconds(pcm)}`))),
    );
    const { t, sent, speak } = setup(engine);
    await t.start();
    for (const ms of [1000, 1100, 1200, 1300, 1400]) speak(ms);
    await tick();
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 4; i++) {
      releases.shift()?.();
      await tick();
    }
    expect(sent.map((c) => c.text)).toEqual(["1", "1.2", "1.3", "1.4"]);
  });

  test("stop closes the microphone and aborts the pending transcription", async () => {
    const { engine, calls } = fakeEngine(
      (_pcm) =>
        new Promise((_resolve, reject) => {
          calls.at(-1)?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const { t, sent, speak, closes } = setup(engine);
    await t.start();
    speak(1000);
    await tick();
    expect(calls[0]?.signal?.aborted).toBe(false);
    t.stop();
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(closes()).toBe(1);
    speak(1000);
    await tick();
    expect(calls).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test("start without a microphone track fails", async () => {
    const { engine } = fakeEngine(async () => "x");
    const { t } = setup(engine, null);
    await expect(t.start()).rejects.toThrow("no microphone track");
  });

  test("stop during start closes the microphone once it opens", async () => {
    const { engine } = fakeEngine(async () => "x");
    let open!: () => void;
    let closed = 0;
    const t = new AudioTranscriber({
      track: () => ({}) as MediaStreamTrack,
      engine,
      lang: "en",
      send: () => {},
      open: () =>
        new Promise((resolve) => {
          open = () => resolve(() => closed++);
        }),
    });
    const started = t.start();
    t.stop();
    open();
    await started;
    expect(closed).toBe(1);
  });
});
