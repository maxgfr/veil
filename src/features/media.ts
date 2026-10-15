/**
 * Calls: camera, microphone, screen sharing, sent directly to every member
 * we have a link with (no SFU), with:
 *  - media E2EE via Encoded Transforms (frames encrypted with our sender
 *    key, in a worker), detected at runtime;
 *  - an uplink budget: bitrate and resolution per receiver come from the
 *    measured available bandwidth and the number of receivers;
 *  - graceful degradation in large rooms: we only ask for video from the
 *    most recent active speakers (and screen shares); the others stay audio;
 *  - screen sharing on its own track, next to the camera, for members that
 *    announce the "screen-track" capability (the screen replaces the camera
 *    for the others). The receiver tells the two apart by stream id (msid),
 *    published in presence as `screenStream`.
 */
import { type Bytes, utf8 } from "../crypto/bytes";
import { hkdf } from "../crypto/room";
import type { SenderKeys } from "../crypto/senderkeys";
import type { Peer } from "../mesh/peer";
import type { CtrlMessage, MediaState } from "../mesh/protocol";
import { trustedScriptUrl } from "../security";
import type { ScreenQuality } from "../ui/settings";
import type { WorkerMessage } from "../workers/e2ee-worker";
import { type DeviceRequest, type MediaKind, openDevices } from "./devices";

export type E2eeMode = "script" | "streams" | "none";

declare class RTCRtpScriptTransform {
  constructor(worker: Worker, options?: unknown, transfer?: Transferable[]);
}

interface EncodedStreams {
  readable: ReadableStream;
  writable: WritableStream;
}

type WithStreams<T> = T & { createEncodedStreams?: () => EncodedStreams; transform?: unknown };

export function detectE2ee(): E2eeMode {
  if (
    typeof (globalThis as { RTCRtpScriptTransform?: unknown }).RTCRtpScriptTransform === "function"
  )
    return "script";
  if (typeof RTCRtpSender !== "undefined" && "createEncodedStreams" in RTCRtpSender.prototype)
    return "streams";
  return "none";
}

/** Chromium's legacy API needs a flag on every RTCPeerConnection. */
export function rtcConfigFor(mode: E2eeMode, base: RTCConfiguration): RTCConfiguration {
  return mode === "streams"
    ? ({ ...base, encodedInsertableStreams: true } as RTCConfiguration)
    : base;
}

export async function mediaKey(senderKey: Uint8Array): Promise<Bytes> {
  return hkdf(senderKey, utf8("veil/v1"), "media");
}

export interface Budget {
  /** Per-receiver video bitrate cap, bits/s. */
  maxBitrate: number;
  scaleResolutionDownBy: number;
  /** How many incoming videos this device should decode at once. */
  maxVideoIn: number;
}

/** Splits the measured uplink between video receivers; keeps headroom for audio and data. */
export function videoBudget(o: {
  uplinkBps: number;
  videoReceivers: number;
  cores: number;
}): Budget {
  const usable = Math.max(0, o.uplinkBps * 0.85 - 64_000 * o.videoReceivers);
  const per = usable / Math.max(1, o.videoReceivers);
  const maxBitrate = Math.round(Math.min(1_500_000, Math.max(80_000, per)));
  const scaleResolutionDownBy = maxBitrate >= 900_000 ? 1 : maxBitrate >= 350_000 ? 2 : 4;
  const maxVideoIn = o.cores >= 8 ? 12 : o.cores >= 4 ? 8 : 4;
  return { maxBitrate, scaleResolutionDownBy, maxVideoIn };
}

export interface Speaker {
  peerId: string;
  lastSpoke: number;
  screen: boolean;
  video: boolean;
}

/** Screen shares first, then the most recent speakers, up to `max` videos. */
export function pickVideoSources(speakers: readonly Speaker[], max: number): Set<string> {
  const withVideo = speakers.filter((s) => s.video || s.screen);
  withVideo.sort(
    (a, b) =>
      Number(b.screen) - Number(a.screen) ||
      b.lastSpoke - a.lastSpoke ||
      (a.peerId < b.peerId ? -1 : 1),
  );
  return new Set(withVideo.slice(0, max).map((s) => s.peerId));
}

