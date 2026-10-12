/**
 * Everything a joined room needs, wired together for the UI: the mesh Room,
 * chat, files and media. Loaded lazily (it carries the crypto and transports),
 * so the home screen stays small.
 *
 * The UI subscribes to `tick`, bumped (at most once per frame) whenever
 * anything changes, and reads plain fields from here.
 */
import { signal } from "@preact/signals";
import { sha256 } from "../crypto/bytes";
import { SAS_EMOJIS, type Sas } from "../crypto/sas";
import { Chat, type ChatMessage } from "../features/chat";
import {
  clearTemporaryFiles,
  Files,
  type Incoming,
  type Outgoing,
  pickSink,
} from "../features/files";
import { detectE2ee, Media, rtcConfigFor } from "../features/media";
import type { PeerState } from "../mesh/peer";
import type { AppMessage, MediaState } from "../mesh/protocol";
import { type LinkInfo, type Member, Room } from "../mesh/room";
import type { SignalConfig } from "../signal/mux";
import type { TransportStatus } from "../signal/types";
import { iceServers, type Settings, saveSettings, settings } from "./settings";

export interface JoinParams {
  key: Uint8Array;
  passphrase: string;
  nick: string;
  settings: Settings;
  audio: boolean;
  video: boolean;
}

export interface MemberView {
  peerId: string;
  nick: string;
  self: boolean;
  media: MediaState;
  link: PeerState | null;
  rtt: number | null;
  relayed: boolean;
  verified: boolean;
  /** Verification failed: disconnected for the rest of the session. */
  blocked: boolean;
  speaking: boolean;
  e2ee: boolean;
}

export type FileView = { dir: "in"; file: Incoming } | { dir: "out"; file: Outgoing };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "warn" | "error";
}

const NO_MEDIA: MediaState = { audio: false, video: false, screen: false };

export class RoomSession {
  readonly tick = signal(0);
  readonly manualCode = signal<{ code: string; kind: "offer" | "answer" } | null>(null);
  readonly toasts = signal<Toast[]>([]);
  readonly unread = signal(0);
  chatOpen = false;
  transports: TransportStatus[] = [];
  links: LinkInfo[] = [];
  readonly verified = new Set<string>();
  readonly mismatched = new Set<string>();
  /** Shown when connections keep failing without a TURN server. */
  connectivityHint: string | null = null;
  readonly chat: Chat;
  readonly files: Files;
  readonly media: Media;
  readonly badge: string[];
  readonly badgeNames: string[];
  private pending = false;
  private toastId = 0;
  private failures = 0;
  private everConnected = false;
  private left = false;

  private constructor(
    readonly room: Room,
    readonly params: JoinParams,
    badge: Sas,
  ) {
    this.badge = badge.emojis.slice(0, 3);
    this.badgeNames = badge.names.slice(0, 3);
    const send = (m: AppMessage) => room.send(m);
    this.chat = new Chat({ peerId: room.peerId, send, onChange: () => this.changed() });
    this.files = new Files({
      peerId: room.peerId,
      send,
      peer: (id) => room.peers.get(id),
      require: (id, on) => room.require(id, on),
      onChange: () => this.changed(),
    });
    this.media = new Media({
      peers: () => room.peers.values(),
      peer: (id) => room.peers.get(id),
      keys: room.keys,
      memberMedia: (id) => room.members.get(id)?.media,
      memberE2ee: (id) => room.members.get(id)?.e2ee ?? false,
      publish: (state) => room.setMedia(state),
      onChange: () => this.changed(),
      workerUrl: __E2EE_WORKER_URL__,
      // Read live: a device chosen in Settings during the call applies to the next capture.
      preferredDevices: () => ({
        audio: settings.value.audioDevice,
        video: settings.value.videoDevice,
      }),
      onDeviceFallback: (kind) =>
        this.toast(
          `The selected ${kind === "audio" ? "microphone" : "camera"} is unavailable: using the system default.`,
          "warn",
        ),
    });
  }

