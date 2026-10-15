import { describe, expect, test } from "bun:test";
import { AeadError } from "./aead";
import { randomBytes, utf8 } from "./bytes";
import {
  createIdentity,
  Handshake,
  HandshakeError,
  normalizeFingerprint,
  type PeerSession,
  peerIdOf,
} from "./session";

const FP_A = "sha-256 AA:BB:CC";
const FP_B = "sha-256 11:22:33";

async function pair(opts: { bindB?: Uint8Array; fpSeenByB?: string } = {}) {
  const bindKey = randomBytes(32);
  const a = await createIdentity();
  const b = await createIdentity();
  const ha = await Handshake.start({
    identity: a,
    remotePeerId: b.peerId,
    localFp: FP_A,
    remoteFp: FP_B,
    bindKey,
  });
  const hb = await Handshake.start({
    identity: b,
    remotePeerId: a.peerId,
    localFp: FP_B,
    remoteFp: opts.fpSeenByB ?? FP_A,
    bindKey: opts.bindB ?? bindKey,
  });
  return { a, b, ha, hb };
}

async function sessions(): Promise<[PeerSession, PeerSession]> {
  const { ha, hb } = await pair();
  return Promise.all([ha.finish(hb.hello), hb.finish(ha.hello)]);
}

describe("session", () => {
  test("peer ids are a hash of the identity key", async () => {
    const id = await createIdentity();
    expect(id.peerId).toMatch(/^[0-9a-f]{20}$/);
    expect(await peerIdOf(id.edPub)).toBe(id.peerId);
  });

  test("both sides derive matching channel keys", async () => {
    const [sa, sb] = await sessions();
    const ca = await sa.channel("chat");
    const cb = await sb.channel("chat");
    expect(new TextDecoder().decode(await cb.decrypt(await ca.encrypt(utf8("hi b"))))).toBe("hi b");
    expect(new TextDecoder().decode(await ca.decrypt(await cb.encrypt(utf8("hi a"))))).toBe("hi a");
  });

  test("channels with different labels do not share keys", async () => {
    const [sa, sb] = await sessions();
    const msg = await (await sa.channel("chat")).encrypt(utf8("x"));
    await expect((await sb.channel("file")).decrypt(msg)).rejects.toBeInstanceOf(AeadError);
  });

  test("replayed and reordered messages are rejected", async () => {
    const [sa, sb] = await sessions();
    const ca = await sa.channel("ctrl");
    const cb = await sb.channel("ctrl");
    const m0 = await ca.encrypt(utf8("0"));
    const m1 = await ca.encrypt(utf8("1"));
    const m2 = await ca.encrypt(utf8("2"));
    await cb.decrypt(m0);
    await cb.decrypt(m2);
    await expect(cb.decrypt(m1)).rejects.toBeInstanceOf(AeadError);
    await expect(cb.decrypt(m2)).rejects.toBeInstanceOf(AeadError);
  });

  test("a tampered message is rejected and does not advance the counter", async () => {
    const [sa, sb] = await sessions();
    const ca = await sa.channel("ctrl");
    const cb = await sb.channel("ctrl");
    const m = await ca.encrypt(utf8("payload"));
    const bad = m.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    await expect(cb.decrypt(bad)).rejects.toBeInstanceOf(AeadError);
    expect(new TextDecoder().decode(await cb.decrypt(m))).toBe("payload");
  });

  test("a hello claiming another identity is rejected", async () => {
    const { ha, hb } = await pair();
    const mallory = await createIdentity();
    await expect(ha.finish({ ...hb.hello, edPub: mallory.edPub })).rejects.toBeInstanceOf(
      HandshakeError,
    );
  });

  test("a forged signature is rejected", async () => {
    const { ha, hb } = await pair();
    const sig = hb.hello.sig.slice();
    sig[0] = (sig[0] as number) ^ 1;
    await expect(ha.finish({ ...hb.hello, sig })).rejects.toBeInstanceOf(HandshakeError);
  });

  test("a tampered SAS commitment is rejected", async () => {
    const { ha, hb } = await pair();
    const commit = hb.hello.commit.slice();
    commit[0] = (commit[0] as number) ^ 1;
    await expect(ha.finish({ ...hb.hello, commit })).rejects.toBeInstanceOf(HandshakeError);
    const { csig: _s, ...unsigned } = hb.hello;
    await expect(ha.finish(unsigned)).rejects.toBeInstanceOf(HandshakeError);
  });

  test("the revealed SAS nonce must open the commitment", async () => {
    const { ha, hb } = await pair();
    const [sa, sb] = await Promise.all([ha.finish(hb.hello), hb.finish(ha.hello)]);
    expect(await sa.reveal(randomBytes(32))).toBe(false);
    expect(await sa.reveal(sb.sas.nonce)).toBe(true);
    expect(await sa.remoteSasNonce).toEqual(sb.sas.nonce);
  });

  test("a peer without a SAS commitment can still connect, but cannot reveal", async () => {
    const { ha, hb } = await pair();
    const { commit: _c, csig: _s, ...old } = hb.hello;
    const sa = await ha.finish(old);
    expect(sa.sas.remoteCommit).toBeNull();
    expect(await sa.reveal(randomBytes(32))).toBe(false);
  });

  test("mismatched DTLS fingerprints (MITM) are rejected", async () => {
    const { ha, hb } = await pair({ fpSeenByB: "sha-256 EE:EE:EE" });
    await expect(ha.finish(hb.hello)).rejects.toBeInstanceOf(HandshakeError);
  });

  test("peers in different rooms cannot talk", async () => {
    const { ha, hb } = await pair({ bindB: randomBytes(32) });
    await expect(ha.finish(hb.hello)).rejects.toBeInstanceOf(HandshakeError);
  });

  test("fingerprints are normalized", () => {
    expect(normalizeFingerprint("  SHA-256 ab:cd ")).toBe("sha-256 AB:CD");
  });
});
