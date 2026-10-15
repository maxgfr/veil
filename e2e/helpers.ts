import {
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  expect,
  type Page,
} from "@playwright/test";

export const BASE = "http://localhost:4173";

export interface TestSettings {
  nostr?: boolean;
  torrent?: boolean;
  manual?: boolean;
}

/** Local relay/tracker only, no STUN: tests never touch the public network. */
export function settingsJson(o: TestSettings = {}): string {
  return JSON.stringify({
    nick: "",
    nostr: { enabled: o.nostr ?? true, relays: [`ws://localhost:4173/relay`] },
    torrent: { enabled: o.torrent ?? false, trackers: [`ws://localhost:4173/tracker`] },
    manual: { enabled: o.manual ?? true },
    stun: [],
    turn: null,
    audioDevice: "",
    videoDevice: "",
  });
}

export interface Member {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
}

export async function member(
  browser: Browser,
  o: TestSettings = {},
  extra: BrowserContextOptions = {},
): Promise<Member> {
  const isChromium = browser.browserType().name() === "chromium";
  const ctx = await browser.newContext({
    ...(isChromium ? { permissions: ["camera", "microphone"] } : {}),
    acceptDownloads: true,
    ...extra,
  });
  await ctx.addInitScript((s) => {
    localStorage.setItem("veil.settings.v1", s);
  }, settingsJson(o));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|TrustedScript|Trusted Types/i.test(m.text())
    )
      errors.push(m.text());
  });
  return { ctx, page, errors };
}

/** Creates a room from the home screen and returns its link. */
export async function createRoom(m: Member, nick: string): Promise<string> {
  await m.page.goto(`${BASE}/?nosw`);
  await m.page.getByTestId("new-room").click();
  await m.page.getByTestId("nick").fill(nick);
  await m.page.getByTestId("enter-room").click();
  await expect(m.page.getByTestId("room")).toBeVisible();
  await closeSheets(m.page);
  return m.page.url();
}

export async function joinRoom(m: Member, link: string, nick: string): Promise<void> {
  await m.page.goto(link);
  await m.page.getByTestId("nick").fill(nick);
  await m.page.getByTestId("enter-room").click();
  await expect(m.page.getByTestId("room")).toBeVisible();
}

/** The invite sheet opens by itself when alone: dismiss any open dialog. */
export async function closeSheets(page: Page): Promise<void> {
  await page.waitForTimeout(1400);
  for (let i = 0; i < 3 && (await page.locator("dialog[open]").count()) > 0; i++)
    await page.keyboard.press("Escape");
}

export async function waitMembers(page: Page, n: number, timeout = 30_000): Promise<void> {
  await expect(page.getByTestId("room")).toHaveAttribute("data-members", String(n), { timeout });
}

export async function waitLinks(page: Page, atLeast: number, timeout = 30_000): Promise<void> {
  await expect
    .poll(async () => Number(await page.getByTestId("room").getAttribute("data-links")), {
      timeout,
    })
    .toBeGreaterThanOrEqual(atLeast);
}

export async function openChat(page: Page): Promise<void> {
  if ((await page.getByTestId("composer").count()) === 0)
    await page.getByTestId("toggle-chat").click();
  await expect(page.getByTestId("composer")).toBeVisible();
}

export async function say(page: Page, text: string): Promise<void> {
  await openChat(page);
  await page.getByTestId("composer").fill(text);
  await page.getByTestId("composer").press("Enter");
}

export async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/**
 * Init script: the browser's built-in AI, faked. German is told apart by a few
 * words; "translation" into English looks phrases up, else tags the text.
 */
export function fakeBuiltinAi(): void {
  const english: Record<string, string> = {
    "Guten Morgen zusammen": "Good morning everyone",
    "Wie geht es euch heute?": "How are you all today?",
  };
  const german = /\b(guten|morgen|zusammen|wie|geht|euch|heute|und|ist)\b/i;
  const api = <T>(create: (opts: Record<string, string>) => T) => ({
    availability: async () => "available",
    create: async (opts: Record<string, string> = {}) => create(opts),
  });
  const w = window as unknown as Record<string, unknown>;
  w.LanguageDetector = api(() => ({
    detect: async (text: string) => [
      { detectedLanguage: german.test(text) ? "de" : "en", confidence: 0.9 },
    ],
    destroy() {},
  }));
  w.Translator = api((opts) => ({
    translate: async (text: string) =>
      opts.targetLanguage === "en"
        ? (english[text] ?? `[en] ${text}`)
        : `[${opts.targetLanguage}] ${text}`,
    destroy() {},
  }));
  w.Summarizer = api(() => ({
    summarize: async (text: string) => `- The meeting covered ${text.split("\n").length} lines.`,
    destroy() {},
  }));
}

export interface FakeDevice {
  /** `navigator.deviceMemory`, GiB. */
  memory: number;
  /** `navigator.storage.estimate()`, bytes. */
  quota: number;
  usage: number;
}

/** Init script: a WebGPU adapter with `shader-f16`, the RAM and the free space given. */
export function fakeDevice(d: FakeDevice): void {
  const GiB = 1024 ** 3;
  const adapter = {
    features: new Set(["shader-f16"]),
    limits: {
      maxBufferSize: 2 * GiB,
      maxStorageBufferBindingSize: 2 * GiB,
      maxComputeWorkgroupStorageSize: 32 * 1024,
    },
    info: { vendor: "fake" },
  };
  Object.defineProperty(Navigator.prototype, "gpu", {
    configurable: true,
    get: () => ({ requestAdapter: async () => adapter }),
  });
  Object.defineProperty(Navigator.prototype, "deviceMemory", {
    configurable: true,
    get: () => d.memory,
  });
  StorageManager.prototype.estimate = async () => ({ quota: d.quota, usage: d.usage });
}

