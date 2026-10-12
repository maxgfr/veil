/**
 * Minimal NIP-01 relay for tests and local dev. It keeps nothing (every event
 * is treated as ephemeral), checks event ids and Schnorr signatures like a
 * real relay would, and fans events out to matching subscriptions.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

export interface RelayEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

interface Filter {
  kinds?: number[];
  "#t"?: string[];
}

export interface RelaySocket {
  send(data: string): unknown;
}

export interface MockRelay {
  open(ws: RelaySocket): void;
  message(ws: RelaySocket, data: string): void;
  close(ws: RelaySocket): void;
  /** Every event accepted so far (for assertions: relays must only see ciphertext). */
  readonly seen: RelayEvent[];
}

function matches(ev: RelayEvent, f: Filter): boolean {
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  const tags = f["#t"];
  if (tags && !ev.tags.some((t) => t[0] === "t" && tags.includes(t[1] ?? ""))) return false;
  return true;
}

export function verifyEvent(ev: RelayEvent): boolean {
  const serial = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  const id = bytesToHex(sha256(utf8ToBytes(serial)));
  if (id !== ev.id) return false;
  try {
    return schnorr.verify(hexToBytes(ev.sig), hexToBytes(ev.id), hexToBytes(ev.pubkey));
  } catch {
    return false;
  }
}

export function createMockRelay(): MockRelay {
  const subs = new Map<RelaySocket, Map<string, Filter[]>>();
  const seen: RelayEvent[] = [];
  return {
    seen,
    open(ws) {
      subs.set(ws, new Map());
    },
    close(ws) {
      subs.delete(ws);
    },
    message(ws, data) {
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        ws.send(JSON.stringify(["NOTICE", "invalid json"]));
        return;
      }
      if (!Array.isArray(msg)) return;
      const [type, ...rest] = msg as [string, ...unknown[]];
      const mine = subs.get(ws);
      if (!mine) return;
      if (type === "REQ") {
        const [id, ...filters] = rest as [string, ...Filter[]];
        mine.set(id, filters);
        ws.send(JSON.stringify(["EOSE", id]));
      } else if (type === "CLOSE") {
        mine.delete(rest[0] as string);
      } else if (type === "EVENT") {
        const ev = rest[0] as RelayEvent;
        if (!verifyEvent(ev)) {
          ws.send(JSON.stringify(["OK", ev?.id ?? "", false, "invalid: bad signature"]));
          return;
        }
        seen.push(ev);
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        for (const [sock, s] of subs) {
          for (const [subId, filters] of s) {
            if (filters.some((f) => matches(ev, f)))
              sock.send(JSON.stringify(["EVENT", subId, ev]));
          }
        }
      }
    },
  };
}
