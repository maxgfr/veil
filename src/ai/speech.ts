/**
 * The page side of on-device speech recognition: one speech worker
 * (src/workers/speech-worker.ts) running Whisper, one model at a time. A
 * download cannot be stopped half-way, so cancelling terminates the worker;
 * the files already cached stay and a later load resumes from them. A crashed
 * worker fails what was pending, is reported to `onCrash` listeners, and is
 * replaced on the next call. Implements the transcriber's `PcmEngine`.
 */
import type { PcmEngine } from "../features/audioCaptions";
import { trustedScriptUrl } from "../security";
import {
  fromWire,
  isSpeechResponse,
  type LoadProgress,
  type ModelCacheState,
  type SpeechRequest,
  type SpeechResponse,
} from "./protocol";
import { whisperLanguage } from "./speechModels";

/** `new Worker(…)`, structurally, so tests can fake it. */
export interface SpeechWorkerLike {
  postMessage(message: SpeechRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
  terminate(): void;
}

export interface SpeechLoadOptions {
  /** Fetch what the cache lacks; false loads from the cache only (and fails if anything is missing). */
  download: boolean;
  onProgress?: (p: LoadProgress) => void;
}

type Handler = (res: SpeechResponse) => boolean;

interface Live {
  worker: SpeechWorkerLike;
  pending: Map<number, Handler>;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function defaultWorker(): SpeechWorkerLike {
  return new Worker(trustedScriptUrl(__SPEECH_WORKER_URL__) as unknown as string, {
    type: "module",
    name: "veil-speech",
  });
}

export class SpeechEngine implements PcmEngine {
  #createWorker: () => SpeechWorkerLike;
  #live: Live | null = null;
  #next = 1;
  #modelId: string | null = null;
  #ready = false;
  #loading: Promise<void> | null = null;
  #crashListeners = new Set<(err: Error) => void>();

  constructor(deps: { createWorker?: () => SpeechWorkerLike } = {}) {
    this.#createWorker = deps.createWorker ?? defaultWorker;
  }

  /** The loaded (or loading) model. */
  get modelId(): string | null {
    return this.#modelId;
  }

  /** A model is loaded and transcribes. */
  get ready(): boolean {
    return this.#ready;
  }

