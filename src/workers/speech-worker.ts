/**
 * Runs Whisper (transformers.js on ONNX Runtime Web) off the main thread. The
 * page talks to it through src/ai/speech.ts with the speech messages of
 * src/ai/protocol.ts. This file is the only place transformers.js is
 * imported, so it never reaches the page's bundle.
 *
 * Everything runs here, on the device. ONNX Runtime's WebAssembly is served
 * by this origin (scripts/build.ts copies it next to this worker), never by a
 * CDN. The only requests that leave the device are for the weights, to
 * Hugging Face, during a load the user started; they stay in transformers.js's
 * cache (`transformers-cache`).
 */
import { type AutomaticSpeechRecognitionPipeline, env, pipeline } from "@huggingface/transformers";
import { isSpeechRequest, type SpeechRequest, type SpeechResponse, toWire } from "../ai/protocol";
import {
  filesBytes,
  formatMb,
  removeSpeechFiles,
  type SpeechBackend,
  type SpeechModel,
  type SpeechPlan,
  speechBackend,
  speechCacheState,
  speechModel,
  speechPlan,
} from "../ai/speechModels";
import { GenerationQueue } from "./ai-queue";
import { SpeechLoader } from "./speech-loader";

interface Scope {
  postMessage(message: SpeechResponse): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}
const scope = self as unknown as Scope;

interface GpuLike {
  requestAdapter(options?: {
    powerPreference?: "high-performance";
  }): Promise<{ features: { has(name: string): boolean } } | null>;
}

// Weights from Hugging Face only, never from this origin's /models/.
env.allowLocalModels = false;
env.allowRemoteModels = true;
// ONNX Runtime's files come from this origin and the service worker caches them:
// transformers.js must not refetch them into its own cache as blob: modules.
env.useWasmCache = false;

/**
 * transformers.js points ONNX Runtime at its CDN, picking the build for this
 * browser (asyncify, or the plain one on Safari before 26 without WebGPU).
 * The same files, served from here, replace those URLs before anything loads.
 */
function selfHostOrt(): void {
  const wasm = env.backends.onnx.wasm;
  const chosen = wasm?.wasmPaths;
  if (!wasm || typeof chosen !== "object") throw new Error("no ONNX Runtime build was picked");
  const local = (url: URL | string | undefined): string => {
    const name = String(url ?? "")
      .split("/")
      .pop();
    const file = name ? __ORT_FILES__[name] : undefined;
    if (!file) throw new Error(`ONNX Runtime file ${name} is not served by Veil`);
    return new URL(file, import.meta.url).href;
  };
  wasm.wasmPaths = { mjs: local(chosen.mjs), wasm: local(chosen.wasm) };
}
selfHostOrt();

/** The hosts the CSP allows: huggingface.co and *.hf.co (its CDN, e.g. us.aws.cdn.hf.co). */
const HF_HOST = /^(?:huggingface\.co|(?:[a-z0-9-]+\.)+hf\.co)$/;

function huggingFaceOnly(url: URL): void {
  if (url.protocol !== "https:" || !HF_HOST.test(url.hostname))
    throw new Error(`blocked request to ${url.origin}`);
}

/** One load at a time, each with its own download permission (none unless the user clicked). */
const loader = new SpeechLoader<AutomaticSpeechRecognitionPipeline>();

// Every request transformers.js makes goes through here: Hugging Face only, and
// only for the files of a load allowed to download. Cached files are read from
// the cache, never fetched.
env.fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  huggingFaceOnly(url);
  if (!loader.allows(url)) throw new Error(`${url.pathname} is not downloaded`);
  const res = await fetch(url, init);
  if (res.url) huggingFaceOnly(new URL(res.url));
  return res;
};

/** Whisper runs one segment at a time: requests wait their turn. */
const queue = new GenerationQueue(async () => {});

function send(message: SpeechResponse): void {
  scope.postMessage(message);
}

function known(id: string): SpeechModel {
  const model = speechModel(id);
  if (!model) throw new Error(`${id} is not a speech model`);
  return model;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/** WebGPU (with or without fp16) when there is an adapter, else WebAssembly; read once. */
let backend: Promise<SpeechBackend> | null = null;

function backendOf(): Promise<SpeechBackend> {
  backend ??= (async () => {
    const gpu = (navigator as { gpu?: GpuLike }).gpu;
    // The adapter ONNX Runtime asks for, and the one the page's detection reads.
    const adapter = gpu ? await gpu.requestAdapter({ powerPreference: "high-performance" }) : null;
    return speechBackend(adapter && { shaderF16: adapter.features.has("shader-f16") });
  })();
  return backend;
}

async function planFor(model: SpeechModel): Promise<SpeechPlan> {
  const plan = speechPlan(model, await backendOf());
  if (!plan) throw new Error(`${model.label} needs WebGPU with fp16`);
  return plan;
}

async function handle(req: SpeechRequest): Promise<void> {
  switch (req.op) {
    case "abort":
      await queue.abort(req.target);
      return;
    case "load": {
      const model = known(req.modelId);
      const plan = await planFor(model);
      const total = filesBytes(plan.files);
      const loaded = new Map<string, number>();
      await loader.load(model.id, req.download, () =>
        pipeline("automatic-speech-recognition", model.id, {
          device: plan.device,
          dtype: plan.dtype,
          progress_callback: (p) => {
            if (p.status !== "progress") return;
            loaded.set(p.file, p.loaded);
            let bytes = 0;
            for (const n of loaded.values()) bytes += n;
            send({
              id: req.id,
              kind: "progress",
              progress: {
                progress: Math.min(1, bytes / total),
                text: `${formatMb(bytes)} of ${formatMb(total)}`,
              },
            });
          },
        }),
      );
      send({ id: req.id, kind: "ok" });
      return;
    }
    case "unload":
      await loader.unload();
      send({ id: req.id, kind: "ok" });
      return;
    case "transcribe":
      await queue.run(req.id, async () => {
        const asr = loader.loaded?.pipeline;
        if (!asr) throw new Error("no speech model is loaded");
        const out = await asr(req.pcm, {
          task: "transcribe",
          ...(req.language !== undefined && { language: req.language }),
        });
        if (!queue.wanted(req.id)) throw abortError();
        send({ id: req.id, kind: "text", text: out.text.trim() });
      });
      return;
    case "cacheState": {
      const state = await speechCacheState(caches, known(req.modelId), await backendOf());
      send({ id: req.id, kind: "state", state });
      return;
    }
    case "remove":
      if (loader.loaded?.modelId === req.modelId) await loader.unload();
      await removeSpeechFiles(caches, known(req.modelId));
      send({ id: req.id, kind: "ok" });
      return;
  }
}

scope.addEventListener("message", (e) => {
  const req: unknown = e.data;
  if (!isSpeechRequest(req)) return;
  handle(req).catch((err: unknown) => send({ id: req.id, kind: "error", error: toWire(err) }));
});
