import { describe, expect, test } from "bun:test";
import { AeadError, importAesKey, open, seal } from "./aead";
import { randomBytes, utf8 } from "./bytes";

describe("aead", () => {
  test("seal/open round-trip with AAD", async () => {
    const key = await importAesKey(randomBytes(32));
    const sealed = await seal(key, utf8("hello"), utf8("aad"));
    expect(new TextDecoder().decode(await open(key, sealed, utf8("aad")))).toBe("hello");
  });

  test("nonces are random: sealing twice gives different ciphertexts", async () => {
    const key = await importAesKey(randomBytes(32));
    const a = await seal(key, utf8("x"));
    const b = await seal(key, utf8("x"));
    expect(a).not.toEqual(b);
  });

  test("tampered ciphertext, nonce or AAD is rejected", async () => {
    const key = await importAesKey(randomBytes(32));
    const sealed = await seal(key, utf8("secret"), utf8("topic"));
    for (const i of [0, 12, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[i] = (bad[i] as number) ^ 1;
      await expect(open(key, bad, utf8("topic"))).rejects.toBeInstanceOf(AeadError);
    }
    await expect(open(key, sealed, utf8("other"))).rejects.toBeInstanceOf(AeadError);
    await expect(open(key, sealed.slice(0, 10))).rejects.toBeInstanceOf(AeadError);
  });

  test("wrong key fails to open", async () => {
    const sealed = await seal(await importAesKey(randomBytes(32)), utf8("secret"));
    await expect(open(await importAesKey(randomBytes(32)), sealed)).rejects.toBeInstanceOf(
      AeadError,
    );
  });
});