  static async join(p: JoinParams): Promise<RoomSession> {
    void clearTemporaryFiles();
    const s = p.settings;
    const signal: SignalConfig = {
      nostr: { enabled: s.nostr.enabled, relays: s.nostr.relays },
      torrent: { enabled: s.torrent.enabled, trackers: s.torrent.trackers },
      manual: { enabled: s.manual.enabled },
    };
    const mode = detectE2ee();
    let session!: RoomSession;
    const room = await Room.create(
      {
        roomKey: p.key,
        ...(p.passphrase ? { passphrase: p.passphrase } : {}),
        nick: p.nick,
        signal,
        rtc: rtcConfigFor(mode, { iceServers: iceServers(s) }),
        e2ee: mode !== "none",
      },
      {
        members: () => session?.onMembers(),
        links: (links) => session?.onLinks(links),
        transports: (t) => {
          if (!session) return;
          session.transports = t;
          session.changed();
        },
        app: (author, msg) => session?.onApp(author, msg),
        manualCode: (code, kind) => {
          if (session) session.manualCode.value = { code, kind };
        },
        linkUp: (peer) => {
          session?.files.onLinkUp(peer.remoteId);
          if (session?.room.members.has(peer.remoteId)) session.media.onLinkUp(peer);
        },
        linkDown: (id) => {
          session?.files.onLinkDown(id);
          session?.media.onLinkDown(id);
        },
        track: (peer, ev) => session?.media.onTrack(peer, ev),
        ctrl: (peer, msg) => session?.media.onCtrl(peer, msg),
        file: (peer, frame) => session?.files.onFrame(peer, frame),
        keys: () => session?.media.onKeys(),
        memberLeft: (id) => {
          if (!session) return;
          session.files.onMemberLeft(id);
          session.chat.forget(id);
          session.verified.delete(id);
        },
      },
    );
    const digest = await sha256(room.secrets.sasSalt);
    const badge: Sas = { emojis: [], names: [] };
    for (const b of digest.subarray(0, 3)) {
      const e = SAS_EMOJIS[b & 63] as readonly [string, string];
      badge.emojis.push(e[0]);
      badge.names.push(e[1]);
    }
    session = new RoomSession(room, p, badge);
    await room.start();
    if (p.audio || p.video) {
      try {
        await session.media.start({
          audio: p.audio,
          video: p.video,
        });
      } catch (err) {
        session.toast(mediaError(err), "warn");
      }
    }
    return session;
  }

  get peerId(): string {
    return this.room.peerId;
  }

