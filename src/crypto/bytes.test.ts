import { describe, expect, test } from "bun:test";
import {
  compareBytes,
  concat,
  equalBytes,
  fromB64u,
  fromHex,
  randomBytes,
  readU64,
  toB64u,
  toHex,
  u64,
} from "./bytes";

describe("bytes", () => {
  test("base64url round-trips every length and matches the platform encoder", () => {
    for (let n = 0; n < 70; n++) {
      const b = randomBytes(n);
      const s = toB64u(b);
      expect(s).toBe(Buffer.from(b).toString("base64url"));
      expect(fromB64u(s)).toEqual(b);
    }
  });

  test("only the canonical base64url spelling decodes", () => {
    const s = toB64u(randomBytes(64));
    expect(s.length).toBe(86);
    const last = s.at(-1) as string;
    const tweaked =
      s.slice(0, -1) + (last === "A" ? "B" : String.fromCharCode(last.charCodeAt(0) ^ 1));
    expect(() => fromB64u(tweaked)).toThrow();
  });

  test("rejects malformed base64url and hex", () => {
    expect(() => fromB64u("ab+c")).toThrow();
    expect(() => fromB64u("a")).toThrow();
    expect(() => fromHex("abc")).toThrow();
    expect(() => fromHex("zz")).toThrow();
  });

  test("hex, concat, compare, equality and counters", () => {
    expect(toHex(fromHex("00ff10"))).toBe("00ff10");
    expect(concat(fromHex("01"), fromHex("0203"))).toEqual(fromHex("010203"));
    expect(compareBytes(fromHex("01"), fromHex("02"))).toBe(-1);
    expect(compareBytes(fromHex("0102"), fromHex("01"))).toBe(1);
    expect(equalBytes(fromHex("0102"), fromHex("0102"))).toBe(true);
    expect(equalBytes(fromHex("0102"), fromHex("0103"))).toBe(false);
    expect(readU64(u64(2 ** 40 + 7))).toBe(2 ** 40 + 7);
  });

  test("randomBytes fills buffers larger than the 64 KiB getRandomValues limit", () => {
    const b = randomBytes(200_000);
    expect(b.length).toBe(200_000);
    expect(b.subarray(150_000).some((x) => x !== 0)).toBe(true);
  });
});
