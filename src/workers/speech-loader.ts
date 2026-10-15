/**
 * Whisper loads one at a time: a load waits for the one before it, disposes
 * the pipeline it replaces, and gets its own download permission, for its own
 * model's files only, which ends with it. A late request of an earlier load
 * (transformers.js may still be fetching when a load fails) is never allowed
 * by a later one.
 */

export interface Disposable {
  dispose(): Promise<void>;
}

interface Permit {
  modelId: string;
  download: boolean;
}

export class SpeechLoader<P extends Disposable> {
  #tail: Promise<unknown> = Promise.resolve();
  #loaded: { modelId: string; pipeline: P } | null = null;
  #permit: Permit | null = null;

  /** The pipeline loaded, and its model; null while none is. */
  get loaded(): { modelId: string; pipeline: P } | null {
    return this.#loaded;
  }

  /** Whether `url` may be downloaded now: by the load running, if it may download, for its model. */
  allows(url: URL): boolean {
    const permit = this.#permit;
    return !!permit?.download && url.pathname.startsWith(`/${permit.modelId}/`);
  }

  /** Runs `open` in turn, after disposing the pipeline loaded; it becomes the one loaded. */
  load(modelId: string, download: boolean, open: () => Promise<P>): Promise<P> {
    return this.#turn(async () => {
      await this.#dispose();
      this.#permit = { modelId, download };
      try {
        const pipeline = await open();
        this.#loaded = { modelId, pipeline };
        return pipeline;
      } finally {
        this.#permit = null;
      }
    });
  }

  /** Disposes the pipeline loaded, in turn with loads. */
  unload(): Promise<void> {
    return this.#turn(() => this.#dispose());
  }

  async #dispose(): Promise<void> {
    const loaded = this.#loaded;
    this.#loaded = null;
    await loaded?.pipeline.dispose();
  }

  #turn<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn);
    // The next turn waits for this one, whether it succeeds or fails; its caller gets the failure.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
