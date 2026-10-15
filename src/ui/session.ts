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
import { detectE2ee, Media, rtcConfigFor, SCREEN_TRACK_CAP } from "../features/media";
import { Recorder, type RecorderSource, type RecordingUrls } from "../features/recorder";
import type { PeerState } from "../mesh/peer";
import type { AppMessage, MediaState } from "../mesh/protocol";
import { type LinkInfo, type Member, Room } from "../mesh/room";
import type { SignalConfig } from "../signal/mux";
import type { TransportStatus } from "../signal/types";
import { iceServers, type ScreenQuality, type Settings, saveSettings, settings } from "./settings";

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

export type RecordingState = "idle" | "recording" | "stopping";

/** The files of a finished recording, with when it started (for their names). */
export interface RecordingFiles extends RecordingUrls {
  started: number;
}

const NO_MEDIA: MediaState = { audio: false, video: false, screen: false };

export class RoomSession {
  readonly tick = signal(0);
  readonly manualCode = signal<{ code: string; kind: "offer" | "answer" } | null>(null);
  readonly toasts = signal<Toast[]>([]);
  readonly unread = signal(0);
  /** Files offered to us while the Files view was not on screen. */
  readonly pendingFiles = signal(0);
  readonly recording = signal<RecordingState>("idle");
  chatOpen = false;
  filesVisible = false;
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
  private recorder: Recorder | null = null;
  /** Our camera (or screen) and microphone as one stream, kept stable for the recorder. */
  private readonly selfStream = new MediaStream();
  /** Who was recording at the last members update, to announce changes. */
  private recordingMembers = new Set<string>();

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
      memberCaps: (id) => room.members.get(id)?.caps ?? [],
      screenQuality: () => settings.value.screenQuality,
      publish: (state) => room.setMedia(this.presence(state)),
      onChange: () => this.changed(),
      workerUrl: __E2EE_WORKER_URL__,
      // Read live: a device chosen in Settings during the call applies to the next capture.
      preferredDevices: () => ({
        audio: settings.value.audioDevice,
        video: settings.value.videoDevice,
      }),
      noiseReduction: () => settings.value.noiseReduction,
      noiseAssets: __NOISE_ASSETS__,
      onNoiseReductionFailed: () =>
        this.toast("Strong noise reduction couldn't start: using the standard one.", "warn"),
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
        caps: [SCREEN_TRACK_CAP],
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
    // Capabilities and screen stream ids come with presence: screen senders and routing follow.
    this.media.onMembers();
    const recording = new Set<string>();
    for (const m of this.room.members.values()) if (m.media?.recording) recording.add(m.peerId);
    for (const id of recording)
      if (!this.recordingMembers.has(id)) this.toast(`${this.nickOf(id)} started recording`);
    for (const id of this.recordingMembers)
      if (!recording.has(id)) this.toast(`${this.nickOf(id)} stopped recording`);
    this.recordingMembers = recording;
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
      if (!known) {
        this.chat.addFileEntry(author, msg.id, false);
        if (!this.filesVisible) {
          this.pendingFiles.value++;
          this.toast(`${this.nickOf(author)} wants to send you ${msg.name}`);
        }
      }
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
        media: this.presence(this.media.state()),
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

  setFilesVisible(visible: boolean): void {
    this.filesVisible = visible;
    if (visible) this.pendingFiles.value = 0;
  }

  /** Every file offered in the room, newest first (ours and others'). */
  fileEntries(): { fileId: string; author: string; ts: number; mine: boolean }[] {
    const out: { fileId: string; author: string; ts: number; mine: boolean }[] = [];
    for (const m of this.chat.messages)
      if (m.fileId) out.push({ fileId: m.fileId, author: m.author, ts: m.ts, mine: m.mine });
    return out.reverse();
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    if (open) this.unread.value = 0;
  }

