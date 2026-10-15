/**
 * Messages between the page (src/ai/engine.ts) and the AI worker
 * (src/workers/ai-worker.ts), plus the types the AI features share. The
 * channel carries only our own messages: anything else is ignored.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  /** JSON-schema-constrained output (response_format json + schema). */
  schema?: Record<string, unknown>;
  /** Called with each streamed text delta. */
  onDelta?: (delta: string) => void;
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

export interface LoadProgress {
  /** 0 to 1: download, then upload to the GPU. */
  progress: number;
  /** WebLLM's own line, in English. */
  text: string;
}

export interface ModelCacheState {
  /** Some weights are cached (a stopped download resumes from there). */
  cached: boolean;
  /** Weights, config, tokenizer and library all cached: the model runs offline. */
  complete: boolean;
  /** Weight bytes cached. */
  bytes: number;
}

export interface WireError {
  name: string;
  message: string;
}

export type AiRequest =
  | { id: number; op: "load"; modelId: string }
  | { id: number; op: "unload" }
  | {
      id: number;
      op: "chat";
      messages: ChatMessage[];
      schema?: Record<string, unknown>;
      maxTokens?: number;
      temperature?: number;
    }
  | { id: number; op: "transcribe"; pcm: Float32Array; lang?: string }
  | { id: number; op: "abort"; target: number }
  | { id: number; op: "cacheState"; modelId: string }
  | { id: number; op: "remove"; modelId: string };

export type AiResponse =
  | { id: number; kind: "progress"; progress: LoadProgress }
  | { id: number; kind: "delta"; delta: string }
  | { id: number; kind: "text"; text: string }
  | { id: number; kind: "state"; state: ModelCacheState }
  | { id: number; kind: "ok" }
  | { id: number; kind: "error"; error: WireError };

const OPS: ReadonlySet<string> = new Set([
  "load",
  "unload",
  "chat",
  "transcribe",
  "abort",
  "cacheState",
  "remove",
]);
const KINDS: ReadonlySet<string> = new Set(["progress", "delta", "text", "state", "ok", "error"]);

export function isRequest(d: unknown): d is AiRequest {
  return (
    typeof d === "object" &&
    d !== null &&
    "id" in d &&
    typeof d.id === "number" &&
    "op" in d &&
    OPS.has(String(d.op))
  );
}

export function isResponse(d: unknown): d is AiResponse {
  return (
    typeof d === "object" &&
    d !== null &&
    "id" in d &&
    typeof d.id === "number" &&
    "kind" in d &&
    KINDS.has(String(d.kind))
  );
}

export function toWire(e: unknown): WireError {
  if (e instanceof Error) return { name: e.name, message: e.message };
  if (typeof e === "object" && e !== null && "name" in e && "message" in e) {
    return { name: String(e.name), message: String(e.message) };
  }
  return { name: "Error", message: String(e) };
}

export function fromWire(w: WireError): Error {
  if (w.name === "AbortError") return new DOMException(w.message, "AbortError");
  const e = new Error(w.message);
  e.name = w.name;
  return e;
}