  /** Coalesces change notifications into one render per frame. */
  changed(): void {
    if (this.pending) return;
    this.pending = true;
    const flush = () => {
      this.pending = false;
      this.tick.value++;
    };
    if (typeof requestAnimationFrame === "function" && document.visibilityState === "visible")
      requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  toast(text: string, tone: Toast["tone"] = "info"): void {
    const id = ++this.toastId;
    this.toasts.value = [...this.toasts.value, { id, text, tone }].slice(-3);
    setTimeout(
      () => {
        this.toasts.value = this.toasts.value.filter((t) => t.id !== id);
      },
      tone === "info" ? 3500 : 6000,
    );
  }

  private onMembers(): void {
    // Media is attached once we know the member (its E2EE capability comes with its presence).
    for (const peer of this.room.peers.values())
      if (peer.ready && this.room.members.has(peer.remoteId)) this.media.onLinkUp(peer);
    this.changed();
  }

  private onLinks(links: LinkInfo[]): void {
    const before = new Map(this.links.map((l) => [l.peerId, l.state]));
    this.links = links;
    for (const l of links) if (l.state === "connected") this.everConnected = true;
    // A link that died before ever becoming secure usually means NAT traversal failed.
    for (const [id, state] of before) {
      if ((state === "connecting" || state === "securing") && !links.some((l) => l.peerId === id))
        this.failures++;
    }
    if (this.failures >= 2 && !this.params.settings.turn) {
      this.connectivityHint = this.everConnected
        ? "Some members could not be reached directly. A TURN server (Settings) can relay those connections."
        : "Direct connection impossible from this network. Add a TURN server in Settings to relay the connection.";
    }
    this.changed();
  }

  private onApp(author: string, msg: AppMessage): void {
    if (msg.type === "file-offer") {
      // Offers are re-announced to latecomers: show each file once.
      const known = this.files.incoming.has(msg.id);
      this.files.onApp(author, msg);
      if (!known) this.chat.addFileEntry(author, msg.id, false);
    } else if (msg.type === "file-cancel") {
      this.files.onApp(author, msg);
    } else {
      const before = this.chat.messages.length;
      this.chat.onApp(author, msg);
      if (msg.type === "chat" && this.chat.messages.length > before && !this.chatOpen)
        this.unread.value++;
    }
  }

  // ── views ─────────────────────────────────────────────────────────────────

  members(): MemberView[] {
    const linkOf = new Map(this.links.map((l) => [l.peerId, l]));
    const now = Date.now();
    const out: MemberView[] = [
      {
        peerId: this.peerId,
        nick: this.params.nick || "You",
        self: true,
        media: this.media.state(),
        link: null,
        rtt: null,
        relayed: false,
        verified: true,
        blocked: false,
        speaking: this.media.micOn && this.media.localLevel > 0.06,
        e2ee: this.media.e2ee,
      },
    ];
    const list: Member[] = [...this.room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    for (const m of list) {
      const l = linkOf.get(m.peerId);
      const r = this.media.remote.get(m.peerId);
      out.push({
        peerId: m.peerId,
        nick: m.nick,
        self: false,
        media: m.media ?? NO_MEDIA,
        link: l?.state ?? null,
        rtt: l?.rtt ?? null,
        relayed: l?.relayed ?? false,
        verified: this.verified.has(m.peerId),
        blocked: this.room.blocked.has(m.peerId),
        speaking: !!r && now - r.lastSpoke < 600,
        e2ee: m.e2ee,
      });
    }
    return out;
  }

  nickOf(peerId: string): string {
    if (peerId === this.peerId) return this.params.nick || "You";
    return this.room.members.get(peerId)?.nick ?? "Someone who left";
  }

  fileView(id: string): FileView | null {
    const out = this.files.outgoing.get(id);
    if (out) return { dir: "out", file: out.pub };
    const inc = this.files.incoming.get(id);
    return inc ? { dir: "in", file: inc.pub } : null;
  }

  messages(): readonly ChatMessage[] {
    return this.chat.messages;
  }

  /** Media is end-to-end encrypted with everyone we are sending to or receiving from. */
  mediaE2ee(): boolean {
    if (!this.media.e2ee) return false;
    for (const id of this.media.remote.keys()) if (!this.media.pairE2ee(id)) return false;
    return true;
  }

  // ── actions ───────────────────────────────────────────────────────────────

  async sendText(text: string): Promise<void> {
    await this.chat.sendText(text);
  }

  async offerFiles(list: Iterable<File>): Promise<void> {
    for (const f of list) {
      const out = await this.files.offer(f);
      this.chat.addFileEntry(this.peerId, out.id, true);
    }
  }

  /** Must run inside the click handler: the save picker needs a user gesture. */
  async acceptFile(id: string): Promise<void> {
    const inc = this.files.incoming.get(id)?.pub;
    if (!inc) return;
    const sink = await pickSink(inc);
    if (!sink) return;
    this.files.accept(id, sink);
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) this.unread.value = 0;
  }

  async sas(peerId: string): Promise<Sas | null> {
    return this.room.sas(peerId);
  }

  markVerified(peerId: string, ok: boolean): void {
    if (ok) {
      this.verified.add(peerId);
      this.mismatched.delete(peerId);
    } else {
      this.verified.delete(peerId);
      this.mismatched.add(peerId);
      this.room.block(peerId);
      this.toast("Verification failed: disconnected from that member.", "error");
    }
    this.changed();
  }

  private mediaQueue: Promise<void> = Promise.resolve();

  /** Media operations run one at a time: a second click never races a pending getUserMedia. */
  private queueMedia(op: () => Promise<void>): Promise<void> {
    const run = this.mediaQueue.then(op).catch((err) => {
      if (err instanceof DOMException && err.name === "NotAllowedError" && this.media.active)
        return;
      this.toast(mediaError(err), "warn");
    });
    this.mediaQueue = run;
    return run;
  }

  toggleMic(): Promise<void> {
    return this.queueMedia(async () => {
      if (!this.media.active) await this.media.start({ audio: true, video: false });
      else await this.media.setMic(!this.media.micOn);
    });
  }

  toggleCam(): Promise<void> {
    return this.queueMedia(async () => {
      if (!this.media.active) await this.media.start({ audio: false, video: true });
      else await this.media.setCam(!this.media.camOn);
    });
  }

  toggleScreen(): Promise<void> {
    return this.queueMedia(async () => {
      if (!this.media.active) await this.media.start({ audio: false, video: false });
      try {
        await this.media.setScreen(!this.media.screenOn);
      } catch (err) {
        // Cancelling the browser's screen picker is not an error.
        if (err instanceof DOMException && err.name === "NotAllowedError") return;
        throw err;
      }
    });
  }

  /** Saves the chosen microphone or camera and switches to it now if it is in use. */
  selectDevice(kind: "audio" | "video", deviceId: string): Promise<void> {
    saveSettings({
      ...settings.value,
      [kind === "audio" ? "audioDevice" : "videoDevice"]: deviceId,
    });
    return this.queueMedia(() => this.media.switchDevice(kind));
  }

  hangUp(): void {
    void this.queueMedia(async () => this.media.stop());
  }

  createManualOffer(): void {
    this.manualCode.value = null;
    this.room.createManualOffer();
  }

  ingestManual(code: string): boolean {
    return this.room.ingestManual(code);
  }

  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    this.media.dispose();
    this.files.dispose();
    this.chat.dispose();
    await this.room.leave();
  }
}

export function mediaError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError")
    return "Camera or microphone access was denied. Allow it in your browser settings.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No camera or microphone found.";
  if (name === "NotReadableError") return "Your camera or microphone is in use by another app.";
  return "Could not start camera or microphone.";
}
