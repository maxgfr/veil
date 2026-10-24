/**
 * Peer-to-peer file transfer with no size limit.
 *
 *  - The offer (name, size, type) is announced to the room, encrypted with
 *    our sender key. Each member accepts or declines explicitly.
 *  - The transfer itself is pairwise, over the `file` DataChannel of a direct
 *    link (created on demand), every chunk encrypted by its SecureChannel.
 *  - The file is read slice by slice and written straight to disk (File
 *    System Access picker, else OPFS, else an in-memory Blob as a last
 *    resort), so neither side ever holds the whole file in memory.
 *  - Flow control: at most WINDOW chunks in flight until acknowledged.
 *  - Integrity: SHA-256 per chunk, plus an incremental SHA-256 of the whole
 *    file compared at the end.
 *  - Resume: if the link drops, the receiver asks again from the last chunk
 *    it wrote.
 */
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { type Bytes, equalBytes, randomBytes, sha256, toB64u, toHex } from "../crypto/bytes";
import {
  type AppMessage,
  decodeChunk,
  decodeFileCtrl,
  encodeChunk,
  type FileCtrl,
  type Frame,
} from "../mesh/protocol";

/**
 * 63 KiB: with framing and encryption overhead every message stays under the
 * 64 KiB SCTP max-message-size that RFC 8841 makes the default, so any
 * WebRTC implementation (browsers, the CLI) can receive it.
 */
export const CHUNK_SIZE = 63 * 1024;
export const WINDOW = 64;
const ACK_EVERY = 8;

export type Hasher = ReturnType<typeof nobleSha256.create>;

export interface Sink {
  readonly kind: "picker" | "opfs" | "memory";
  write(data: Bytes): Promise<void>;
  /** Returns an object URL to download the result, or null if already saved by the user. */
  close(): Promise<string | null>;
  abort(): Promise<void>;
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export type IncomingState =
  | "offered"
  | "waiting"
  | "receiving"
  | "paused"
  | "verifying"
  | "done"
  | "failed"
  | "declined"
  | "cancelled";

export interface Incoming extends FileMeta {
  from: string;
  state: IncomingState;
  received: number;
  next: number;
  startedAt: number;
  rate: number;
  url: string | null;
  sinkKind: Sink["kind"] | null;
  error?: string;
}

export interface Outgoing extends FileMeta {
  file: Blob;
  /** Bytes acknowledged, per recipient. */
  progress: Map<string, number>;
  done: Set<string>;
  cancelled: boolean;
}

export interface FilePeer {
  readonly remoteId: string;
  readonly ready: boolean;
  send(label: "file", frame: Frame): Promise<void>;
  drain(label: "file"): Promise<void>;
}

export interface FilesDeps {
  peerId: string;
  send(msg: AppMessage): Promise<void>;
  peer(id: string): FilePeer | undefined;
  require(peerId: string, on: boolean): void;
  onChange(): void;
}

export function chunkCount(size: number): number {
  return Math.ceil(size / CHUNK_SIZE);
}

/** Reads one chunk of a Blob/File (random access: needed to resume). */
export async function readChunk(file: Blob, index: number): Promise<Bytes> {
  const start = index * CHUNK_SIZE;
  return new Uint8Array(
    await file.slice(start, Math.min(file.size, start + CHUNK_SIZE)).arrayBuffer(),
  );
}

interface IncomingInternal {
  pub: Incoming;
  sink: Sink | null;
  hasher: Hasher;
  chain: Promise<void>;
  lastTick: { at: number; bytes: number };
}

interface StreamState {
  token: number;
  sent: number;
  acked: number;
  wake: (() => void) | null;
}

interface OutgoingInternal {
  pub: Outgoing;
  hasher: Hasher;
  hashed: number;
  digest: string | null;
  streams: Map<string, StreamState>;
}

export class Files {
  readonly incoming = new Map<string, IncomingInternal>();
  readonly outgoing = new Map<string, OutgoingInternal>();
  private tokens = 0;

  constructor(private readonly d: FilesDeps) {}

  // ── sending ───────────────────────────────────────────────────────────────

