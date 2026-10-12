/**
 * Group encryption with sender keys.
 *
 * Each member encrypts its messages (and media frames) once, with its own
 * random 256-bit sender key; relayed copies are therefore end-to-end
 * encrypted for the room members only, and intermediate peers can neither
 * read nor forge them (frames are also signed with the author's Ed25519 key).
 *
 * A sender key is distributed by wrapping it for every member with a pairwise
 * key: X25519 between the members' static session keys, expanded by HKDF and
 * bound to the room. It is rotated whenever someone leaves (the departed
 * member never receives the new key) and every 10 minutes or 10 000 messages.
 */
import { open, seal } from "./aead";
import {
  type Bytes,
  bytes,
  concat,
  fromB64u,
  randomBytes,
  readU32,
  toB64u,
  toHex,
  u32,
  utf8,
} from "./bytes";
import { hkdf } from "./room";
import type { Identity } from "./session";

export const ROTATE_MS = 10 * 60_000;
export const ROTATE_MESSAGES = 10_000;
/** Keys kept per remote author, so in-flight messages survive a rotation. */
const KEEP_REMOTE_KEYS = 4;

export interface StaticKey {
  pub: Bytes;
  priv: CryptoKey;
}

export async function createStaticKey(): Promise<StaticKey> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return {
    pub: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
    priv: kp.privateKey,
  };
}

/**
 * Symmetric pairwise key between two members, bound to the room (bindKey),
 * both ids and both public keys. Cached: it never changes during a session.
 */
export class PairKeys {
  private readonly cache = new Map<string, Promise<CryptoKey>>();

  constructor(
    private readonly me: { peerId: string; key: StaticKey },
    private readonly bindKey: Uint8Array,
  ) {}

  get(peerId: string, theirPub: Uint8Array, purpose: string): Promise<CryptoKey> {
    const id = `${purpose}|${peerId}|${toHex(theirPub)}`;
    let k = this.cache.get(id);
    if (!k) {
      k = this.derive(peerId, theirPub, purpose);
      this.cache.set(id, k);
      // A failed derivation must not stay cached.
      k.catch(() => this.cache.delete(id));
    }
    return k;
  }

  private async derive(peerId: string, theirPub: Uint8Array, purpose: string): Promise<CryptoKey> {
    if (theirPub.length !== 32) throw new Error("bad public key");
    const pub = await crypto.subtle.importKey(
      "raw",
      bytes(theirPub),
      { name: "X25519" },
      false,
      [],
    );
    const shared = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "X25519", public: pub }, this.me.key.priv, 256),
    );
    if (shared.every((b) => b === 0)) throw new Error("bad public key");
    const mine = { id: this.me.peerId, pub: this.me.key.pub };
    const theirs = { id: peerId, pub: theirPub };
    const [lo, hi] = mine.id < theirs.id ? [mine, theirs] : [theirs, mine];
    const raw = await hkdf(
      shared,
      this.bindKey,
      concat(utf8(`veil/pair/v1/${purpose}|${lo.id}|${hi.id}|`), lo.pub, hi.pub),
    );
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
}

interface KeyEntry {
  keyId: number;
  raw: Bytes;
  key: CryptoKey;
}

interface OwnKey extends KeyEntry {
  createdAt: number;
  count: number;
}

export interface Wrapped {
  keyId: number;
  xPub: string;
  wraps: Record<string, string>;
}

async function entry(keyId: number, raw: Bytes): Promise<KeyEntry> {
  const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { keyId, raw, key };
}

function wrapAad(author: string, recipient: string, keyId: number): Bytes {
  return concat(utf8(`veil/skwrap/v1|${author}|${recipient}|`), u32(keyId));
}

function dataAad(author: string, keyId: number): Bytes {
  return concat(utf8(`veil/sk/v1|${author}|`), u32(keyId));
}

export type DecryptResult = { ok: Bytes } | { unknownKey: number } | { invalid: true };

export class SenderKeys {
  private current!: OwnKey;
  private readonly remote = new Map<string, KeyEntry[]>();
  readonly pairs: PairKeys;

