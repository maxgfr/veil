import { afterEach, describe, expect, test } from "bun:test";
import { FakePC } from "../../test/fake-rtc";
import { MemoryBus } from "../../test/memory-transport";
import { deriveRoomSecrets, newRoomKey, type RoomSecrets } from "../crypto/room";
import type { Outgoing } from "../signal/envelope";
import type { SignalMessage, TransportName, TransportStatus } from "../signal/types";
import type { AppMessage } from "./protocol";
import { Room } from "./room";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Convergence is driven by 3 s hello and maintenance timers: leave room for slow CI machines.
async function until(cond: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await wait(10);
  }
}

const rooms: Room[] = [];
afterEach(() => {
  for (const r of rooms.splice(0)) r.stop();
});

interface Node {
  room: Room;
  chat: string[];
  keyEvents: number;
}

async function node(
  bus: MemoryBus,
  secrets: RoomSecrets,
  nick: string,
  degree?: number,
): Promise<Node> {
  const n = { chat: [] as string[], keyEvents: 0 } as Node;
  n.room = await Room.create(
    {
      roomKey: newRoomKey(),
      secrets,
      nick,
      PC: FakePC,
      factory: bus.factory(),
      ...(degree ? { degree } : {}),
    },
    {
      app: (_author, msg: AppMessage) => {
        if (msg.type === "chat") n.chat.push(msg.text);
      },
      keys: () => {
        n.keyEvents++;
      },
    },
  );
  rooms.push(n.room);
  await n.room.start();
  return n;
}

const OFFLINE = {
  nostr: { enabled: false, relays: [] },
  torrent: { enabled: false, trackers: [] },
  manual: { enabled: false },
};
/** Peer ids that sort below and above any real one. */
const LOW = "0".repeat(20);
const HIGH = "f".repeat(20);

interface Internals {
  signaling: { send(out: Outgoing): Promise<unknown> };
  onSignal(msg: SignalMessage, via: TransportName): void;
  onTransports(statuses: TransportStatus[]): void;
  connect(to: string, route: { kind: "external" }): void;
  scheduleHello(delay: number): void;
  helloCount: number;
  nextHelloAt: number;
}

/** A room with no transport: what it sends is recorded, what it hears is handed to it. */
async function bare(start = false) {
  const room = await Room.create({
    roomKey: newRoomKey(),
    secrets: await deriveRoomSecrets(newRoomKey()),
    nick: "Solo",
    PC: FakePC,
    signal: OFFLINE,
  });
  rooms.push(room);
  const inner = room as unknown as Internals;
  const sent: Outgoing[] = [];
  inner.signaling.send = async (out) => void sent.push(out);
  if (start) await room.start();
  const offer = (from: string, session: string, sdp: string) =>
    inner.onSignal(
      { v: 1, id: "id", from, ts: Date.now(), kind: "offer", sdp, session, edPub: "", sig: "" },
      "nostr",
    );
  const answers = () => sent.filter((o) => o.kind === "answer");
  return { room, inner, sent, offer, answers };
}

async function remoteOffer(): Promise<string> {
  const pc = new FakePC({});
  await pc.setLocalDescription();
  return pc.localDescription?.sdp ?? "";
}