/** Members announcing this send the screen on its own track, next to the camera. */
export const SCREEN_TRACK_CAP = "screen-track";

/** Stream ids as published in presence: Firefox wraps them in braces, which ids can't hold. */
export const streamKey = (id: string): string => id.replace(/[{}]/g, "");

/** Capture constraints and sender settings for each screen-share quality. */
export const SCREEN_PROFILES: Record<
  ScreenQuality,
  {
    hint: "detail" | "motion";
    width: number;
    height: number;
    frameRate: number;
    maxBitrate: number;
    degradation: "maintain-resolution" | "maintain-framerate";
  }
> = {
  detail: {
    hint: "detail",
    width: 1920,
    height: 1080,
    frameRate: 15,
    maxBitrate: 1_500_000,
    degradation: "maintain-resolution",
  },
  motion: {
    hint: "motion",
    width: 1280,
    height: 720,
    frameRate: 30,
    maxBitrate: 2_500_000,
    degradation: "maintain-framerate",
  },
};

export function screenConstraints(q: ScreenQuality): MediaTrackConstraints {
  const p = SCREEN_PROFILES[q];
  return {
    width: { max: p.width },
    height: { max: p.height },
    frameRate: { ideal: p.frameRate, max: p.frameRate },
  };
}

/** While sharing, the camera goes out small so the screen keeps the bandwidth. */
const CAMERA_WHILE_SHARING = { maxBitrate: 150_000, scaleResolutionDownBy: 4 };

export interface RemoteMedia {
  peerId: string;
  /** Camera and microphone. */
  stream: MediaStream;
  /** The member's screen share on its own track, null when none. */
  screen: MediaStream | null;
  audioLevel: number;
  lastSpoke: number;
  /** We asked this member to send us video. */
  wantVideo: boolean;
}

interface Senders {
  peer: Peer;
  audio: RTCRtpSender;
  video: RTCRtpSender;
  /** Added on the first share to a capable member, then only replaceTrack. */
  screen?: RTCRtpSender;
  /** The receiver asked us for video. */
  videoWanted: boolean;
}

/** A received video track and the stream id (msid) it came with. */
interface Incoming {
  track: MediaStreamTrack;
  msid: string;
}

export interface MediaDeps {
  peers(): Iterable<Peer>;
  peer(id: string): Peer | undefined;
  keys: SenderKeys;
  /** Member flags from presence: who has video/screen on. */
  memberMedia(peerId: string): MediaState | undefined;
  /** Whether a member can encrypt/decrypt media frames (from its presence). */
  memberE2ee(peerId: string): boolean;
  publish(state: MediaState): void;
  onChange(): void;
  workerUrl: string;
  mode?: E2eeMode;
  /** The microphone and camera chosen in Settings ("" = system default), read at each use. */
  preferredDevices(): { audio: string; video: string };
  /** A chosen device could not be opened and the system default was used instead. */
  onDeviceFallback?(kind: MediaKind): void;
  /** Optional features a member announced in its presence ("screen-track"). */
  memberCaps(peerId: string): readonly string[];
  /** The screen-share quality chosen in Settings, read when Media is created. */
  screenQuality(): ScreenQuality;
}

export interface StartOptions {
  audio: boolean;
  video: boolean;
}

const SPEAKING_LEVEL = 0.04;