  private constructor(
    readonly identity: Identity,
    readonly staticKey: StaticKey,
    bindKey: Uint8Array,
    private readonly now: () => number,
  ) {
    this.pairs = new PairKeys({ peerId: identity.peerId, key: staticKey }, bindKey);
  }

  static async create(
    identity: Identity,
    bindKey: Uint8Array,
    now: () => number = Date.now,
  ): Promise<SenderKeys> {
    const sk = new SenderKeys(identity, await createStaticKey(), bindKey, now);
    await sk.rotate();
    return sk;
  }

  get xPub(): string {
    return toB64u(this.staticKey.pub);
  }

  get keyId(): number {
    return this.current.keyId;
  }

  /** Raw key material of the current own key (used to derive the media key). */
  get currentRaw(): Bytes {
    return this.current.raw;
  }

  needsRotation(): boolean {
    return (
      this.now() - this.current.createdAt >= ROTATE_MS || this.current.count >= ROTATE_MESSAGES
    );
  }

  async rotate(): Promise<void> {
    let keyId = readU32(randomBytes(4));
    if (this.current && keyId === this.current.keyId) keyId = (keyId + 1) >>> 0;
    this.current = { ...(await entry(keyId, randomBytes(32))), createdAt: this.now(), count: 0 };
  }

  /** Wraps the current key for each recipient (by static X25519 public key). */
  async wrap(recipients: readonly { peerId: string; xPub: Uint8Array }[]): Promise<Wrapped> {
    const me = this.identity.peerId;
    const { keyId, raw } = this.current;
    const wraps: Record<string, string> = {};
    await Promise.all(
      recipients
        .filter((r) => r.peerId !== me)
        .map(async (r) => {
          const k = await this.pairs.get(r.peerId, r.xPub, "sk");
          wraps[r.peerId] = toB64u(await seal(k, raw, wrapAad(me, r.peerId, keyId)));
        }),
    );
    return { keyId, xPub: this.xPub, wraps };
  }

  /** Stores the key `author` wrapped for us. Returns false if there is none for us or it is invalid. */
  async receive(author: string, body: Wrapped): Promise<boolean> {
    const me = this.identity.peerId;
    const wrapped = body.wraps[me];
    if (!wrapped || author === me) return false;
    try {
      const k = await this.pairs.get(author, fromB64u(body.xPub), "sk");
      const raw = await open(k, fromB64u(wrapped), wrapAad(author, me, body.keyId));
      if (raw.length !== 32) return false;
      const list = this.remote.get(author) ?? [];
      if (!list.some((e) => e.keyId === body.keyId)) {
        list.unshift(await entry(body.keyId, raw));
        list.length = Math.min(list.length, KEEP_REMOTE_KEYS);
      }
      this.remote.set(author, list);
      return true;
    } catch {
      return false;
    }
  }

  hasKey(author: string, keyId: number): boolean {
    return this.remote.get(author)?.some((e) => e.keyId === keyId) ?? false;
  }

  /** Remote keys of an author, newest first (for the media worker). */
  remoteKeys(author: string): readonly { keyId: number; raw: Bytes }[] {
    return this.remote.get(author) ?? [];
  }

  /** data = keyId (4) || AES-GCM(payload). */
  async encrypt(payload: Uint8Array): Promise<Bytes> {
    const { keyId, key } = this.current;
    this.current.count++;
    return concat(u32(keyId), await seal(key, payload, dataAad(this.identity.peerId, keyId)));
  }

  async decrypt(author: string, data: Uint8Array): Promise<DecryptResult> {
    if (data.length < 4) return { invalid: true };
    const keyId = readU32(data);
    const e = this.remote.get(author)?.find((x) => x.keyId === keyId);
    if (!e) return { unknownKey: keyId };
    try {
      return { ok: await open(e.key, data.subarray(4), dataAad(author, keyId)) };
    } catch {
      return { invalid: true };
    }
  }

  forget(author: string): void {
    this.remote.delete(author);
  }
}
