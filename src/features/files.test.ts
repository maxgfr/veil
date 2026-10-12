import { describe, expect, test } from "bun:test";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { type Bytes, concat, randomBytes, toHex } from "../crypto/bytes";
import type { AppMessage, Frame } from "../mesh/protocol";
import { CHUNK_SIZE, chunkCount, type FilePeer, Files, type Sink, WINDOW } from "./files";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await wait(5);
  }
}

function testSink() {
  const parts: Bytes[] = [];
  let aborted = false;
  const sink: Sink = {
    kind: "memory",
    write: async (d) => void parts.push(d.slice()),
    close: async () => "blob:test",
    abort: async () => {
      aborted = true;
    },
  };
  return { sink, bytes: () => concat(...parts), aborted: () => aborted };
}

/** Two Files instances wired by fake links; `corrupt` flips a byte in one chunk. */
function setup(opts: { corruptIndex?: number } = {}) {
  const A = "aaaaaaaaaaaaaaaaaaaa";
  const B = "bbbbbbbbbbbbbbbbbbbb";
  const link = { up: true, inflightMax: 0, sentChunks: 0, ackedChunks: 0 };
  let a!: Files;
  let b!: Files;
  const mkPeer = (remoteId: string, deliver: () => Files): FilePeer => ({
    remoteId,
    get ready() {
      return link.up;
    },
    async drain() {},
    async send(_label, frame: Frame) {
      if (!link.up) return;
      let f = frame;
      if ("binary" in frame) {
        link.sentChunks++;
        link.inflightMax = Math.max(link.inflightMax, link.sentChunks - link.ackedChunks);
        const idx = new DataView(frame.binary.buffer, frame.binary.byteOffset).getUint32(
          1 + (frame.binary[0] as number),
        );
        if (idx === opts.corruptIndex) {
          const copy = frame.binary.slice();
          copy[copy.length - 1] = (copy[copy.length - 1] as number) ^ 0xff;
          f = { binary: copy };
        }
      } else if ((frame.json as { t?: string }).t === "ack") {
        link.ackedChunks = (frame.json as { upto: number }).upto;
      }
      setTimeout(() => {
        if (link.up) deliver().onFrame(remoteId === B ? peerToA : peerToB, f);
      }, 0);
    },
  });
  // peerToB: A's handle on B; frames it sends are delivered to b, arriving from A.
  const peerToB = mkPeer(B, () => b);
  const peerToA = mkPeer(A, () => a);
  const required: string[] = [];
  a = new Files({
    peerId: A,
    send: async (m: AppMessage) => b.onApp(A, m),
    peer: (id) => (id === B ? peerToB : undefined),
    require: () => {},
    onChange() {},
  });
  b = new Files({
    peerId: B,
    send: async (m: AppMessage) => a.onApp(B, m),
    peer: (id) => (id === A ? peerToA : undefined),
    require: (id, on) => void (on && required.push(id)),
    onChange() {},
  });
  return { a, b, link, A, B, required };
}

async function transfer(size: number) {
  const { a, b, link } = setup();
  const data = randomBytes(size);
  const out = await a.offer(new Blob([data]), "data.bin");
  const inc = b.incoming.get(out.id)?.pub;
  expect(inc?.state).toBe("offered");
  expect(inc?.size).toBe(size);
  const s = testSink();
  b.accept(out.id, s.sink);
  await until(() => b.incoming.get(out.id)?.pub.state === "done");
  expect(s.bytes()).toEqual(data);
  return { a, b, out, link, data };
}

describe("files", () => {
  test("transfers files of awkward sizes intact", async () => {
    for (const size of [0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, 3 * CHUNK_SIZE + 123])
      await transfer(size);
  });

  test("a multi-megabyte file streams with bounded in-flight chunks and is acknowledged", async () => {
    const { a, out, link } = await transfer(12 * 1024 * 1024 + 7);
    expect(chunkCount(out.size)).toBe(196);
    expect(link.inflightMax).toBeLessThanOrEqual(WINDOW);
    await until(() => a.outgoing.get(out.id)?.pub.done.size === 1);
  });

  test("a corrupted chunk fails the transfer and aborts the sink", async () => {
    const { a, b } = setup({ corruptIndex: 2 });
    const out = await a.offer(new Blob([randomBytes(5 * CHUNK_SIZE)]), "x");
    const s = testSink();
    b.accept(out.id, s.sink);
    await until(() => b.incoming.get(out.id)?.pub.state === "failed");
    expect(b.incoming.get(out.id)?.pub.error).toContain("corrupted");
    expect(s.aborted()).toBe(true);
  });

  test("resumes from the last written chunk after the link drops", async () => {
    const { a, b, link, A } = setup();
    const data = randomBytes(40 * CHUNK_SIZE + 10);
    const out = await a.offer(new Blob([data]), "big.bin");
    const s = testSink();
    b.accept(out.id, s.sink);
    await until(() => (b.incoming.get(out.id)?.pub.next ?? 0) >= 10);
    link.up = false;
    b.onLinkDown(A);
    a.onLinkDown("bbbbbbbbbbbbbbbbbbbb");
    expect(b.incoming.get(out.id)?.pub.state).toBe("paused");
    await wait(20);
    link.up = true;
    link.ackedChunks = link.sentChunks;
    b.onLinkUp(A);
    await until(() => b.incoming.get(out.id)?.pub.state === "done");
    expect(s.bytes()).toEqual(data);
    expect(toHex(nobleSha256(s.bytes()))).toBe(toHex(nobleSha256(data)));
  });

  test("declining keeps the file away, and a sender cancel stops the receiver", async () => {
    const { a, b } = setup();
    const one = await a.offer(new Blob([randomBytes(10)]), "one");
    b.decline(one.id);
    expect(b.incoming.get(one.id)?.pub.state).toBe("declined");
    const two = await a.offer(new Blob([randomBytes(30 * CHUNK_SIZE)]), "two");
    const s = testSink();
    b.accept(two.id, s.sink);
    await until(() => (b.incoming.get(two.id)?.pub.next ?? 0) > 0);
    await a.cancelOutgoing(two.id);
    await until(() => b.incoming.get(two.id)?.pub.state === "cancelled");
  });

  test("accepting asks for a direct link to the sender", async () => {
    const { a, b, A, required } = setup();
    const out = await a.offer(new Blob([randomBytes(3)]), "x");
    b.accept(out.id, testSink().sink);
    expect(required).toEqual([A]);
  });
});
