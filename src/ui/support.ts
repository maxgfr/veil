/**
 * Can this browser open a room? Rooms need WebCrypto Ed25519 and X25519,
 * WebRTC and raw-deflate streams. iOS 16 and older (and every in-app browser
 * built on it) lack some of them, and would otherwise fail with a vague error.
 */

export const INSECURE_CONTEXT =
  "This page was opened over plain http://, so the browser disables encryption. Open it over https:// or on localhost.";

export const UNSUPPORTED =
  "This browser can't open Veil rooms (it needs iOS 17+ or a recent Chrome, Firefox or Safari). If you opened the link inside an app, open it in your browser instead.";

let cached: Promise<string | null> | null = null;

/** Null when this browser can open rooms, otherwise what to tell the user. Probed once. */
export function checkSupport(): Promise<string | null> {
  cached ??= probeSupport();
  return cached;
}

/** The uncached probe (tests). */
export async function probeSupport(): Promise<string | null> {
  // Plain http:// on a LAN address (not localhost): the browser withholds WebCrypto.
  if (!globalThis.crypto?.subtle) return INSECURE_CONTEXT;
  try {
    if (typeof globalThis.RTCPeerConnection !== "function") return UNSUPPORTED;
    new CompressionStream("deflate-raw");
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
    return null;
  } catch {
    return UNSUPPORTED;
  }
}
