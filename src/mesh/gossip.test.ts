import { describe, expect, test } from "bun:test";
import { fromB64u, toB64u, utf8 } from "../crypto/bytes";
import { createIdentity, type Identity } from "../crypto/session";
import { chooseLinks, distance, Gossip, helloResponseDelay } from "./gossip";
import type { GossipFrame } from "./protocol";

interface Node {
  id: Identity;
  g: Gossip;
  got: string[];
  links: Set<string>;
}

async function line(n: number, ttl?: number): Promise<Node[]> {
  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  for (let i = 0; i < n; i++) {
    const id = await createIdentity();
    const node = { id, got: [] as string[], links: new Set<string>() } as Node;
    node.g = new Gossip({
      identity: id,
      ...(ttl ? { ttl } : {}),
      neighbors: () => node.links,
      send: (to, frame) => {
        const dst = byId.get(to);
        if (dst) setTimeout(() => void dst.g.receive(structuredClone(frame), id.peerId), 1);
      },
      deliver: (frame, body) =>
        node.got.push(`${frame.author.slice(0, 4)}:${new TextDecoder().decode(body)}`),
    });
    byId.set(id.peerId, node);
    nodes.push(node);
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = nodes[i] as Node;
    const b = nodes[i + 1] as Node;
    a.links.add(b.id.peerId);
    b.links.add(a.id.peerId);
  }
  return nodes;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("gossip", () => {
  test("a frame floods across a 3-node line, once per node", async () => {
    const [a, b, c] = (await line(3)) as [Node, Node, Node];
    // Close the triangle too, so c hears the frame twice and must de-duplicate.
    a.links.add(c.id.peerId);
    c.links.add(a.id.peerId);
    await a.g.publish("data", utf8("hi"));
    await wait(50);
    const tag = `${a.id.peerId.slice(0, 4)}:hi`;
    expect(b.got).toEqual([tag]);
    expect(c.got).toEqual([tag]);
    expect(a.got).toEqual([]);
  });

  test("forged, altered, replayed and impersonating frames are dropped", async () => {
    const [a, b] = (await line(2)) as [Node, Node];
    const frame = await a.g.publish("data", utf8("original"), { only: [] });
    const mallory = await createIdentity();

    expect(await b.g.receive({ ...frame, body: toB64u(utf8("altered")) }, "x")).toBe(false);
    expect(await b.g.receive({ ...frame, seq: frame.seq + 1 }, "x")).toBe(false);
    // Valid signature by mallory, but claiming to be a.
    const forged: GossipFrame = { ...frame, edPub: toB64u(mallory.edPub) };
    expect(await b.g.receive(forged, "x")).toBe(false);
    // A forged copy must not shadow the real frame.
    expect(await b.g.receive(frame, "x")).toBe(true);
    expect(await b.g.receive(frame, "x")).toBe(false);
    expect(b.got).toEqual([`${a.id.peerId.slice(0, 4)}:original`]);
    expect(fromB64u(frame.body)).toEqual(utf8("original"));
  });

  test("stale frames are rejected", async () => {
    const id = await createIdentity();
    const past = new Gossip({
      identity: id,
      now: () => Date.now() - 10 * 60_000,
      neighbors: () => [],
      send() {},
      deliver() {},
    });
    const frame = await past.publish("data", utf8("old"));
    const [, b] = (await line(2)) as [Node, Node];
    expect(await b.g.receive(frame, "x")).toBe(false);
  });

  test("the TTL bounds how far a frame travels", async () => {
    const nodes = await line(5, 2);
    await (nodes[0] as Node).g.publish("data", utf8("x"));
    await wait(60);
    expect(nodes.map((n) => n.got.length)).toEqual([0, 1, 1, 0, 0]);
  });

  test("only the closest members answer a hello right away", () => {
    const newcomer = "00000000000000000000";
    const members = [
      "00000000000000000001",
      "00000000000000000002",
      "f0000000000000000000",
      "ff000000000000000000",
      "fff00000000000000000",
    ];
    expect(helloResponseDelay("00000000000000000001", newcomer, members)).toBeLessThan(300);
    expect(helloResponseDelay("fff00000000000000000", newcomer, members)).toBeGreaterThanOrEqual(
      3000,
    );
    expect(distance("0f", "f0")).toBe(distance("f0", "0f"));
  });

  test("link selection fills to the target degree, required links first", () => {
    const members = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(20, "0"));
    const me = "ffffffffffffffffffff";
    const picks = chooseLinks({
      me,
      linked: new Set([members[0] as string]),
      pending: new Set(),
      members,
      required: [members[19] as string],
      degree: 6,
    });
    expect(picks[0]).toBe(members[19]);
    expect(picks.length).toBe(5);
    expect(picks).not.toContain(members[0]);
    const full = chooseLinks({
      me,
      linked: new Set(members.slice(0, 6)),
      pending: new Set(),
      members,
      required: [],
    });
    expect(full).toEqual([]);
  });
});
