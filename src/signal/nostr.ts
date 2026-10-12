/**
 * Nostr transport (NIP-01). Envelopes are published as *ephemeral* events
 * (kind 20000–29999, which relays forward but never store), tagged with the
 * hex topic and signed with a throwaway key generated for this session.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { fromHex, toHex } from "../crypto/bytes";
import {
  aggregateState,
  backoff,
  type EndpointStatus,
  type SignalTransport,
  type TransportHandlers,
  type TransportState,
  type TransportStatus,
  type WebSocketCtor,
} from "./types";

export const NOSTR_KIND = 21_917;
const QUEUE_TTL_MS = 30_000;

export { DEFAULT_RELAYS } from "./defaults";

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export function signEvent(
  sk: Uint8Array,
  content: string,
  tags: string[][],
  kind = NOSTR_KIND,
): NostrEvent {
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  const created_at = Math.floor(Date.now() / 1000);
  const id = bytesToHex(
    sha256(utf8ToBytes(JSON.stringify([0, pubkey, created_at, kind, tags, content]))),
  );
  const sig = bytesToHex(schnorr.sign(fromHex(id), sk));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

interface Relay {
  url: string;
  ws: WebSocket | null;
  state: TransportState;
  detail?: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface NostrOptions {
  WebSocket?: WebSocketCtor;
  kind?: number;
}

export class NostrTransport implements SignalTransport {
  readonly name = "nostr" as const;
  private readonly sk = schnorr.utils.randomSecretKey();
  private readonly pubkey = bytesToHex(schnorr.getPublicKey(this.sk));
  private readonly relays: Relay[];
  private readonly topics = new Map<string, Uint8Array>();
  private queue: { at: number; frame: string }[] = [];
  private closed = false;
  private readonly WS: WebSocketCtor;
  private readonly kind: number;

  constructor(
    urls: string[],
    private readonly handlers: TransportHandlers,
    opts: NostrOptions = {},
  ) {
    this.WS = opts.WebSocket ?? WebSocket;
    this.kind = opts.kind ?? NOSTR_KIND;
    this.relays = [...new Set(urls)].map((url) => ({
      url,
      ws: null,
      state: "connecting",
      attempt: 0,
    }));
    for (const r of this.relays) this.connect(r);
    this.emit();
  }

  private connect(r: Relay): void {
    if (this.closed) return;
    r.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new this.WS(r.url);
    } catch (err) {
      r.state = "error";
      r.detail = err instanceof Error ? err.message : "invalid URL";
      this.emit();
      return;
    }
    r.ws = ws;
    ws.onopen = () => {
      r.state = "online";
      r.attempt = 0;
      delete r.detail;
      for (const hex of this.topics.keys()) ws.send(JSON.stringify(this.req(hex)));
      const now = Date.now();
      this.queue = this.queue.filter((q) => now - q.at < QUEUE_TTL_MS);
      for (const q of this.queue) ws.send(q.frame);
      this.emit();
    };
    ws.onmessage = (e) => this.onMessage(r, e.data);
    ws.onerror = () => {
      r.detail = "connection error";
    };
    ws.onclose = () => {
      if (r.ws !== ws) return;
      r.ws = null;
      if (this.closed) return;
      r.state = "error";
      r.detail ??= "disconnected";
      const delay = backoff(r.attempt++);
      r.timer = setTimeout(() => this.connect(r), delay);
      this.emit();
    };
    this.emit();
  }

  private req(hex: string): unknown[] {
    return [
      "REQ",
      `veil-${hex.slice(0, 16)}`,
      { kinds: [this.kind], "#t": [hex], since: Math.floor(Date.now() / 1000) - 60 },
    ];
  }

  private onMessage(r: Relay, data: unknown): void {
    if (typeof data !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    if (msg[0] === "EVENT") {
      const ev = msg[2] as Partial<NostrEvent> | undefined;
      if (
        !ev ||
        ev.pubkey === this.pubkey ||
        ev.kind !== this.kind ||
        typeof ev.content !== "string"
      )
        return;
      const tag = ev.tags?.find((t) => t[0] === "t")?.[1];
      const topic = tag ? this.topics.get(tag) : undefined;
      if (topic) this.handlers.onEnvelope(ev.content, topic);
    } else if (msg[0] === "OK" && msg[2] === false) {
      r.detail = `rejected: ${String(msg[3] ?? "")}`.slice(0, 120);
      this.emit();
    } else if (msg[0] === "CLOSED" || msg[0] === "NOTICE") {
      r.detail = String(msg[msg.length - 1] ?? "").slice(0, 120);
      this.emit();
    }
  }

  join(topic: Uint8Array): void {
    const hex = toHex(topic);
    if (this.topics.has(hex)) return;
    this.topics.set(hex, topic);
    const frame = JSON.stringify(this.req(hex));
    for (const r of this.relays) if (r.state === "online") r.ws?.send(frame);
  }

  leave(topic: Uint8Array): void {
    const hex = toHex(topic);
    if (!this.topics.delete(hex)) return;
    const frame = JSON.stringify(["CLOSE", `veil-${hex.slice(0, 16)}`]);
    for (const r of this.relays) if (r.state === "online") r.ws?.send(frame);
  }

  send(topic: Uint8Array, wire: string): void {
    const ev = signEvent(this.sk, wire, [["t", toHex(topic)]], this.kind);
    const frame = JSON.stringify(["EVENT", ev]);
    let sent = false;
    for (const r of this.relays) {
      if (r.state === "online" && r.ws) {
        r.ws.send(frame);
        sent = true;
      }
    }
    if (!sent) this.queue.push({ at: Date.now(), frame });
    if (this.queue.length > 64) this.queue.shift();
  }

  status(): TransportStatus {
    const endpoints: EndpointStatus[] = this.relays.map((r) =>
      r.detail ? { url: r.url, state: r.state, detail: r.detail } : { url: r.url, state: r.state },
    );
    const state = aggregateState(endpoints);
    return { name: this.name, state, endpoints };
  }

  private emit(): void {
    this.handlers.onStatus(this.status());
  }

  close(): void {
    this.closed = true;
    for (const r of this.relays) {
      clearTimeout(r.timer);
      const ws = r.ws;
      r.ws = null;
      r.state = "off";
      ws?.close();
    }
    this.emit();
  }
}