/**
 * Init script: on-device speech recognition that hears `text` shortly after it
 * starts, then again every few seconds. No save picker either (files go to
 * private storage).
 */
export function fakeSpeechSaying(text: string): void {
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  class FakeRecognition {
    static available = async () => "available";
    static install = async () => true;
    continuous = false;
    interimResults = false;
    lang = "";
    processLocally = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    private timers: ReturnType<typeof setTimeout>[] = [];
    start(): void {
      const hear = () => {
        const result = Object.assign([{ transcript: text }], { isFinal: true });
        this.onresult?.({ resultIndex: 0, results: [result] });
      };
      this.timers = [setTimeout(hear, 300), setInterval(hear, 3000)];
    }
    stop(): void {
      for (const t of this.timers) clearTimeout(t);
      this.onend?.();
    }
    abort(): void {
      this.stop();
    }
  }
  (window as { SpeechRecognition?: unknown }).SpeechRecognition = FakeRecognition;
}

/** Init script: merges `ai` into the stored settings (runs after `member`'s own). */
export function aiSettings(ai: {
  model: string | null;
  translateChat: boolean;
  speechModel?: string | null;
}): void {
  const key = "veil.settings.v1";
  const s = JSON.parse(localStorage.getItem(key) ?? "{}");
  localStorage.setItem(key, JSON.stringify({ ...s, ai: { speechModel: null, ...ai } }));
}

/** Init script: a browser that can't recognize speech on the device (no Web Speech at all). */
export function noWebSpeech(): void {
  const w = window as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
}

/**
 * Init script: the microphone "speaks": a tone for 1.5 s, then 1 s of
 * silence, over and over, in place of the fake device's audio.
 */
export function fakeMicSpeaking(): void {
  const real = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    const stream = await real.call(this, constraints);
    if (!constraints?.audio) return stream;
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    tone.frequency.value = 220;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    for (let t = 0; t < 300; t += 2.5) {
      gain.gain.setValueAtTime(0.3, t);
      gain.gain.setValueAtTime(0, t + 1.5);
    }
    const out = ctx.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    void ctx.resume();
    for (const t of stream.getAudioTracks()) {
      stream.removeTrack(t);
      t.stop();
    }
    for (const t of out.stream.getAudioTracks()) stream.addTrack(t);
    return stream;
  };
}

/**
 * Init script: the speech worker (Whisper), faked. `cached` models are fully
 * downloaded; a load with `download` caches its model after some progress, a
 * load without it fails if the model isn't cached; every transcription is
 * `text`. Each request is logged in `window.speechReqs`. Other workers are real.
 */
export function fakeSpeechWorker(o: { cached: string[]; text: string }): void {
  interface Req {
    id: number;
    op: string;
    modelId?: string;
    download?: boolean;
  }
  const w = window as unknown as { speechReqs: Req[]; Worker: typeof Worker };
  const Real = w.Worker;
  const cached = new Set(o.cached);
  w.speechReqs = [];
  class FakeSpeechWorker extends EventTarget {
    postMessage(req: Req): void {
      w.speechReqs.push({ ...req });
      const answer = (reply: Record<string, unknown>, ms = 0) =>
        setTimeout(
          () => this.dispatchEvent(new MessageEvent("message", { data: { id: req.id, ...reply } })),
          ms,
        );
      const id = req.modelId ?? "";
      if (req.op === "cacheState") {
        const complete = cached.has(id);
        answer({ kind: "state", state: { cached: complete, complete, bytes: complete ? 1 : 0 } });
      } else if (req.op === "load" && req.download) {
        answer({ kind: "progress", progress: { progress: 0.5, text: "40 MB of 80 MB" } }, 100);
        cached.add(id);
        answer({ kind: "ok" }, 600);
      } else if (req.op === "load" && !cached.has(id)) {
        answer({ kind: "error", error: { name: "Error", message: `${id} is not downloaded` } });
      } else if (req.op === "transcribe") {
        answer({ kind: "text", text: o.text }, 50);
      } else {
        if (req.op === "remove") cached.delete(id);
        answer({ kind: "ok" });
      }
    }
    terminate(): void {}
  }
  w.Worker = new Proxy(Real, {
    construct(target, args: [string | URL, WorkerOptions?]) {
      if (String(args[0]).includes("speech-worker")) return new FakeSpeechWorker();
      return Reflect.construct(target, args);
    },
  });
}

/**
 * Init script: the AI worker, faked. Every model is fully cached and every load
 * fails; each request's `op` is logged in `window.aiOps`. Other workers are real.
 */
export function fakeAiWorker(): void {
  const w = window as unknown as { aiOps: string[]; Worker: typeof Worker };
  const Real = w.Worker;
  w.aiOps = [];
  class FakeAiWorker extends EventTarget {
    postMessage(req: { id: number; op: string }): void {
      w.aiOps.push(req.op);
      const reply =
        req.op === "cacheState"
          ? { kind: "state", state: { cached: true, complete: true, bytes: 1 } }
          : req.op === "load"
            ? { kind: "error", error: { name: "Error", message: "GPU device lost" } }
            : { kind: "ok" };
      setTimeout(() =>
        this.dispatchEvent(new MessageEvent("message", { data: { id: req.id, ...reply } })),
      );
    }
    terminate(): void {}
  }
  w.Worker = new Proxy(Real, {
    construct(target, args: [string | URL, WorkerOptions?]) {
      if (String(args[0]).includes("ai-worker")) return new FakeAiWorker();
      return Reflect.construct(target, args);
    },
  });
}
