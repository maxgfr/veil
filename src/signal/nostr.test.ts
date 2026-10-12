import { afterAll, describe, expect, test } from "bun:test";
import { serveApp } from "../../test/serve";
import { randomBytes } from "../crypto/bytes";
import { NostrTransport } from "./nostr";
import type { TransportHandlers } from "./types";

const server = serveApp({ port: 0, dir: "/nonexistent" });
const url = `ws://localhost:${server.port}/relay`;
afterAll(() => server.stop());

function client() {
  const got: string[] = [];
  let resolveOnline: () => void = () => {};
  const online = new Promise<void>((r) => {
    resolveOnline = r;
  });
  const handlers: TransportHandlers = {
    onEnvelope: (wire) => got.push(wire),
    onStatus: (s) => {
      if (s.state === "online") resolveOnline();
    },
  };
  return { t: new NostrTransport([url], handlers), got, online };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("nostr transport", () => {
  test("two clients exchange envelopes through the relay; others topics stay silent", async () => {
    const topic = randomBytes(32);
    const a = client();
    const b = client();
    const c = client();
    await Promise.all([a.online, b.online, c.online]);
    a.t.join(topic);
    b.t.join(topic);
    c.t.join(randomBytes(32));
    await wait(50);
    a.t.send(topic, "0123456789abcdef0123.sealed-payload");
    await wait(150);
    expect(b.got).toEqual(["0123456789abcdef0123.sealed-payload"]);
    expect(a.got).toEqual([]);
    expect(c.got).toEqual([]);
    const ev = server.relay.seen.at(-1);
    expect(ev?.kind).toBeGreaterThanOrEqual(20000);
    expect(ev?.kind).toBeLessThan(30000);
    for (const x of [a, b, c]) x.t.close();
  });

  test("events sent before the relay is up are queued, and the relay accepts our signatures", async () => {
    const topic = randomBytes(32);
    const b = client();
    await b.online;
    b.t.join(topic);
    const a = client();
    a.t.join(topic);
    a.t.send(topic, "0123456789abcdef0123.queued");
    await a.online;
    await wait(150);
    expect(b.got).toEqual(["0123456789abcdef0123.queued"]);
    a.t.close();
    b.t.close();
  });

  test("an unreachable relay reports an error and retries", async () => {
    const states: string[] = [];
    const t = new NostrTransport(["ws://localhost:1/relay"], {
      onEnvelope: () => {},
      onStatus: (s) => states.push(s.state),
    });
    await wait(300);
    expect(states).toContain("error");
    t.close();
  });
});
