/**
 * One RTCPeerConnection to one member, with:
 *  - three negotiated DataChannels (ctrl, chat, file),
 *  - "perfect negotiation" (polite = smaller peer id) so both sides may
 *    renegotiate at any time without glare deadlocks,
 *  - non-trickle ICE: a description is only sent once gathering completes,
 *    so a single message carries everything,
 *  - an in-band handshake on ctrl that upgrades every channel to a
 *    SecureChannel bound to both DTLS fingerprints (see crypto/session.ts),
 *  - after that, renegotiation travels over the encrypted ctrl channel; the
 *    external path (signaling or mesh) is only used to bootstrap and when the
 *    connection is down (ICE restart).
 */
import { type Bytes, bytes, fromB64u, toB64u } from "../crypto/bytes";
import {
  Handshake,
  type Identity,
  normalizeFingerprint,
  type PeerSession,
  type SecureChannel,
} from "../crypto/session";
import {
  CHANNELS,
  type ChannelLabel,
  type CtrlMessage,
  decodeCtrl,
  decodeFrame,
  decodeGossip,
  encodeFrame,
  type Frame,
  type GossipFrame,
  PROTOCOL_VERSION,
} from "./protocol";

export type PeerState = "connecting" | "securing" | "connected" | "reconnecting" | "closed";

export interface Description {
  type: "offer" | "answer";
  sdp: string;
}

export interface PeerOptions {
  identity: Identity;
  /** Unknown ("") only for a manual offer, until the answer tells who took it. */
  remoteId: string;
  bindKey: Uint8Array;
  rtcConfig: RTCConfiguration;
  initiator: boolean;
  session: string;
  PC?: typeof RTCPeerConnection;
  gatherTimeoutMs?: number;
  /** Give up on a connection that never got secured after this long (manual pairing needs minutes). */
  connectTimeoutMs?: number;
}

export interface PeerEvents {
  state(peer: Peer, state: PeerState): void;
  /** A description that must travel outside the (unavailable) ctrl channel. */
  signal(peer: Peer, desc: Description): void;
  ctrl(peer: Peer, msg: CtrlMessage): void;
  gossip(peer: Peer, frame: GossipFrame): void;
  file(peer: Peer, frame: Frame): void;
  track(peer: Peer, ev: RTCTrackEvent): void;
}

const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
const PING_MS = 5000;
const SILENT_MS = 15_000;
const DISCONNECTED_GRACE_MS = 4000;
const GIVE_UP_MS = 45_000;
const CONNECT_TIMEOUT_MS = 15_000;

/** First `a=fingerprint:` line of an SDP, normalized. */
export function sdpFingerprint(sdp: string | undefined): string {
  const m = sdp?.match(/^a=fingerprint:(\S+ \S+)\s*$/m);
  return m?.[1] ? normalizeFingerprint(m[1]) : "";
}

export class Peer {
  readonly pc: RTCPeerConnection;
  remoteId: string;
  readonly session: string;
  state: PeerState = "connecting";
  secure: PeerSession | null = null;
  localFp = "";
  remoteFp = "";
  rtt: number | null = null;
  /** The connection goes through a TURN relay (set from stats by the media layer). */
  relayed = false;

