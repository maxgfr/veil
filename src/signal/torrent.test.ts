import { afterAll, describe, expect, jest, test } from "bun:test";
import { FakeWebSocket, FakeWS } from "../../test/fake-ws";
import { serveApp } from "../../test/serve";
import { randomBytes } from "../crypto/bytes";
import { infoHash, TorrentTransport } from "./torrent";

const server = serveApp({ port: 0, dir: "/nonexistent" });
const url = `ws://localhost:${server.port}/tracker`;
afterAll(() => server.stop());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function client(peerId: string) {
  const got: string[] = [];
  let resolveOnline: () => void = () => {};
  const online = new Promise<void>((r) => {
    resolveOnline = r;
  });
  const t = new TorrentTransport([url], peerId, {
    onEnvelope: (wire) => got.push(wire),
    onStatus: (s) => {
      if (s.state === "online") resolveOnline();
    },
  });
  return { t, got, online };
}

describe("torrent transport", () => {
  test("broadcast reaches the swarm and direct messages reach only their target", async () => {
    const topic = randomBytes(32);
    const a = client("aaaaaaaaaaaaaaaaaaaa");
    const b = client("bbbbbbbbbbbbbbbbbbbb");
    const c = client("cccccccccccccccccccc");
    await Promise.all([a.online, b.online, c.online]);
    for (const x of [a, b, c]) x.t.join(topic);
    await wait(80);
    a.t.send(topic, "hello-wire");
    await wait(80);
    expect(b.got).toEqual(["hello-wire"]);
    expect(c.got).toEqual(["hello-wire"]);
    expect(a.got).toEqual([]);
    b.t.send(topic, "direct-wire", "aaaaaaaaaaaaaaaaaaaa");
    await wait(80);
    expect(a.got).toEqual(["direct-wire"]);
    expect(c.got).toEqual(["hello-wire"]);
    for (const x of [a, b, c]) x.t.close();
  });

  test("messages sent before the tracker is up are queued and go out once it is", async () => {
    const topic = randomBytes(32);
    const b = client("bbbbbbbbbbbbbbbbbbbb");
    await b.online;
    b.t.join(topic);
    const a = client("aaaaaaaaaaaaaaaaaaaa");
    a.t.join(topic);
    a.t.send(topic, "queued-wire");
    a.t.send(topic, "queued-direct", "bbbbbbbbbbbbbbbbbbbb");
    await a.online;
    await wait(80);
    expect(b.got).toEqual(["queued-wire", "queued-direct"]);
    a.t.close();
    b.t.close();
  });

  test("resuming reconnects a dropped socket now, and a silent one", () => {
    jest.useFakeTimers();
    FakeWebSocket.reset();
    try {
      const t = new TorrentTransport(
        ["wss://tracker.example"],
        "aaaaaaaaaaaaaaaaaaaa",
        { onEnvelope() {}, onStatus() {} },
        { WebSocket: FakeWS },
      );
      const ws = FakeWebSocket.all[0] as FakeWebSocket;
      ws.open();
      t.resume();
      expect(FakeWebSocket.all.length).toBe(1);
      ws.close();
      t.resume();
      expect(FakeWebSocket.all.length).toBe(2);
      const second = FakeWebSocket.all[1] as FakeWebSocket;
      second.open();
      // Trackers answer every announce: a minute of silence means the socket is gone.
      second.hear({ action: "announce", interval: 120 });
      jest.advanceTimersByTime(30_000);
      t.resume();
      expect(FakeWebSocket.all.length).toBe(2);
      jest.advanceTimersByTime(31_000);
      t.resume();
      expect(second.closed).toBe(true);
      expect(FakeWebSocket.all.length).toBe(3);
      t.close();
    } finally {
      jest.useRealTimers();
      FakeWebSocket.reset();
    }
  });

  test("info_hash is the first 20 bytes of the topic", () => {
    const topic = randomBytes(32);
    const h = infoHash(topic);
    expect(h.length).toBe(20);
    expect(h.charCodeAt(19)).toBe(topic[19] as number);
  });

  test("the peer id must be 20 characters", () => {
    expect(() => new TorrentTransport([], "short", { onEnvelope() {}, onStatus() {} })).toThrow();
  });
});
