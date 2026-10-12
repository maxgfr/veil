/**
 * Partial-mesh gossip. Each peer keeps a handful of direct links (about 6);
 * frames are flooded to every neighbor with a TTL and de-duplicated, so a
 * room scales to dozens of members without everyone connecting to everyone.
 *
 * Frames are signed by their author's Ed25519 key, whose hash is the author's
 * peer id: a relaying peer can neither forge nor alter a frame, and a replay
 * is dropped (seen-set + timestamp window). Payload confidentiality comes from
 * sender keys (see crypto/senderkeys.ts).
 */
import { type Bytes, concat, fromB64u, toB64u, utf8 } from "../crypto/bytes";
import { type Identity, peerIdOf, verifyEd25519 } from "../crypto/session";
import { type GossipFrame, type GossipKind, PROTOCOL_VERSION } from "./protocol";

export const DEFAULT_TTL = 10;
export const MAX_SKEW_MS = 5 * 60_000;
export const TARGET_DEGREE = 6;

export function signedBytes(
  f: Pick<GossipFrame, "author" | "kind" | "seq" | "ts" | "body">,
): Bytes {
  return concat(
    utf8(`veil/g/v${PROTOCOL_VERSION}|${f.author}|${f.kind}|${f.seq}|${f.ts}|`),
    fromB64u(f.body),
  );
}

export interface GossipOptions {
  identity: Identity;
  /** Sends a frame to one neighbor. */
  send(to: string, frame: GossipFrame): void;
  neighbors(): Iterable<string>;
  /** A verified, never-seen frame (own frames are not delivered back). */
  deliver(frame: GossipFrame, body: Bytes, from: string): void;
  now?: () => number;
  ttl?: number;
}

export class Gossip {
  private seq = 0;
  private readonly seen = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  private readonly ids = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(private readonly o: GossipOptions) {
    this.now = o.now ?? Date.now;
    this.ttl = o.ttl ?? DEFAULT_TTL;
  }

  async publish(
    kind: GossipKind,
    body: Uint8Array,
    opts: { only?: string[] } = {},
  ): Promise<GossipFrame> {
    const me = this.o.identity;
    const unsigned = {
      author: me.peerId,
      kind,
      seq: this.seq++,
      ts: this.now(),
      body: toB64u(body),
    };
    const sig = await me.sign(signedBytes(unsigned));
    const frame: GossipFrame = {
      t: "g",
      v: PROTOCOL_VERSION,
      ...unsigned,
      edPub: toB64u(me.edPub),
      ttl: this.ttl,
      sig: toB64u(sig),
    };
    this.markSeen(frame.sig);
    for (const n of opts.only ?? this.o.neighbors()) this.o.send(n, frame);
    return frame;
  }

  /** Verifies, delivers and forwards. Resolves true if the frame was new and valid. */
  receive(frame: GossipFrame, from: string): Promise<boolean> {
    const key = frame.sig;
    if (this.seen.has(key)) return Promise.resolve(false);
    const pending = this.inflight.get(key);
    // The same frame is arriving from another neighbor: let the first copy decide.
    if (pending) return pending.then(() => false);
    const p = this.process(frame, from).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async process(frame: GossipFrame, from: string): Promise<boolean> {
    if (frame.author === this.o.identity.peerId) return false;
    if (Math.abs(this.now() - frame.ts) > MAX_SKEW_MS) return false;
    let edPub: Bytes;
    let body: Bytes;
    try {
      edPub = fromB64u(frame.edPub);
      body = fromB64u(frame.body);
    } catch {
      return false;
    }
    let owner = this.ids.get(frame.edPub);
    if (!owner) {
      owner = await peerIdOf(edPub);
      this.ids.set(frame.edPub, owner);
    }
    if (owner !== frame.author) return false;
    if (!(await verifyEd25519(edPub, fromB64u(frame.sig), signedBytes(frame)))) return false;
    // Only now: a forged copy must not be able to shadow the genuine frame.
    if (this.seen.has(frame.sig)) return false;
    this.markSeen(frame.sig);
    if (frame.ttl > 1) {
      const fwd: GossipFrame = { ...frame, ttl: frame.ttl - 1 };
      for (const n of this.o.neighbors()) if (n !== from && n !== frame.author) this.o.send(n, fwd);
    }
    this.o.deliver(frame, body, from);
    return true;
  }

  private markSeen(key: string): void {
    const now = this.now();
    this.seen.set(key, now);
    if (this.seen.size > 4096) {
      for (const [k, t] of this.seen) if (now - t > 2 * MAX_SKEW_MS) this.seen.delete(k);
    }
  }
}

/** Stable pseudo-random rank of `id` relative to `target` (XOR distance on the hex ids). */
export function distance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 8; i++)
    d = d * 16 + (Number.parseInt(a[i] ?? "0", 16) ^ Number.parseInt(b[i] ?? "0", 16));
  return d;
}

/**
 * When a newcomer says hello on the public transports, only the few members
 * closest to it (XOR distance) answer right away; the others wait and answer
 * only if nobody has linked the newcomer yet. Returns the delay before
 * answering, or null to stay silent.
 */
export function helloResponseDelay(
  me: string,
  newcomer: string,
  members: Iterable<string>,
  fanout = 3,
): number {
  const mine = distance(me, newcomer);
  let closer = 0;
  for (const m of members) if (m !== me && m !== newcomer && distance(m, newcomer) < mine) closer++;
  return closer < fanout ? Math.random() * 300 : 3000 + Math.random() * 2000;
}

/**
 * Picks who to link with next: members we must reach directly (media,
 * transfers) first, then random members until the target degree is met.
 */
export function chooseLinks(opts: {
  me: string;
  linked: ReadonlySet<string>;
  pending: ReadonlySet<string>;
  members: readonly string[];
  required: readonly string[];
  degree?: number;
}): string[] {
  const degree = opts.degree ?? TARGET_DEGREE;
  const out: string[] = [];
  const busy = (id: string) =>
    id === opts.me || opts.linked.has(id) || opts.pending.has(id) || out.includes(id);
  for (const id of opts.required) if (!busy(id)) out.push(id);
  let have = opts.linked.size + opts.pending.size + out.length;
  const candidates = opts.members.filter((id) => !busy(id));
  // Deterministic shuffle per pair so both ends tend to agree on who links with whom.
  candidates.sort((x, y) => distance(opts.me, x) - distance(opts.me, y));
  for (const id of candidates) {
    if (have >= degree) break;
    out.push(id);
    have++;
  }
  return out;
}
