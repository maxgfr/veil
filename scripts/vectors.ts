/**
 * Cross-implementation test vectors: the Rust CLI's tests (cli/src/crypto.rs)
 * check that it derives the same room secrets, opens the same envelopes and
 * computes the same SAS as the web app. Regenerate with `bun scripts/vectors.ts`.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromHex, toHex } from "../src/crypto/bytes";
import { deriveRoom } from "../src/crypto/room";
import { computeSas } from "../src/crypto/sas";
import { createIdentity } from "../src/crypto/session";
import { sealEnvelope } from "../src/signal/envelope";

const key = fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const day = 20_000;
const plain = await deriveRoom(key, undefined, day);
const pass = await deriveRoom(key, "correct horse", day);
const ts = day * 86_400_000 + 1234;
const signer = await createIdentity();
const from = signer.peerId;
const sdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=fingerprint:sha-256 AA:BB:CC\r\n";
const env = await sealEnvelope(
  plain.sigKey,
  plain.topic,
  signer,
  { kind: "offer", to: "fedcba9876543210fedc", sdp, session: "sess" },
  ts,
);
const sasSalt = fromHex("aa".repeat(32));
const a = {
  peerId: "aaaaaaaaaaaaaaaaaaaa",
  edPub: fromHex("01".repeat(32)),
  fingerprint: "sha-256 AB:CD",
};
const b = {
  peerId: "bbbbbbbbbbbbbbbbbbbb",
  edPub: fromHex("02".repeat(32)),
  fingerprint: "sha-256 EF:01",
};
const sas = await computeSas(sasSalt, a, b);

const vectors = {
  key: toHex(key),
  day,
  plain: {
    topic: toHex(plain.topic),
    sasSalt: toHex(plain.sasSalt),
    bindKey: toHex(plain.bindKey),
  },
  passphrase: "correct horse",
  withPassphrase: {
    topic: toHex(pass.topic),
    sasSalt: toHex(pass.sasSalt),
    bindKey: toHex(pass.bindKey),
  },
  envelope: { wire: env.wire, ts, from, sdp, to: "fedcba9876543210fedc", session: "sess" },
  sas: { salt: toHex(sasSalt), a, b, names: sas.names },
};
const out = resolve(import.meta.dir, "../cli/tests/vectors.json");
writeFileSync(
  out,
  `${JSON.stringify(vectors, (_k, v) => (v instanceof Uint8Array ? toHex(v) : v), 2)}\n`,
);
console.log(`wrote ${out}`);
