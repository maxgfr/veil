import { afterAll, afterEach, describe, expect, jest, test } from "bun:test";
import { FakeWebSocket, FakeWS } from "../../test/fake-ws";
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

describe("nostr transport, relay replies", () => {
  afterEach(() => {
    jest.useRealTimers();
    FakeWebSocket.reset();
  });

  function setup() {
    jest.useFakeTimers();
    FakeWebSocket.reset();
    const t = new NostrTransport(
      ["wss://relay.example"],
      { onEnvelope() {}, onStatus() {} },
      {
        WebSocket: FakeWS,
      },
    );
    const ws = FakeWebSocket.all[0] as FakeWebSocket;
    ws.open();
    const sent = (verb: string) => ws.sent.filter((f) => JSON.parse(f)[0] === verb);
    const detail = () => t.status().endpoints[0]?.detail ?? "";
    return { t, ws, sent, detail };
  }

  test("a closed subscription is requested again; one refused for lack of rights is left after a few tries", () => {
    const { t, ws, sent, detail } = setup();
    t.join(randomBytes(32));
    const sub = JSON.parse(sent("REQ")[0] as string)[1];
    ws.hear(["CLOSED", "someone-else", "error: gone"]);
    jest.advanceTimersByTime(60_000);
    expect(sent("REQ").length).toBe(1);
    for (let i = 0; i < 3; i++) {
      ws.hear(["CLOSED", sub, "auth-required: sign in first"]);
      jest.advanceTimersByTime(60_000);
      expect(sent("REQ").length).toBe(2 + i);
    }
    ws.hear(["CLOSED", sub, "auth-required: sign in first"]);
    jest.advanceTimersByTime(60_000);
    expect(sent("REQ").length).toBe(4);
    expect(detail()).toBe("subscription refused: auth-required: sign in first");
    t.close();
  });

  test("an event a relay rate-limited is published to it once more", () => {
    const { t, ws, sent } = setup();
    t.send(randomBytes(32), "0123456789abcdef0123.sealed");
    const id = JSON.parse(sent("EVENT")[0] as string)[1].id;
    ws.hear(["OK", id, false, "rate-limited: slow down"]);
    expect(sent("EVENT").length).toBe(1);
    jest.advanceTimersByTime(5000);
    expect(sent("EVENT")).toEqual([sent("EVENT")[0] as string, sent("EVENT")[0] as string]);
    ws.hear(["OK", id, false, "rate-limited: slow down"]);
    jest.advanceTimersByTime(60_000);
    expect(sent("EVENT").length).toBe(2);
    t.close();
  });

  test("a relay asking for NIP-42 authentication says so", () => {
    const { t, ws, detail } = setup();
    ws.hear(["AUTH", "challenge-string"]);
    expect(detail()).toContain("NIP-42");
    t.close();
  });

  test("resuming reconnects a dropped socket now, and a silent one", () => {
    const { t, ws } = setup();
    // Open and recently heard: kept.
    t.resume();
    expect(FakeWebSocket.all.length).toBe(1);
    // Dropped: no waiting for the backoff.
    ws.close();
    t.resume();
    expect(FakeWebSocket.all.length).toBe(2);
    const second = FakeWebSocket.all[1] as FakeWebSocket;
    second.open();
    jest.advanceTimersByTime(61_000);
    t.resume();
    expect(second.closed).toBe(true);
    expect(FakeWebSocket.all.length).toBe(3);
    t.close();
  });
});
