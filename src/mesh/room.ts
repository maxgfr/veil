/**
 * A room: who is here, who we are linked to, and how messages get around.
 *
 * Bootstrap: a newcomer says `hello` on the public transports (sealed with
 * the room key). A few members answer with an offer; once one link is up,
 * everything else happens inside the mesh:
 *  - presence frames are gossiped (signed), so everyone learns the roster;
 *  - new links are negotiated with offers/answers *routed through the mesh*,
 *    encrypted to the target's static X25519 key;
 *  - renegotiation (media) goes over the link's own encrypted ctrl channel.
 * One connected member is therefore enough to bring a newcomer in.
 *
 * Application messages are encrypted once with our sender key and flooded.
 * The key is rotated when a member leaves, and every 10 min / 10k messages.
 */
import { open, seal } from "../crypto/aead";
import { type Bytes, fromB64u, fromUtf8, randomBytes, toB64u, utf8 } from "../crypto/bytes";
import { deriveRoomSecrets, type RoomSecrets } from "../crypto/room";
import { computeSas, type Sas } from "../crypto/sas";
import { SenderKeys } from "../crypto/senderkeys";
import { createIdentity, type Identity } from "../crypto/session";
import {
  DEFAULT_SIGNAL_CONFIG,
  RoomSignaling,
  type SignalConfig,
  type TransportFactory,
} from "../signal/mux";
import type { SignalMessage, TransportName, TransportStatus } from "../signal/types";
import { chooseLinks, Gossip, helloResponseDelay, TARGET_DEGREE } from "./gossip";
import { type Description, Peer, type PeerState } from "./peer";
import {
  type AppMessage,
  type CtrlMessage,
  decodeApp,
  decodePresence,
  decodeRoutedSignal,
  decodeSigBody,
  decodeSkey,
  type Frame,
  type GossipFrame,
  type MediaState,
  type Presence,
  type RoutedSignal,
} from "./protocol";

export const PRESENCE_MS = 10_000;
export const MEMBER_TIMEOUT_MS = 35_000;
const MAINTAIN_MS = 3000;
const PENDING_KEY_MS = 15_000;

export interface Member {
  peerId: string;
  nick: string;
  e2ee: boolean;
  /** Optional features the member announced ("screen-track"). */
  caps: readonly string[];
  edPub: Bytes;
  xPub: Bytes;
  media: MediaState;
  joinedAt: number;
  lastSeen: number;
}

export interface LinkInfo {
  peerId: string;
  state: PeerState;
  rtt: number | null;
  relayed: boolean;
}

export interface RoomOptions {
  roomKey: Uint8Array;
  passphrase?: string;
  nick: string;
  signal?: SignalConfig;
  rtc?: RTCConfiguration;
  PC?: typeof RTCPeerConnection;
  factory?: TransportFactory;
  degree?: number;
  /** Advertised in presence: this browser can end-to-end encrypt media frames. */
  e2ee?: boolean;
  /** Advertised in presence: optional features this client supports. */
  caps?: string[];
  /** Test hook: pre-derived secrets (skips PBKDF2). */
  secrets?: RoomSecrets;
}

export interface RoomEvents {
  members?(members: Member[]): void;
  links?(links: LinkInfo[]): void;
  transports?(statuses: TransportStatus[]): void;
  app?(author: string, msg: AppMessage): void;
  manualCode?(code: string, kind: "offer" | "answer"): void;
  linkUp?(peer: Peer): void;
  linkDown?(peerId: string): void;
  track?(peer: Peer, ev: RTCTrackEvent): void;
  ctrl?(peer: Peer, msg: CtrlMessage): void;
  file?(peer: Peer, frame: Frame): void;
  /** Our own or someone else's sender key changed (media keys follow). */
  keys?(): void;
  memberLeft?(peerId: string): void;
}

type Route =
  | { kind: "external"; via?: readonly TransportName[] }
  | { kind: "mesh" }
  | { kind: "manual" };

interface PendingData {
  frame: GossipFrame;
  body: Bytes;
  at: number;
}