describe("room", () => {
  test("three members find each other and chat end to end", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const a = await node(bus, secrets, "Ada");
    const b = await node(bus, secrets, "Bob");
    const c = await node(bus, secrets, "Cy");
    const all = [a, b, c];
    await until(() => all.every((n) => n.room.members.size === 2));
    await until(() => all.every((n) => n.room.readyIds().length >= 1));
    expect([...a.room.members.values()].map((m) => m.nick).sort()).toEqual(["Bob", "Cy"]);
    // Let sender keys propagate, then talk.
    await until(() => [b, c].every((n) => n.room.keys.hasKey(a.room.peerId, a.room.keys.keyId)));
    await a.room.send({ type: "chat", id: "msg-00000001", text: "hello room", ts: Date.now() });
    await until(() => b.chat.length === 1 && c.chat.length === 1);
    expect(b.chat).toEqual(["hello room"]);
  }, 30_000);

  test("SAS is identical on both sides of a link", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const a = await node(bus, secrets, "Ada");
    const b = await node(bus, secrets, "Bob");
    await until(
      () => a.room.readyIds().includes(b.room.peerId) && b.room.readyIds().includes(a.room.peerId),
    );
    // Each side waits for the other's revealed nonce before showing anything.
    const [sa, sb] = await Promise.all([a.room.sas(b.room.peerId), b.room.sas(a.room.peerId)]);
    if (!sa || sa === "outdated") throw new Error(`no SAS: ${sa}`);
    expect(sa.emojis.length).toBe(4);
    expect(sb).toEqual(sa);
  }, 30_000);

  test("with a small degree, messages are relayed to members we are not linked to", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const nodes: Node[] = [];
    for (const nick of ["n0", "n1", "n2", "n3", "n4", "n5"]) {
      nodes.push(await node(bus, secrets, nick, 2));
      await wait(30);
    }
    await until(() => nodes.every((n) => n.room.members.size === nodes.length - 1), 15_000);
    // Send from the least-connected member, so some recipients are only reachable through relays.
    const sender = [...nodes].sort(
      (x, y) => x.room.readyIds().length - y.room.readyIds().length,
    )[0] as Node;
    const others = nodes.filter((n) => n !== sender);
    const relayedTo = others.filter((n) => !sender.room.readyIds().includes(n.room.peerId));
    expect(relayedTo.length).toBeGreaterThan(0);
    await until(
      () => others.every((n) => n.room.keys.hasKey(sender.room.peerId, sender.room.keys.keyId)),
      15_000,
    );
    await sender.room.send({ type: "chat", id: "msg-00000002", text: "relayed", ts: Date.now() });
    await until(() => others.every((n) => n.chat.includes("relayed")), 15_000);
    for (const n of relayedTo) expect(n.chat).toEqual(["relayed"]);
  }, 30_000);

  test("when a member leaves, keys rotate and the departed member cannot decrypt", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const a = await node(bus, secrets, "Ada");
    const b = await node(bus, secrets, "Bob");
    const c = await node(bus, secrets, "Cy");
    const all = [a, b, c];
    await until(() => all.every((n) => n.room.members.size === 2));
    await until(() => [b, c].every((n) => n.room.keys.hasKey(a.room.peerId, a.room.keys.keyId)));
    const before = a.room.keys.keyId;
    await c.room.leave();
    await until(() => !a.room.members.has(c.room.peerId) && a.room.keys.keyId !== before);
    await until(() => b.room.keys.hasKey(a.room.peerId, a.room.keys.keyId));
    expect(c.room.keys.hasKey(a.room.peerId, a.room.keys.keyId)).toBe(false);
    await a.room.send({ type: "chat", id: "msg-00000003", text: "after", ts: Date.now() });
    await until(() => b.chat.includes("after"));
    expect(c.chat).not.toContain("after");
  }, 30_000);

  test("a member blocked after a failed verification is never re-linked nor given keys", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const a = await node(bus, secrets, "Ada");
    const b = await node(bus, secrets, "Bob");
    await until(() => a.room.readyIds().includes(b.room.peerId));
    const before = a.room.keys.keyId;
    a.room.block(b.room.peerId);
    await until(() => !a.room.readyIds().includes(b.room.peerId) && a.room.keys.keyId !== before);
    // Bob keeps trying (hello, maintenance, offers): no link comes back.
    await wait(4000);
    expect(a.room.peers.has(b.room.peerId)).toBe(false);
    expect(b.room.keys.hasKey(a.room.peerId, a.room.keys.keyId)).toBe(false);
  }, 30_000);

  test("manual pairing connects two members with no network transport", async () => {
    const secrets = await deriveRoomSecrets(newRoomKey());
    const offline = {
      nostr: { enabled: false, relays: [] },
      torrent: { enabled: false, trackers: [] },
      manual: { enabled: true },
    };
    const codes: Record<string, string[]> = { a: [], b: [] };
    const mk = async (name: "a" | "b") => {
      const r = await Room.create(
        { roomKey: newRoomKey(), secrets, nick: name, PC: FakePC, signal: offline },
        { manualCode: (code) => codes[name]?.push(code) },
      );
      rooms.push(r);
      await r.start();
      return r;
    };
    const a = await mk("a");
    const b = await mk("b");
    a.createManualOffer();
    await until(() => (codes.a?.length ?? 0) === 1);
    expect(b.ingestManual(codes.a?.[0] ?? "")).toBe(true);
    await until(() => (codes.b?.length ?? 0) === 1);
    expect(a.ingestManual(codes.b?.[0] ?? "")).toBe(true);
    await until(() => a.readyIds().includes(b.peerId) && b.readyIds().includes(a.peerId));
    await until(() => a.members.has(b.peerId) && b.members.has(a.peerId));
  }, 30_000);

  test("a copy of an offer already answered gets the same answer, on the same link", async () => {
    const { room, offer, answers } = await bare();
    const sdp = await remoteOffer();
    offer(LOW, "sess-a", sdp);
    await until(() => answers().length === 1);
    const peer = room.peers.get(LOW);
    offer(LOW, "sess-a", sdp);
    await until(() => answers().length === 2);
    expect(room.peers.get(LOW)).toBe(peer);
    expect(answers()[1]).toEqual(answers()[0] as Outgoing);
  });

  test("a retry with a new session replaces a stale answerer, whatever the ids", async () => {
    const { room, offer, answers } = await bare();
    offer(LOW, "sess-a", await remoteOffer());
    await until(() => answers().length === 1);
    const stale = room.peers.get(LOW);
    // We have the larger id, which made us ignore the retry as if it were glare.
    offer(LOW, "sess-b", await remoteOffer());
    await until(() => answers().length === 2);
    expect(stale?.closeReason).toBe("replaced");
    expect(room.peers.get(LOW)?.session).toBe("sess-b");
    expect(answers()[1]?.session).toBe("sess-b");
  });

  test("real glare: the larger id keeps its own offer, the smaller one yields", async () => {
    const { room, inner, offer } = await bare();
    inner.connect(LOW, { kind: "external" });
    const mine = room.peers.get(LOW);
    offer(LOW, "sess-c", await remoteOffer());
    await wait(20);
    expect(room.peers.get(LOW)).toBe(mine);
    expect(mine?.state).not.toBe("closed");

    inner.connect(HIGH, { kind: "external" });
    const yielded = room.peers.get(HIGH);
    offer(HIGH, "sess-d", await remoteOffer());
    expect(yielded?.closeReason).toBe("replaced");
    expect(room.peers.get(HIGH)?.session).toBe("sess-d");
  });

  test("waking the page says hello at once and goes back to the fast beat", async () => {
    const { inner, sent } = await bare(true);
    await until(() => sent.some((o) => o.kind === "hello"));
    inner.helloCount = 20;
    inner.scheduleHello(15_000);
    const before = sent.length;
    globalThis.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await until(() => sent.length === before + 1);
    expect(sent.at(-1)?.kind).toBe("hello");
    expect(inner.helloCount).toBe(1);
    expect(inner.nextHelloAt - Date.now()).toBeLessThanOrEqual(3000);
  });

  test("a transport coming back online brings the fast hello beat back", async () => {
    const { inner } = await bare(true);
    const status = (state: TransportStatus["state"]): TransportStatus[] => [
      { name: "nostr", state, endpoints: [] },
    ];
    inner.onTransports(status("online"));
    inner.helloCount = 20;
    inner.scheduleHello(15_000);
    inner.onTransports(status("online"));
    expect(inner.helloCount).toBe(20);
    inner.onTransports(status("error"));
    inner.onTransports(status("online"));
    expect(inner.helloCount).toBe(0);
    expect(inner.nextHelloAt - Date.now()).toBeLessThanOrEqual(3000);
  });

  test("a stopped room no longer listens for the page waking up", async () => {
    const { room, sent } = await bare(true);
    await until(() => sent.some((o) => o.kind === "hello"));
    room.stop();
    const before = sent.length;
    globalThis.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    await wait(30);
    expect(sent.length).toBe(before);
  });
});
