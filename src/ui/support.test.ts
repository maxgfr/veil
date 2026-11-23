import { afterEach, describe, expect, test } from "bun:test";
import { checkSupport, probeSupport, UNSUPPORTED } from "./support";

const g = globalThis as { RTCPeerConnection?: unknown };
const original = g.RTCPeerConnection;

afterEach(() => {
  if (original === undefined) delete g.RTCPeerConnection;
  else g.RTCPeerConnection = original;
});

describe("checkSupport", () => {
  test("a browser without WebRTC cannot open rooms", async () => {
    delete g.RTCPeerConnection;
    expect(await probeSupport()).toBe(UNSUPPORTED);
  });

  test("WebRTC, raw deflate and Ed25519/X25519 are enough", async () => {
    g.RTCPeerConnection = class {};
    expect(await probeSupport()).toBeNull();
  });

  test("a missing algorithm is reported, not thrown", async () => {
    g.RTCPeerConnection = class {};
    const real = crypto.subtle.generateKey.bind(crypto.subtle);
    crypto.subtle.generateKey = (() =>
      Promise.reject(new DOMException("nope", "NotSupportedError"))) as typeof real;
    try {
      expect(await probeSupport()).toBe(UNSUPPORTED);
    } finally {
      crypto.subtle.generateKey = real;
    }
  });

  test("the result is probed once", () => {
    expect(checkSupport()).toBe(checkSupport());
  });
});
