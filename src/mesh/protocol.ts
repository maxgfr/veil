/**
 * Every message exchanged between peers, typed and versioned. Decoders
 * validate the shape of untrusted input and return null for anything unknown:
 * nothing received is ever evaluated or rendered as HTML.
 *
 * Pairwise channels (each frame encrypted by a SecureChannel):
 *   ctrl  handshake, renegotiation SDP, liveness, roster snapshot, media prefs
 *   chat  gossip frames, flooded through the partial mesh
 *   file  file transfer control + binary chunks
 */
import { type Bytes, concat, fromUtf8, utf8 } from "../crypto/bytes";
import { isPeerId } from "../crypto/session";

export const PROTOCOL_VERSION = 1;
export const CHANNELS = { ctrl: 0, chat: 1, file: 2 } as const;
export type ChannelLabel = keyof typeof CHANNELS;

const MAX_JSON = 256 * 1024;
const B64U = /^[A-Za-z0-9_-]*$/;

type Rec = Record<string, unknown>;
const isObj = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown, max = 4096): x is string => typeof x === "string" && x.length <= max;
const isB64 = (x: unknown, max = 4096): x is string => isStr(x, max) && B64U.test(x);
const isInt = (x: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
const isId = (x: unknown): x is string => isStr(x, 64) && /^[A-Za-z0-9_-]{8,64}$/.test(x);

// ── ctrl ────────────────────────────────────────────────────────────────────

export type CtrlMessage =
  | { t: "hs"; v: number; edPub: string; xPub: string; sig: string }
  | { t: "sdp"; type: "offer" | "answer"; sdp: string }
  | { t: "ping"; ts: number }
  | { t: "pong"; ts: number }
  | { t: "video"; want: boolean }
  | { t: "roster"; frames: GossipFrame[] }
  | { t: "bye" };

export function decodeCtrl(x: unknown): CtrlMessage | null {
  if (!isObj(x)) return null;
  switch (x.t) {
    case "hs":
      return isInt(x.v) && isB64(x.edPub, 64) && isB64(x.xPub, 64) && isB64(x.sig, 128)
        ? { t: "hs", v: x.v, edPub: x.edPub, xPub: x.xPub, sig: x.sig }
        : null;
    case "sdp":
      return (x.type === "offer" || x.type === "answer") && isStr(x.sdp, 65536)
        ? { t: "sdp", type: x.type, sdp: x.sdp }
        : null;
    case "ping":
    case "pong":
      return isInt(x.ts) ? { t: x.t, ts: x.ts } : null;
    case "video":
      return typeof x.want === "boolean" ? { t: "video", want: x.want } : null;
    case "roster": {
      if (!Array.isArray(x.frames) || x.frames.length > 1024) return null;
      const frames = x.frames.map(decodeGossip).filter((f): f is GossipFrame => f !== null);
      return { t: "roster", frames };
    }
    case "bye":
      return { t: "bye" };
    default:
      return null;
  }
}

// ── chat: gossip frames ─────────────────────────────────────────────────────

export type GossipKind = "presence" | "bye" | "skey" | "data" | "sig";
const GOSSIP_KINDS: readonly GossipKind[] = ["presence", "bye", "skey", "data", "sig"];

/** A frame flooded through the mesh. Everything but `ttl` is covered by the author's signature. */
export interface GossipFrame {
  t: "g";
  v: number;
  author: string;
  edPub: string;
  kind: GossipKind;
  seq: number;
  ts: number;
  ttl: number;
  body: string;
  sig: string;
}

export function decodeGossip(x: unknown): GossipFrame | null {
  if (!isObj(x) || x.t !== "g") return null;
  if (!isInt(x.v) || x.v !== PROTOCOL_VERSION) return null;
  if (!isPeerId(x.author) || !isB64(x.edPub, 64) || !isB64(x.sig, 128)) return null;
  if (!GOSSIP_KINDS.includes(x.kind as GossipKind)) return null;
  if (!isInt(x.seq) || !isInt(x.ts) || !isInt(x.ttl, 0, 32) || !isB64(x.body, MAX_JSON))
    return null;
  return {
    t: "g",
    v: x.v,
    author: x.author,
    edPub: x.edPub,
    kind: x.kind as GossipKind,
    seq: x.seq,
    ts: x.ts,
    ttl: x.ttl,
    body: x.body,
    sig: x.sig,
  };
}

export interface MediaState {
  audio: boolean;
  video: boolean;
  screen: boolean;
}

/** Presence body (plaintext inside the mesh; every hop is pairwise-encrypted). */
export interface Presence {
  nick: string;
  xPub: string;
  media: MediaState;
  links: string[];
  joinedAt: number;
  /** Authors whose current sender key we are missing (they re-send it). */
  want?: string[];
  /** Media frames can be end-to-end encrypted (Encoded Transforms available). */
  e2ee?: boolean;
  /** The author's current sender key id: members missing it ask again (heals partitions). */
  keyId?: number;
}

export function decodePresence(x: unknown): Presence | null {
  if (!isObj(x) || !isStr(x.nick, 64) || !isB64(x.xPub, 64) || !isInt(x.joinedAt)) return null;
  const m = x.media;
  if (
    !isObj(m) ||
    typeof m.audio !== "boolean" ||
    typeof m.video !== "boolean" ||
    typeof m.screen !== "boolean"
  ) {
    return null;
  }
  if (!Array.isArray(x.links) || x.links.length > 256 || !x.links.every(isPeerId)) return null;
  const out: Presence = {
    nick: x.nick,
    xPub: x.xPub,
    media: { audio: m.audio, video: m.video, screen: m.screen },
    links: x.links,
    joinedAt: x.joinedAt,
  };
  if (x.keyId !== undefined) {
    if (!isInt(x.keyId, 0, 0xffffffff)) return null;
    out.keyId = x.keyId;
  }
  if (x.e2ee !== undefined) {
    if (typeof x.e2ee !== "boolean") return null;
    out.e2ee = x.e2ee;
  }
  if (x.want !== undefined) {
    if (!Array.isArray(x.want) || x.want.length > 256 || !x.want.every(isPeerId)) return null;
    out.want = x.want;
  }
  return out;
}

/** Sender-key distribution: the new key wrapped for each recipient. */
export interface SkeyBody {
  keyId: number;
  xPub: string;
  wraps: Record<string, string>;
}

export function decodeSkey(x: unknown): SkeyBody | null {
  if (!isObj(x) || !isInt(x.keyId, 0, 0xffffffff) || !isB64(x.xPub, 64) || !isObj(x.wraps))
    return null;
  const wraps: Record<string, string> = {};
  for (const [k, v] of Object.entries(x.wraps)) {
    if (!isPeerId(k) || !isB64(v, 256)) return null;
    wraps[k] = v;
  }
  return { keyId: x.keyId, xPub: x.xPub, wraps };
}

/** Mesh-routed signaling, encrypted to the recipient's static X25519 key. */
export interface SigBody {
  to: string;
  xPub: string;
  ct: string;
}

export function decodeSigBody(x: unknown): SigBody | null {
  if (!isObj(x) || !isPeerId(x.to) || !isB64(x.xPub, 64) || !isB64(x.ct, 131072)) return null;
  return { to: x.to, xPub: x.xPub, ct: x.ct };
}

export interface RoutedSignal {
  kind: "offer" | "answer";
  sdp: string;
  session: string;
}

export function decodeRoutedSignal(x: unknown): RoutedSignal | null {
  if (
    !isObj(x) ||
    (x.kind !== "offer" && x.kind !== "answer") ||
    !isStr(x.sdp, 65536) ||
    !isId(x.session)
  ) {
    return null;
  }
  return { kind: x.kind, sdp: x.sdp, session: x.session };
}

// ── app messages (sender-key encrypted, inside `data` gossip frames) ───────

export type AppMessage =
  | { type: "chat"; id: string; text: string; ts: number }
  | { type: "typing"; on: boolean }
  | { type: "receipt"; ids: string[] }
  | { type: "file-offer"; id: string; name: string; size: number; mime: string }
  | { type: "file-cancel"; id: string };

export const MAX_CHAT_LENGTH = 8000;

export function decodeApp(x: unknown): AppMessage | null {
  if (!isObj(x)) return null;
  switch (x.type) {
    case "chat":
      return isId(x.id) && isStr(x.text, MAX_CHAT_LENGTH) && x.text.length > 0 && isInt(x.ts)
        ? { type: "chat", id: x.id, text: x.text, ts: x.ts }
        : null;
    case "typing":
      return typeof x.on === "boolean" ? { type: "typing", on: x.on } : null;
    case "receipt":
      return Array.isArray(x.ids) && x.ids.length <= 256 && x.ids.every(isId)
        ? { type: "receipt", ids: x.ids as string[] }
        : null;
    case "file-offer":
      return isId(x.id) && isStr(x.name, 512) && isInt(x.size) && isStr(x.mime, 256)
        ? { type: "file-offer", id: x.id, name: x.name, size: x.size, mime: x.mime }
        : null;
    case "file-cancel":
      return isId(x.id) ? { type: "file-cancel", id: x.id } : null;
    default:
      return null;
  }
}

// ── file channel ────────────────────────────────────────────────────────────

export type FileCtrl =
  | { t: "req"; id: string; from: number }
  | { t: "ack"; id: string; upto: number }
  | { t: "end"; id: string; chunks: number; sha256: string }
  | { t: "cancel"; id: string };

export function decodeFileCtrl(x: unknown): FileCtrl | null {
  if (!isObj(x) || !isId(x.id)) return null;
  switch (x.t) {
    case "req":
      return isInt(x.from) ? { t: "req", id: x.id, from: x.from } : null;
    case "ack":
      return isInt(x.upto) ? { t: "ack", id: x.id, upto: x.upto } : null;
    case "end":
      return isInt(x.chunks) && isStr(x.sha256, 64) && /^[0-9a-f]{64}$/.test(x.sha256)
        ? { t: "end", id: x.id, chunks: x.chunks, sha256: x.sha256 }
        : null;
    case "cancel":
      return { t: "cancel", id: x.id };
    default:
      return null;
  }
}

/** Binary file chunk: id (utf8, 1-byte length) | index u32 | sha256(data) | data. */
export interface FileChunk {
  id: string;
  index: number;
  hash: Bytes;
  data: Bytes;
}

export function encodeChunk(c: FileChunk): Bytes {
  const id = utf8(c.id);
  const head = new Uint8Array(1 + id.length + 4);
  head[0] = id.length;
  head.set(id, 1);
  new DataView(head.buffer).setUint32(1 + id.length, c.index);
  return concat(head, c.hash, c.data);
}

export function decodeChunk(b: Uint8Array): FileChunk | null {
  const n = b[0];
  if (n === undefined || b.length < 1 + n + 4 + 32) return null;
  let id: string;
  try {
    id = fromUtf8(b.subarray(1, 1 + n));
  } catch {
    return null;
  }
  if (!isId(id)) return null;
  const index = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(1 + n);
  const off = 1 + n + 4;
  return { id, index, hash: b.slice(off, off + 32) as Bytes, data: b.slice(off + 32) as Bytes };
}

// ── framing inside a SecureChannel ──────────────────────────────────────────

const FRAME_JSON = 0;
const FRAME_BINARY = 1;

export type Frame = { json: unknown } | { binary: Bytes };

export function encodeFrame(f: Frame): Bytes {
  if ("json" in f) return concat(new Uint8Array([FRAME_JSON]), utf8(JSON.stringify(f.json)));
  return concat(new Uint8Array([FRAME_BINARY]), f.binary);
}

export function decodeFrame(b: Uint8Array): Frame | null {
  if (b[0] === FRAME_BINARY) return { binary: b.slice(1) as Bytes };
  if (b[0] !== FRAME_JSON || b.length > MAX_JSON + 1) return null;
  try {
    return { json: JSON.parse(fromUtf8(b.subarray(1))) };
  } catch {
    return null;
  }
}
