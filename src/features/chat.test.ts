import { describe, expect, test } from "bun:test";
import type { AppMessage } from "../mesh/protocol";
import { Chat } from "./chat";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pair() {
  const sentA: AppMessage[] = [];
  const sentB: AppMessage[] = [];
  let b!: Chat;
  let a!: Chat;
  a = new Chat({
    peerId: "aaaaaaaaaaaaaaaaaaaa",
    send: async (m) => {
      sentA.push(m);
      b.onApp("aaaaaaaaaaaaaaaaaaaa", m);
    },
    onChange() {},
  });
  b = new Chat({
    peerId: "bbbbbbbbbbbbbbbbbbbb",
    send: async (m) => {
      sentB.push(m);
      a.onApp("bbbbbbbbbbbbbbbbbbbb", m);
    },
    onChange() {},
  });
  return { a, b, sentA, sentB };
}

describe("chat", () => {
  test("messages are delivered once and acknowledged with batched receipts", async () => {
    const { a, b, sentB } = pair();
    const m1 = await a.sendText("hello");
    await a.sendText("  second  ");
    expect(b.messages.map((m) => m.text)).toEqual(["hello", "  second"]);
    b.onApp("aaaaaaaaaaaaaaaaaaaa", {
      type: "chat",
      id: m1?.id ?? "",
      text: "hello",
      ts: Date.now(),
    });
    expect(b.messages.length).toBe(2);
    await wait(900);
    expect(sentB.filter((m) => m.type === "receipt").length).toBe(1);
    expect([...(a.messages[0]?.delivered ?? [])]).toEqual(["bbbbbbbbbbbbbbbbbbbb"]);
  });

  test("blank messages are not sent; markup stays plain text", async () => {
    const { a, b } = pair();
    expect(await a.sendText("   \n ")).toBeNull();
    await a.sendText("<img src=x onerror=alert(1)>");
    expect(b.messages[0]?.text).toBe("<img src=x onerror=alert(1)>");
  });

  test("typing indicators are throttled and expire", async () => {
    let t = 1_000;
    const sent: AppMessage[] = [];
    const a = new Chat({
      peerId: "aaaaaaaaaaaaaaaaaaaa",
      send: async (m) => void sent.push(m),
      onChange() {},
      now: () => t,
    });
    a.setTyping(true);
    a.setTyping(true);
    expect(sent.length).toBe(1);
    a.setTyping(false);
    expect(sent.length).toBe(2);
    const b = new Chat({
      peerId: "bbbbbbbbbbbbbbbbbbbb",
      send: async () => {},
      onChange() {},
      now: () => t,
    });
    b.onApp("aaaaaaaaaaaaaaaaaaaa", { type: "typing", on: true });
    expect(b.typingNow()).toEqual(["aaaaaaaaaaaaaaaaaaaa"]);
    t += 6000;
    expect(b.typingNow()).toEqual([]);
  });

  test("late messages are inserted in chronological order", () => {
    const c = new Chat({ peerId: "cccccccccccccccccccc", send: async () => {}, onChange() {} });
    const now = Date.now();
    c.onApp("aaaaaaaaaaaaaaaaaaaa", { type: "chat", id: "id-00000002", text: "second", ts: now });
    c.onApp("aaaaaaaaaaaaaaaaaaaa", {
      type: "chat",
      id: "id-00000001",
      text: "first",
      ts: now - 1000,
    });
    expect(c.messages.map((m) => m.text)).toEqual(["first", "second"]);
  });
});
