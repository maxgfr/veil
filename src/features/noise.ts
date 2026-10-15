/**
 * Strong noise reduction: the microphone goes through RNNoise (a small neural network, run as
 * WebAssembly in an AudioWorklet) before it is sent. Opt-in; the browser's own suppression is
 * the default. Everything runs on the device, and the files are fetched only when it is on.
 */
import { trustedScriptUrl } from "../security";

export interface NoiseAssets {
  worklet: string;
  wasm: string;
  simd: string;
}

/** A denoised microphone: `track` is what gets sent; `stop()` releases it and the raw input. */
export interface Denoised {
  track: MediaStreamTrack;
  stop(): void;
}

/** RNNoise works on 48 kHz audio: the context resamples the microphone to it. */
const SAMPLE_RATE = 48_000;

let binary: Promise<ArrayBuffer> | null = null;

/** Whether this browser can run it at all (AudioWorklet and WebAssembly). */
export function canDenoise(): boolean {
  return (
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof WebAssembly !== "undefined"
  );
}

/** Wraps `raw` in RNNoise. Throws when the browser can't; the caller then sends `raw`. */
export async function denoise(raw: MediaStreamTrack, assets: NoiseAssets): Promise<Denoised> {
  // Imported here: the library subclasses AudioWorkletNode as it loads, and only now is it needed.
  const { loadRnnoise, RnnoiseWorkletNode } = await import("@sapphi-red/web-noise-suppressor");
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    binary ??= loadRnnoise({ url: assets.wasm, simdUrl: assets.simd }).catch((err) => {
      binary = null;
      throw err;
    });
    const [wasmBinary] = await Promise.all([
      binary,
      ctx.audioWorklet.addModule(trustedScriptUrl(assets.worklet) as string),
    ]);
    const source = ctx.createMediaStreamSource(new MediaStream([raw]));
    // Each node takes its own copy: the worklet gets the binary transferred.
    const node = new RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary: wasmBinary.slice(0) });
    const dest = ctx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    await ctx.resume().catch(() => {});
    const track = dest.stream.getAudioTracks()[0];
    if (!track) throw new Error("no denoised track");
    return {
      track,
      stop() {
        node.destroy();
        source.disconnect();
        track.stop();
        raw.stop();
        void ctx.close().catch(() => {});
      },
    };
  } catch (err) {
    void ctx.close().catch(() => {});
    throw err;
  }
}
