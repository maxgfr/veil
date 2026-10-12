/**
 * Calls: camera, microphone, screen sharing, sent directly to every member
 * we have a link with (no SFU), with:
 *  - media E2EE via Encoded Transforms (frames encrypted with our sender
 *    key, in a worker), detected at runtime;
 *  - an uplink budget: bitrate and resolution per receiver come from the
 *    measured available bandwidth and the number of receivers;
 *  - graceful degradation in large rooms: we only ask for video from the
 *    most recent active speakers (and screen shares); the others stay audio.
 */
import { type Bytes, utf8 } from "../crypto/bytes";
import { hkdf } from "../crypto/room";
import type { SenderKeys } from "../crypto/senderkeys";
import type { Peer } from "../mesh/peer";
import type { CtrlMessage, MediaState } from "../mesh/protocol";
import { trustedScriptUrl } from "../security";
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

export interface RemoteMedia {
  peerId: string;
  stream: MediaStream;
  audioLevel: number;
  lastSpoke: number;
  /** We asked this member to send us video. */
  wantVideo: boolean;
}

interface Senders {
  audio: RTCRtpSender;
  video: RTCRtpSender;
  /** The receiver asked us for video. */
  videoWanted: boolean;
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
  readonly preview = new MediaStream();
  readonly remote = new Map<string, RemoteMedia>();
  e2eeStats = { encrypted: 0, decrypted: 0, dropped: 0 };
  budget: Budget = { maxBitrate: 1_500_000, scaleResolutionDownBy: 1, maxVideoIn: 8 };
  localLevel = 0;
  private readonly senders = new Map<string, Senders>();
  private readonly attached = new WeakSet<Peer>();
  private worker: Worker | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;

  constructor(private readonly d: MediaDeps) {
    this.mode = d.mode ?? detectE2ee();
  }

  get e2ee(): boolean {
    return this.mode !== "none";
  }

  private get videoTrack(): MediaStreamTrack | null {
    return this.screenOn ? this.screenTrack : this.camOn ? this.cameraTrack : null;
  }

  state(): MediaState {
    return { audio: this.micOn, video: this.camOn, screen: this.screenOn };
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
    }
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
        video: { frameRate: { ideal: 15 } },
        audio: false,
      });
      const track = s.getVideoTracks()[0];
      if (!track) return;
      track.contentHint = "detail";
      track.addEventListener("ended", () => void this.setScreen(false));
      this.screenTrack = track;
      this.screenOn = true;
    } else {
      this.screenTrack?.stop();
      this.screenTrack = null;
      this.screenOn = false;
    }
    this.updateVideoSenders();
    this.refreshPreview();
    this.d.publish(this.state());
    this.d.onChange();
  }

  private refreshPreview(): void {
    for (const t of this.preview.getTracks()) this.preview.removeTrack(t);
    const v = this.videoTrack;
    if (v) this.preview.addTrack(v);
  }

  private updateVideoSenders(): void {
    for (const s of this.senders.values())
      void s.video.replaceTrack(s.videoWanted ? this.videoTrack : null).catch(() => {});
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
    const s: Senders = { audio: audio.sender, video: video.sender, videoWanted: true };
    this.senders.set(peer.remoteId, s);
    void audio.sender.replaceTrack(this.micOn ? this.audioTrack : null).catch(() => {});
    void video.sender.replaceTrack(this.videoTrack).catch(() => {});
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
      this.remote.delete(peerId);
    }
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
        audioLevel: 0,
        lastSpoke: 0,
        wantVideo: true,
      };
      this.remote.set(peer.remoteId, r);
    }
    for (const t of r.stream.getTracks()) if (t.kind === ev.track.kind) r.stream.removeTrack(t);
    r.stream.addTrack(ev.track);
    const change = () => this.d.onChange();
    ev.track.addEventListener("mute", change);
    ev.track.addEventListener("unmute", change);
    ev.track.addEventListener("ended", change);
    if (!this.timers.length) this.startLoops();
    this.d.onChange();
  }

  onCtrl(peer: Peer, msg: CtrlMessage): void {
    if (msg.t !== "video") return;
    const s = this.senders.get(peer.remoteId);
    if (!s || s.videoWanted === msg.want) return;
    s.videoWanted = msg.want;
    void s.video.replaceTrack(msg.want ? this.videoTrack : null).catch(() => {});
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
    const speakers: Speaker[] = [];
    for (const r of this.remote.values()) {
      const m = this.d.memberMedia(r.peerId);
      speakers.push({
        peerId: r.peerId,
        lastSpoke: r.lastSpoke,
        screen: !!m?.screen,
        video: !!m?.video,
      });
    }
    const wanted = pickVideoSources(speakers, this.budget.maxVideoIn);
    for (const r of this.remote.values()) {
      const m = this.d.memberMedia(r.peerId);
      const want = wanted.has(r.peerId) || !(m?.video || m?.screen);
      if (want !== r.wantVideo) {
        r.wantVideo = want;
        void this.d.peer(r.peerId)?.sendCtrl({ t: "video", want });
        this.d.onChange();
      }
    }
    await this.measureUplink();
    for (const id of this.senders.keys()) await this.applyBudget(id);
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
    const receivers = [...this.senders.values()].filter((s) => s.videoWanted).length;
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
    try {
      const p = s.video.getParameters();
      if (!p.encodings?.length) return;
      const enc = p.encodings[0] as RTCRtpEncodingParameters;
      const scale = this.screenOn ? 1 : this.budget.scaleResolutionDownBy;
      if (enc.maxBitrate === this.budget.maxBitrate && enc.scaleResolutionDownBy === scale) return;
      enc.maxBitrate = this.budget.maxBitrate;
      enc.scaleResolutionDownBy = scale;
      await s.video.setParameters(p);
    } catch {
      // Not negotiated yet: the next adaptation round will apply it.
    }
  }

  dispose(): void {
    this.stop();
    for (const t of this.timers) clearInterval(t);
    this.worker?.terminate();
    this.worker = null;
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
