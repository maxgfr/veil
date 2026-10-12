/**
 * Signaling envelopes. A SignalMessage is serialized, compressed and sealed
 * with the room's sigKey (AES-256-GCM, AAD = topic || sender). Only holders
 * of the room key can read or forge one, so a relay or tracker can neither
 * learn the SDP nor substitute its own DTLS fingerprint (MITM).
 *
 *   wire = <sender peerId> "." base64url(nonce || ciphertext)
 *
 * Inside, every message is signed by the sender's Ed25519 identity, whose
 * hash is the sender's peer id: holding the room key is not enough to speak
 * for another member (a forged "bye" or "offer" from someone else is dropped).
 *
 * Opening rejects forgeries, envelopes older than 120 s (or from the future),
 * replays, and anything that is not a well-formed message.
 */
import { open, seal } from "../crypto/aead";
import {
  type Bytes,
  bytes,
  concat,
  fromB64u,
  fromUtf8,
  randomBytes,
  sha256,
  toB64u,
  toHex,
  utf8,
} from "../crypto/bytes";
import { type Identity, isPeerId, peerIdOf, verifyEd25519 } from "../crypto/session";
import type { SignalKind, SignalMessage } from "./types";

export const MAX_AGE_MS = 120_000;
const MAX_PLAINTEXT = 64 * 1024;
const KINDS: readonly SignalKind[] = ["hello", "offer", "answer", "bye"];

function aad(topic: Uint8Array, from: string): Bytes {
  return concat(utf8("veil/env/v1|"), utf8(toHex(topic)), utf8(`|${from}`));
}

/** SDP uses CRLF line endings; LF is enough on the wire and restored on open (lossless). */
export function minimizeSdp(sdp: string): string {
  return sdp.replace(/\r\n/g, "\n");
}

export function expandSdp(sdp: string): string {
  return sdp.replace(/\r?\n/g, "\r\n");
}

async function pipe(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  limit: number,
): Promise<Bytes> {
  const writer = stream.writable.getWriter();
  writer.write(bytes(data)).catch(() => {});
  writer.close().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

export const deflate = (data: Uint8Array): Promise<Bytes> =>
  pipe(data, new CompressionStream("deflate-raw"), MAX_PLAINTEXT * 4);
export const inflate = (data: Uint8Array, limit = MAX_PLAINTEXT): Promise<Bytes> =>
  pipe(data, new DecompressionStream("deflate-raw"), limit);

export function newEnvelopeId(): string {
  return toB64u(randomBytes(12));
}

export type Outgoing = Omit<SignalMessage, "v" | "id" | "ts" | "from" | "edPub" | "sig">;

export type EnvelopeSigner = Pick<Identity, "peerId" | "edPub" | "sign">;

/** What the sender signs; the CLI (cli/src/envelope.rs) builds the same bytes. */
export async function signedEnvelopeBytes(m: Omit<SignalMessage, "edPub" | "sig">): Promise<Bytes> {
  const head = `veil/env-sig/v1|${m.id}|${m.from}|${m.to ?? ""}|${m.ts}|${m.kind}|${m.session ?? ""}|`;
  return concat(utf8(head), await sha256(utf8(minimizeSdp(m.sdp ?? ""))));
}

export async function sealEnvelope(
  sigKey: CryptoKey,
  topic: Uint8Array,
  signer: EnvelopeSigner,
  msg: Outgoing,
  now: number = Date.now(),
): Promise<{ wire: string; message: SignalMessage }> {
  const from = signer.peerId;
  const unsigned = { v: 1 as const, id: newEnvelopeId(), from, ts: now, ...msg };
  const sig = await signer.sign(await signedEnvelopeBytes(unsigned));
  const message: SignalMessage = { ...unsigned, edPub: toB64u(signer.edPub), sig: toB64u(sig) };
  const json = JSON.stringify(
    message.sdp ? { ...message, sdp: minimizeSdp(message.sdp) } : message,
  );
  const sealed = await seal(sigKey, await deflate(utf8(json)), aad(topic, from));
  return { wire: `${from}.${toB64u(sealed)}`, message };
}

function validate(x: unknown, from: string): SignalMessage | null {
  if (typeof x !== "object" || x === null) return null;
  const m = x as Record<string, unknown>;
  if (m.v !== 1 || m.from !== from) return null;
  if (typeof m.id !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(m.id)) return null;
  if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return null;
  if (typeof m.kind !== "string" || !KINDS.includes(m.kind as SignalKind)) return null;
  if (m.to !== undefined && !isPeerId(m.to)) return null;
  if (m.sdp !== undefined && (typeof m.sdp !== "string" || m.sdp.length > 32_768)) return null;
  if (m.session !== undefined && (typeof m.session !== "string" || m.session.length > 64))
    return null;
  if (typeof m.edPub !== "string" || m.edPub.length !== 43) return null;
  if (typeof m.sig !== "string" || m.sig.length !== 86) return null;
  const out: SignalMessage = {
    v: 1,
    id: m.id,
    from,
    ts: m.ts,
    kind: m.kind as SignalKind,
    edPub: m.edPub,
    sig: m.sig,
  };
  if (m.to !== undefined) out.to = m.to as string;
  if (m.sdp !== undefined) out.sdp = expandSdp(m.sdp as string);
  if (m.session !== undefined) out.session = m.session as string;
  return out;
}

export interface OpenerOptions {
  maxAgeMs?: number;
  now?: () => number;
}

export class EnvelopeOpener {
  private readonly seen = new Map<string, number>();
  private readonly maxAge: number;
  private readonly now: () => number;

  constructor(
    private readonly sigKey: CryptoKey,
    opts: OpenerOptions = {},
  ) {
    this.maxAge = opts.maxAgeMs ?? MAX_AGE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Returns the message, or null if forged, stale, replayed or malformed. Never throws. */
  async open(wire: string, topic: Uint8Array): Promise<SignalMessage | null> {
    const dot = wire.indexOf(".");
    if (dot !== 20 || wire.length > 100_000) return null;
    const from = wire.slice(0, dot);
    if (!isPeerId(from)) return null;
    let msg: SignalMessage | null;
    try {
      const plain = await open(this.sigKey, fromB64u(wire.slice(dot + 1)), aad(topic, from));
      msg = validate(JSON.parse(fromUtf8(await inflate(plain))), from);
    } catch {
      return null;
    }
    if (!msg) return null;
    // The sender must own `from`: its key hashes to it and signed the message.
    try {
      const edPub = fromB64u(msg.edPub);
      if ((await peerIdOf(edPub)) !== from) return null;
      const { edPub: _e, sig: _s, ...unsigned } = msg;
      if (!(await verifyEd25519(edPub, fromB64u(msg.sig), await signedEnvelopeBytes(unsigned))))
        return null;
    } catch {
      return null;
    }
    const now = this.now();
    if (Math.abs(now - msg.ts) > this.maxAge) return null;
    this.gc(now);
    if (this.seen.has(msg.id)) return null;
    this.seen.set(msg.id, now);
    return msg;
  }

  private gc(now: number): void {
    if (this.seen.size < 512) return;
    for (const [id, t] of this.seen) if (now - t > this.maxAge * 2) this.seen.delete(id);
  }
}
