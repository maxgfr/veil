/** Byte helpers. Everything is `Uint8Array<ArrayBuffer>` so it is a valid WebCrypto BufferSource. */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

export function utf8(s: string): Bytes {
  return enc.encode(s) as Bytes;
}

export function fromUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function bytes(b: Uint8Array | ArrayBuffer): Bytes {
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (b.buffer instanceof ArrayBuffer) return b as Bytes;
  return new Uint8Array(b) as Bytes;
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  // getRandomValues is limited to 64 KiB per call.
  for (let i = 0; i < n; i += 65536)
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

export function concat(...parts: Uint8Array[]): Bytes {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

export function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(s)) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_REV = new Int16Array(128).fill(-1);
for (let i = 0; i < B64U.length; i++) B64U_REV[B64U.charCodeAt(i)] = i;

export function toB64u(b: Uint8Array): string {
  let s = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8) | (b[i + 2] as number);
    s +=
      B64U.charAt(n >> 18) +
      B64U.charAt((n >> 12) & 63) +
      B64U.charAt((n >> 6) & 63) +
      B64U.charAt(n & 63);
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = (b[i] as number) << 16;
    s += B64U.charAt(n >> 18) + B64U.charAt((n >> 12) & 63);
  } else if (rest === 2) {
    const n = ((b[i] as number) << 16) | ((b[i + 1] as number) << 8);
    s += B64U.charAt(n >> 18) + B64U.charAt((n >> 12) & 63) + B64U.charAt((n >> 6) & 63);
  }
  return s;
}

export function fromB64u(s: string): Bytes {
  if (s.length % 4 === 1) throw new Error("invalid base64url");
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? (B64U_REV[c] as number) : -1;
    if (v < 0) throw new Error("invalid base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Canonical encodings only: leftover bits must be zero, so one byte string has one spelling
  // (otherwise "the same" signature could be written 16 ways and slip past de-duplication).
  if ((acc & ((1 << bits) - 1)) !== 0) throw new Error("invalid base64url");
  return out.subarray(0, o) as Bytes;
}

/** Constant-time equality (for MACs, keys and fingerprints). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** Lexicographic order, used to make pairwise derivations symmetric. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function u32(n: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
}

export function u64(n: number): Bytes {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

export function readU32(b: Uint8Array, off = 0): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off);
}

export function readU64(b: Uint8Array, off = 0): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("counter overflow");
  return Number(v);
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(data)));
}
