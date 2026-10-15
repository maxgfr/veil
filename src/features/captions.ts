// Local speech-to-text: captions are produced on-device only, never by an online service.

export type Caption =
  | { ts: number; text: string; lang?: string }
  | { ts: number; text: ""; unavailable: true };

export type Availability = "available" | "downloadable" | "downloading" | "unavailable";

export interface RecognitionOptions {
  langs: string[];
  processLocally: boolean;
}

export interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export interface RecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  processLocally: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionConstructor {
  new (): RecognitionInstance;
  available?: (options: RecognitionOptions) => Promise<Availability>;
  install?: (options: RecognitionOptions) => Promise<boolean>;
}

const MAX_CAPTION = 500;

/** The browser's SpeechRecognition constructor, if any. */
export function speechRecognition(scope: object = globalThis): RecognitionConstructor | undefined {
  const g = scope as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return g.SpeechRecognition ?? g.webkitSpeechRecognition;
}

export class Transcriber {
  private active = false;
  /** The unavailable notice is sent once, until `reset()`. */
  private reportedUnavailable = false;
  private instance: RecognitionInstance | null = null;
  /** Bumped by every start() and stop(), so a stale probe never listens. */
  private generation = 0;

  constructor(
    private readonly deps: {
      Recognition: RecognitionConstructor | undefined;
      lang: string;
      send(caption: Caption): void;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    const generation = ++this.generation;
    const ready = await this.prepare();
    if (generation !== this.generation) return;
    if (!ready) {
      this.active = false;
      this.reportUnavailable();
      return;
    }
    this.listen();
  }

  stop(): void {
    this.active = false;
    this.generation++;
    const instance = this.instance;
    this.instance = null;
    if (!instance) return;
    instance.onend = null;
    instance.onresult = null;
    instance.abort();
  }

  /** Stops, and sends the unavailable notice again if the next start finds none (a new language). */
  reset(): void {
    this.stop();
    this.reportedUnavailable = false;
  }

  /** Whether on-device recognition for the language is (or was made) ready. */
  private async prepare(): Promise<boolean> {
    const { Recognition, lang } = this.deps;
    if (!Recognition?.available) return false;
    const options = { langs: [lang], processLocally: true };
    try {
      const status = await Recognition.available(options);
      if (status === "available") return true;
      if (status === "unavailable" || !Recognition.install) return false;
      return await Recognition.install(options);
    } catch {
      // A failed probe means no local model: online recognition is never an option.
      return false;
    }
  }

  private reportUnavailable(): void {
    if (this.reportedUnavailable) return;
    this.reportedUnavailable = true;
    this.deps.send({ ts: this.now(), text: "", unavailable: true });
  }

  private listen(): void {
    const { Recognition, lang } = this.deps;
    if (!Recognition) return;
    const instance = new Recognition();
    instance.continuous = true;
    instance.interimResults = false;
    instance.lang = lang;
    instance.processLocally = true;
    instance.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result?.isFinal) continue;
        const text = (result[0]?.transcript ?? "").trim().slice(0, MAX_CAPTION);
        if (text) this.deps.send({ ts: this.now(), text });
      }
    };
    instance.onend = () => {
      if (this.instance !== instance || !this.active) return;
      instance.start();
    };
    this.instance = instance;
    instance.start();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
