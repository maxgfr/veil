/**
 * Room secrets. A room is a 256-bit random key carried in the link's
 * #fragment (never sent to any server). Everything else is derived from it
 * with HKDF-SHA256, optionally mixed with a passphrase stretched by PBKDF2.
 *
 *   master  = key                                  (no passphrase)
 *           = HKDF-extract(key || PBKDF2(pass))     (passphrase)
 *   topic_d = HKDF(master, "topic/<utc day>")      public rendezvous id, rotates daily
 *   sigKey  = HKDF(master, "sig")                  AES-GCM key for signaling envelopes
 *   sasSalt = HKDF(master, "sas")                  salt for the emoji verification
 *   bindKey = HKDF(master, "bind")                 binds pairwise sessions to the room
 */
import { importAesKey } from "./aead";
import { type Bytes, bytes, concat, fromB64u, toB64u, toHex, utf8 } from "./bytes";

export const ROOM_KEY_BYTES = 32;
export const PBKDF2_ITERATIONS = 600_000;
const DAY_MS = 86_400_000;
const SALT = utf8("veil/v1");

export function newRoomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(ROOM_KEY_BYTES));
}

export function encodeRoomKey(key: Uint8Array): string {
  return toB64u(key);
}

/** Builds the share link. `base` is the app URL without fragment. */
export function roomLink(base: string, key: Uint8Array): string {
  return `${base.split("#")[0]}#${encodeRoomKey(key)}`;
}

/** Accepts a full link, a "#fragment" or a bare key. Returns null if invalid. */
export function parseRoomLink(input: string): Bytes | null {
  const s = input.trim();
  const frag = s.includes("#") ? s.slice(s.lastIndexOf("#") + 1) : s;
  if (!/^[A-Za-z0-9_-]{43}$/.test(frag)) return null;
  try {
    const key = fromB64u(frag);
    return key.length === ROOM_KEY_BYTES ? key : null;
  } catch {
    return null;
  }
}

export function utcDay(ms: number = Date.now()): number {
  return Math.floor(ms / DAY_MS);
}

export async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string | Uint8Array,
  length = 32,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey("raw", bytes(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: bytes(salt),
      info: typeof info === "string" ? utf8(info) : bytes(info),
    },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function pbkdf2(
  passphrase: string,
  salt: Uint8Array,
  iterations = PBKDF2_ITERATIONS,
): Promise<Bytes> {
  const base = await crypto.subtle.importKey(
    "raw",
    utf8(passphrase.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export interface RoomSecrets {
  sigKey: CryptoKey;
  sasSalt: Bytes;
  bindKey: Bytes;
  /** Rendezvous topic for a UTC day (cached). */
  topic(day: number): Promise<Bytes>;
}

async function masterSecret(key: Uint8Array, passphrase?: string): Promise<Bytes> {
  if (key.length !== ROOM_KEY_BYTES) throw new Error("room key must be 32 bytes");
  if (!passphrase) return bytes(key);
  const stretched = await pbkdf2(passphrase, concat(utf8("veil/v1/passphrase"), key));
  return hkdf(concat(key, stretched), SALT, "master");
}

export async function deriveRoomSecrets(
  key: Uint8Array,
  passphrase?: string,
): Promise<RoomSecrets> {
  const master = await masterSecret(key, passphrase);
  const [sig, sasSalt, bindKey] = await Promise.all([
    hkdf(master, SALT, "sig"),
    hkdf(master, SALT, "sas"),
    hkdf(master, SALT, "bind"),
  ]);
  const sigKey = await importAesKey(sig);
  const topics = new Map<number, Promise<Bytes>>();
  return {
    sigKey,
    sasSalt,
    bindKey,
    topic(day) {
      let t = topics.get(day);
      if (!t) {
        t = hkdf(master, SALT, `topic/${day}`);
        topics.set(day, t);
      }
      return t;
    },
  };
}

export interface DerivedRoom {
  topic: Bytes;
  topicHex: string;
  sigKey: CryptoKey;
  sasSalt: Bytes;
  bindKey: Bytes;
}

export async function deriveRoom(
  key: Uint8Array,
  passphrase: string | undefined,
  day: number,
): Promise<DerivedRoom> {
  const s = await deriveRoomSecrets(key, passphrase);
  const topic = await s.topic(day);
  return {
    topic,
    topicHex: toHex(topic),
    sigKey: s.sigKey,
    sasSalt: s.sasSalt,
    bindKey: s.bindKey,
  };
}
