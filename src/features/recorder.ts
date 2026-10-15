/**
 * Local meeting recording.
 *
 *  - Every source (us and each peer) is drawn into a 1280×720 canvas grid,
 *    name under each tile, initials when there is no video track.
 *  - All audio tracks are mixed through one AudioContext destination, resynced
 *    whenever the set of tracks changes.
 *  - Two MediaRecorders run on that mix: video + audio, and audio only. Their
 *    chunks go to sinks (the same ones file transfers use), in order.
 *  - Captions are collected and written as a plain-text transcript on stop.
 *
 * Only type imports here: this module lives in the lazy session chunk.
 */

import type { Bytes } from "../crypto/bytes";
import type { FileMeta, Sink } from "./files";

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FPS = 15;
const TIMESLICE = 1000;
const LABEL = 28;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Splits w×h into n equal tiles, as square a grid as possible, centred. */
export function gridLayout(n: number, w: number, h: number): Rect[] {
  if (n <= 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const tw = Math.floor(w / cols);
  const th = Math.floor(h / rows);
  const rects: Rect[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    // The last row may be short: centre it.
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const offset = Math.floor((w - inRow * tw) / 2);
    rects.push({ x: offset + (i - row * cols) * tw, y: row * th, w: tw, h: th });
  }
  return rects;
}

const VIDEO_MIMES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4",
];
const AUDIO_MIMES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];

/** First MIME type the browser can record, or null if none. */
export function pickMime(
  isTypeSupported: (mime: string) => boolean,
  kind: "video" | "audio",
): string | null {
  return (kind === "video" ? VIDEO_MIMES : AUDIO_MIMES).find((m) => isTypeSupported(m)) ?? null;
}

export type RecordingPart = "video" | "audio" | "transcript";

const pad = (n: number) => String(n).padStart(2, "0");

