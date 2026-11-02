/**
 * Migration only: opens what the previous version sealed itself, under its own
 * device key (IndexedDB `veil-secrets`), so it can be sealed again by
 * `sealedStore` (secrets.ts). Never seals and never makes a key. Once nothing
 * sealed that way is left in localStorage, the old database is deleted.
 */
import { fromB64u, fromUtf8, utf8 } from "../crypto/bytes";

const DB = "veil-secrets";
const STORE = "kv";
const KEY_ID = "device-key";

/** localStorage keys the previous version sealed under its device key. */
export const LEGACY_SEALED = ["veil.meetings.v2", "veil.turn.v1"] as const;

/**
 * The plain text; "gone" when it can never be opened (no old key left, or the
 * text is damaged), so it can be dropped; "later" when storage is out of reach
 * for now, so it must be kept.
 */
export type LegacyOpened = { plain: string } | "gone" | "later";
export type LegacyOpener = (sealed: string, label: string) => Promise<LegacyOpened>;

function oldKey(): Promise<CryptoKey | undefined> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    // No database yet: do not make one, there is no key to find.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onerror = () => (req.error?.name === "AbortError" ? resolve(undefined) : reject(req.error));
    req.onsuccess = () => {
      const db = req.result;
      try {
        const get = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY_ID);
        get.onsuccess = () => resolve(get.result as CryptoKey | undefined);
        get.onerror = () => reject(get.error);
      } catch (err) {
        reject(err);
      } finally {
        db.close();
      }
    };
  });
}

export const openLegacy: LegacyOpener = async (sealed, label) => {
  let key: CryptoKey | undefined;
  try {
    key = await oldKey();
  } catch {
    return "later";
  }
  if (!key) return "gone";
  try {
    const b = fromB64u(sealed);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b.subarray(0, 12), additionalData: utf8(label) },
      key,
      b.subarray(12),
    );
    return { plain: fromUtf8(new Uint8Array(pt)) };
  } catch {
    return "gone";
  }
};

/** Deletes the old device key once nothing sealed with it is left in `storage`. */
export function forgetLegacyKey(storage: Pick<Storage, "getItem">): void {
  try {
    if (LEGACY_SEALED.some((k) => storage.getItem(k) !== null)) return;
    if (typeof indexedDB !== "undefined") indexedDB.deleteDatabase(DB);
  } catch {
    // Storage out of reach: tried again on the next visit.
  }
}
