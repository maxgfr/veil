import { describe, expect, test } from "bun:test";
import { fromB64u, randomBytes, utf8 } from "./bytes";
import { ROTATE_MESSAGES, ROTATE_MS, SenderKeys } from "./senderkeys";
import { createIdentity } from "./session";

async function members(n: number, bindKey = randomBytes(32), now?: () => number) {
  return Promise.all(
    Array.from({ length: n }, async () => SenderKeys.create(await createIdentity(), bindKey, now)),
  );
}

const recipient = (s: SenderKeys) => ({ peerId: s.identity.peerId, xPub: fromB64u(s.xPub) });
const decode = (r: Awaited<ReturnType<SenderKeys["decrypt"]>>) =>
  "ok" in r ? new TextDecoder().decode(r.ok) : r;

describe("sender keys", () => {
  test("a key wrapped for every member lets each of them decrypt", async () => {
    const [a, b, c] = (await members(3)) as [SenderKeys, SenderKeys, SenderKeys];
    const body = await a.wrap([b, c].map(recipient));
    expect(await b.receive(a.identity.peerId, body)).toBe(true);
    expect(await c.receive(a.identity.peerId, body)).toBe(true);
    const ct = await a.encrypt(utf8("hello room"));
    expect(decode(await b.decrypt(a.identity.peerId, ct))).toBe("hello room");
    expect(decode(await c.decrypt(a.identity.peerId, ct))).toBe("hello room");
  });

  test("after rotation on departure, the departed member cannot decrypt", async () => {
    const [a, b, gone] = (await members(3)) as [SenderKeys, SenderKeys, SenderKeys];
    const first = await a.wrap([b, gone].map(recipient));
    await b.receive(a.identity.peerId, first);
    await gone.receive(a.identity.peerId, first);
    await a.rotate();
    const second = await a.wrap([b].map(recipient));
    expect(await gone.receive(a.identity.peerId, second)).toBe(false);
    await b.receive(a.identity.peerId, second);
    const ct = await a.encrypt(utf8("after"));
    expect(decode(await b.decrypt(a.identity.peerId, ct))).toBe("after");
    expect(await gone.decrypt(a.identity.peerId, ct)).toEqual({ unknownKey: second.keyId });
  });

  test("a member of another room cannot unwrap, and a forged wrap is refused", async () => {
    const [a, b] = (await members(2)) as [SenderKeys, SenderKeys];
    const [outsider] = (await members(1)) as [SenderKeys];
    const body = await a.wrap([recipient(b)]);
    // Same ids and public keys, different room binding → different pairwise key.
    const stolen = {
      ...body,
      wraps: { [outsider.identity.peerId]: body.wraps[b.identity.peerId] as string },
    };
    expect(await outsider.receive(a.identity.peerId, stolen)).toBe(false);
    // Claiming the wrap came from someone else breaks the AAD/pairwise key.
    const [c] = (await members(1)) as [SenderKeys];
    expect(await b.receive(c.identity.peerId, body)).toBe(false);
  });

  test("tampered ciphertexts are invalid", async () => {
    const [a, b] = (await members(2)) as [SenderKeys, SenderKeys];
    await b.receive(a.identity.peerId, await a.wrap([recipient(b)]));
    const ct = await a.encrypt(utf8("x"));
    ct[ct.length - 1] = (ct[ct.length - 1] as number) ^ 1;
    expect(await b.decrypt(a.identity.peerId, ct)).toEqual({ invalid: true });
  });

  test("rotation is due after 10 minutes or 10 000 messages", async () => {
    let t = 1_000_000;
    const [a] = (await members(1, randomBytes(32), () => t)) as [SenderKeys];
    expect(a.needsRotation()).toBe(false);
    t += ROTATE_MS;
    expect(a.needsRotation()).toBe(true);
    await a.rotate();
    expect(a.needsRotation()).toBe(false);
    for (let i = 0; i < ROTATE_MESSAGES; i++) await a.encrypt(utf8(""));
    expect(a.needsRotation()).toBe(true);
  });

  test("old keys stay usable for in-flight messages after a rotation", async () => {
    const [a, b] = (await members(2)) as [SenderKeys, SenderKeys];
    await b.receive(a.identity.peerId, await a.wrap([recipient(b)]));
    const inflight = await a.encrypt(utf8("old"));
    await a.rotate();
    await b.receive(a.identity.peerId, await a.wrap([recipient(b)]));
    expect(decode(await b.decrypt(a.identity.peerId, inflight))).toBe("old");
  });
});