  async sas(peerId: string): Promise<Sas | "outdated" | null> {
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

  /** Saves the screen-share quality and applies it now if we are sharing. */
  setScreenQuality(q: ScreenQuality): Promise<void> {
    saveSettings({ ...settings.value, screenQuality: q });
    return this.queueMedia(() => this.media.setScreenQuality(q));
  }

  /** Saves strong noise reduction on or off and reopens the microphone with it, if in use. */
  setNoiseReduction(on: boolean): Promise<void> {
    saveSettings({ ...settings.value, noiseReduction: on });
    return this.queueMedia(() => this.media.switchDevice("audio"));
  }

  /** Saves the chosen microphone or camera and switches to it now if it is in use. */
  selectDevice(kind: "audio" | "video", deviceId: string): Promise<void> {
    saveSettings({
      ...settings.value,
      [kind === "audio" ? "audioDevice" : "videoDevice"]: deviceId,
    });
    return this.queueMedia(() => this.media.switchDevice(kind));
  }

  private get isRecording(): boolean {
    return this.recording.value === "recording";
  }

  /** Records the call on this device: everyone is told through our presence. */
  async startRecording(): Promise<void> {
    if (this.recording.value !== "idle") return;
    // The previous recording's sheet is closed by now: its files can go.
    this.recorder?.dispose();
    const recorder = new Recorder({
      sources: () => this.recorderSources(),
      sink: (meta) => pickSink(meta, { preferPicker: false }),
    });
    this.recorder = recorder;
    this.recording.value = "recording";
    try {
      await recorder.start();
    } catch (err) {
      console.warn("recording failed to start", err);
      recorder.dispose();
      this.recorder = null;
      this.recording.value = "idle";
      this.toast("Could not start recording.", "warn");
    }
    this.publishRecording();
  }

  /**
   * Stops recording and returns its files, or null if nothing was recording.
   * A call while already stopping waits for the same files.
   */
  async stopRecording(): Promise<RecordingFiles | null> {
    const recorder = this.recorder;
    if (!recorder || this.recording.value === "idle") return null;
    if (this.recording.value === "recording") {
      this.recording.value = "stopping";
      this.publishRecording();
    }
    const urls = await recorder.stop();
    this.recording.value = "idle";
    this.changed();
    return { ...urls, started: recorder.started };
  }

  private presence(state: MediaState): MediaState {
    return { ...state, recording: this.isRecording };
  }

  /** Publishes our recording state. */
  private publishRecording(): void {
    this.room.setMedia(this.presence(this.media.state()));
    this.changed();
  }

  /** Us first, then everyone whose media we receive, then any screen share. */
  private recorderSources(): RecorderSource[] {
    const want = [
      ...this.media.preview.getVideoTracks(),
      ...(this.media.micOn && this.media.audioTrack ? [this.media.audioTrack] : []),
    ];
    for (const t of this.selfStream.getTracks())
      if (!want.includes(t)) this.selfStream.removeTrack(t);
    const have = this.selfStream.getTracks();
    for (const t of want) if (!have.includes(t)) this.selfStream.addTrack(t);
    const out: RecorderSource[] = [
      { id: this.peerId, nick: this.nickOf(this.peerId), stream: this.selfStream },
    ];
    for (const r of this.media.remote.values())
      out.push({ id: r.peerId, nick: this.nickOf(r.peerId), stream: r.stream });
    // Screen ids differ from camera ids: the recorder keys its videos by id.
    if (this.media.screenOn)
      out.push({
        id: `${this.peerId}:screen`,
        nick: this.nickOf(this.peerId),
        stream: this.media.screenStream,
        kind: "screen",
      });
    for (const r of this.media.remote.values())
      if (r.screen)
        out.push({
          id: `${r.peerId}:screen`,
          nick: this.nickOf(r.peerId),
          stream: r.screen,
          kind: "screen",
        });
    return out;
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
    if (this.recorder) {
      await this.recorder.stop();
      this.recorder.dispose();
      this.recorder = null;
      this.recording.value = "idle";
    }
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
