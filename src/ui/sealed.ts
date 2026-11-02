/**
 * Secrets this device keeps between visits: scheduled meetings (their links
 * hold room keys) and a TURN password. Every maxgfr.github.io site shares
 * this origin's storage, so none of them is ever stored in clear: each is
 * sealed with AES-GCM under a non-extractable key kept in IndexedDB
 * (`veil-secrets`), apart from the sealed text. A dump of the storage only
 * yields opaque bytes; a script of another site of the origin could still
 * have the browser decrypt them (see SECURITY.md).
 */
import { concat, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../crypto/bytes";

export interface Sealer {
  seal(plain: string): Promise<string>;
  /** Rejects when the text cannot be opened (another key, tampered, no storage). */
  open(sealed: string): Promise<string>;
}

/** Seals under `key()`, bound to `label` so one secret cannot be passed off as another. */
export function sealerFor(key: () => Promise<CryptoKey>, label: string): Sealer {
  const ad = utf8(label);
  return {
    async seal(plain) {
      const iv = randomBytes(12);
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: ad },
        await key(),
        utf8(plain),
      );
      return toB64u(concat(iv, new Uint8Array(ct)));
    },
    async open(sealed) {
      const b = fromB64u(sealed);
      if (b.length < 12 + 16) throw new Error("sealed text too short");
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b.subarray(0, 12), additionalData: ad },
        await key(),
        b.subarray(12),
      );
      return fromUtf8(new Uint8Array(pt));
    },
  };
}

const DB = "veil-secrets";
const STORE = "kv";
const KEY_ID = "device-key";

async function idb<T>(
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

let cached: Promise<CryptoKey> | null = null;

/** This device's sealing key, made on first use. Rejects without IndexedDB or WebCrypto. */
export function deviceKey(): Promise<CryptoKey> {
  if (!cached) {
    cached = (async () => {
      const existing = await idb<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      try {
        // add, not put: when two tabs make one at once, the first one stored wins.
        await idb("readwrite", (s) => s.add(key, KEY_ID));
        return key;
      } catch (err) {
        const first = await idb<CryptoKey | undefined>("readonly", (s) => s.get(KEY_ID));
        if (first) return first;
        throw err;
      }
    })();
    // A failure (storage blocked for now) is retried on the next use.
    cached.catch(() => {
      cached = null;
    });
  }
  return cached;
}
