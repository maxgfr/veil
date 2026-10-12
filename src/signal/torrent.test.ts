import { afterAll, describe, expect, test } from "bun:test";
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