export class Room {
  readonly peers = new Map<string, Peer>();
  readonly members = new Map<string, Member>();
  private readonly manualOffers = new Map<string, Peer>();
  private readonly routes = new Map<Peer, Route>();
  private readonly presenceFrames = new Map<string, GossipFrame>();
  private ownPresence: GossipFrame | null = null;
  private readonly pendingData = new Map<string, PendingData[]>();
  private readonly wantKeys = new Set<string>();
  private readonly lastKeyResend = new Map<string, number>();
  private readonly required = new Map<string, number>();
  /** Members whose verification failed: never linked again, never given our keys. */
  readonly blocked = new Set<string>();
  private readonly chosenRounds = new Map<string, number>();
  private readonly gossip: Gossip;
  private readonly signaling: RoomSignaling;
  private readonly timers: ReturnType<typeof setInterval>[] = [];
  private readonly helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rotateTimer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private helloCount = 0;
  private media: MediaState = { audio: false, video: false, screen: false };
  private nick: string;
  private readonly joinedAt = Date.now();
  private stopped = false;
  private readonly degree: number;
  private readonly onOnline = () => this.restartIce();

  private constructor(
    readonly identity: Identity,
    readonly secrets: RoomSecrets,
    readonly keys: SenderKeys,
    private readonly o: RoomOptions,
    private readonly events: RoomEvents,
  ) {
    this.nick = o.nick;
    this.degree = o.degree ?? TARGET_DEGREE;
    this.gossip = new Gossip({
      identity,
      send: (to, frame) => {
        const p = this.peers.get(to);
        if (p?.ready) void p.sendGossip(frame);
      },
      neighbors: () => this.readyIds(),
      deliver: (frame, body) => void this.onGossip(frame, body),
    });
    this.signaling = new RoomSignaling(
      {
        secrets,
        identity,
        config: o.signal ?? DEFAULT_SIGNAL_CONFIG,
        ...(o.factory ? { factory: o.factory } : {}),
      },
      {
        onMessage: (msg, via) => this.onSignal(msg, via),
        onStatus: (s) => this.events.transports?.(s),
        onManualOutgoing: (code, to) => this.events.manualCode?.(code, to ? "answer" : "offer"),
      },
    );
  }

  static async create(o: RoomOptions, events: RoomEvents = {}): Promise<Room> {
    const [identity, secrets] = await Promise.all([
      createIdentity(),
      o.secrets ? Promise.resolve(o.secrets) : deriveRoomSecrets(o.roomKey, o.passphrase),
    ]);
    const keys = await SenderKeys.create(identity, secrets.bindKey);
    return new Room(identity, secrets, keys, o, events);
  }

  get peerId(): string {
    return this.identity.peerId;
  }

  readyIds(): string[] {
    const out: string[] = [];
    for (const [id, p] of this.peers) if (p.ready) out.push(id);
    return out;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.signaling.start();
    this.scheduleHello(0);
    this.timers.push(setInterval(() => void this.heartbeat(), PRESENCE_MS));
    this.timers.push(setInterval(() => this.maintain(), MAINTAIN_MS));
    this.timers.push(
      setInterval(() => {
        if (this.keys.needsRotation()) this.scheduleRotation(0);
        this.expirePending();
      }, 30_000),
    );
    globalThis.addEventListener?.("online", this.onOnline);
    void this.publishPresence();
  }

  async leave(): Promise<void> {
    if (this.stopped) return;
    await this.gossip.publish("bye", new Uint8Array()).catch(() => {});
    await this.signaling.send({ kind: "bye" }).catch(() => {});
    this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    globalThis.removeEventListener?.("online", this.onOnline);
    for (const t of this.timers) clearInterval(t);
    for (const t of this.helloTimers.values()) clearTimeout(t);
    clearTimeout(this.helloTimer);
    clearTimeout(this.rotateTimer);
    for (const p of [...this.peers.values(), ...this.manualOffers.values()]) p.close("leaving");
    this.peers.clear();
    this.manualOffers.clear();
    this.signaling.stop();
  }

  /** Hello cadence: fast while alone, then a slow beat that also merges split groups. */
  private scheduleHello(delay: number): void {
    clearTimeout(this.helloTimer);
    this.helloTimer = setTimeout(() => {
      if (this.stopped) return;
      void this.signaling.send({ kind: "hello" }).catch(() => {});
      this.helloCount++;
      const alone = this.readyIds().length === 0;
      this.scheduleHello(alone ? (this.helloCount < 8 ? 3000 : 15_000) : 60_000);
    }, delay);
  }

  restartIce(): void {
    for (const p of this.peers.values()) p.restartIce();
  }

