import { describe, expect, test } from "bun:test";
import {
  type Availability,
  type Caption,
  type CaptionSource,
  type RecognitionConstructor,
  type RecognitionInstance,
  type RecognitionResultEvent,
  speechRecognition,
  Transcriber,
} from "./captions";

function fake(opts: {
  status?: Availability | Promise<Availability>;
  install?: boolean;
  throws?: boolean;
}) {
  const instances: FakeRecognition[] = [];
  const installs: unknown[] = [];
  class FakeRecognition implements RecognitionInstance {
    continuous = false;
    interimResults = true;
    lang = "";
    processLocally = false;
    onresult: ((event: RecognitionResultEvent) => void) | null = null;
    onend: (() => void) | null = null;
    starts = 0;
    aborts = 0;
    constructor() {
      instances.push(this);
    }
    start() {
      this.starts++;
    }
    stop() {}
    abort() {
      this.aborts++;
    }
    static async available() {
      if (opts.throws) throw new Error("boom");
      return opts.status ?? "available";
    }
    static async install(options: unknown) {
      installs.push(options);
      return opts.install ?? true;
    }
  }
  return { Recognition: FakeRecognition as RecognitionConstructor, instances, installs };
}

function setup(
  Recognition: RecognitionConstructor | undefined,
  fallback?: () => CaptionSource | null | Promise<CaptionSource | null>,
) {
  const sent: Caption[] = [];
  const t = new Transcriber({
    Recognition,
    lang: "fr-FR",
    send: (c) => sent.push(c),
    now: () => 42,
    ...(fallback ? { fallback } : {}),
  });
  return { t, sent };
}

function fakeSource(fails = false) {
  const source = {
    starts: 0,
    stops: 0,
    async start() {
      source.starts++;
      if (fails) throw new Error("no worklet");
    },
    stop() {
      source.stops++;
    },
  };
  return source;
}

function results(...items: [string, boolean][]): RecognitionResultEvent {
  return {
    resultIndex: 0,
    results: items.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })),
  };
}

const unavailable = [{ ts: 42, text: "", unavailable: true }];

