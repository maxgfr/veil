/**
 * WebLLM serves one generation at a time: requests wait their turn here. An
 * abort of a request still waiting drops it and answers it as aborted at once;
 * only an abort of the request running interrupts the engine, so one caller
 * never cuts another's generation short.
 */

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export class GenerationQueue {
  #interrupt: () => Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  #active: number | null = null;
  /** Requests still wanted, with how to answer them if aborted while waiting. */
  #waiting = new Map<number, (err: unknown) => void>();

  constructor(interrupt: () => Promise<void>) {
    this.#interrupt = interrupt;
  }

  /** Runs `fn` in turn; rejects with an AbortError if `id` is aborted first. */
  run<T>(id: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#waiting.set(id, reject);
      const turn = async () => {
        if (!this.#waiting.delete(id)) return; // aborted while waiting: already answered
        this.#active = id;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          this.#active = null;
        }
      };
      this.#tail = this.#tail.then(turn);
    });
  }

  /** Whether `id` is the request running and still wanted (a stream checks it per chunk). */
  wanted(id: number): boolean {
    return this.#active === id;
  }

  async abort(id: number): Promise<void> {
    const reject = this.#waiting.get(id);
    if (reject) {
      this.#waiting.delete(id);
      reject(abortError());
      return;
    }
    if (this.#active === id) {
      this.#active = null;
      await this.#interrupt();
    }
  }
}