  async offer(
    file: File | Blob,
    name = file instanceof File ? file.name : "file",
  ): Promise<Outgoing> {
    const meta: FileMeta = {
      id: toB64u(randomBytes(12)),
      name: name.slice(0, 255) || "file",
      size: file.size,
      mime: (file.type || "application/octet-stream").slice(0, 120),
    };
    const pub: Outgoing = { ...meta, file, progress: new Map(), done: new Set(), cancelled: false };
    this.outgoing.set(meta.id, {
      pub,
      hasher: nobleSha256.create(),
      hashed: 0,
      digest: null,
      streams: new Map(),
    });
    await this.d.send({ type: "file-offer", ...meta });
    this.d.onChange();
    return pub;
  }

  async cancelOutgoing(id: string): Promise<void> {
    const out = this.outgoing.get(id);
    if (!out) return;
    out.pub.cancelled = true;
    for (const [peerId, s] of out.streams) {
      s.token = -1;
      s.wake?.();
      void this.d.peer(peerId)?.send("file", { json: { t: "cancel", id } satisfies FileCtrl });
    }
    await this.d.send({ type: "file-cancel", id });
    this.d.onChange();
  }

  /** An offer is flooded once: someone who joins later hears ours again (receivers de-duplicate). */
  async reannounce(): Promise<void> {
    for (const { pub } of this.outgoing.values()) {
      if (pub.cancelled) continue;
      const { id, name, size, mime } = pub;
      await this.d.send({ type: "file-offer", id, name, size, mime });
    }
  }

  private async stream(peer: FilePeer, out: OutgoingInternal, from: number): Promise<void> {
    const { pub } = out;
    const total = chunkCount(pub.size);
    const token = ++this.tokens;
    const prev = out.streams.get(peer.remoteId);
    if (prev) {
      prev.token = -1;
      prev.wake?.();
    }
    const st: StreamState = { token, sent: from, acked: from, wake: null };
    out.streams.set(peer.remoteId, st);
    const alive = () => st.token === token && !pub.cancelled && peer.ready;

    for (let i = from; i < total; i++) {
      while (alive() && st.sent - st.acked >= WINDOW) {
        await new Promise<void>((resolve) => {
          st.wake = resolve;
          setTimeout(resolve, 2000);
        });
        st.wake = null;
      }
      if (!alive()) return;
      await peer.drain("file");
      const data = await readChunk(pub.file, i);
      if (i === out.hashed) {
        out.hasher.update(data);
        out.hashed++;
      }
      const frame = encodeChunk({ id: pub.id, index: i, hash: await sha256(data), data });
      if (!alive()) return;
      await peer.send("file", { binary: frame });
      st.sent = i + 1;
    }
    if (!alive()) return;
    await peer.send("file", {
      json: {
        t: "end",
        id: pub.id,
        chunks: total,
        sha256: await this.digest(out),
      } satisfies FileCtrl,
    });
  }

  /** Whole-file SHA-256, finishing the incremental hash if a resume skipped ahead. */
  private async digest(out: OutgoingInternal): Promise<string> {
    if (out.digest) return out.digest;
    const total = chunkCount(out.pub.size);
    while (out.hashed < total) {
      out.hasher.update(await readChunk(out.pub.file, out.hashed));
      out.hashed++;
    }
    out.digest = toHex(out.hasher.digest());
    return out.digest;
  }