describe("transcriber", () => {
  test("listens locally when the language is available", async () => {
    const { Recognition, instances, installs } = fake({ status: "available" });
    const { t, sent } = setup(Recognition);
    await t.start();
    expect(instances).toHaveLength(1);
    const r = instances[0];
    expect([r?.continuous, r?.interimResults, r?.lang, r?.processLocally]).toEqual([
      true,
      false,
      "fr-FR",
      true,
    ]);
    expect(r?.starts).toBe(1);
    expect(installs).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  test("stop then start during the probe listens once, and stop aborts it", async () => {
    let resolve: (status: Availability) => void = () => {};
    const status = new Promise<Availability>((r) => {
      resolve = r;
    });
    const { Recognition, instances } = fake({ status });
    const { t, sent } = setup(Recognition);
    const first = t.start();
    t.stop();
    const second = t.start();
    resolve("available");
    await Promise.all([first, second]);
    expect(instances).toHaveLength(1);
    t.stop();
    expect(instances[0]?.aborts).toBe(1);
    expect(sent).toEqual([]);
  });

  test("installs a downloadable model, then listens", async () => {
    const { Recognition, instances, installs } = fake({ status: "downloadable", install: true });
    const { t, sent } = setup(Recognition);
    await t.start();
    expect(installs).toEqual([{ langs: ["fr-FR"], processLocally: true }]);
    expect(instances).toHaveLength(1);
    expect(sent).toEqual([]);
  });

  test("a failed install reports unavailable", async () => {
    const { Recognition, instances } = fake({ status: "downloadable", install: false });
    const { t, sent } = setup(Recognition);
    await t.start();
    expect(instances).toHaveLength(0);
    expect(sent).toEqual(unavailable);
  });

  test("unavailable is reported once and never listens", async () => {
    const { Recognition, instances } = fake({ status: "unavailable" });
    const { t, sent } = setup(Recognition);
    await t.start();
    await t.start();
    expect(instances).toHaveLength(0);
    expect(sent).toEqual(unavailable);
  });

  test("a missing API or a failing probe reports unavailable", async () => {
    const missing = setup(undefined);
    await missing.t.start();
    expect(missing.sent).toEqual(unavailable);

    const { Recognition, instances } = fake({ throws: true });
    const failing = setup(Recognition);
    await failing.t.start();
    expect(instances).toHaveLength(0);
    expect(failing.sent).toEqual(unavailable);
  });

  test("only trimmed, non-empty final results are sent, capped", async () => {
    const { Recognition, instances } = fake({});
    const { t, sent } = setup(Recognition);
    await t.start();
    instances[0]?.onresult?.(
      results(["  hello  ", true], ["interim", false], ["   ", true], ["x".repeat(600), true]),
    );
    expect(sent).toEqual([
      { ts: 42, text: "hello" },
      { ts: 42, text: "x".repeat(500) },
    ]);
  });

  test("restarts on end while active, not after stop", async () => {
    const { Recognition, instances } = fake({});
    const { t } = setup(Recognition);
    await t.start();
    const r = instances[0];
    r?.onend?.();
    expect(r?.starts).toBe(2);
    t.stop();
    r?.onend?.();
    expect(r?.starts).toBe(2);
  });

  test("stop is idempotent", async () => {
    const { Recognition, instances } = fake({});
    const { t } = setup(Recognition);
    t.stop();
    await t.start();
    t.stop();
    t.stop();
    expect(instances[0]?.aborts).toBe(1);
  });

  test("stop while availability is pending never listens", async () => {
    let resolve!: (s: Availability) => void;
    const { Recognition, instances } = fake({ status: new Promise((r) => (resolve = r)) });
    const { t, sent } = setup(Recognition);
    const started = t.start();
    t.stop();
    resolve("available");
    await started;
    expect(instances).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  test("without local recognition the fallback captions instead of the notice", async () => {
    const source = fakeSource();
    const { Recognition, instances } = fake({ status: "unavailable" });
    const { t, sent } = setup(Recognition, () => source);
    await t.start();
    await t.start();
    expect(source.starts).toBe(1);
    expect(instances).toHaveLength(0);
    expect(sent).toEqual([]);
    t.stop();
    expect(source.stops).toBe(1);
  });

  test("local recognition wins over the fallback", async () => {
    let asked = 0;
    const { Recognition, instances } = fake({ status: "available" });
    const { t } = setup(Recognition, () => {
      asked++;
      return fakeSource();
    });
    await t.start();
    expect(asked).toBe(0);
    expect(instances).toHaveLength(1);
  });

  test("no fallback on offer keeps the unavailable notice", async () => {
    const { t, sent } = setup(undefined, () => null);
    await t.start();
    expect(sent).toEqual(unavailable);
  });

  test("a fallback that loads first sends no notice meanwhile, then captions", async () => {
    const source = fakeSource();
    let resolve!: (s: CaptionSource | null) => void;
    const { t, sent } = setup(undefined, () => new Promise((r) => (resolve = r)));
    const started = t.start();
    await Promise.resolve();
    expect(sent).toEqual([]);
    resolve(source);
    await started;
    expect(source.starts).toBe(1);
    expect(sent).toEqual([]);
  });

  test("a fallback whose load fails reports unavailable once", async () => {
    const { t, sent } = setup(undefined, async () => {
      throw new Error("load failed");
    });
    await t.start();
    await t.start();
    expect(sent).toEqual(unavailable);
  });

  test("stop while the fallback loads never starts it", async () => {
    const source = fakeSource();
    let resolve!: (s: CaptionSource | null) => void;
    const { t, sent } = setup(undefined, () => new Promise((r) => (resolve = r)));
    const started = t.start();
    await Promise.resolve();
    t.stop();
    resolve(source);
    await started;
    expect(source.starts).toBe(0);
    expect(sent).toEqual([]);
  });

  test("a fallback that fails to start reports unavailable", async () => {
    const source = fakeSource(true);
    const { t, sent } = setup(undefined, () => source);
    await t.start();
    expect(source.stops).toBe(1);
    expect(sent).toEqual(unavailable);
  });

  test("picks the standard or prefixed constructor", () => {
    const { Recognition } = fake({});
    expect(speechRecognition({ webkitSpeechRecognition: Recognition })).toBe(Recognition);
    expect(speechRecognition({ SpeechRecognition: Recognition })).toBe(Recognition);
    expect(speechRecognition({})).toBeUndefined();
  });
});
