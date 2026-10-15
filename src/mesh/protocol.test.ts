import { describe, expect, test } from "bun:test";
import { decodeApp, decodePresence } from "./protocol";

const presence = (media: Record<string, unknown>) => ({
  nick: "ada",
  xPub: "AAAA",
  media: { audio: true, video: false, screen: false, ...media },
  links: [],
  joinedAt: 1,
});

describe("captions from an older version", () => {
  test("a caption message is dropped, and a captions flag ignored", () => {
    expect(decodeApp({ type: "caption", ts: 5, text: "hello" })).toBeNull();
    expect(decodePresence(presence({ captions: true }))?.media).toEqual({
      audio: true,
      video: false,
      screen: false,
    });
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
