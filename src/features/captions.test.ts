import { describe, expect, test } from "bun:test";
import {
  type Availability,
  type Caption,
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
  /** install() rejects like Chrome does outside a click. */
  needsGesture?: boolean;
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
      if (opts.needsGesture) {
        opts.needsGesture = false;
        throw new DOMException("Requires handling a user gesture", "NotAllowedError");
      }
      return opts.install ?? true;
    }
  }
  return { Recognition: FakeRecognition as RecognitionConstructor, instances, installs };
}

function setup(Recognition: RecognitionConstructor | undefined) {
  const sent: Caption[] = [];
  const t = new Transcriber({
    Recognition,
    lang: "fr-FR",
    send: (c) => sent.push(c),
    now: () => 42,
  });
  return { t, sent };
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

  test("says while it installs, and when it is done", async () => {
    const { Recognition } = fake({ status: "downloading", install: true });
    const installing: boolean[] = [];
    const t = new Transcriber({
      Recognition,
      lang: "fr-FR",
      send: () => {},
      onInstalling: (v) => installing.push(v),
    });
    await t.start();
    expect(installing).toEqual([true, false]);
  });

  test("a failed install reports unavailable", async () => {
    const { Recognition, instances } = fake({ status: "downloadable", install: false });
    const { t, sent } = setup(Recognition);
    await t.start();
    expect(instances).toHaveLength(0);
    expect(sent).toEqual(unavailable);
  });

  test("an install refused outside a click asks for one rather than reporting unavailable", async () => {
    const { Recognition, instances, installs } = fake({
      status: "downloadable",
      needsGesture: true,
    });
    const needs: boolean[] = [];
    const installing: boolean[] = [];
    const sent: Caption[] = [];
    const t = new Transcriber({
      Recognition,
      lang: "fr-FR",
      send: (c) => sent.push(c),
      onNeedsDownload: (v) => needs.push(v),
      onInstalling: (v) => installing.push(v),
      now: () => 42,
    });
    await t.start();
    expect(instances).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(needs).toEqual([true]);

    // The click: install is asked at once, then a new start listens.
    const done = t.download();
    expect(installs).toHaveLength(2);
    expect(await done).toBe(true);
    expect(needs).toEqual([true, false]);
    expect(installing).toEqual([true, false, true, false]);
    await t.start();
    expect(instances).toHaveLength(1);
  });

  test("download without an install API, or a failed one, is false", async () => {
    expect(await setup(undefined).t.download()).toBe(false);
    const { Recognition } = fake({ status: "downloadable", install: false });
    expect(await setup(Recognition).t.download()).toBe(false);
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

  test("after a reset the unavailable notice is sent again", async () => {
    const { t, sent } = setup(undefined);
    await t.start();
    await t.start();
    t.reset();
    await t.start();
    expect(sent).toEqual([...unavailable, ...unavailable]);
  });

  test("picks the standard or prefixed constructor", () => {
    const { Recognition } = fake({});
    expect(speechRecognition({ webkitSpeechRecognition: Recognition })).toBe(Recognition);
    expect(speechRecognition({ SpeechRecognition: Recognition })).toBe(Recognition);
    expect(speechRecognition({})).toBeUndefined();
  });
});