  /**
   * Loads the model, downloading what the cache lacks only when `download` says
   * so. One load at a time: a load of another model still running is cancelled
   * (its worker terminated, its promise rejected as an AbortError) first.
   */
  load(modelId: string, opts: SpeechLoadOptions): Promise<void> {
    if (this.#modelId === modelId && this.#loading) return this.#loading;
    if (this.#modelId === modelId && this.#ready) return Promise.resolve();
    if (this.#loading) this.cancel();
    this.#modelId = modelId;
    this.#ready = false;
    const loading = this.#ask<void>(
      (id) => ({ id, op: "load", modelId, download: opts.download }),
      (res, resolve, reject) => {
        if (res.kind === "progress") {
          opts.onProgress?.(res.progress);
          return false;
        }
        if (res.kind === "ok") resolve();
        else if (res.kind === "error") reject(fromWire(res.error));
        else return false;
        return true;
      },
    ).then(
      () => {
        if (this.#loading === loading) {
          this.#loading = null;
          this.#ready = true;
        }
      },
      (err: unknown) => {
        if (this.#loading === loading) {
          this.#loading = null;
          this.#modelId = null;
        }
        throw err;
      },
    );
    this.#loading = loading;
    return loading;
  }

  /** Stops whatever runs (a download included) by terminating the worker. */
  cancel(): void {
    this.#reset();
    this.#stop(new DOMException("Cancelled", "AbortError"));
  }

  async unload(): Promise<void> {
    if (!this.#live) {
      this.#reset();
      return;
    }
    this.#reset();
    await this.#ask<void>((id) => ({ id, op: "unload" }), done);
  }

  /** Transcribes 16 kHz mono PCM; `lang` is the speaker's BCP 47 tag ("fr-FR"). */
  transcribe(
    pcm16k: Float32Array,
    opts: { lang?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    if (!this.#ready) return Promise.reject(new Error("no speech model is loaded"));
    // A copy goes over, so the caller keeps its samples.
    const pcm = pcm16k.slice();
    const language = opts.lang ? whisperLanguage(opts.lang) : undefined;
    return this.#ask<string>(
      (id) => (language ? { id, op: "transcribe", pcm, language } : { id, op: "transcribe", pcm }),
      (res, resolve, reject) => {
        if (res.kind === "text") resolve(res.text);
        else if (res.kind === "error") reject(fromWire(res.error));
        else return false;
        return true;
      },
      opts.signal,
      [pcm.buffer],
    );
  }

  cacheState(modelId: string): Promise<ModelCacheState> {
    return this.#ask<ModelCacheState>(
      (id) => ({ id, op: "cacheState", modelId }),
      (res, resolve, reject) => {
        if (res.kind === "state") resolve(res.state);
        else if (res.kind === "error") reject(fromWire(res.error));
        else return false;
        return true;
      },
    );
  }

  /** Deletes the model's files (and unloads it if it is the loaded one). */
  remove(modelId: string): Promise<void> {
    if (this.#modelId === modelId) this.#reset();
    return this.#ask<void>((id) => ({ id, op: "remove", modelId }), done);
  }

  /** Called when the worker dies (out of memory, WebGPU lost…); returns unsubscribe. */
  onCrash(cb: (err: Error) => void): () => void {
    this.#crashListeners.add(cb);
    return () => {
      this.#crashListeners.delete(cb);
    };
  }

  #reset(): void {
    this.#modelId = null;
    this.#ready = false;
    this.#loading = null;
  }

  /** Terminates the worker and fails what was pending with `err`. */
  #stop(err: Error): void {
    const live = this.#live;
    if (!live) return;
    this.#live = null;
    live.worker.terminate();
    for (const [id, on] of live.pending)
      on({ id, kind: "error", error: { name: err.name, message: err.message } });
    live.pending.clear();
  }

  #worker(): Live {
    if (this.#live) return this.#live;
    const worker = this.#createWorker();
    const live: Live = { worker, pending: new Map() };
    worker.addEventListener("message", (event) => {
      const res = event.data;
      if (!isSpeechResponse(res)) return;
      const on = live.pending.get(res.id);
      if (on?.(res)) live.pending.delete(res.id);
    });
    worker.addEventListener("error", (event) => {
      if (this.#live !== live) return;
      const err = new Error(event.message || "the speech worker crashed");
      err.name = "SpeechWorkerCrash";
      this.#reset();
      this.#stop(err);
      for (const cb of this.#crashListeners) cb(err);
    });
    this.#live = live;
    return live;
  }

  /** Sends a request; `on` gets every answer until it returns true (done). */
  #ask<T>(
    make: (id: number) => SpeechRequest,
    on: (res: SpeechResponse, resolve: (v: T) => void, reject: (e: unknown) => void) => boolean,
    signal?: AbortSignal,
    transfer?: Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const live = this.#worker();
      const id = this.#next++;
      const onAbort = () => {
        live.pending.delete(id);
        if (this.#live === live)
          live.worker.postMessage({ id: this.#next++, op: "abort", target: id });
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      live.pending.set(id, (res) => {
        const finished = on(res, resolve, reject);
        if (finished) signal?.removeEventListener("abort", onAbort);
        return finished;
      });
      live.worker.postMessage(make(id), transfer ?? []);
    });
  }
}

const done = (res: SpeechResponse, resolve: () => void, reject: (e: unknown) => void): boolean => {
  if (res.kind === "ok") resolve();
  else if (res.kind === "error") reject(fromWire(res.error));
  else return false;
  return true;
};

let engine: SpeechEngine | null = null;

/** The page-wide speech engine, created on first use. */
export function getSpeechEngine(): SpeechEngine {
  engine ??= new SpeechEngine();
  return engine;
}
