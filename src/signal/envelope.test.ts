import { describe, expect, test } from "bun:test";
import { importAesKey } from "../crypto/aead";
import { randomBytes } from "../crypto/bytes";
import { createIdentity } from "../crypto/session";
import { EnvelopeOpener, expandSdp, MAX_AGE_MS, minimizeSdp, sealEnvelope } from "./envelope";

const FROM = await createIdentity();
const TO = "fedcba9876543210fedc";
const SDP = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB\r\n";

async function setup() {
  const key = await importAesKey(randomBytes(32));
  const topic = randomBytes(32);
  return { key, topic, opener: new EnvelopeOpener(key) };
}

describe("envelope", () => {
  test("round-trips a message, SDP included, byte for byte", async () => {
    const { key, topic, opener } = await setup();
    const { wire, message } = await sealEnvelope(key, topic, FROM, {
      kind: "offer",
      to: TO,
      sdp: SDP,
    });
    expect(wire.startsWith(`${FROM.peerId}.`)).toBe(true);
    expect(wire).not.toContain("fingerprint");
    expect(wire).not.toContain(TO);
    const got = await opener.open(wire, topic);
    expect(got).toEqual(message);
    expect(got?.sdp).toBe(SDP);
  });

  test("an envelope forged with another key is rejected", async () => {
    const { topic, opener } = await setup();
    const other = await importAesKey(randomBytes(32));
    const { wire } = await sealEnvelope(other, topic, FROM, { kind: "hello" });
    expect(await opener.open(wire, topic)).toBeNull();
  });

  test("tampering, a wrong topic or a spoofed sender is rejected", async () => {
    const { key, topic, opener } = await setup();
    const { wire } = await sealEnvelope(key, topic, FROM, { kind: "hello" });
    const last = wire.at(-2) === "A" ? "B" : "A";
    expect(await opener.open(`${wire.slice(0, -2)}${last}${wire.at(-1)}`, topic)).toBeNull();
    expect(await opener.open(wire, randomBytes(32))).toBeNull();
    expect(await opener.open(TO + wire.slice(20), topic)).toBeNull();
    expect(await opener.open("garbage", topic)).toBeNull();
  });

  test("stale and future timestamps are rejected", async () => {
    const { key, topic, opener } = await setup();
    const old = await sealEnvelope(
      key,
      topic,
      FROM,
      { kind: "hello" },
      Date.now() - MAX_AGE_MS - 1000,
    );
    const future = await sealEnvelope(
      key,
      topic,
      FROM,
      { kind: "hello" },
      Date.now() + MAX_AGE_MS + 1000,
    );
    expect(await opener.open(old.wire, topic)).toBeNull();
    expect(await opener.open(future.wire, topic)).toBeNull();
  });

  test("a replayed envelope is rejected", async () => {
    const { key, topic, opener } = await setup();
    const { wire } = await sealEnvelope(key, topic, FROM, { kind: "hello" });
    expect(await opener.open(wire, topic)).not.toBeNull();
    expect(await opener.open(wire, topic)).toBeNull();
  });

  test("a member cannot speak for another member", async () => {
    const { key, topic, opener } = await setup();
    const victim = await createIdentity();
    const mallory = await createIdentity();
    // Claims the victim's id with its own key: the key does not hash to that id.
    const borrowedId = { peerId: victim.peerId, edPub: mallory.edPub, sign: mallory.sign };
    const a = await sealEnvelope(key, topic, borrowedId, { kind: "bye" });
    expect(await opener.open(a.wire, topic)).toBeNull();
    // Presents the victim's public key but cannot produce its signature.
    const borrowedKey = { peerId: victim.peerId, edPub: victim.edPub, sign: mallory.sign };
    const b = await sealEnvelope(key, topic, borrowedKey, { kind: "bye" });
    expect(await opener.open(b.wire, topic)).toBeNull();
    // The genuine sender still gets through.
    const c = await sealEnvelope(key, topic, victim, { kind: "bye" });
    expect((await opener.open(c.wire, topic))?.from).toBe(victim.peerId);
  });

  test("SDP minimization is lossless", () => {
    expect(expandSdp(minimizeSdp(SDP))).toBe(SDP);
  });
});
