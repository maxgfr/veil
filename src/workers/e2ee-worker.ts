/**
 * Media end-to-end encryption, run inside an Encoded Transform worker
 * (RTCRtpScriptTransform on Safari/Firefox/Chrome, or Chromium's
 * createEncodedStreams piped in here).
 *
 * Each encoded frame is encrypted with the sender's current media key
 * (derived from its sender key) using AES-GCM:
 *
 *   frame = header (clear) | ciphertext+tag | iv (12) | keyId (4)
 *
 * The first bytes of each frame stay in the clear so the packetizer still
 * works (VP8: 10 bytes on key frames, 3 otherwise; Opus: 1 byte); they are
 * authenticated as AAD. A frame that does not decrypt is dropped: nothing
 * unencrypted is ever played.
 */

export const IV_BYTES = 12;
export const TRAILER_BYTES = IV_BYTES + 4;

export type FrameKind = "audio" | "video";

/** Unencrypted prefix length for a frame. */
export function clearBytes(kind: FrameKind, isKeyFrame: boolean): number {
  if (kind === "audio") return 1;
  return isKeyFrame ? 10 : 3;
}

export async function encryptFrame(
  data: ArrayBuffer,
  clear: number,
  key: CryptoKey,
  keyId: number,
): Promise<ArrayBuffer> {
  const src = new Uint8Array(data);
  const n = Math.min(clear, src.length);
  const header = src.subarray(0, n);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header },
      key,
      src.subarray(n),
    ),
  );
  const out = new Uint8Array(n + ct.length + TRAILER_BYTES);
  out.set(header, 0);
  out.set(ct, n);
  out.set(iv, n + ct.length);
  new DataView(out.buffer).setUint32(out.length - 4, keyId >>> 0);
  return out.buffer;
}

/** Returns the plaintext frame, or null if it cannot be authenticated. */
export async function decryptFrame(
  data: ArrayBuffer,
  clear: number,
  lookup: (keyId: number) => CryptoKey | undefined,
): Promise<ArrayBuffer | null> {
  const src = new Uint8Array(data);
  if (src.length < TRAILER_BYTES + 16) return null;
  const n = Math.min(clear, src.length - TRAILER_BYTES - 16);
  const keyId = new DataView(src.buffer, src.byteOffset, src.byteLength).getUint32(src.length - 4);
  const key = lookup(keyId);
  if (!key) return null;
  const header = src.subarray(0, n);
  const iv = src.slice(src.length - TRAILER_BYTES, src.length - 4);
  try {
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: header },
        key,
        src.subarray(n, src.length - TRAILER_BYTES),
      ),
    );
    const out = new Uint8Array(n + pt.length);
    out.set(header, 0);
    out.set(pt, n);
    return out.buffer;
  } catch {
    return null;
  }
}

// ── worker runtime ──────────────────────────────────────────────────────────

export type WorkerMessage =
  | { type: "send-key"; keyId: number; raw: ArrayBuffer }
  | { type: "recv-keys"; author: string; keys: { keyId: number; raw: ArrayBuffer }[] }
  | { type: "forget"; author: string }
  | {
      type: "stream";
      op: "encrypt" | "decrypt";
      author: string;
      kind: FrameKind;
      readable: ReadableStream;
      writable: WritableStream;
    };

export interface TransformOptions {
  op: "encrypt" | "decrypt";
  author: string;
  kind: FrameKind;
}

interface EncodedFrame {
  data: ArrayBuffer;
  type?: "key" | "delta" | "empty";
}

const importKey = (raw: ArrayBuffer) =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

function startWorker(scope: {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null;
  onrtctransform?: ((e: { transformer: RTCRtpScriptTransformerLike }) => void) | null;
}): void {
  let send: { keyId: number; key: CryptoKey } | null = null;
  const recv = new Map<string, Map<number, CryptoKey>>();
  const stats = { encrypted: 0, decrypted: 0, dropped: 0 };

  const transform = (o: TransformOptions) =>
    new TransformStream<EncodedFrame, EncodedFrame>({
      async transform(frame, controller) {
        const kind: FrameKind = frame.type === undefined ? "audio" : "video";
        if (frame.data.byteLength === 0) {
          controller.enqueue(frame);
          return;
        }
        const clear = clearBytes(kind, frame.type === "key");
        if (o.op === "encrypt") {
          if (!send) {
            stats.dropped++;
            return;
          }
          frame.data = await encryptFrame(frame.data, clear, send.key, send.keyId);
          stats.encrypted++;
          controller.enqueue(frame);
        } else {
          const keys = recv.get(o.author);
          const out = await decryptFrame(frame.data, clear, (id) => keys?.get(id));
          if (!out) {
            stats.dropped++;
            return;
          }
          frame.data = out;
          stats.decrypted++;
          controller.enqueue(frame);
        }
      },
    });

  const pipe = (readable: ReadableStream, writable: WritableStream, o: TransformOptions) => {
    readable
      .pipeThrough(transform(o))
      .pipeTo(writable)
      .catch(() => {});
  };

  scope.onrtctransform = (e) => {
    const t = e.transformer;
    pipe(t.readable, t.writable, t.options as TransformOptions);
  };

  scope.onmessage = async (e) => {
    const m = e.data;
    if (m.type === "send-key") send = { keyId: m.keyId, key: await importKey(m.raw) };
    else if (m.type === "recv-keys") {
      const map = new Map<number, CryptoKey>();
      for (const k of m.keys) map.set(k.keyId, await importKey(k.raw));
      recv.set(m.author, map);
    } else if (m.type === "forget") recv.delete(m.author);
    else if (m.type === "stream")
      pipe(m.readable, m.writable, { op: m.op, author: m.author, kind: m.kind });
  };

  setInterval(() => scope.postMessage({ type: "stats", ...stats }), 1000);
}

interface RTCRtpScriptTransformerLike {
  readable: ReadableStream;
  writable: WritableStream;
  options: unknown;
}

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== "undefined" && typeof window === "undefined") {
  startWorker(self as unknown as Parameters<typeof startWorker>[0]);
}
