/**
 * Secrets this device keeps between visits: scheduled meetings (their links
 * hold room keys) and a TURN password. Every maxgfr.github.io site shares
 * this origin's storage, so none of them is ever stored in clear: each is
 * sealed by llm-connect's `sealedStore` (AES-GCM 256 under a non-extractable
 * key kept in IndexedDB, `veil-sealed`, the secret's name bound to it), and
 * only the sealed text is kept. A dump of the storage only yields opaque
 * bytes; a script of another site of the origin could still have the browser
 * decrypt them (see SECURITY.md).
 */
import { type SealedStore, sealedStore } from "llm-connect";
import { concat, fromB64u, toB64u } from "../crypto/bytes";

export interface Sealer {
  /** Rejects when it cannot seal (no IndexedDB or WebCrypto). */
  seal(plain: string): Promise<string>;
  /** Rejects when the text cannot be opened (another key, tampered, no storage). */
  open(sealed: string): Promise<string>;
}

export const secrets: SealedStore = sealedStore({ dbName: "veil-sealed" });

const IV = 12;
const TAG = 16;

/** Seals as text under `name`, so one secret cannot be passed off as another. */
export function sealerFor(
  name: string,
  store: Pick<SealedStore, "seal" | "unseal"> = secrets,
): Sealer {
  return {
    async seal(plain) {
      const { iv, ciphertext } = await store.seal(name, plain);
      return toB64u(concat(iv, new Uint8Array(ciphertext)));
    },
    async open(sealed) {
      const b = fromB64u(sealed);
      if (b.length < IV + TAG) throw new Error("sealed text too short");
      const plain = await store.unseal(name, {
        v: 2,
        iv: b.slice(0, IV),
        ciphertext: b.slice(IV).buffer,
      });
      if (plain === null) throw new Error("sealed text does not open");
      return plain;
    },
  };
}
