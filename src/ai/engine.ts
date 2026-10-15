/**
 * The page side of the on-device model: one AI worker (src/workers/ai-worker.ts),
 * one model at a time. WebLLM cannot stop a download half-way, so cancelling
 * terminates the worker; the shards already cached stay and a later load
 * resumes from them. A crashed worker fails what was pending, is reported to
 * `onCrash` listeners, and is replaced on the next call.
 */
import { trustedScriptUrl } from "../security";
// Context windows only: small, and no llm-models catalog on the page.
import { ENGINE_MODELS } from "./engineModels";
import {
  type AiRequest,
  type AiResponse,
  type ChatMessage,
  type ChatOptions,
  fromWire,
  isResponse,
  type LoadProgress,
  type ModelCacheState,
} from "./protocol";

/** `new Worker(…)`, structurally, so tests can fake it. */
export interface WorkerLike {
  postMessage(message: AiRequest, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "error",
    listener: (event: { data?: unknown; message?: string }) => void,
  ): void;
  terminate(): void;
}

/** Share of the context window a prompt may fill, leaving room for the answer. */
export const CONTEXT_SHARE = 0.75;

type Handler = (res: AiResponse) => boolean;

interface Live {
  worker: WorkerLike;
  pending: Map<number, Handler>;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function defaultWorker(): WorkerLike {
  return new Worker(trustedScriptUrl(__AI_WORKER_URL__) as unknown as string, {
    type: "module",
    name: "veil-ai",
  });
}

export class AiEngine {
  #createWorker: () => WorkerLike;
  #live: Live | null = null;
  #next = 1;
  #modelId: string | null = null;
  #ready = false;
  #loading: Promise<void> | null = null;
  #crashListeners = new Set<(err: Error) => void>();

  constructor(deps: { createWorker?: () => WorkerLike } = {}) {
    this.#createWorker = deps.createWorker ?? defaultWorker;
  }

  /** The loaded (or loading) model. */
  get modelId(): string | null {
    return this.#modelId;
  }

  /** A model is loaded and usable. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Tokens a prompt may take: 75% of the loaded model's context window, 0 if none. */
  get contextBudget(): number {
    if (!this.#ready || this.#modelId === null) return 0;
    const id = this.#modelId;
    const context = ENGINE_MODELS.find((m) => m.id === id)?.contextWindow ?? 0;
    return Math.floor(CONTEXT_SHARE * context);
  }

  /** Downloads what the cache lacks, then loads; loading another model unloads the first. */
  load(modelId: string, onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.#modelId === modelId && this.#loading) return this.#loading;
    if (this.#modelId === modelId && this.#ready) return Promise.resolve();
    this.#modelId = modelId;
    this.#ready = false;
    const loading = this.#ask<void>(
      (id) => ({ id, op: "load", modelId }),
      (res, resolve, reject) => {
        if (res.kind === "progress") {
          onProgress?.(res.progress);
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

  /** The full answer; deltas stream to `opts.onDelta`; `opts.signal` aborts. */
  chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    if (!this.#ready) return Promise.reject(new Error("no model is loaded"));
    const make = (id: number): AiRequest => {
      const req: AiRequest = { id, op: "chat", messages };
      if (opts.schema) req.schema = opts.schema;
      if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens;
      if (opts.temperature !== undefined) req.temperature = opts.temperature;
      return req;
    };
    return this.#ask<string>(
      make,
      (res, resolve, reject) => {
        if (res.kind === "delta") {
          opts.onDelta?.(res.delta);
          return false;
        }
        if (res.kind === "text") resolve(res.text);
        else if (res.kind === "error") reject(fromWire(res.error));
        else return false;
        return true;
      },
      opts.signal,
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

  /** Called when the worker dies (WebGPU lost, out of memory…); returns unsubscribe. */
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
      if (!isResponse(res)) return;
      const on = live.pending.get(res.id);
      if (on?.(res)) live.pending.delete(res.id);
    });
    worker.addEventListener("error", (event) => {
      if (this.#live !== live) return;
      const err = new Error(event.message || "the AI worker crashed");
      err.name = "AiWorkerCrash";
      this.#reset();
      this.#stop(err);
      for (const cb of this.#crashListeners) cb(err);
    });
    this.#live = live;
    return live;
  }

  /** Sends a request; `on` gets every answer until it returns true (done). */
  #ask<T>(
    make: (id: number) => AiRequest,
    on: (res: AiResponse, resolve: (v: T) => void, reject: (e: unknown) => void) => boolean,
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

const done = (res: AiResponse, resolve: () => void, reject: (e: unknown) => void): boolean => {
  if (res.kind === "ok") resolve();
  else if (res.kind === "error") reject(fromWire(res.error));
  else return false;
  return true;
};

let engine: AiEngine | null = null;

/** The page-wide engine, created on first use. */
export function getAiEngine(): AiEngine {
  engine ??= new AiEngine();
  return engine;
}
