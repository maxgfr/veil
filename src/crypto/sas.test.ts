import { describe, expect, test } from "bun:test";
import { randomBytes } from "./bytes";
import { computeSas, SAS_EMOJIS, type SasParty } from "./sas";

const party = (peerId: string, fingerprint: string): SasParty => ({
  peerId,
  edPub: randomBytes(32),
  fingerprint,
});

describe("sas", () => {
  test("the table has 64 distinct emojis", () => {
    expect(SAS_EMOJIS.length).toBe(64);
    expect(new Set(SAS_EMOJIS.map((e) => e[0])).size).toBe(64);
  });

  test("A and B compute the same 4 emojis", async () => {
    const salt = randomBytes(32);
    const a = party("aaaa", "sha-256 AA:01");
    const b = party("bbbb", "sha-256 bb:02");
    const sa = await computeSas(salt, a, b);
    const sb = await computeSas(salt, b, { ...a, fingerprint: "SHA-256 aa:01" });
    expect(sa.emojis.length).toBe(4);
    expect(sa).toEqual(sb);
  });

  test("a different fingerprint, key or room changes the SAS", async () => {
    const salt = randomBytes(32);
    const a = party("aaaa", "sha-256 AA:01");
    const b = party("bbbb", "sha-256 BB:02");
    const base = (await computeSas(salt, a, b)).emojis.join("");
    const variants = await Promise.all([
      computeSas(salt, a, { ...b, fingerprint: "sha-256 BB:03" }),
      computeSas(salt, a, { ...b, edPub: randomBytes(32) }),
      computeSas(randomBytes(32), a, b),
    ]);
    // 24-bit SAS: a collision here would be a 1-in-16M event per variant.
    for (const v of variants) expect(v.emojis.join("")).not.toBe(base);
  });
});
