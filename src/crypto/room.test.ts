import { describe, expect, test } from "bun:test";
import { open, seal } from "./aead";
import { fromHex, toHex, utf8 } from "./bytes";
import {
  deriveRoom,
  encodeRoomKey,
  hkdf,
  newRoomKey,
  parseRoomLink,
  pbkdf2,
  roomLink,
  utcDay,
} from "./room";

describe("room", () => {
  test("HKDF-SHA256 matches RFC 5869 test case 1", async () => {
    const okm = await hkdf(
      fromHex("0b".repeat(22)),
      fromHex("000102030405060708090a0b0c"),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );
    expect(toHex(okm)).toBe(
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  test("PBKDF2-SHA256 matches the RFC 7914 / published vectors", async () => {
    expect(toHex(await pbkdf2("password", utf8("salt"), 1))).toBe(
      "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b",
    );
    expect(toHex(await pbkdf2("password", utf8("salt"), 4096))).toBe(
      "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a",
    );
  });

  test("room links round-trip and junk is rejected", () => {
    const key = newRoomKey();
    const link = roomLink("https://maxgfr.github.io/veil/", key);
    expect(link).toBe(`https://maxgfr.github.io/veil/#${encodeRoomKey(key)}`);
    expect(parseRoomLink(link)).toEqual(key);
    expect(parseRoomLink(`  ${encodeRoomKey(key)} `)).toEqual(key);
    expect(parseRoomLink("https://maxgfr.github.io/veil/")).toBeNull();
    expect(parseRoomLink("#short")).toBeNull();
    expect(parseRoomLink(`#${encodeRoomKey(key)}x`)).toBeNull();
  });

  test("derivation is deterministic, the topic rotates daily, keys do not", async () => {
    const key = newRoomKey();
    const d = utcDay(Date.UTC(2026, 9, 12, 12));
    const a = await deriveRoom(key, undefined, d);
    const b = await deriveRoom(key, undefined, d);
    const next = await deriveRoom(key, undefined, d + 1);
    expect(a.topic).toEqual(b.topic);
    expect(a.topic).not.toEqual(next.topic);
    expect(a.sasSalt).toEqual(next.sasSalt);
    const sealed = await seal(a.sigKey, utf8("x"));
    expect(await open(next.sigKey, sealed)).toEqual(utf8("x"));
    expect(a.topicHex).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a passphrase changes every derived secret", async () => {
    const key = newRoomKey();
    const plain = await deriveRoom(key, undefined, 1);
    const withPass = await deriveRoom(key, "correct horse", 1);
    const otherPass = await deriveRoom(key, "wrong horse", 1);
    expect(withPass.topic).not.toEqual(plain.topic);
    expect(withPass.topic).not.toEqual(otherPass.topic);
    expect(withPass.bindKey).not.toEqual(plain.bindKey);
    const sealed = await seal(withPass.sigKey, utf8("x"));
    await expect(open(otherPass.sigKey, sealed)).rejects.toThrow();
  });

  test("utcDay changes at UTC midnight", () => {
    expect(utcDay(Date.UTC(2026, 0, 2, 0, 0, 0)) - utcDay(Date.UTC(2026, 0, 1, 23, 59, 59))).toBe(
      1,
    );
  });
});
