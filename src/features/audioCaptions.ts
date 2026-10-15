// Captions from the on-device speech model (Whisper): the microphone is cut into spoken
// segments here, and each segment is transcribed locally, never by an online service.

import { trustedScriptUrl } from "../security";
import type { Caption, CaptionSource } from "./captions";

export const SAMPLE_RATE = 16_000;
const MAX_CAPTION = 500;
/** Segments waiting for the model; past this the oldest is dropped to stay live. */
const MAX_QUEUE = 3;

export interface SegmenterOptions {
  /** RMS level above which a frame counts as voice. */
  threshold?: number;
  /** Silence kept inside a segment before it ends. */
  hangoverMs?: number;
  /** Shorter segments (coughs, clicks) are dropped. */
  minMs?: number;
  /** Longer speech is cut into segments of this length. */
  maxMs?: number;
}

export interface Segment {
  pcm: Float32Array;
  /** Where the segment starts, in ms since the first frame. */
  offsetMs: number;
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const s of frame) sum += s * s;
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

function concat(chunks: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.length, length - at)), at);
    at += c.length;
    if (at >= length) break;
  }
  return out;
}

/** Energy-based voice detection over 16 kHz frames: frames in, spoken segments out. */
export class Segmenter {
  private readonly threshold: number;
  private readonly hangover: number;
  private readonly min: number;
  private readonly max: number;
  private chunks: Float32Array[] = [];
  /** Samples buffered, and how many of them end on the last voiced frame. */
  private length = 0;
  private voiced = 0;
  private start = 0;
  private consumed = 0;

  constructor(opts: SegmenterOptions = {}) {
    const samples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);
    this.threshold = opts.threshold ?? 0.01;
    this.hangover = samples(opts.hangoverMs ?? 700);
    this.min = samples(opts.minMs ?? 1000);
    this.max = samples(opts.maxMs ?? 28_000);
  }

  push(frame: Float32Array): Segment[] {
    const out: Segment[] = [];
    const loud = rms(frame) >= this.threshold;
    const at = this.consumed;
    this.consumed += frame.length;
    if (this.length === 0) {
      if (!loud) return out;
      this.start = at;
    }
    this.chunks.push(frame);
    this.length += frame.length;
    if (loud) this.voiced = this.length;
    if (this.length - this.voiced >= this.hangover) {
      const segment = this.flush();
      if (segment) out.push(segment);
    }
    while (this.length >= this.max) out.push(this.cut());
    return out;
  }

  /** Ends the current segment: up to its last voiced frame, or null if too short. */
  flush(): Segment | null {
    const segment =
      this.voiced >= this.min
        ? { pcm: concat(this.chunks, this.voiced), offsetMs: this.offsetMs() }
        : null;
    this.chunks = [];
    this.length = 0;
    this.voiced = 0;
    return segment;
  }

  private cut(): Segment {
    const all = concat(this.chunks, this.length);
    const segment = { pcm: all.slice(0, this.max), offsetMs: this.offsetMs() };
    const rest = all.slice(this.max);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    this.voiced = Math.max(0, this.voiced - this.max);
    this.start += this.max;
    return segment;
  }

  private offsetMs(): number {
    return Math.round((this.start * 1000) / SAMPLE_RATE);
  }
}

export interface PcmEngine {
  transcribe(pcm16k: Float32Array, opts: { lang?: string; signal?: AbortSignal }): Promise<string>;
}

/** Feeds 16 kHz mono frames from a microphone track; resolves to a close function. */
export type OpenPcm = (
  track: MediaStreamTrack,
  onFrame: (frame: Float32Array) => void,
) => Promise<() => void>;

/** The microphone through the PCM AudioWorklet, at the device's rate (the worklet downsamples). */
export const openMicPcm: OpenPcm = async (track, onFrame) => {
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule(trustedScriptUrl(__PCM_WORKLET_URL__) as unknown as string);
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, "veil-pcm");
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) onFrame(e.data);
    };
    source.connect(node);
    // Some engines only run nodes that reach the destination; the worklet outputs silence.
    node.connect(ctx.destination);
    await ctx.resume();
    return () => {
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      void ctx.close();
    };
  } catch (err) {
    void ctx.close();
    throw err;
  }
};

export class AudioTranscriber implements CaptionSource {
  private active = false;
  /** Bumped by every start() and stop(), so stale work never sends. */
  private generation = 0;
  private close: (() => void) | null = null;
  private segmenter = new Segmenter();
  private queue: Segment[] = [];
  private busy = false;
  private pending: AbortController | null = null;
  private startedAt = 0;

  constructor(
    private readonly deps: {
      track: () => MediaStreamTrack | null;
      engine: PcmEngine;
      lang: string;
      send(caption: Caption): void;
      open?: OpenPcm;
      segmenter?: SegmenterOptions;
      now?: () => number;
    },
  ) {}

  async start(): Promise<void> {
    if (this.active) return;
    const track = this.deps.track();
    if (!track) throw new Error("no microphone track");
    this.active = true;
    const generation = ++this.generation;
    this.segmenter = new Segmenter(this.deps.segmenter);
    this.startedAt = this.now();
    let close: () => void;
    try {
      close = await (this.deps.open ?? openMicPcm)(track, (frame) => {
        if (generation === this.generation) this.onFrame(frame);
      });
    } catch (err) {
      if (generation === this.generation) this.active = false;
      throw err;
    }
    if (generation !== this.generation) close();
    else this.close = close;
  }

  stop(): void {
    this.active = false;
    this.generation++;
    this.close?.();
    this.close = null;
    this.queue = [];
    this.pending?.abort();
    this.pending = null;
  }

  private onFrame(frame: Float32Array): void {
    for (const segment of this.segmenter.push(frame)) {
      this.queue.push(segment);
      if (this.queue.length > MAX_QUEUE) this.queue.shift();
    }
    void this.drain();
  }

  /** One transcription in flight at a time, oldest segment first. */
  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let segment = this.queue.shift(); segment; segment = this.queue.shift()) {
        await this.transcribe(segment);
      }
    } finally {
      this.busy = false;
    }
  }

  private async transcribe(segment: Segment): Promise<void> {
    const { engine, lang } = this.deps;
    const generation = this.generation;
    const ctrl = new AbortController();
    this.pending = ctrl;
    try {
      const raw = await engine.transcribe(segment.pcm, { lang, signal: ctrl.signal });
      const text = raw.trim().slice(0, MAX_CAPTION);
      if (text && generation === this.generation)
        this.deps.send({ ts: this.startedAt + segment.offsetMs, text, lang });
    } catch (err) {
      if (!ctrl.signal.aborted) console.warn("transcription failed", err);
    } finally {
      if (this.pending === ctrl) this.pending = null;
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