export class Media {
  readonly mode: E2eeMode;
  active = false;
  micOn = false;
  camOn = false;
  screenOn = false;
  audioTrack: MediaStreamTrack | null = null;
  cameraTrack: MediaStreamTrack | null = null;
  screenTrack: MediaStreamTrack | null = null;
  /** Our camera, for the self view. */
  readonly preview = new MediaStream();
  /** Our single screen-share stream: its id is the msid capable members route by. */
  readonly screenStream = new MediaStream();
  readonly remote = new Map<string, RemoteMedia>();
  e2eeStats = { encrypted: 0, decrypted: 0, dropped: 0 };
  budget: Budget = { maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxVideoIn: 8 };
  localLevel = 0;
  private readonly senders = new Map<string, Senders>();
  private readonly attached = new WeakSet<Peer>();
  /** Received video tracks per member, routed to camera or screen by msid. */
  private readonly incoming = new Map<string, Incoming[]>();
  /** Every screen stream id a member published: those tracks never go to the camera. */
  private readonly screenIds = new Map<string, Set<string>>();
  /** The stream id each member's audio came with: its camera shares it. */
  private readonly audioMsid = new Map<string, string>();
  private quality: ScreenQuality;
  private worker: Worker | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly d: MediaDeps) {
    this.mode = d.mode ?? detectE2ee();
    this.quality = d.screenQuality();
  }

  get e2ee(): boolean {
    return this.mode !== "none";
  }

  private get camTrack(): MediaStreamTrack | null {
    return this.camOn ? this.cameraTrack : null;
  }

  /** The member gets the screen on its own track. */
  private capable(peerId: string): boolean {
    return this.d.memberCaps(peerId).includes(SCREEN_TRACK_CAP);
  }

  /** What goes on a link's video sender: the camera, or the screen for members without screen-track. */
  private videoFor(peerId: string): MediaStreamTrack | null {
    return this.screenOn && !this.capable(peerId) ? this.screenTrack : this.camTrack;
  }

  state(): MediaState {
    const s: MediaState = { audio: this.micOn, video: this.camOn, screen: this.screenOn };
    if (this.screenOn) s.screenStream = streamKey(this.screenStream.id);
    return s;
  }

  // ── E2EE worker ───────────────────────────────────────────────────────────

  private ensureWorker(): Worker | null {
    if (this.mode === "none") return null;
    if (!this.worker) {
      this.worker = new Worker(trustedScriptUrl(this.d.workerUrl) as unknown as string, {
        type: "module",
        name: "veil-e2ee",
      });
      this.worker.onmessage = (
        e: MessageEvent<{ type: string; encrypted: number; decrypted: number; dropped: number }>,
      ) => {
        if (e.data?.type !== "stats") return;
        const { encrypted, decrypted, dropped } = e.data;
        const changed =
          decrypted !== this.e2eeStats.decrypted || encrypted !== this.e2eeStats.encrypted;
        this.e2eeStats = { encrypted, decrypted, dropped };
        if (changed) this.d.onChange();
      };
      void this.syncKeys();
    }
    return this.worker;
  }

  private post(m: WorkerMessage, transfer: Transferable[] = []): void {
    this.worker?.postMessage(m, transfer);
  }

  /** Pushes our current media key and every member's keys to the worker. */
  async syncKeys(): Promise<void> {
    if (!this.worker) return;
    const own = await mediaKey(this.d.keys.currentRaw);
    this.post({ type: "send-key", keyId: this.d.keys.keyId, raw: own.slice().buffer });
    for (const peer of this.d.peers()) await this.syncPeerKeys(peer.remoteId);
  }

  private async syncPeerKeys(author: string): Promise<void> {
    const keys = await Promise.all(
      this.d.keys
        .remoteKeys(author)
        .map(async (k) => ({ keyId: k.keyId, raw: (await mediaKey(k.raw)).slice().buffer })),
    );
    this.post({ type: "recv-keys", author, keys });
  }

  /** Media is end-to-end encrypted with a member only if both sides support it. */
  pairE2ee(peerId: string): boolean {
    return this.e2ee && this.d.memberE2ee(peerId);
  }

  private attachTransform(
    target: WithStreams<RTCRtpSender> | WithStreams<RTCRtpReceiver>,
    op: "encrypt" | "decrypt",
    author: string,
    kind: "audio" | "video",
  ): void {
    if (!this.pairE2ee(author)) return;
    const worker = this.ensureWorker();
    if (!worker) return;
    if (this.mode === "script") {
      target.transform = new RTCRtpScriptTransform(worker, { op, author, kind });
    } else if (this.mode === "streams" && target.createEncodedStreams) {
      const { readable, writable } = target.createEncodedStreams();
      this.post({ type: "stream", op, author, kind, readable, writable }, [
        readable,
        writable,
      ] as unknown as Transferable[]);
    }
  }

  // ── local media ───────────────────────────────────────────────────────────

  /** Opens the chosen devices (falling back to the defaults if they are gone). */
  private async open(want: DeviceRequest): Promise<MediaStream> {
    const { stream, fellBack } = await openDevices(want);
    for (const kind of fellBack) this.d.onDeviceFallback?.(kind);
    return stream;
  }

  async start(o: StartOptions): Promise<void> {
    const pref = this.d.preferredDevices();
    const want: DeviceRequest = {};
    if (o.audio) want.audio = pref.audio;
    if (o.video) want.video = pref.video;
    const stream = o.audio || o.video ? await this.open(want) : new MediaStream();
    this.audioTrack = stream.getAudioTracks()[0] ?? null;
    this.cameraTrack = stream.getVideoTracks()[0] ?? null;
    this.micOn = !!this.audioTrack;
    this.camOn = !!this.cameraTrack;
    if (this.audioTrack) this.watchLocalLevel(this.audioTrack);
    this.active = true;
    this.refreshPreview();
    for (const peer of this.d.peers()) if (peer.ready) this.attach(peer);
    this.startLoops();
    this.d.publish(this.state());
    this.d.onChange();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    for (const t of [this.audioTrack, this.cameraTrack, this.screenTrack]) t?.stop();
    this.audioTrack = this.cameraTrack = this.screenTrack = null;
    this.micOn = this.camOn = this.screenOn = false;
    for (const s of this.senders.values()) {
      void s.audio.replaceTrack(null).catch(() => {});
      void s.video.replaceTrack(null).catch(() => {});
      void s.screen?.replaceTrack(null).catch(() => {});
    }
    this.refreshScreenStream();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    void this.audioCtx?.close().catch(() => {});
    this.audioCtx = null;
    this.localAnalyser = null;
    this.localSource = null;
    this.refreshPreview();
    this.d.publish(this.state());
    this.d.onChange();
  }

  async setMic(on: boolean): Promise<void> {
    if (on && !this.audioTrack) {
      const s = await this.open({ audio: this.d.preferredDevices().audio });
      this.audioTrack = s.getAudioTracks()[0] ?? null;
      if (this.audioTrack) this.watchLocalLevel(this.audioTrack);
    }
    if (this.audioTrack) this.audioTrack.enabled = on;
    this.micOn = on && !!this.audioTrack;
    for (const s of this.senders.values())
      void s.audio.replaceTrack(this.micOn ? this.audioTrack : null).catch(() => {});
    this.d.publish(this.state());
    this.d.onChange();
  }

  async setCam(on: boolean): Promise<void> {
    if (on) {
      if (!this.cameraTrack) {
        const s = await this.open({ video: this.d.preferredDevices().video });
        this.cameraTrack = s.getVideoTracks()[0] ?? null;
      }
    } else {
      // Turning the camera off releases it (the light goes off).
      this.cameraTrack?.stop();
      this.cameraTrack = null;
    }
    this.camOn = on && !!this.cameraTrack;
    this.updateVideoSenders();
    this.refreshPreview();
    this.d.publish(this.state());
    this.d.onChange();
  }

  /**
   * Applies a newly chosen device right away if it is in use: the new track
   * replaces the old one on every link, without renegotiation.
   */
  async switchDevice(kind: MediaKind): Promise<void> {
    const pref = this.d.preferredDevices();
    if (kind === "audio") {
      if (!this.audioTrack) return;
      const track = (await this.open({ audio: pref.audio })).getAudioTracks()[0];
      if (!track) return;
      this.audioTrack.stop();
      this.audioTrack = track;
      track.enabled = this.micOn;
      this.watchLocalLevel(track);
      for (const sd of this.senders.values())
        void sd.audio.replaceTrack(this.micOn ? track : null).catch(() => {});
    } else {
      if (!this.camOn || !this.cameraTrack) return;
      const track = (await this.open({ video: pref.video })).getVideoTracks()[0];
      if (!track) return;
      this.cameraTrack.stop();
      this.cameraTrack = track;
      this.updateVideoSenders();
      this.refreshPreview();
    }
    this.d.onChange();
  }

  /** The device actually capturing, as the browser reports it (for display and tests). */
  activeDeviceId(kind: MediaKind): string {
    const track = kind === "audio" ? this.audioTrack : this.cameraTrack;
    return track?.getSettings().deviceId ?? "";
  }

  async setScreen(on: boolean): Promise<void> {
    if (on) {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: screenConstraints(this.quality),
        audio: false,
      });
      const track = s.getVideoTracks()[0];
      if (!track) return;
      track.contentHint = SCREEN_PROFILES[this.quality].hint;
      track.addEventListener("ended", () => {
        if (this.screenTrack === track) void this.setScreen(false);
      });
      this.screenTrack?.stop();
      this.screenTrack = track;
      this.screenOn = true;
    } else {
      this.screenTrack?.stop();
      this.screenTrack = null;
      this.screenOn = false;
    }
    this.refreshScreenStream();
    this.updateVideoSenders();
    for (const id of this.senders.keys()) void this.applyBudget(id);
    this.d.publish(this.state());
    this.d.onChange();
  }

  /**
   * Changes the screen-share quality. While sharing it applies right away (capture
   * constraints, content hint and encoding, without a new picker); otherwise it
   * is used by the next share.
   */
  async setScreenQuality(q: ScreenQuality): Promise<void> {
    this.quality = q;
    const track = this.screenTrack;
    if (!track) return;
    track.contentHint = SCREEN_PROFILES[q].hint;
    await track.applyConstraints(screenConstraints(q));
    await Promise.all([...this.senders.keys()].map((id) => this.applyBudget(id)));
    this.d.onChange();
  }

  private refreshPreview(): void {
    for (const t of this.preview.getTracks()) this.preview.removeTrack(t);
    const v = this.camTrack;
    if (v) this.preview.addTrack(v);
  }

  private refreshScreenStream(): void {
    for (const t of this.screenStream.getTracks()) this.screenStream.removeTrack(t);
    if (this.screenOn && this.screenTrack) this.screenStream.addTrack(this.screenTrack);
  }

  private updateVideoSenders(): void {
    for (const [id, s] of this.senders) {
      void s.video.replaceTrack(s.videoWanted ? this.videoFor(id) : null).catch(() => {});
      this.updateScreenSender(id, s);
    }
  }

  /** The screen always goes out to capable members (not subject to their video want). */
  private updateScreenSender(peerId: string, s: Senders): void {
    if (!this.capable(peerId)) {
      void s.screen?.replaceTrack(null).catch(() => {});
      return;
    }
    const track = this.screenOn ? this.screenTrack : null;
    if (!s.screen) {
      if (!track) return;
      // First share on this link: one more transceiver (one renegotiation), then only replaceTrack.
      const t = s.peer.pc.addTransceiver("video", {
        direction: "sendonly",
        streams: [this.screenStream],
      });
      preferVp8(t);
      this.attachTransform(t.sender, "encrypt", peerId, "video");
      s.screen = t.sender;
    }
    void s.screen.replaceTrack(track).catch(() => {});
  }

  /** Presence changed: capabilities may have arrived (screen sender) and screen ids too (routing). */
  onMembers(): void {
    if (this.active) this.updateVideoSenders();
    let changed = false;
    for (const id of this.remote.keys()) changed = this.route(id) || changed;
    if (changed) this.d.onChange();
  }

  private watchLocalLevel(track: MediaStreamTrack): void {
    try {
      this.audioCtx ??= new AudioContext();
      // One source at a time: a device switch must not leave the old one connected.
      this.localSource?.disconnect();
      this.localSource = this.audioCtx.createMediaStreamSource(new MediaStream([track]));
      this.localAnalyser = this.audioCtx.createAnalyser();
      this.localAnalyser.fftSize = 256;
      this.localSource.connect(this.localAnalyser);
    } catch {
      this.localAnalyser = null;
    }
  }

  // ── per-peer wiring ───────────────────────────────────────────────────────

  /** Adds our send-only audio+video transceivers to a link (one renegotiation, then only replaceTrack). */
  attach(peer: Peer): void {
    if (!this.active || this.attached.has(peer) || !peer.ready) return;
    this.attached.add(peer);
    const pc = peer.pc;
    const stream = new MediaStream();
    const audio = pc.addTransceiver("audio", { direction: "sendonly", streams: [stream] });
    const video = pc.addTransceiver("video", { direction: "sendonly", streams: [stream] });
    preferVp8(video);
    this.attachTransform(audio.sender, "encrypt", peer.remoteId, "audio");
    this.attachTransform(video.sender, "encrypt", peer.remoteId, "video");
    const s: Senders = { peer, audio: audio.sender, video: video.sender, videoWanted: true };
    this.senders.set(peer.remoteId, s);
    void audio.sender.replaceTrack(this.micOn ? this.audioTrack : null).catch(() => {});
    void video.sender.replaceTrack(this.videoFor(peer.remoteId)).catch(() => {});
    this.updateScreenSender(peer.remoteId, s);
    void this.applyBudget(peer.remoteId);
  }

  onLinkUp(peer: Peer): void {
    this.attach(peer);
    void this.syncPeerKeys(peer.remoteId);
  }

  onLinkDown(peerId: string): void {
    this.senders.delete(peerId);
    const r = this.remote.get(peerId);
    if (r) {
      for (const t of r.stream.getTracks()) t.stop();
      for (const t of r.screen?.getTracks() ?? []) t.stop();
      this.remote.delete(peerId);
    }
    this.incoming.delete(peerId);
    this.screenIds.delete(peerId);
    this.audioMsid.delete(peerId);
    this.post({ type: "forget", author: peerId });
    this.d.onChange();
  }

  onTrack(peer: Peer, ev: RTCTrackEvent): void {
    const kind = ev.track.kind === "audio" ? "audio" : "video";
    this.attachTransform(ev.receiver, "decrypt", peer.remoteId, kind);
    if (kind === "video" && ev.transceiver) preferVp8(ev.transceiver);
    let r = this.remote.get(peer.remoteId);
    if (!r) {
      r = {
        peerId: peer.remoteId,
        stream: new MediaStream(),
        screen: null,
        audioLevel: 0,
        lastSpoke: 0,
        wantVideo: true,
      };
      this.remote.set(peer.remoteId, r);
    }
    const track = ev.track;
    const msid = streamKey(ev.streams[0]?.id ?? "");
    if (kind === "audio") {
      for (const t of r.stream.getAudioTracks()) r.stream.removeTrack(t);
      r.stream.addTrack(track);
      this.audioMsid.set(peer.remoteId, msid);
    } else {
      const list = (this.incoming.get(peer.remoteId) ?? []).filter((x) => x.track !== track);
      this.incoming.set(peer.remoteId, [...list, { track, msid }]);
    }
    this.route(peer.remoteId);
    const change = () => this.d.onChange();
    track.addEventListener("mute", change);
    track.addEventListener("unmute", change);
    track.addEventListener("ended", () => {
      const list = this.incoming.get(peer.remoteId);
      if (list)
        this.incoming.set(
          peer.remoteId,
          list.filter((x) => x.track !== track),
        );
      this.route(peer.remoteId);
      change();
    });
    if (!this.timers.length) this.startLoops();
    this.d.onChange();
  }

  /**
   * Puts a member's video tracks where they belong: the one whose msid is the
   * member's published `screenStream` goes to `screen`, the camera (same stream
   * as its audio, else the latest other track) to `stream`. A track that came
   * before the presence naming it is moved when the presence arrives.
   * Returns whether anything moved.
   */
  private route(peerId: string): boolean {
    const r = this.remote.get(peerId);
    if (!r) return false;
    const m = this.d.memberMedia(peerId);
    const sid = m?.screen && m.screenStream ? m.screenStream : null;
    let ids = this.screenIds.get(peerId);
    if (sid) {
      if (!ids) {
        ids = new Set();
        this.screenIds.set(peerId, ids);
      }
      ids.add(sid);
    }
    const live = (this.incoming.get(peerId) ?? []).filter((x) => x.track.readyState !== "ended");
    const screen = sid ? live.filter((x) => x.msid === sid).at(-1)?.track : undefined;
    const cams = live.filter((x) => !ids?.has(x.msid));
    const audioMsid = this.audioMsid.get(peerId);
    const camera = (cams.filter((x) => x.msid === audioMsid).at(-1) ?? cams.at(-1))?.track;
    let changed = false;
    const current = r.stream.getVideoTracks();
    if (current.length !== (camera ? 1 : 0) || (camera && current[0] !== camera)) {
      for (const t of current) r.stream.removeTrack(t);
      if (camera) r.stream.addTrack(camera);
      changed = true;
    }
    if (r.screen?.getVideoTracks()[0] !== screen) {
      r.screen = screen ? new MediaStream([screen]) : null;
      changed = true;
    }
    return changed;
  }

  onCtrl(peer: Peer, msg: CtrlMessage): void {
    if (msg.t !== "video") return;
    const s = this.senders.get(peer.remoteId);
    if (!s || s.videoWanted === msg.want) return;
    s.videoWanted = msg.want;
    void s.video.replaceTrack(msg.want ? this.videoFor(peer.remoteId) : null).catch(() => {});
    void this.applyBudget(peer.remoteId);
  }

  onKeys(): void {
    // Give the new key a moment to reach everyone before frames use it.
    setTimeout(() => void this.syncKeys(), 1500);
  }

  // ── adaptation loops ──────────────────────────────────────────────────────

  private startLoops(): void {
    if (this.timers.length) return;
    this.timers.push(setInterval(() => this.sampleLevels(), 250));
    this.timers.push(setInterval(() => void this.adapt(), 4000));
  }

  private sampleLevels(): void {
    const now = Date.now();
    let changed = false;
    for (const r of this.remote.values()) {
      const peer = this.d.peer(r.peerId);
      const recv = peer?.pc.getReceivers().find((x) => x.track?.kind === "audio");
      const level = recv?.getSynchronizationSources?.()[0]?.audioLevel ?? 0;
      if (Math.abs(level - r.audioLevel) > 0.02) changed = true;
      r.audioLevel = level;
      if (level > SPEAKING_LEVEL) r.lastSpoke = now;
    }
    if (this.localAnalyser) {
      const buf = new Uint8Array(this.localAnalyser.fftSize);
      this.localAnalyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128) / 128);
      const level = this.micOn ? peak : 0;
      if (Math.abs(level - this.localLevel) > 0.02) changed = true;
      this.localLevel = level;
    }
    if (changed) this.d.onChange();
  }

  private async adapt(): Promise<void> {
    // Who do we want video from? Most recent speakers and screen shares, within the device budget.
    // A screen on its own track is always received: it is outside the `want` and takes a slot.
    const speakers: Speaker[] = [];
    let separateScreens = 0;
    for (const r of this.remote.values()) {
      const m = this.d.memberMedia(r.peerId);
      const legacyScreen = !!m?.screen && !this.separateScreen(r.peerId);
      if (m?.screen && !legacyScreen) separateScreens++;
      speakers.push({
        peerId: r.peerId,
        lastSpoke: r.lastSpoke,
        screen: legacyScreen,
        video: !!m?.video,
      });
    }
    const wanted = pickVideoSources(
      speakers,
      Math.max(1, this.budget.maxVideoIn - separateScreens),
    );
    for (const r of this.remote.values()) {
      const m = this.d.memberMedia(r.peerId);
      const legacyScreen = !!m?.screen && !this.separateScreen(r.peerId);
      const want = wanted.has(r.peerId) || !(m?.video || legacyScreen);
      if (want !== r.wantVideo) {
        r.wantVideo = want;
        void this.d.peer(r.peerId)?.sendCtrl({ t: "video", want });
        this.d.onChange();
      }
    }
    await this.measureUplink();
    for (const id of this.senders.keys()) await this.applyBudget(id);
  }

  /** The member sends its screen on its own track (both sides support it). */
  private separateScreen(peerId: string): boolean {
    return this.capable(peerId) && !!this.d.memberMedia(peerId)?.screenStream;
  }

  private async measureUplink(): Promise<void> {
    let uplink = 0;
    for (const peer of this.d.peers()) {
      if (!peer.ready) continue;
      try {
        const report = await peer.pc.getStats();
        let pairId: string | undefined;
        report.forEach((s: RTCStats & Record<string, unknown>) => {
          if (s.type === "transport" && typeof s.selectedCandidatePairId === "string")
            pairId = s.selectedCandidatePairId;
        });
        report.forEach((s: RTCStats & Record<string, unknown>) => {
          const selected = pairId
            ? s.id === pairId
            : s.type === "candidate-pair" && s.nominated === true && s.state === "succeeded";
          if (s.type !== "candidate-pair" || !selected) return;
          if (typeof s.availableOutgoingBitrate === "number")
            uplink = Math.max(uplink, s.availableOutgoingBitrate);
          const local =
            typeof s.localCandidateId === "string" ? report.get(s.localCandidateId) : undefined;
          peer.relayed =
            (local as { candidateType?: string } | undefined)?.candidateType === "relay";
        });
      } catch {
        // Stats are best effort.
      }
    }
    // Every outgoing video stream counts: the cameras asked for and the screens being sent.
    let receivers = 0;
    for (const [id, s] of this.senders) {
      if (s.videoWanted) receivers++;
      if (this.screenOn && s.screen && this.capable(id)) receivers++;
    }
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 4 : 4;
    this.budget = videoBudget({
      uplinkBps: uplink || 2_500_000,
      videoReceivers: Math.max(1, receivers),
      cores,
    });
  }

  private async applyBudget(peerId: string): Promise<void> {
    const s = this.senders.get(peerId);
    if (!s) return;
    const b = this.budget;
    if (!this.screenOn) {
      await setEncoding(s.video, {
        maxBitrate: b.maxBitrate,
        scaleResolutionDownBy: b.scaleResolutionDownBy,
      });
    } else if (!this.capable(peerId)) {
      // The screen replaces the camera on this link: full size.
      await setEncoding(s.video, { maxBitrate: b.maxBitrate, scaleResolutionDownBy: 1 });
    } else {
      await setEncoding(s.video, {
        maxBitrate: Math.min(b.maxBitrate, CAMERA_WHILE_SHARING.maxBitrate),
        scaleResolutionDownBy: CAMERA_WHILE_SHARING.scaleResolutionDownBy,
      });
      if (!s.screen) return;
      const q = SCREEN_PROFILES[this.quality];
      // The screen has priority: at least a receiver's share of the uplink, up to the quality's cap.
      await setEncoding(
        s.screen,
        {
          maxBitrate: Math.max(b.maxBitrate, Math.min(q.maxBitrate, 2 * b.maxBitrate)),
          scaleResolutionDownBy: 1,
          priority: "high",
          networkPriority: "high",
        },
        q.degradation,
      );
    }
  }

  dispose(): void {
    this.stop();
    for (const t of this.timers) clearInterval(t);
    this.worker?.terminate();
    this.worker = null;
  }
}

