import { describe, expect, test } from "bun:test";
import { randomBytes } from "../crypto/bytes";
import { clearBytes, decryptFrame, encryptFrame, TRAILER_BYTES } from "../workers/e2ee-worker";
import { mediaKey, pickVideoSources, videoBudget } from "./media";

const aes = async (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

describe("media E2EE frames", () => {
  test("encrypt/decrypt round-trip keeps the codec header in the clear", async () => {
    const key = await aes(randomBytes(32));
    for (const [kind, isKey] of [
      ["video", true],
      ["video", false],
      ["audio", false],
    ] as const) {
      const frame = randomBytes(1200);
      const clear = clearBytes(kind, isKey);
      const enc = new Uint8Array(await encryptFrame(frame.slice().buffer, clear, key, 42));
      expect(enc.length).toBe(frame.length + 16 + TRAILER_BYTES);
      expect(enc.subarray(0, clear)).toEqual(frame.subarray(0, clear));
      expect(enc.subarray(clear, clear + 32)).not.toEqual(frame.subarray(clear, clear + 32));
      const dec = await decryptFrame(enc.buffer, clear, (id) => (id === 42 ? key : undefined));
      expect(new Uint8Array(dec as ArrayBuffer)).toEqual(frame);
    }
  });

  test("tampered frames, wrong keys and unknown key ids are dropped", async () => {
    const key = await aes(randomBytes(32));
    const other = await aes(randomBytes(32));
    const enc = new Uint8Array(await encryptFrame(randomBytes(500).buffer, 3, key, 7));
    expect(await decryptFrame(enc.buffer, 3, () => other)).toBeNull();
    expect(await decryptFrame(enc.buffer, 3, () => undefined)).toBeNull();
    const header = enc.slice();
    header[0] = (header[0] as number) ^ 1;
    expect(await decryptFrame(header.buffer, 3, () => key)).toBeNull();
    expect(await decryptFrame(new Uint8Array(10).buffer, 3, () => key)).toBeNull();
  });

  test("tiny frames (shorter than the clear header) still round-trip", async () => {
    const key = await aes(randomBytes(32));
    const frame = randomBytes(2);
    const enc = await encryptFrame(frame.slice().buffer, 10, key, 1);
    // The receiver bounds the clear prefix by the payload length, exactly like the sender.
    const dec = await decryptFrame(enc, 10, () => key);
    expect(new Uint8Array(dec as ArrayBuffer)).toEqual(frame);
  });

  test("media keys are derived from, and differ from, the sender key", async () => {
    const sk = randomBytes(32);
    const mk = await mediaKey(sk);
    expect(mk.length).toBe(32);
    expect(mk).not.toEqual(sk);
    expect(await mediaKey(sk)).toEqual(mk);
  });
});

describe("media budget", () => {
  test("bitrate per receiver shrinks with the audience and resolution follows", () => {
    const one = videoBudget({ uplinkBps: 5_000_000, videoReceivers: 1, cores: 8 });
    const many = videoBudget({ uplinkBps: 5_000_000, videoReceivers: 20, cores: 8 });
    expect(one.maxBitrate).toBe(1_500_000);
    expect(one.scaleResolutionDownBy).toBe(1);
    expect(many.maxBitrate).toBeLessThan(250_000);
    expect(many.scaleResolutionDownBy).toBe(4);
    expect(videoBudget({ uplinkBps: 0, videoReceivers: 50, cores: 2 }).maxBitrate).toBe(80_000);
    expect(videoBudget({ uplinkBps: 1e6, videoReceivers: 1, cores: 2 }).maxVideoIn).toBe(4);
  });

  test("video goes to screen shares first, then the most recent speakers", () => {
    const picks = pickVideoSources(
      [
        { peerId: "a", lastSpoke: 10, screen: false, video: true },
        { peerId: "b", lastSpoke: 50, screen: false, video: true },
        { peerId: "c", lastSpoke: 0, screen: true, video: false },
        { peerId: "d", lastSpoke: 99, screen: false, video: false },
        { peerId: "e", lastSpoke: 30, screen: false, video: true },
      ],
      3,
    );
    expect([...picks]).toEqual(["c", "b", "e"]);
  });
});
