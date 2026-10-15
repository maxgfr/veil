import { describe, expect, test } from "bun:test";
import { decodeApp, decodePresence, MAX_CAPTION_LENGTH } from "./protocol";

const presence = (media: Record<string, unknown>) => ({
  nick: "ada",
  xPub: "AAAA",
  media: { audio: true, video: false, screen: false, ...media },
  links: [],
  joinedAt: 1,
});

describe("decodePresence recording", () => {
  test("absent stays absent", () => {
    const p = decodePresence(presence({}));
    expect(p).not.toBeNull();
    expect("recording" in (p?.media ?? {})).toBe(false);
  });

  test("a boolean is kept", () => {
    expect(decodePresence(presence({ recording: true }))?.media.recording).toBe(true);
    expect(decodePresence(presence({ recording: false }))?.media.recording).toBe(false);
  });

  test("any other type rejects the presence", () => {
    expect(decodePresence(presence({ recording: "yes" }))).toBeNull();
    expect(decodePresence(presence({ recording: 1 }))).toBeNull();
    expect(decodePresence(presence({ recording: null }))).toBeNull();
  });
});

describe("decodeApp caption", () => {
  test("a valid caption", () => {
    expect(decodeApp({ type: "caption", ts: 5, text: "hello" })).toEqual({
      type: "caption",
      ts: 5,
      text: "hello",
    });
    const max = "a".repeat(MAX_CAPTION_LENGTH);
    expect(decodeApp({ type: "caption", ts: 5, text: max })).toEqual({
      type: "caption",
      ts: 5,
      text: max,
    });
  });

  test("too long is rejected", () => {
    const text = "a".repeat(MAX_CAPTION_LENGTH + 1);
    expect(decodeApp({ type: "caption", ts: 5, text })).toBeNull();
  });

  test("empty text needs unavailable", () => {
    expect(decodeApp({ type: "caption", ts: 5, text: "" })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "", unavailable: true })).toEqual({
      type: "caption",
      ts: 5,
      text: "",
      unavailable: true,
    });
  });

  test("bad types are rejected", () => {
    expect(decodeApp({ type: "caption", ts: "5", text: "hi" })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: 3 })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "", unavailable: false })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", unavailable: "yes" })).toBeNull();
  });
});
