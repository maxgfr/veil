/** AES-256-GCM with a 96-bit random nonce: sealed = nonce || ciphertext+tag. */
import { type Bytes, bytes, concat, randomBytes } from "./bytes";

export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;

export class AeadError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "AeadError";
  }
}

export function importAesKey(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("AES key must be 32 bytes");
  return crypto.subtle.importKey("raw", bytes(raw), { name: "AES-GCM" }, extractable, [
    "encrypt",
    "decrypt",
  ]);
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: Uint8Array,
): Promise<Bytes> {
  const iv = randomBytes(NONCE_BYTES);
  const params: AesGcmParams = { name: "AES-GCM", iv };
  if (aad) params.additionalData = bytes(aad);
  const ct = await crypto.subtle.encrypt(params, key, bytes(plaintext));
  return concat(iv, new Uint8Array(ct));
}

export async function open(key: CryptoKey, sealed: Uint8Array, aad?: Uint8Array): Promise<Bytes> {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new AeadError();
  const params: AesGcmParams = { name: "AES-GCM", iv: bytes(sealed.slice(0, NONCE_BYTES)) };
  if (aad) params.additionalData = bytes(aad);
  try {
    const pt = await crypto.subtle.decrypt(params, key, bytes(sealed.slice(NONCE_BYTES)));
    return new Uint8Array(pt);
  } catch {
    throw new AeadError();
  }
}
