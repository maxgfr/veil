import { afterAll, describe, expect, test } from "bun:test";
import { serveApp } from "../../test/serve";
import { deriveRoomSecrets, newRoomKey } from "../crypto/room";
import { createIdentity } from "../crypto/session";
import { decodeManual, encodeManual } from "./manual";
import { RoomSignaling, type SignalConfig } from "./mux";
import type { SignalMessage, TransportName } from "./types";

const server = serveApp({ port: 0, dir: "/nonexistent" });
afterAll(() => server.stop());
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CONFIG: SignalConfig = {
  nostr: { enabled: true, relays: [`ws://localhost:${server.port}/relay`] },
  torrent: { enabled: true, trackers: [`ws://localhost:${server.port}/tracker`] },
  manual: { enabled: true },
};

const SDP = "v=0\r\no=- 46117 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 0A:1B:2C\r\n";

async function peer(key: Uint8Array, config = CONFIG, passphrase?: string) {
  const identity = await createIdentity();
  const got: { msg: SignalMessage; via: TransportName }[] = [];
  const codes: string[] = [];
  const s = new RoomSignaling(
    { secrets: await deriveRoomSecrets(key, passphrase), identity, config },
    {
      onMessage: (msg, via) => got.push({ msg, via }),
      onStatus: () => {},
      onManualOutgoing: (code) => codes.push(code),
    },
  );
  await s.start();
  return { s, got, codes };
}

describe("room signaling", () => {
  test("an envelope sent on every transport is delivered exactly once", async () => {
    const key = newRoomKey();
    const a = await peer(key);
    const b = await peer(key);
    await wait(150);
    await a.s.send({ kind: "hello" });
    await wait(200);
    expect(b.got.length).toBe(1);
    expect(b.got[0]?.msg.kind).toBe("hello");
    expect(a.got.length).toBe(0);
    await b.s.send({ kind: "offer", to: a.s.peerId, sdp: SDP });
    await wait(200);
    expect(a.got.map((g) => g.msg.sdp)).toEqual([SDP]);
    a.s.stop();
    b.s.stop();
  });

  test("other rooms, other passphrases and other recipients are ignored", async () => {
    const key = newRoomKey();
    const a = await peer(key);
    const b = await peer(key);
    const intruder = await peer(newRoomKey());
    const wrongPass = await peer(key, CONFIG, "nope");
    await wait(150);
    await a.s.send({ kind: "offer", to: "eeeeeeeeeeeeeeeeeeee", sdp: SDP });
    await intruder.s.send({ kind: "hello" });
    await wrongPass.s.send({ kind: "hello" });
    await wait(200);
    expect(b.got).toEqual([]);
    for (const x of [a, b, intruder, wrongPass]) x.s.stop();
  });

  test("manual mode round-trips an offer and its answer with no network", async () => {
    const offline: SignalConfig = {
      nostr: { enabled: false, relays: [] },
      torrent: { enabled: false, trackers: [] },
      manual: { enabled: true },
    };
    const key = newRoomKey();
    const a = await peer(key, offline);
    const b = await peer(key, offline);
    expect(a.s.mux.transports.size).toBe(1);
    await a.s.send({ kind: "offer", sdp: SDP, session: "s1" }, ["manual"]);
    const code = a.codes[0] ?? "";
    expect(code.startsWith("veil1:")).toBe(true);
    // Codes survive the line breaks that chat apps and QR readers add.
    expect(b.s.ingestManual(code.replace(/(.{40})/g, "$1\n"))).toBe(true);
    await wait(50);
    expect(b.got[0]?.msg.sdp).toBe(SDP);
    expect(b.got[0]?.via).toBe("manual");
    await b.s.send({ kind: "answer", to: a.s.peerId, sdp: SDP, session: "s1" }, ["manual"]);
    expect(a.s.ingestManual(b.codes[0] ?? "")).toBe(true);
    await wait(50);
    expect(a.got[0]?.msg.kind).toBe("answer");
    expect(a.got[0]?.msg.sdp).toBe(SDP);
    expect(b.s.ingestManual("not a code")).toBe(false);
    a.s.stop();
    b.s.stop();
  });

  test("manual codes are validated", () => {
    expect(decodeManual(encodeManual("0123456789abcdef0123.abc_-"))).toBe(
      "0123456789abcdef0123.abc_-",
    );
    expect(decodeManual("veil1:<script>")).toBeNull();
    expect(decodeManual("hello")).toBeNull();
  });
});