/** File name of one part of a recording started at `date` (local time). */
export function recordingNames(date: Date, part: RecordingPart, mime = ""): string {
  const base = `veil-meeting-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const ext =
    mime.startsWith("video/mp4") || mime.startsWith("audio/mp4")
      ? "mp4"
      : mime.startsWith("audio/ogg")
        ? "ogg"
        : "webm";
  if (part === "video") return `${base}.${ext}`;
  if (part === "audio") return `${base}.audio.${ext}`;
  return `${base}.txt`;
}

export interface CaptionLine {
  nick: string;
  ts: number;
  /** null when the speaker's device cannot transcribe. */
  text: string | null;
  /** The speaker's language (BCP 47), when their device said. */
  lang?: string;
}

/** `[hh:mm:ss] Nick: text`, elapsed since `start`; notices carry no time. */
export function formatTranscript(start: number, lines: CaptionLine[]): string {
  return lines
    .map((l) => {
      if (l.text === null) return `${l.nick}: transcription unavailable on this device`;
      const s = Math.max(0, Math.floor((l.ts - start) / 1000));
      return `[${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}] ${l.nick}: ${l.text}`;
    })
    .map((l) => `${l}\n`)
    .join("");
}

export function initials(nick: string): string {
  const [first = "", second] = nick.trim().split(/\s+/);
  if (!first) return "?";
  return (second ? first.charAt(0) + second.charAt(0) : first.slice(0, 2)).toUpperCase();
}

export interface RecorderSource {
  id: string;
  nick: string;
  stream: MediaStream | null;
}

export interface RecorderDeps {
  sources(): RecorderSource[];
  /** Same shape as `(meta) => pickSink(meta, { preferPicker: false })`. */
  sink(meta: FileMeta): Promise<Sink | null>;
  now?: () => number;
}

export interface RecordingUrls {
  video: string | null;
  audio: string | null;
  transcript: string | null;
}

/** One MediaRecorder writing into one sink, chunk after chunk. */
class Track {
  private chain: Promise<void> = Promise.resolve();
  private failed: unknown = null;

  constructor(
    readonly rec: MediaRecorder,
    readonly sink: Sink,
  ) {
    rec.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      this.chain = this.chain.then(async () => {
        if (this.failed) return;
        await sink.write(new Uint8Array(await e.data.arrayBuffer()) as Bytes);
      });
      this.chain = this.chain.catch((err) => {
        this.failed = err;
      });
    };
  }

  /** Stops the recorder, flushes the last chunk, returns the URL or null. */
  async finish(): Promise<string | null> {
    if (this.rec.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => {
        this.rec.onstop = () => resolve();
      });
      this.rec.stop();
      await stopped;
    }
    await this.chain;
    if (this.failed) {
      await this.sink.abort();
      console.warn("recording failed", this.failed);
      return null;
    }
    return this.sink.close();
  }
}

export class Recorder {
  readonly started: number;
  private readonly now: () => number;
  private ctx: CanvasRenderingContext2D | null = null;
  private videos = new Map<string, HTMLVideoElement>();
  private audio: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private inputs = new Map<string, MediaStreamAudioSourceNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tracks: { video: Track | null; audio: Track | null } = { video: null, audio: null };
  private captured: MediaStream | null = null;
  private captions: CaptionLine[] = [];
  private urls: string[] = [];
  private stopping: Promise<RecordingUrls> | null = null;

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now;
    this.started = this.now();
  }

  /** Builds the canvas and the mix, then starts both recorders. */
  async start(): Promise<void> {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    this.ctx = canvas.getContext("2d");
    this.audio = new AudioContext();
    this.dest = this.audio.createMediaStreamDestination();
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000 / FPS);

    const date = new Date(this.started);
    const supported = (m: string) => MediaRecorder.isTypeSupported(m);
    const mixed = this.dest.stream.getAudioTracks();
    this.captured = canvas.captureStream(FPS);
    const videoMime = pickMime(supported, "video");
    if (videoMime) {
      const stream = new MediaStream([...this.captured.getVideoTracks(), ...mixed]);
      this.tracks.video = await this.open(
        stream,
        videoMime,
        recordingNames(date, "video", videoMime),
      );
    }
    const audioMime = pickMime(supported, "audio");
    if (audioMime) {
      this.tracks.audio = await this.open(
        new MediaStream(mixed),
        audioMime,
        recordingNames(date, "audio", audioMime),
      );
    }
  }

  private async open(stream: MediaStream, mime: string, name: string): Promise<Track | null> {
    const sink = await this.deps.sink({
      id: crypto.randomUUID(),
      name,
      size: 0,
      mime: mime.replace(/;.*/, ""),
    });
    if (!sink) return null;
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const track = new Track(rec, sink);
    rec.start(TIMESLICE);
    return track;
  }

  addCaption(nick: string, ts: number, text: string | null, lang?: string): void {
    this.captions.push(lang ? { nick, ts, text, lang } : { nick, ts, text });
  }

  /** The transcript so far (a copy). */
  lines(): CaptionLine[] {
    return this.captions.map((l) => ({ ...l }));
  }

  private tick(): void {
    const sources = this.deps.sources();
    this.syncVideos(sources);
    this.syncAudio(sources);
    this.draw(sources);
  }

  private syncVideos(sources: RecorderSource[]): void {
    const live = new Set<string>();
    for (const s of sources) {
      const track = s.stream?.getVideoTracks().find((t) => t.readyState === "live");
      if (!track) continue;
      live.add(s.id);
      let el = this.videos.get(s.id);
      if (!el) {
        el = document.createElement("video");
        el.muted = true;
        el.playsInline = true;
        this.videos.set(s.id, el);
      }
      if (el.srcObject !== s.stream) {
        el.srcObject = s.stream;
        el.play().catch(() => {});
      }
    }
    for (const [id, el] of this.videos) {
      if (live.has(id)) continue;
      el.srcObject = null;
      this.videos.delete(id);
    }
  }

  /** Reconnects the mix only when the set of live audio tracks changed. */
  private syncAudio(sources: RecorderSource[]): void {
    const { audio, dest } = this;
    if (!audio || !dest) return;
    const wanted = new Map<string, MediaStreamTrack>();
    for (const s of sources) {
      for (const t of s.stream?.getAudioTracks() ?? [])
        if (t.readyState === "live") wanted.set(t.id, t);
    }
    for (const [id, node] of this.inputs) {
      if (wanted.has(id)) continue;
      node.disconnect();
      this.inputs.delete(id);
    }
    for (const [id, track] of wanted) {
      if (this.inputs.has(id)) continue;
      const node = audio.createMediaStreamSource(new MediaStream([track]));
      node.connect(dest);
      this.inputs.set(id, node);
    }
  }

  private draw(sources: RecorderSource[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const rects = gridLayout(sources.length, WIDTH, HEIGHT);
    rects.forEach((r, i) => {
      const s = sources[i];
      if (!s) return;
      const area = { x: r.x + 4, y: r.y + 4, w: r.w - 8, h: r.h - 8 - LABEL };
      ctx.fillStyle = "#222";
      ctx.fillRect(area.x, area.y, area.w, area.h);
      const el = this.videos.get(s.id);
      if (el && el.videoWidth > 0) {
        // Fit inside the tile, keeping the aspect ratio.
        const scale = Math.min(area.w / el.videoWidth, area.h / el.videoHeight);
        const w = el.videoWidth * scale;
        const h = el.videoHeight * scale;
        ctx.drawImage(el, area.x + (area.w - w) / 2, area.y + (area.h - h) / 2, w, h);
      } else {
        ctx.fillStyle = "#ccc";
        ctx.font = `600 ${Math.round(Math.min(area.w, area.h) / 4)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(initials(s.nick), area.x + area.w / 2, area.y + area.h / 2);
      }
      ctx.fillStyle = "#eee";
      ctx.font = "16px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.nick, r.x + r.w / 2, r.y + r.h - 4 - LABEL / 2, r.w - 16);
    });
  }

  /** Stops recording; each URL is null when that part failed or was unsupported. */
  stop(): Promise<RecordingUrls> {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  private async finish(): Promise<RecordingUrls> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const [video, audio] = await Promise.all([
      this.tracks.video?.finish() ?? null,
      this.tracks.audio?.finish() ?? null,
    ]);
    const transcript = await this.writeTranscript();
    for (const url of [video, audio, transcript]) if (url) this.urls.push(url);
    this.release();
    return { video, audio, transcript };
  }

  private async writeTranscript(): Promise<string | null> {
    if (this.captions.length === 0) return null;
    const data = new TextEncoder().encode(formatTranscript(this.started, this.captions)) as Bytes;
    const name = recordingNames(new Date(this.started), "transcript");
    const sink = await this.deps.sink({
      id: crypto.randomUUID(),
      name,
      size: data.length,
      mime: "text/plain",
    });
    if (!sink) return null;
    try {
      await sink.write(data);
    } catch (err) {
      await sink.abort();
      console.warn("transcript failed", err);
      return null;
    }
    return sink.close();
  }

  /** Releases everything; URLs returned by stop() stop working. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of [this.tracks.video, this.tracks.audio])
      if (t && t.rec.state !== "inactive") t.rec.stop();
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    this.release();
  }

  /** Releases the live capture (canvas, mix, hidden videos); the output URLs stay. */
  private release(): void {
    for (const t of this.captured?.getTracks() ?? []) t.stop();
    for (const t of this.dest?.stream.getTracks() ?? []) t.stop();
    for (const node of this.inputs.values()) node.disconnect();
    this.inputs.clear();
    for (const el of this.videos.values()) el.srcObject = null;
    this.videos.clear();
    this.audio?.close().catch(() => {});
    this.audio = null;
  }
}
