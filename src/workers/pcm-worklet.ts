/**
 * Microphone to 16 kHz mono PCM, for on-device transcription. Runs as an
 * AudioWorklet in a context at the device's own rate and downsamples here:
 * a 16 kHz AudioContext fed by a microphone at another rate is not resampled
 * by every engine (Firefox refuses the connection).
 *
 * Posts one Float32Array of FRAME samples (100 ms) at a time, transferred.
 */
export {};

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][]): boolean;
  },
): void;

const TARGET_RATE = 16_000;
const FRAME = 1600;

class PcmProcessor extends AudioWorkletProcessor {
  private readonly ratio = sampleRate / TARGET_RATE;
  private frame = new Float32Array(FRAME);
  private filled = 0;
  /** Box filter: the input samples averaged into the next output sample. */
  private sum = 0;
  private count = 0;
  private pos = 0;

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0];
    const first = channels?.[0];
    if (!channels || !first) return true;
    for (let i = 0; i < first.length; i++) {
      let s = 0;
      for (const ch of channels) s += ch[i] ?? 0;
      this.sum += s / channels.length;
      this.count++;
      this.pos++;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      this.frame[this.filled++] = this.sum / this.count;
      this.sum = 0;
      this.count = 0;
      if (this.filled === FRAME) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(FRAME);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("veil-pcm", PcmProcessor);
