import { describe, expect, test } from "bun:test";
import { FakePC, type FakePeerConnection } from "../../test/fake-rtc";
import { randomBytes, utf8 } from "../crypto/bytes";
import { createIdentity, type Identity } from "../crypto/session";
import { type Description, Peer, type PeerEvents, type PeerState, sdpFingerprint } from "./peer";
import type { CtrlMessage, Frame, GossipFrame } from "./protocol";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await wait(5);
  }
}

interface Side {
  peer: Peer;
  states: PeerState[];
  ctrl: CtrlMessage[];
  gossip: GossipFrame[];
  files: Frame[];
  signals: Description[];
}

function side(
  identity: Identity,
  remoteId: string,
  bindKey: Uint8Array,
  initiator: boolean,
  link: () => Side,
): Side {
  const s = { states: [], ctrl: [], gossip: [], files: [], signals: [] } as unknown as Side;
  const events: PeerEvents = {
    state: (_p, st) => s.states.push(st),
    signal: (_p, desc) => {
      s.signals.push(desc);
      // External signaling: deliver to the other side.
      setTimeout(() => void link().peer.acceptRemote(desc), 1);
    },
    ctrl: (_p, m) => s.ctrl.push(m),
    gossip: (_p, g) => s.gossip.push(g),
    file: (_p, f) => s.files.push(f),
    track: () => {},
  };
  s.peer = new Peer(
    { identity, remoteId, bindKey, rtcConfig: {}, initiator, session: "sess-0001", PC: FakePC },
    events,
  );
  return s;
}

async function connectedPair(opts: { bindB?: Uint8Array } = {}) {
  const [ia, ib] = await Promise.all([createIdentity(), createIdentity()]);
  const bindKey = randomBytes(32);
  let a!: Side;
  let b!: Side;
  a = side(ia, ib.peerId, bindKey, true, () => b);
  b = side(ib, ia.peerId, opts.bindB ?? bindKey, false, () => a);
  return { a, b, ia, ib };
}

describe("peer", () => {
  test("connects, runs the handshake and exchanges encrypted messages on every channel", async () => {
    const { a, b } = await connectedPair();
    await until(() => a.peer.state === "connected" && b.peer.state === "connected");
    expect(a.states).toEqual(["securing", "connected"]);
    expect(a.peer.localFp).toBe(b.peer.remoteFp);
    expect(a.peer.remoteFp).toBe(b.peer.localFp);
    expect(a.signals.length).toBe(1);
    expect(b.signals.length).toBe(1);

    await a.peer.sendCtrl({ t: "video", want: false });
    await a.peer.send("file", { binary: utf8("chunk") });
    const frame = {
      t: "g",
      v: 1,
      author: "a".repeat(20),
      edPub: "x",
      kind: "data",
      seq: 0,
      ts: 1,
      ttl: 3,
      body: "",
      sig: "y",
    } as const;
    await a.peer.sendGossip(frame);
    await until(() => b.ctrl.length === 1 && b.files.length === 1 && b.gossip.length === 1);
    expect(b.ctrl[0]).toEqual({ t: "video", want: false });
    expect(b.gossip[0]).toEqual(frame);

    // On the wire, nothing is readable.
    const pc = a.peer.pc as unknown as FakePeerConnection;
    expect(pc.channels.every((c) => c.sentBytes > 0)).toBe(true);
    a.peer.close();
    b.peer.close();
  });

  test("simultaneous renegotiation from both sides (glare) settles without deadlock", async () => {
    const { a, b } = await connectedPair();
    await until(() => a.peer.state === "connected" && b.peer.state === "connected");
    for (let round = 0; round < 5; round++) {
      a.peer.restartIce();
      b.peer.restartIce();
      await wait(40);
      await until(
        () => a.peer.pc.signalingState === "stable" && b.peer.pc.signalingState === "stable",
      );
    }
    // Renegotiation went over the encrypted ctrl channel, not the external path.
    expect(a.signals.length + b.signals.length).toBe(2);
    expect(a.peer.state).toBe("connected");
    expect(b.peer.state).toBe("connected");
    const fa = a.peer.pc as unknown as FakePeerConnection;
    const fb = b.peer.pc as unknown as FakePeerConnection;
    expect(fa.restarts + fb.restarts).toBe(10);
    a.peer.close();
    b.peer.close();
  });

  test("peers in different rooms fail the handshake and close", async () => {
    const { a, b } = await connectedPair({ bindB: randomBytes(32) });
    await until(() => a.peer.state === "closed" && b.peer.state === "closed");
    expect(a.peer.closeReason).toBe("handshake failed");
  });

  test("a changed remote fingerprint (MITM) closes the connection", async () => {
    const { a, b } = await connectedPair();
    await until(() => a.peer.state === "connected" && b.peer.state === "connected");
    await a.peer.acceptRemote({ type: "offer", sdp: "v=0\r\na=fingerprint:sha-256 00:11\r\n" });
    expect(a.peer.state).toBe("closed");
    expect(a.peer.closeReason).toBe("fingerprint changed");
    b.peer.close();
  });

  test("closing one side closes the other", async () => {
    const { a, b } = await connectedPair();
    await until(() => a.peer.state === "connected" && b.peer.state === "connected");
    a.peer.close("leaving");
    await until(() => b.peer.state === "closed");
  });

  test("an offer arriving right behind an answer is not mistaken for a collision", async () => {
    // Impolite side (larger id than the remote) with an outstanding offer.
    const me = await createIdentity();
    const signals: Description[] = [];
    const peer = new Peer(
      {
        identity: me,
        remoteId: "00000000000000000000",
        bindKey: randomBytes(32),
        rtcConfig: {},
        initiator: true,
        session: "sess-0002",
        PC: FakePC,
      },
      {
        state() {},
        signal: (_p, d) => void signals.push(d),
        ctrl() {},
        gossip() {},
        file() {},
        track() {},
      },
    );
    await until(() => signals.length === 1);
    const offer = signals[0] as Description;
    const remote = new FakePC({}) as unknown as RTCPeerConnection;
    await remote.setRemoteDescription(offer);
    await remote.setLocalDescription();
    const answer = remote.localDescription as Description;
    await remote.setLocalDescription({ type: "offer" } as RTCSessionDescriptionInit);
    const nextOffer = remote.localDescription as Description;
    // Back to back, without awaiting: the offer must wait for the answer to be applied.
    void peer.acceptRemote(answer);
    void peer.acceptRemote(nextOffer);
    await until(() => signals.some((d) => d.type === "answer"));
    expect(peer.pc.signalingState).toBe("stable");
    peer.close();
  });

  test("extracts and normalizes the SDP fingerprint", () => {
    expect(sdpFingerprint("v=0\r\na=fingerprint:SHA-256 ab:cd\r\n")).toBe("sha-256 AB:CD");
    expect(sdpFingerprint("v=0\r\n")).toBe("");
  });
});