type Encoding = RTCRtpEncodingParameters & {
  priority?: RTCPriorityType;
  networkPriority?: RTCPriorityType;
};

type Degradation = "maintain-resolution" | "maintain-framerate";

/** Sets a sender's first encoding (and degradation preference) when it differs. */
async function setEncoding(
  sender: RTCRtpSender,
  want: Encoding,
  degradation?: Degradation,
): Promise<void> {
  try {
    const p = sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: Degradation;
    };
    if (!p.encodings?.length) return;
    const enc = p.encodings[0] as Encoding;
    const keys = Object.keys(want) as (keyof Encoding)[];
    const same =
      keys.every((k) => enc[k] === want[k]) &&
      (!degradation || p.degradationPreference === degradation);
    if (same) return;
    Object.assign(enc, want);
    if (degradation) p.degradationPreference = degradation;
    await sender.setParameters(p);
  } catch {
    // Not negotiated yet: the next adaptation round will apply it.
  }
}

/** VP8 first: E2EE keeps a fixed-size codec header in the clear, which VP8 allows. */
function preferVp8(t: RTCRtpTransceiver): void {
  try {
    const caps = RTCRtpReceiver.getCapabilities?.("video");
    if (!caps || !t.setCodecPreferences) return;
    const rank = (c: { mimeType: string }) =>
      /vp8/i.test(c.mimeType) ? 0 : /rtx|red|ulpfec/i.test(c.mimeType) ? 1 : 2;
    t.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {
    // Codec preferences are an optimization.
  }
}