  private onSenderCtrl(peer: FilePeer, msg: FileCtrl): void {
    const out = this.outgoing.get(msg.id);
    if (!out || out.pub.cancelled) {
      if (msg.t === "req")
        void peer.send("file", { json: { t: "cancel", id: msg.id } satisfies FileCtrl });
      return;
    }
    const total = chunkCount(out.pub.size);
    if (msg.t === "req") {
      if (msg.from > total) return;
      void this.stream(peer, out, msg.from).catch((err) =>
        console.debug("[veil] file stream", err),
      );
    } else if (msg.t === "ack") {
      const st = out.streams.get(peer.remoteId);
      if (st && msg.upto > st.acked && msg.upto <= st.sent) {
        st.acked = msg.upto;
        st.wake?.();
      }
      out.pub.progress.set(peer.remoteId, Math.min(out.pub.size, msg.upto * CHUNK_SIZE));
      if (msg.upto >= total) {
        out.pub.done.add(peer.remoteId);
        out.streams.delete(peer.remoteId);
      }
      this.d.onChange();
    } else if (msg.t === "cancel") {
      const st = out.streams.get(peer.remoteId);
      if (st) {
        st.token = -1;
        st.wake?.();
        out.streams.delete(peer.remoteId);
      }
      out.pub.progress.delete(peer.remoteId);
      this.d.onChange();
    }
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  onApp(author: string, msg: AppMessage): void {
    if (msg.type === "file-offer") {
      if (this.incoming.has(msg.id)) return;
      const pub: Incoming = {
        id: msg.id,
        name: msg.name,
        size: msg.size,
        mime: msg.mime,
        from: author,
        state: "offered",
        received: 0,
        next: 0,
        startedAt: 0,
        rate: 0,
        url: null,
        sinkKind: null,
      };
      this.incoming.set(msg.id, {
        pub,
        sink: null,
        hasher: nobleSha256.create(),
        chain: Promise.resolve(),
        lastTick: { at: 0, bytes: 0 },
      });
      this.d.onChange();
    } else if (msg.type === "file-cancel") {
      const inc = this.incoming.get(msg.id);
      if (
        inc &&
        inc.pub.from === author &&
        !["done", "failed", "declined"].includes(inc.pub.state)
      ) {
        void this.fail(inc, "cancelled", "Cancelled by sender");
      }
    }
  }

  /** Accept an offered file. `sink` should be created in the click handler (user gesture). */
  accept(id: string, sink: Sink): void {
    const inc = this.incoming.get(id);
    if (inc?.pub.state !== "offered") {
      void sink.abort();
      return;
    }
    inc.sink = sink;
    inc.pub.sinkKind = sink.kind;
    inc.pub.state = "waiting";
    inc.pub.startedAt = Date.now();
    this.d.require(inc.pub.from, true);
    this.request(inc);
    this.d.onChange();
  }

  decline(id: string): void {
    const inc = this.incoming.get(id);
    if (inc?.pub.state !== "offered") return;
    inc.pub.state = "declined";
    this.d.onChange();
  }

  async cancelIncoming(id: string): Promise<void> {
    const inc = this.incoming.get(id);
    if (!inc) return;
    void this.d.peer(inc.pub.from)?.send("file", { json: { t: "cancel", id } satisfies FileCtrl });
    await this.fail(inc, "cancelled", "Cancelled");
  }

  private request(inc: IncomingInternal): void {
    const peer = this.d.peer(inc.pub.from);
    if (!peer?.ready) return;
    inc.pub.state = inc.pub.next > 0 ? "receiving" : "waiting";
    void peer.send("file", {
      json: { t: "req", id: inc.pub.id, from: inc.pub.next } satisfies FileCtrl,
    });
  }

  /** A link came (back) up: resume what we were receiving from that member. */
  onLinkUp(peerId: string): void {
    for (const inc of this.incoming.values()) {
      if (inc.pub.from === peerId && (inc.pub.state === "paused" || inc.pub.state === "waiting"))
        this.request(inc);
    }
    this.d.onChange();
  }

  onLinkDown(peerId: string): void {
    let changed = false;
    for (const inc of this.incoming.values()) {
      if (
        inc.pub.from === peerId &&
        (inc.pub.state === "receiving" || inc.pub.state === "waiting")
      ) {
        inc.pub.state = "paused";
        changed = true;
      }
    }
    for (const out of this.outgoing.values()) {
      const st = out.streams.get(peerId);
      if (st) {
        st.token = -1;
        st.wake?.();
        out.streams.delete(peerId);
      }
    }
    if (changed) this.d.onChange();
  }

  onMemberLeft(peerId: string): void {
    for (const inc of this.incoming.values()) {
      if (inc.pub.from !== peerId) continue;
      if (inc.pub.state === "offered") {
        inc.pub.state = "cancelled";
        inc.pub.error = "Sender left";
      } else if (["waiting", "receiving", "paused"].includes(inc.pub.state)) {
        void this.fail(inc, "failed", "Sender left before the transfer finished");
      }
    }
    this.d.onChange();
  }

  /** Frames from a peer's `file` channel. */
  onFrame(peer: FilePeer, frame: Frame): void {
    if ("binary" in frame) {
      const chunk = decodeChunk(frame.binary);
      if (!chunk) return;
      const inc = this.incoming.get(chunk.id);
      if (!inc || inc.pub.from !== peer.remoteId) return;
      inc.chain = inc.chain
        .then(() => this.onChunk(peer, inc, chunk.index, chunk.hash, chunk.data))
        .catch((err) =>
          this.fail(inc, "failed", err instanceof Error ? err.message : "Write failed"),
        );
      return;
    }
    const msg = decodeFileCtrl(frame.json);
    if (!msg) return;
    if (msg.t === "end") {
      const inc = this.incoming.get(msg.id);
      if (inc && inc.pub.from === peer.remoteId) {
        inc.chain = inc.chain
          .then(() => this.onEnd(peer, inc, msg))
          .catch((err) =>
            this.fail(inc, "failed", err instanceof Error ? err.message : "Write failed"),
          );
      }
      return;
    }
    if (msg.t === "cancel") {
      const inc = this.incoming.get(msg.id);
      if (inc && inc.pub.from === peer.remoteId) {
        void this.fail(inc, "cancelled", "Cancelled by sender");
        return;
      }
    }
    this.onSenderCtrl(peer, msg);
  }

  private async onChunk(
    peer: FilePeer,
    inc: IncomingInternal,
    index: number,
    hash: Bytes,
    data: Bytes,
  ): Promise<void> {
    const p = inc.pub;
    if (!inc.sink || (p.state !== "receiving" && p.state !== "waiting")) return;
    // Duplicates after a resume are ignored; the channel is ordered, so gaps cannot happen.
    if (index !== p.next) return;
    if (!equalBytes(await sha256(data), hash)) {
      await this.fail(inc, "failed", "A chunk was corrupted");
      return;
    }
    const expected = index === chunkCount(p.size) - 1 ? p.size - index * CHUNK_SIZE : CHUNK_SIZE;
    if (data.length !== expected) {
      await this.fail(inc, "failed", "Unexpected chunk size");
      return;
    }
    // The link may have dropped (paused) or the transfer ended while we were hashing.
    if (!inc.sink || (p.state !== "receiving" && p.state !== "waiting")) return;
    if (p.state === "waiting") p.state = "receiving";
    await inc.sink.write(data);
    inc.hasher.update(data);
    p.next++;
    p.received += data.length;
    if (p.next % ACK_EVERY === 0 || p.next === chunkCount(p.size)) {
      void peer.send("file", { json: { t: "ack", id: p.id, upto: p.next } satisfies FileCtrl });
    }
    const now = Date.now();
    if (now - inc.lastTick.at > 250) {
      if (inc.lastTick.at)
        p.rate = ((p.received - inc.lastTick.bytes) * 1000) / (now - inc.lastTick.at);
      inc.lastTick = { at: now, bytes: p.received };
      this.d.onChange();
    }
  }

  private async onEnd(
    peer: FilePeer,
    inc: IncomingInternal,
    msg: Extract<FileCtrl, { t: "end" }>,
  ): Promise<void> {
    const p = inc.pub;
    if (!inc.sink || p.state === "done" || p.state === "failed" || p.state === "cancelled") return;
    if (p.next !== msg.chunks || msg.chunks !== chunkCount(p.size)) return;
    p.state = "verifying";
    this.d.onChange();
    if (p.next === 0)
      void peer.send("file", { json: { t: "ack", id: p.id, upto: 0 } satisfies FileCtrl });
    const digest = toHex(inc.hasher.digest());
    if (digest !== msg.sha256) {
      await this.fail(inc, "failed", "Integrity check failed (SHA-256 mismatch)");
      return;
    }
    try {
      p.url = await inc.sink.close();
    } catch (err) {
      await this.fail(
        inc,
        "failed",
        err instanceof Error ? err.message : "Could not save the file",
      );
      return;
    }
    inc.sink = null;
    p.state = "done";
    p.rate = 0;
    this.d.require(p.from, false);
    this.d.onChange();
  }

  private async fail(
    inc: IncomingInternal,
    state: "failed" | "cancelled",
    error: string,
  ): Promise<void> {
    const wasActive = inc.sink !== null;
    inc.pub.state = state;
    inc.pub.error = error;
    const sink = inc.sink;
    inc.sink = null;
    if (wasActive) this.d.require(inc.pub.from, false);
    this.d.onChange();
    await sink?.abort().catch(() => {});
  }

  /** Releases object URLs and temporary storage. */
  dispose(): void {
    for (const inc of this.incoming.values()) {
      if (inc.pub.url) URL.revokeObjectURL(inc.pub.url);
      void inc.sink?.abort().catch(() => {});
    }
    for (const out of this.outgoing.values()) {
      out.pub.cancelled = true;
      for (const s of out.streams.values()) {
        s.token = -1;
        s.wake?.();
      }
    }
  }
}

// ── sinks ───────────────────────────────────────────────────────────────────

export function memorySink(mime: string): Sink {
  let parts: BlobPart[] = [];
  return {
    kind: "memory",
    async write(data) {
      parts.push(data);
    },
    async close() {
      const blob = new Blob(parts, { type: mime });
      parts = [];
      return URL.createObjectURL(blob);
    },
    async abort() {
      parts = [];
    },
  };
}

interface FsWritable {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

interface FsFileHandle {
  createWritable(): Promise<FsWritable>;
  getFile(): Promise<File>;
}

type SavePicker = (opts: { suggestedName: string }) => Promise<FsFileHandle>;

const OPFS_PREFIX = "veil-";

async function opfsSink(name: string): Promise<Sink | null> {
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage?.getDirectory) return null;
  try {
    const dir = await storage.getDirectory();
    const entry = `${OPFS_PREFIX}${toB64u(randomBytes(9))}`;
    const handle = (await dir.getFileHandle(entry, { create: true })) as unknown as FsFileHandle;
    if (typeof handle.createWritable !== "function") {
      await dir.removeEntry(entry);
      return null;
    }
    const w = await handle.createWritable();
    return {
      kind: "opfs",
      write: (data) => w.write(data),
      async close() {
        await w.close();
        const file = await handle.getFile();
        return URL.createObjectURL(new File([file], name, { type: file.type }));
      },
      async abort() {
        await w.abort().catch(() => {});
        await dir.removeEntry(entry).catch(() => {});
      },
    };
  } catch {
    return null;
  }
}

/** Removes temporary files left in the origin's private storage by a previous session. */
export async function clearTemporaryFiles(): Promise<void> {
  try {
    const dir = await navigator.storage?.getDirectory?.();
    if (!dir) return;
    const names: string[] = [];
    for await (const key of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (key.startsWith(OPFS_PREFIX)) names.push(key);
    }
    await Promise.all(names.map((n) => dir.removeEntry(n).catch(() => {})));
  } catch {
    // Private storage unavailable: nothing to clean.
  }
}

/**
 * Where to write an incoming file. Call from the Accept click handler: the
 * save picker requires a user gesture. Returns null if the user cancelled.
 */
export async function pickSink(
  meta: FileMeta,
  opts: { preferPicker?: boolean } = {},
): Promise<Sink | null> {
  const picker = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
  if (picker && opts.preferPicker !== false) {
    try {
      const handle = await picker({ suggestedName: meta.name });
      const w = await handle.createWritable();
      return {
        kind: "picker",
        write: (data) => w.write(data),
        close: async () => {
          await w.close();
          return null;
        },
        abort: () => w.abort().catch(() => {}),
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return null;
      // Picker unavailable in this context: fall through to private storage.
    }
  }
  return (await opfsSink(meta.name)) ?? memorySink(meta.mime);
}