  private readonly channels = {} as Record<ChannelLabel, RTCDataChannel>;
  private readonly secureChannels = {} as Record<ChannelLabel, SecureChannel>;
  private readonly tx = {
    ctrl: Promise.resolve(),
    chat: Promise.resolve(),
    file: Promise.resolve(),
  };
  private readonly rx = {
    ctrl: Promise.resolve(),
    chat: Promise.resolve(),
    file: Promise.resolve(),
  };
  private handshake: Promise<Handshake> | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private channelsCreated = false;
  private lastHeard = Date.now();
  private readonly createdAt = Date.now();
  private downSince: number | null = null;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private disconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly o: PeerOptions,
    private readonly events: PeerEvents,
  ) {
    const PC = o.PC ?? RTCPeerConnection;
    this.remoteId = o.remoteId;
    this.session = o.session;
    this.pc = new PC({ bundlePolicy: "max-bundle", ...o.rtcConfig });
    this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.ontrack = (ev) => this.events.track(this, ev);
    this.pc.onconnectionstatechange = () => this.onConnectionState();
    if (o.initiator) this.createChannels();
    this.timers.push(setInterval(() => this.tick(), PING_MS));
  }

  get polite(): boolean {
    return this.o.identity.peerId < this.remoteId;
  }

  get ready(): boolean {
    return this.state === "connected" || this.state === "reconnecting";
  }

  /** Manual offers learn their remote peer from the answer. */
  bind(remoteId: string): void {
    if (!this.remoteId) this.remoteId = remoteId;
  }

  private createChannels(): void {
    if (this.channelsCreated) return;
    this.channelsCreated = true;
    for (const label of Object.keys(CHANNELS) as ChannelLabel[]) {
      const dc = this.pc.createDataChannel(label, {
        negotiated: true,
        id: CHANNELS[label],
        ordered: true,
      });
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = LOW_WATER;
      dc.onmessage = (e) => this.onMessage(label, e.data as ArrayBuffer | string);
      dc.onclose = () => {
        if (label === "ctrl") this.close("channel closed");
      };
      if (label === "ctrl") dc.onopen = () => void this.startHandshake();
      this.channels[label] = dc;
    }
  }

  // ── negotiation ───────────────────────────────────────────────────────────

  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.pc.removeEventListener("icegatheringstatechange", check);
        resolve();
      };
      const check = () => {
        if (this.pc.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(done, this.o.gatherTimeoutMs ?? 3000);
      this.pc.addEventListener("icegatheringstatechange", check);
    });
  }

  private async negotiate(): Promise<void> {
    if (this.state === "closed") return;
    // The answerer of the very first exchange waits for the offer.
    if (!this.o.initiator && !this.pc.remoteDescription) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      if (this.pc.signalingState !== "have-local-offer") return;
      await this.gathered();
      this.emitDescription();
    } catch (err) {
      this.log(err);
    } finally {
      this.makingOffer = false;
    }
  }

  private emitDescription(): void {
    const d = this.pc.localDescription;
    if (!d || (d.type !== "offer" && d.type !== "answer")) return;
    this.localFp ||= sdpFingerprint(d.sdp);
    const desc: Description = { type: d.type, sdp: d.sdp };
    if (
      this.secure &&
      this.pc.connectionState === "connected" &&
      this.channels.ctrl?.readyState === "open"
    ) {
      void this.sendCtrl({ t: "sdp", type: desc.type, sdp: desc.sdp });
    } else {
      this.events.signal(this, desc);
    }
  }

  private negotiation: Promise<void> = Promise.resolve();

  /**
   * Applies a remote description from any path (signaling, mesh or ctrl).
   * Descriptions are applied one at a time: an offer that arrives while the
   * previous answer is still being applied must not look like a collision.
   */
  acceptRemote(desc: Description): Promise<void> {
    const run = this.negotiation.then(() => this.applyRemote(desc));
    this.negotiation = run.catch(() => {});
    return run;
  }

  private async applyRemote(desc: Description): Promise<void> {
    if (this.state === "closed") return;
    const fp = sdpFingerprint(desc.sdp);
    if (this.remoteFp && fp && fp !== this.remoteFp) {
      // The DTLS identity of an established peer can never change: someone is tampering.
      this.close("fingerprint changed");
      return;
    }
    const collision =
      desc.type === "offer" && (this.makingOffer || this.pc.signalingState !== "stable");
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    try {
      await this.pc.setRemoteDescription(desc);
      this.remoteFp ||= fp;
      this.createChannels();
      if (desc.type === "offer") {
        await this.pc.setLocalDescription();
        await this.gathered();
        this.emitDescription();
      }
    } catch (err) {
      this.log(err);
    }
  }

  restartIce(): void {
    if (this.state === "closed") return;
    this.pc.restartIce();
  }

  private onConnectionState(): void {
    const s = this.pc.connectionState;
    clearTimeout(this.disconnectTimer);
    if (s === "connected") {
      this.downSince = null;
      if (this.state === "reconnecting") this.setState("connected");
    } else if (s === "disconnected" || s === "failed") {
      this.downSince ??= Date.now();
      if (this.secure) this.setState("reconnecting");
      // "disconnected" often heals by itself; "failed" needs an ICE restart now.
      this.disconnectTimer = setTimeout(
        () => this.restartIce(),
        s === "failed" ? 0 : DISCONNECTED_GRACE_MS,
      );
    } else if (s === "closed") {
      this.close("closed");
    }
  }

  private tick(): void {
    const now = Date.now();
    if (this.downSince !== null && now - this.downSince > GIVE_UP_MS) {
      this.close("unreachable");
      return;
    }
    if (!this.secure) {
      // Never connected (lost offer or answer, unreachable peer): give up so it can be retried.
      if (now - this.createdAt > (this.o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS))
        this.close("timeout");
      return;
    }
    if (now - this.lastHeard > SILENT_MS && this.state === "connected")
      this.setState("reconnecting");
    void this.sendCtrl({ t: "ping", ts: now });
  }

  // ── handshake ─────────────────────────────────────────────────────────────

  private startHandshake(): Promise<Handshake> {
    this.handshake ??= (async () => {
      this.setState("securing");
      this.localFp ||= sdpFingerprint(this.pc.localDescription?.sdp);
      this.remoteFp ||= sdpFingerprint(this.pc.remoteDescription?.sdp);
      const hs = await Handshake.start({
        identity: this.o.identity,
        remotePeerId: this.remoteId,
        localFp: this.localFp,
        remoteFp: this.remoteFp,
        bindKey: this.o.bindKey,
      });
      const hello = {
        t: "hs",
        v: PROTOCOL_VERSION,
        edPub: toB64u(hs.hello.edPub),
        xPub: toB64u(hs.hello.xPub),
        sig: toB64u(hs.hello.sig),
      };
      // The connection may have been closed while the keys were generated.
      if (this.state !== "closed" && this.channels.ctrl.readyState === "open") {
        this.channels.ctrl.send(JSON.stringify(hello));
      }
      return hs;
    })();
    return this.handshake;
  }

  private async finishHandshake(msg: CtrlMessage): Promise<void> {
    if (msg.t !== "hs" || this.secure) return;
    try {
      const hs = await this.startHandshake();
      const session = await hs.finish({
        edPub: fromB64u(msg.edPub),
        xPub: fromB64u(msg.xPub),
        sig: fromB64u(msg.sig),
      });
      const labels = Object.keys(CHANNELS) as ChannelLabel[];
      const chans = await Promise.all(labels.map((l) => session.channel(l)));
      labels.forEach((l, i) => {
        this.secureChannels[l] = chans[i] as SecureChannel;
      });
      this.secure = session;
      this.lastHeard = Date.now();
      this.setState("connected");
    } catch (err) {
      this.log(err);
      this.close("handshake failed");
    }
  }

  // ── messages ──────────────────────────────────────────────────────────────

  private onMessage(label: ChannelLabel, data: ArrayBuffer | string): void {
    this.lastHeard = Date.now();
    if (this.state === "reconnecting" && this.pc.connectionState === "connected")
      this.setState("connected");
    if (typeof data === "string") {
      // The only cleartext message (inside DTLS) is the handshake hello.
      if (label !== "ctrl" || this.secure) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      const msg = decodeCtrl(parsed);
      if (msg?.t === "hs") this.rx.ctrl = this.rx.ctrl.then(() => this.finishHandshake(msg));
      return;
    }
    const buf = bytes(data);
    // Serial per channel: preserves order (the SecureChannel rejects reordering).
    this.rx[label] = this.rx[label].then(() => this.decrypt(label, buf));
  }

  private async decrypt(label: ChannelLabel, buf: Bytes): Promise<void> {
    const chan = this.secureChannels[label];
    if (!chan || this.state === "closed") return;
    let frame: Frame | null;
    try {
      frame = decodeFrame(await chan.decrypt(buf));
    } catch {
      // A message that fails authentication on an authenticated channel is an attack or a bug.
      this.close("decryption failed");
      return;
    }
    if (!frame) return;
    if (label === "file") {
      this.events.file(this, frame);
      return;
    }
    if (!("json" in frame)) return;
    if (label === "chat") {
      const g = decodeGossip(frame.json);
      if (g) this.events.gossip(this, g);
      return;
    }
    const msg = decodeCtrl(frame.json);
    if (!msg) return;
    if (msg.t === "ping") void this.sendCtrl({ t: "pong", ts: msg.ts });
    else if (msg.t === "pong") this.rtt = Date.now() - msg.ts;
    else if (msg.t === "sdp") void this.acceptRemote({ type: msg.type, sdp: msg.sdp });
    else if (msg.t === "bye") this.close("left");
    else this.events.ctrl(this, msg);
  }

  /** Encrypts and sends, in order. Resolves once handed to the DataChannel. */
  send(label: ChannelLabel, frame: Frame): Promise<void> {
    const p = this.tx[label].then(async () => {
      const chan = this.secureChannels[label];
      const dc = this.channels[label];
      if (!chan || dc?.readyState !== "open") return;
      const sealed = await chan.encrypt(encodeFrame(frame));
      if (dc.readyState === "open") dc.send(sealed);
    });
    this.tx[label] = p.catch(() => {});
    return p;
  }

  sendCtrl(msg: CtrlMessage): Promise<void> {
    return this.send("ctrl", { json: msg });
  }

  sendGossip(frame: GossipFrame): Promise<void> {
    return this.send("chat", { json: frame });
  }

  bufferedAmount(label: ChannelLabel): number {
    return this.channels[label]?.bufferedAmount ?? 0;
  }

  /** Backpressure: resolves when the channel's buffer is below the high-water mark. */
  async drain(label: ChannelLabel): Promise<void> {
    const dc = this.channels[label];
    while (
      dc &&
      dc.readyState === "open" &&
      dc.bufferedAmount > HIGH_WATER &&
      this.state !== "closed"
    ) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 1000);
        dc.addEventListener(
          "bufferedamountlow",
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  private setState(s: PeerState): void {
    if (this.state === s || this.state === "closed") return;
    this.state = s;
    this.events.state(this, s);
  }

  closeReason = "";

  close(reason = "closed"): void {
    if (this.state === "closed") return;
    this.closeReason = reason;
    if (reason === "leaving" && this.secure && this.channels.ctrl?.readyState === "open") {
      // Best effort: tell the other side right away instead of letting it time out.
      void this.sendCtrl({ t: "bye" });
    }
    this.state = "closed";
    for (const t of this.timers) clearInterval(t);
    clearTimeout(this.disconnectTimer);
    const pc = this.pc;
    // Let the bye flush before tearing the connection down.
    setTimeout(
      () => {
        for (const dc of Object.values(this.channels)) {
          dc.onclose = null;
          dc.close();
        }
        pc.close();
      },
      reason === "leaving" ? 100 : 0,
    );
    this.events.state(this, "closed");
  }

  private log(err: unknown): void {
    if (typeof console !== "undefined")
      console.debug(
        `[veil] peer ${this.remoteId.slice(0, 6)}:`,
        err instanceof Error ? err.message : err,
      );
  }
}
