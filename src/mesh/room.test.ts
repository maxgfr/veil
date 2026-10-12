import { afterEach, describe, expect, test } from "bun:test";
import { FakePC } from "../../test/fake-rtc";
import { MemoryBus } from "../../test/memory-transport";
import { deriveRoomSecrets, newRoomKey, type RoomSecrets } from "../crypto/room";
import type { AppMessage } from "./protocol";
import { Room } from "./room";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, ms = 8000): Promise<void> {
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
  });

  test("SAS is identical on both sides of a link", async () => {
    const bus = new MemoryBus();
    const secrets = await deriveRoomSecrets(newRoomKey());
    const a = await node(bus, secrets, "Ada");
    const b = await node(bus, secrets, "Bob");
    await until(
      () => a.room.readyIds().includes(b.room.peerId) && b.room.readyIds().includes(a.room.peerId),
    );
    const [sa, sb] = await Promise.all([a.room.sas(b.room.peerId), b.room.sas(a.room.peerId)]);
    expect(sa?.emojis.length).toBe(4);
    expect(sa).toEqual(sb);
  });

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
  }, 20_000);

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
  }, 20_000);

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
  });
});