  transportStatus(): TransportStatus[] {
    return this.signaling.status();
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Encrypts with our sender key and floods to the room. */
  async send(msg: AppMessage): Promise<void> {
    if (this.stopped) return;
    const ct = await this.keys.encrypt(utf8(JSON.stringify(msg)));
    await this.gossip.publish("data", ct);
    if (this.keys.needsRotation()) this.scheduleRotation(0);
  }

  setNick(nick: string): void {
    this.nick = nick;
    void this.publishPresence();
  }

  setMedia(media: MediaState): void {
    this.media = media;
    void this.publishPresence();
  }

  /** Keeps (or creates) a direct link to a member, e.g. for a file transfer. */
  require(peerId: string, on = true): void {
    if (on) this.required.set(peerId, (this.required.get(peerId) ?? 0) + 1);
    else {
      const n = (this.required.get(peerId) ?? 1) - 1;
      if (n <= 0) this.required.delete(peerId);
      else this.required.set(peerId, n);
    }
    if (on) this.maintain();
  }

  /**
   * After a failed verification (SAS mismatch): drop the link, refuse any new
   * one for the rest of the session, and rotate our key without them.
   */
  block(peerId: string): void {
    if (peerId === this.peerId) return;
    this.blocked.add(peerId);
    this.required.delete(peerId);
    this.peers.get(peerId)?.close("verification failed");
    this.scheduleRotation(0);
    this.emitMembers();
  }

  async sas(peerId: string): Promise<Sas | null> {
    const p = this.peers.get(peerId);
    if (!p?.secure) return null;
    return computeSas(
      this.secrets.sasSalt,
      { peerId: this.peerId, edPub: this.identity.edPub, fingerprint: p.localFp },
      { peerId, edPub: p.secure.remoteEdPub, fingerprint: p.remoteFp },
    );
  }

  /** Starts a manual (QR / copy-paste) pairing: the offer comes out through `manualCode`. */
  createManualOffer(): void {
    const session = toB64u(randomBytes(12));
    const peer = this.newPeer("", session, true, { kind: "manual" });
    this.manualOffers.set(session, peer);
  }

  ingestManual(code: string): boolean {
    return this.signaling.ingestManual(code);
  }

  // ── peers ─────────────────────────────────────────────────────────────────

  private newPeer(remoteId: string, session: string, initiator: boolean, route: Route): Peer {
    const peer = new Peer(
      {
        identity: this.identity,
        remoteId,
        bindKey: this.secrets.bindKey,
        rtcConfig: this.o.rtc ?? {},
        initiator,
        session,
        ...(route.kind === "manual" ? { connectTimeoutMs: 10 * 60_000 } : {}),
        ...(this.o.PC ? { PC: this.o.PC } : {}),
      },
      {
        state: (p, s) => this.onPeerState(p, s),
        signal: (p, desc) => void this.routeSignal(p, desc),
        ctrl: (p, msg) => this.onCtrl(p, msg),
        gossip: (p, frame) => void this.gossip.receive(frame, p.remoteId),
        file: (p, frame) => this.events.file?.(p, frame),
        track: (p, ev) => this.events.track?.(p, ev),
      },
    );
    this.routes.set(peer, route);
    if (remoteId) this.peers.set(remoteId, peer);
    this.emitLinks();
    return peer;
  }

  private connect(to: string, route: Route): void {
    if (this.stopped || this.peers.has(to) || to === this.peerId || this.blocked.has(to)) return;
    this.newPeer(to, toB64u(randomBytes(12)), true, route);
  }

  private async routeSignal(peer: Peer, desc: Description): Promise<void> {
    let route = this.routes.get(peer) ?? { kind: "external" };
    // After the first connection, prefer the mesh over the public transports (e.g. ICE restart).
    if (peer.secure && route.kind === "external" && this.canRouteViaMesh(peer.remoteId))
      route = { kind: "mesh" };
    const msg = { kind: desc.type, sdp: desc.sdp, session: peer.session };
    try {
      if (route.kind === "mesh" && this.canRouteViaMesh(peer.remoteId)) {
        await this.sendRouted(peer.remoteId, msg);
      } else if (route.kind === "manual") {
        await this.signaling.send(peer.remoteId ? { ...msg, to: peer.remoteId } : msg, ["manual"]);
      } else {
        const via = route.kind === "external" ? route.via : undefined;
        await this.signaling.send({ ...msg, to: peer.remoteId }, via);
      }
    } catch (err) {
      console.debug("[veil] signal", err);
    }
  }

  private canRouteViaMesh(to: string): boolean {
    return this.members.has(to) && this.readyIds().some((id) => id !== to);
  }

  private onPeerState(peer: Peer, state: PeerState): void {
    const id = peer.remoteId;
    if (state === "closed") {
      this.routes.delete(peer);
      if (this.manualOffers.get(peer.session) === peer) this.manualOffers.delete(peer.session);
      if (id && this.peers.get(id) === peer) {
        this.peers.delete(id);
        this.events.linkDown?.(id);
      }
    } else if (state === "connected" && id && this.peers.get(id) === peer) {
      this.onLinkUp(peer);
    }
    this.emitLinks();
  }

  private linked = new WeakSet<Peer>();

  private onLinkUp(peer: Peer): void {
    if (this.linked.has(peer)) return;
    this.linked.add(peer);
    // Hand the newcomer a snapshot of the roster (original signed frames, verified on arrival).
    const frames = [...this.presenceFrames.values()];
    if (this.ownPresence) frames.push(this.ownPresence);
    void peer.sendCtrl({ t: "roster", frames });
    void this.publishPresence();
    // A new direct link may heal a partition: make sure that member can read us.
    if (this.members.has(peer.remoteId)) void this.sendKeyTo(peer.remoteId);
    this.events.linkUp?.(peer);
  }

  private onCtrl(peer: Peer, msg: CtrlMessage): void {
    if (msg.t === "roster") {
      for (const f of msg.frames) void this.gossip.receive(f, peer.remoteId);
      return;
    }
    this.events.ctrl?.(peer, msg);
  }

  private emitLinks(): void {
    if (!this.events.links) return;
    const out: LinkInfo[] = [];
    for (const [peerId, p] of this.peers)
      out.push({ peerId, state: p.state, rtt: p.rtt, relayed: p.relayed });
    this.events.links(out);
  }

  /** Keeps the target degree, plus every member we need a direct link to. */
  private maintain(): void {
    if (this.stopped) return;
    const required = new Set(this.required.keys());
    // Media flows over direct links only: link with everyone who is sending.
    for (const m of this.members.values())
      if (m.media.audio || m.media.video || m.media.screen) required.add(m.peerId);
    if (this.media.audio || this.media.video || this.media.screen)
      for (const id of this.members.keys()) required.add(id);
    const linked = new Set<string>();
    const pending = new Set<string>();
    for (const [id, p] of this.peers) (p.ready ? linked : pending).add(id);
    const picks = chooseLinks({
      me: this.peerId,
      linked,
      pending,
      members: [...this.members.keys()].filter((id) => !this.blocked.has(id)),
      required: [...required].filter((id) => !this.blocked.has(id)),
      degree: this.degree,
    });
    const chosen = new Set(picks);
    for (const id of this.chosenRounds.keys()) if (!chosen.has(id)) this.chosenRounds.delete(id);
    for (const id of picks) {
      const rounds = (this.chosenRounds.get(id) ?? 0) + 1;
      this.chosenRounds.set(id, rounds);
      // The smaller id initiates; the other side steps in if nothing happened after a while.
      if (!required.has(id) && this.peerId > id && rounds < 3) continue;
      this.connect(id, this.canRouteViaMesh(id) ? { kind: "mesh" } : { kind: "external" });
    }
  }

  // ── external signaling ────────────────────────────────────────────────────

  private onSignal(msg: SignalMessage, via: TransportName): void {
    if (this.stopped) return;
    const from = msg.from;
    const route: Route = via === "manual" ? { kind: "manual" } : { kind: "external" };
    switch (msg.kind) {
      case "hello": {
        if (this.peers.has(from) || this.helloTimers.has(from)) return;
        const delay = helloResponseDelay(this.peerId, from, this.members.keys());
        const known = this.members.has(from);
        this.helloTimers.set(
          from,
          setTimeout(() => {
            this.helloTimers.delete(from);
            // Slow responders stay quiet if the newcomer already made it into the mesh.
            if (delay >= 3000 && (known || this.members.has(from))) return;
            this.connect(from, route);
          }, delay),
        );
        return;
      }
      case "offer":
        if (msg.sdp && msg.session) this.onOffer(from, msg.sdp, msg.session, route);
        return;
      case "answer":
        if (msg.sdp && msg.session) this.onAnswer(from, msg.sdp, msg.session);
        return;
      case "bye":
        this.removeMember(from);
        return;
    }
  }

  private onOffer(from: string, sdp: string, session: string, route: Route): void {
    if (this.blocked.has(from)) return;
    const existing = this.peers.get(from);
    if (existing) {
      if (existing.session === session) {
        void existing.acceptRemote({ type: "offer", sdp });
        return;
      }
      if (!existing.secure) {
        // Both sides started a connection at once: the polite (smaller id) side yields.
        if (this.peerId > from) return;
      }
      // Either we yield, or the other side replaced a connection it considers dead.
      existing.close("replaced");
    }
    const peer = this.newPeer(from, session, false, route);
    void peer.acceptRemote({ type: "offer", sdp });
  }

  private onAnswer(from: string, sdp: string, session: string): void {
    let peer = this.peers.get(from);
    if (!peer || peer.session !== session) {
      const manual = this.manualOffers.get(session);
      if (!manual) return;
      if (peer && peer !== manual) peer.close("replaced");
      this.manualOffers.delete(session);
      manual.bind(from);
      this.peers.set(from, manual);
      peer = manual;
    }
    void peer.acceptRemote({ type: "answer", sdp });
  }

  // ── mesh-routed signaling ─────────────────────────────────────────────────

  private async sendRouted(to: string, msg: RoutedSignal): Promise<void> {
    const m = this.members.get(to);
    if (!m) return;
    const key = await this.keys.pairs.get(to, m.xPub, "sig");
    const ct = await seal(key, utf8(JSON.stringify(msg)), utf8(`veil/sig/v1|${this.peerId}|${to}`));
    const body = { to, xPub: this.keys.xPub, ct: toB64u(ct) };
    await this.gossip.publish("sig", utf8(JSON.stringify(body)));
  }

  private async onRouted(author: string, raw: unknown): Promise<void> {
    const body = decodeSigBody(raw);
    if (!body || body.to !== this.peerId) return;
    let msg: RoutedSignal | null;
    try {
      const key = await this.keys.pairs.get(author, fromB64u(body.xPub), "sig");
      const plain = await open(
        key,
        fromB64u(body.ct),
        utf8(`veil/sig/v1|${author}|${this.peerId}`),
      );
      msg = decodeRoutedSignal(JSON.parse(fromUtf8(plain)));
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.kind === "offer") this.onOffer(author, msg.sdp, msg.session, { kind: "mesh" });
    else this.onAnswer(author, msg.sdp, msg.session);
  }

  // ── gossip ────────────────────────────────────────────────────────────────

  private async onGossip(frame: GossipFrame, body: Bytes): Promise<void> {
    if (this.stopped) return;
    const author = frame.author;
    let json: unknown = null;
    if (frame.kind !== "data" && frame.kind !== "bye") {
      try {
        json = JSON.parse(fromUtf8(body));
      } catch {
        return;
      }
    }
    switch (frame.kind) {
      case "presence": {
        const p = decodePresence(json);
        if (p) this.onPresence(frame, p);
        return;
      }
      case "bye":
        this.removeMember(author);
        return;
      case "skey": {
        const s = decodeSkey(json);
        if (s && (await this.keys.receive(author, s))) {
          this.wantKeys.delete(author);
          this.events.keys?.();
          await this.flushPending(author);
        }
        return;
      }
      case "data":
        await this.onData(frame, body);
        return;
      case "sig":
        await this.onRouted(author, json);
        return;
    }
  }

  private onPresence(frame: GossipFrame, p: Presence): void {
    const author = frame.author;
    const prev = this.presenceFrames.get(author);
    if (prev && prev.ts > frame.ts) return;
    this.presenceFrames.set(author, frame);
    const isNew = !this.members.has(author);
    let xPub: Bytes;
    try {
      xPub = fromB64u(p.xPub);
    } catch {
      return;
    }
    this.members.set(author, {
      peerId: author,
      nick: p.nick.trim().slice(0, 40) || "Guest",
      e2ee: p.e2ee ?? false,
      caps: p.caps ?? [],
      edPub: fromB64u(frame.edPub),
      xPub,
      media: p.media,
      joinedAt: p.joinedAt,
      lastSeen: Date.now(),
    });
    const asked = p.want?.includes(this.peerId) ?? false;
    if (isNew || asked) void this.sendKeyTo(author);
    // Their key changed while we were cut off from them (e.g. a partition): ask for it.
    if (p.keyId !== undefined && !this.keys.hasKey(author, p.keyId) && !this.wantKeys.has(author)) {
      this.wantKeys.add(author);
      setTimeout(() => {
        if (this.wantKeys.has(author)) void this.publishPresence();
      }, 300);
    }
    if (isNew) this.maintain();
    this.emitMembers();
  }

  private async sendKeyTo(peerId: string): Promise<void> {
    const m = this.members.get(peerId);
    if (!m || this.blocked.has(peerId)) return;
    const last = this.lastKeyResend.get(peerId) ?? 0;
    if (Date.now() - last < 2000) return;
    this.lastKeyResend.set(peerId, Date.now());
    const wrapped = await this.keys.wrap([{ peerId, xPub: m.xPub }]);
    await this.gossip.publish("skey", utf8(JSON.stringify(wrapped)));
  }

  private async onData(frame: GossipFrame, body: Bytes): Promise<void> {
    const res = await this.keys.decrypt(frame.author, body);
    if ("ok" in res) {
      let msg: AppMessage | null = null;
      try {
        msg = decodeApp(JSON.parse(fromUtf8(res.ok)));
      } catch {
        return;
      }
      if (msg) this.events.app?.(frame.author, msg);
    } else if ("unknownKey" in res) {
      // The key is probably still on its way: hold the message, and ask for it.
      const list = this.pendingData.get(frame.author) ?? [];
      list.push({ frame, body, at: Date.now() });
      if (list.length > 256) list.shift();
      this.pendingData.set(frame.author, list);
      if (!this.wantKeys.has(frame.author)) {
        this.wantKeys.add(frame.author);
        setTimeout(() => {
          if (this.wantKeys.has(frame.author)) void this.publishPresence();
        }, 1500);
      }
    }
  }

  private async flushPending(author: string): Promise<void> {
    this.wantKeys.delete(author);
    const list = this.pendingData.get(author);
    if (!list) return;
    this.pendingData.delete(author);
    list.sort((a, b) => a.frame.seq - b.frame.seq);
    for (const item of list) await this.onData(item.frame, item.body);
  }

  private expirePending(): void {
    const now = Date.now();
    for (const [author, list] of this.pendingData) {
      const fresh = list.filter((x) => now - x.at < PENDING_KEY_MS * 4);
      if (fresh.length) this.pendingData.set(author, fresh);
      else this.pendingData.delete(author);
    }
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const m of [...this.members.values()]) {
      if (now - m.lastSeen > MEMBER_TIMEOUT_MS && !this.peers.get(m.peerId)?.ready)
        this.removeMember(m.peerId);
    }
    await this.publishPresence();
  }

