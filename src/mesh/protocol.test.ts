import { describe, expect, test } from "bun:test";
import { decodeApp, decodePresence, MAX_CAPTION_LENGTH } from "./protocol";

const presence = (media: Record<string, unknown>) => ({
  nick: "ada",
  xPub: "AAAA",
  media: { audio: true, video: false, screen: false, ...media },
  links: [],
  joinedAt: 1,
});

describe("decodePresence captions", () => {
  test("absent stays absent", () => {
    const p = decodePresence(presence({}));
    expect(p).not.toBeNull();
    expect("captions" in (p?.media ?? {})).toBe(false);
  });

  test("a boolean is kept", () => {
    expect(decodePresence(presence({ captions: true }))?.media.captions).toBe(true);
    expect(decodePresence(presence({ captions: false }))?.media.captions).toBe(false);
  });

  test("any other type rejects the presence", () => {
    expect(decodePresence(presence({ captions: "yes" }))).toBeNull();
    expect(decodePresence(presence({ captions: 1 }))).toBeNull();
    expect(decodePresence(presence({ captions: null }))).toBeNull();
  });
});

describe("decodeApp caption lang", () => {
  test("absent stays absent", () => {
    const c = decodeApp({ type: "caption", ts: 5, text: "hi" });
    expect(c).not.toBeNull();
    expect("lang" in (c ?? {})).toBe(false);
  });

  test("a valid tag is kept", () => {
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: "pt-BR" })).toEqual({
      type: "caption",
      ts: 5,
      text: "hi",
      lang: "pt-BR",
    });
    expect(decodeApp({ type: "caption", ts: 5, text: "", lang: "en", unavailable: true })).toEqual({
      type: "caption",
      ts: 5,
      text: "",
      lang: "en",
      unavailable: true,
    });
  });

  test("a too long, malformed or non-string tag rejects the caption", () => {
    const long = `en-${"a".repeat(8)}-${"b".repeat(8)}-${"c".repeat(8)}-dddddd`;
    expect(long.length).toBe(36);
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: long })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: "en_US" })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: "" })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: 3 })).toBeNull();
    expect(decodeApp({ type: "caption", ts: 5, text: "hi", lang: null })).toBeNull();
  });
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

describe("decodePresence caps", () => {
  const withCaps = (caps: unknown) => ({ ...presence({}), caps });

  test("absent stays absent", () => {
    const p = decodePresence(presence({}));
    expect(p).not.toBeNull();
    expect("caps" in (p ?? {})).toBe(false);
  });

  test("a list of capability names is kept", () => {
    expect(decodePresence(withCaps(["screen-track"]))?.caps).toEqual(["screen-track"]);
    expect(decodePresence(withCaps([]))?.caps).toEqual([]);
  });

  test("any other type rejects the presence", () => {
    expect(decodePresence(withCaps("screen-track"))).toBeNull();
    expect(decodePresence(withCaps([1]))).toBeNull();
    expect(decodePresence(withCaps(null))).toBeNull();
    expect(decodePresence(withCaps(["Screen Track"]))).toBeNull();
  });

  test("more than 8 entries rejects the presence", () => {
    expect(decodePresence(withCaps(Array.from({ length: 8 }, (_, i) => `c${i}`)))).not.toBeNull();
    expect(decodePresence(withCaps(Array.from({ length: 9 }, (_, i) => `c${i}`)))).toBeNull();
  });

  test("an entry longer than 24 characters rejects the presence", () => {
    expect(decodePresence(withCaps(["a".repeat(24)]))).not.toBeNull();
    expect(decodePresence(withCaps(["a".repeat(25)]))).toBeNull();
  });
});

describe("decodePresence screenStream", () => {
  test("absent stays absent", () => {
    expect("screenStream" in (decodePresence(presence({}))?.media ?? {})).toBe(false);
  });

  test("a stream id is kept", () => {
    const id = "abcdef12-3456-7890";
    expect(decodePresence(presence({ screen: true, screenStream: id }))?.media.screenStream).toBe(
      id,
    );
  });

  test("anything that is not an id rejects the presence", () => {
    expect(decodePresence(presence({ screenStream: 5 }))).toBeNull();
    expect(decodePresence(presence({ screenStream: "short" }))).toBeNull();
    expect(decodePresence(presence({ screenStream: "{bad id here}" }))).toBeNull();
  });
});
