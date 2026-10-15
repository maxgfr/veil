/**
 * Runs the on-device model (WebLLM on WebGPU) off the main thread. The page
 * talks to it through src/ai/engine.ts with the messages of src/ai/protocol.ts.
 * This file is the only place WebLLM is imported, so it never reaches the
 * page's bundle.
 *
 * One model at a time, one generation at a time (WebLLM runs them in turn).
 * The weights stay in WebLLM's own caches (`webllm/*`); nothing but those
 * downloads ever leaves the device.
 */
import {
  deleteModelAllInfoInCache,
  MLCEngine,
  ModelType,
  prebuiltAppConfig,
} from "@mlc-ai/web-llm";
import { modelCacheState, modelFiles } from "../ai/device";
import {
  type AiRequest,
  type AiResponse,
  isRequest,
  type LoadProgress,
  toWire,
} from "../ai/protocol";
import { GenerationQueue } from "./ai-queue";

interface Scope {
  postMessage(message: AiResponse): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
}
const scope = self as unknown as Scope;

/** The language models of the installed WebLLM. */
const records = new Map(
  prebuiltAppConfig.model_list
    .filter((m) => (m.model_type ?? ModelType.LLM) === ModelType.LLM)
    .map((m) => [m.model_id, m] as const),
);

/** Where WebLLM's progress goes: the load request being served. */
let report: (p: LoadProgress) => void = () => {};
let engine: MLCEngine | null = null;
let current: string | null = null;
/** WebLLM serves one generation at a time: requests wait their turn. */
const queue = new GenerationQueue(async () => {
  await engine?.interruptGenerate();
});

function send(message: AiResponse): void {
  scope.postMessage(message);
}

function getEngine(): MLCEngine {
  engine ??= new MLCEngine({
    appConfig: prebuiltAppConfig,
    initProgressCallback: (p) => report({ progress: p.progress, text: p.text }),
  });
  return engine;
}

function loaded(): MLCEngine {
  if (!engine || current === null) throw new Error("no model is loaded");
  return engine;
}

/** Hybrid models (Qwen3, Qwen3.5) think unless told not to, which spends the small context. */
const HYBRID = /^Qwen3/;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function handle(req: AiRequest): Promise<void> {
  switch (req.op) {
    case "abort":
      await queue.abort(req.target);
      return;
    case "load": {
      if (!records.has(req.modelId)) throw new Error(`${req.modelId} is not in WebLLM's list`);
      report = (progress) => send({ id: req.id, kind: "progress", progress });
      try {
        current = null;
        // Reloading frees the previous model first.
        await getEngine().reload(req.modelId);
        current = req.modelId;
      } finally {
        report = () => {};
      }
      send({ id: req.id, kind: "ok" });
      return;
    }
    case "unload":
      current = null;
      await engine?.unload();
      send({ id: req.id, kind: "ok" });
      return;
    case "chat": {
      await queue.run(req.id, async () => {
        const id = current ?? "";
        const chunks = await loaded().chat.completions.create({
          messages: req.messages,
          stream: true,
          ...(req.schema && {
            response_format: { type: "json_object", schema: JSON.stringify(req.schema) },
          }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
          ...(req.temperature !== undefined && { temperature: req.temperature }),
          ...(HYBRID.test(id) && { extra_body: { enable_thinking: false } }),
        });
        let text = "";
        for await (const chunk of chunks) {
          if (!queue.wanted(req.id)) throw abortError();
          const delta = chunk.choices[0]?.delta.content ?? "";
          if (!delta) continue;
          text += delta;
          send({ id: req.id, kind: "delta", delta });
        }
        send({ id: req.id, kind: "text", text });
      });
      return;
    }
    case "cacheState": {
      const record = records.get(req.modelId);
      if (!record) throw new Error(`${req.modelId} is not in WebLLM's list`);
      const state = await modelCacheState(caches, modelFiles(record.model, record.model_lib));
      send({ id: req.id, kind: "state", state });
      return;
    }
    case "remove":
      if (current === req.modelId) {
        current = null;
        await engine?.unload();
      }
      await deleteModelAllInfoInCache(req.modelId, prebuiltAppConfig);
      send({ id: req.id, kind: "ok" });
      return;
  }
}

scope.addEventListener("message", (e) => {
  const req: unknown = e.data;
  if (!isRequest(req)) return;
  handle(req).catch((err: unknown) => send({ id: req.id, kind: "error", error: toWire(err) }));
});