  private async publishPresence(): Promise<void> {
    if (this.stopped) return;
    const presence: Presence = {
      nick: this.nick,
      xPub: this.keys.xPub,
      media: this.media,
      links: this.readyIds(),
      joinedAt: this.joinedAt,
      e2ee: this.o.e2ee ?? false,
      keyId: this.keys.keyId,
    };
    if (this.o.caps?.length) presence.caps = this.o.caps;
    if (this.wantKeys.size) presence.want = [...this.wantKeys];
    this.ownPresence = await this.gossip.publish("presence", utf8(JSON.stringify(presence)));
  }

  private removeMember(peerId: string): void {
    const had = this.members.delete(peerId);
    this.presenceFrames.delete(peerId);
    this.keys.forget(peerId);
    this.pendingData.delete(peerId);
    this.wantKeys.delete(peerId);
    this.required.delete(peerId);
    const p = this.peers.get(peerId);
    if (p) p.close("left");
    // Offers/answers routed through the departed member may be lost: restart those attempts.
    for (const [id, peer] of [...this.peers]) {
      if (!peer.secure && this.routes.get(peer)?.kind === "mesh") {
        peer.close("route lost");
        this.chosenRounds.set(id, 3);
      }
    }
    if (!had) return;
    this.emitMembers();
    this.events.memberLeft?.(peerId);
    // Forward secrecy for the group: the departed member never gets our next key.
    this.scheduleRotation(500);
  }

  private scheduleRotation(delay: number): void {
    clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => void this.rotateAndDistribute(), delay);
  }

  private async rotateAndDistribute(): Promise<void> {
    if (this.stopped) return;
    await this.keys.rotate();
    const recipients = [...this.members.values()]
      .filter((m) => !this.blocked.has(m.peerId))
      .map((m) => ({ peerId: m.peerId, xPub: m.xPub }));
    const wrapped = await this.keys.wrap(recipients);
    await this.gossip.publish("skey", utf8(JSON.stringify(wrapped)));
    this.events.keys?.();
  }

  private emitMembers(): void {
    this.events.members?.([...this.members.values()]);
  }
}
