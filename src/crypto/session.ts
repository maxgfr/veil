/**
 * Pairwise end-to-end layer on top of DTLS.
 *
 * Every member has an ephemeral Ed25519 identity; its peerId is a hash of the
 * public key, so ids are self-certifying. When two peers connect, each sends a
 * Handshake hello over the (already DTLS-encrypted) control channel: a fresh
 * X25519 key signed with its identity, together with both DTLS fingerprints.
 * The ECDH secret is expanded with HKDF salted by the room's bindKey and bound
 * to both fingerprints, so the session only exists between the two endpoints
 * of that exact DTLS association, inside that exact room.
 *
 * SecureChannel then encrypts every DataChannel message with AES-GCM using a
 * strictly increasing 64-bit counter as nonce: replays and reordering are
 * rejected.
 */
import { AeadError } from "./aead";
import { type Bytes, bytes, concat, readU64, sha256, toHex, u64, utf8 } from "./bytes";
import { hkdf } from "./room";

export interface Identity {
  peerId: string;
  edPub: Bytes;
  sign(data: Uint8Array): Promise<Bytes>;
}

export const PEER_ID_LENGTH = 20;

export async function peerIdOf(edPub: Uint8Array): Promise<string> {
  return toHex(await sha256(concat(utf8("veil/id/v1"), edPub))).slice(0, PEER_ID_LENGTH);
}

export function isPeerId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{20}$/.test(s);
}

export async function createIdentity(): Promise<Identity> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const edPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const peerId = await peerIdOf(edPub);
  return {
    peerId,
    edPub,
    async sign(data) {
      return new Uint8Array(
        await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, bytes(data)),
      );
    },
  };
}

const edKeyCache = new Map<string, Promise<CryptoKey>>();

export async function verifyEd25519(
  edPub: Uint8Array,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  if (edPub.length !== 32 || sig.length !== 64) return false;
  const id = toHex(edPub);
  let key = edKeyCache.get(id);
  if (!key) {
    key = crypto.subtle.importKey("raw", bytes(edPub), { name: "Ed25519" }, false, ["verify"]);
    edKeyCache.set(id, key);
    if (edKeyCache.size > 4096) edKeyCache.delete(edKeyCache.keys().next().value as string);
  }
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, await key, bytes(sig), bytes(data));
  } catch {
    return false;
  }
}

/** "sha-256 ab:cd:…" → "sha-256 AB:CD:…" (fingerprints are compared byte for byte). */
export function normalizeFingerprint(fp: string): string {
  const [alg = "", value = ""] = fp.trim().split(/\s+/);
  return `${alg.toLowerCase()} ${value.toUpperCase()}`;
}

export interface HandshakeHello {
  edPub: Bytes;
  xPub: Bytes;
  sig: Bytes;
}

export interface HandshakeParams {
  identity: Identity;
  remotePeerId: string;
  localFp: string;
  remoteFp: string;
  bindKey: Uint8Array;
}

export class HandshakeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "HandshakeError";
  }
}

async function transcript(
  bindKey: Uint8Array,
  xPub: Uint8Array,
  ownFp: string,
  otherFp: string,
): Promise<Bytes> {
  return concat(
    utf8("veil/hs/v1"),
    await sha256(bindKey),
    xPub,
    utf8(`${normalizeFingerprint(ownFp)}|${normalizeFingerprint(otherFp)}`),
  );
}

export class Handshake {
  private constructor(
    private readonly p: HandshakeParams,
    private readonly xPriv: CryptoKey,
    readonly hello: HandshakeHello,
  ) {}

  static async start(p: HandshakeParams): Promise<Handshake> {
    const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    const xPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const sig = await p.identity.sign(await transcript(p.bindKey, xPub, p.localFp, p.remoteFp));
    return new Handshake(p, kp.privateKey, { edPub: p.identity.edPub, xPub, sig });
  }

  async finish(remote: HandshakeHello): Promise<PeerSession> {
    const { identity, remotePeerId, localFp, remoteFp, bindKey } = this.p;
    if (remote.xPub.length !== 32) throw new HandshakeError("bad key");
    if ((await peerIdOf(remote.edPub)) !== remotePeerId)
      throw new HandshakeError("identity mismatch");
    const ok = await verifyEd25519(
      remote.edPub,
      remote.sig,
      await transcript(bindKey, remote.xPub, remoteFp, localFp),
    );
    if (!ok) throw new HandshakeError("bad signature");

    const theirX = await crypto.subtle.importKey(
      "raw",
      bytes(remote.xPub),
      { name: "X25519" },
      false,
      [],
    );
    let shared: Bytes;
    try {
      shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: "X25519", public: theirX }, this.xPriv, 256),
      );
    } catch {
      throw new HandshakeError("bad key");
    }
    if (shared.every((b) => b === 0)) throw new HandshakeError("bad key");

    const meLow = identity.peerId < remotePeerId;
    const [loX, hiX] = meLow ? [this.hello.xPub, remote.xPub] : [remote.xPub, this.hello.xPub];
    const [loFp, hiFp] = meLow ? [localFp, remoteFp] : [remoteFp, localFp];
    const secret = await hkdf(
      shared,
      bindKey,
      concat(
        utf8("veil/session/v1"),
        loX,
        hiX,
        utf8(`${normalizeFingerprint(loFp)}|${normalizeFingerprint(hiFp)}`),
      ),
    );
    return new PeerSession(secret, identity, remotePeerId, remote.edPub, localFp, remoteFp);
  }
}

export class PeerSession {
  constructor(
    private readonly secret: Bytes,
    readonly identity: Identity,
    readonly remotePeerId: string,
    readonly remoteEdPub: Bytes,
    readonly localFp: string,
    readonly remoteFp: string,
  ) {}

  private key(label: string, from: string, to: string): Promise<CryptoKey> {
    return hkdf(this.secret, utf8("veil/v1"), `chan/${label}/${from}>${to}`).then((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
    );
  }

  /** One SecureChannel per DataChannel label, with its own keys and counters. */
  async channel(label: string): Promise<SecureChannel> {
    const me = this.identity.peerId;
    const them = this.remotePeerId;
    const [send, recv] = await Promise.all([this.key(label, me, them), this.key(label, them, me)]);
    return new SecureChannel(send, recv);
  }
}

/** Counter-mode AEAD channel: msg = counter(8) || AES-GCM(ct, nonce = 0^4 || counter, aad = counter). */
export class SecureChannel {
  private sendCounter = 0;
  private recvCounter = -1;

  constructor(
    private readonly sendKey: CryptoKey,
    private readonly recvKey: CryptoKey,
  ) {}

  async encrypt(plaintext: Uint8Array): Promise<Bytes> {
    const ctr = u64(this.sendCounter++);
    const iv = concat(new Uint8Array(4), ctr);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: ctr },
      this.sendKey,
      bytes(plaintext),
    );
    return concat(ctr, new Uint8Array(ct));
  }

  async decrypt(msg: Uint8Array): Promise<Bytes> {
    if (msg.length < 8 + 16) throw new AeadError();
    const ctrBytes = bytes(msg.slice(0, 8));
    const n = readU64(ctrBytes);
    if (n <= this.recvCounter) throw new AeadError();
    let pt: ArrayBuffer;
    try {
      pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: concat(new Uint8Array(4), ctrBytes), additionalData: ctrBytes },
        this.recvKey,
        bytes(msg.slice(8)),
      );
    } catch {
      throw new AeadError();
    }
    // Re-check after the await: a concurrent call may have advanced the counter.
    if (n <= this.recvCounter) throw new AeadError();
    this.recvCounter = n;
    return new Uint8Array(pt);
  }
}
