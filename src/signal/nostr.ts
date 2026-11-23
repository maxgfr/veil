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
/** An open socket that heard nothing for this long may have died while the page slept. */
const SILENT_MS = 60_000;
/** A subscription refused for lack of rights ("auth-required:", "restricted:") is retried this often, then left. */
const REFUSED_TRIES = 3;
const REFUSED = /^(auth-required|restricted)\b/;
/** Recent events, kept so one a relay rate-limited can be published again. */
const SENT_MAX = 64;

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
  /** Last time the socket opened or carried a message. */
  heard: number;
  /** REQs sent again after a CLOSED, per topic (reset on reconnect). */
  closedTries: Map<string, number>;
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
  /** Event id → frame, and the relays it was published to again after a rate limit. */
  private readonly sent = new Map<string, { frame: string; retried: Set<string> }>();
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
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
      heard: 0,
      closedTries: new Map(),
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
      r.heard = Date.now();
      r.closedTries.clear();
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

  /** Reconnects now, dropping the current socket (if any) without waiting for its close. */
  private reconnect(r: Relay): void {
    clearTimeout(r.timer);
    const ws = r.ws;
    r.ws = null;
    r.attempt = 0;
    ws?.close();
    this.connect(r);
  }

  resume(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const r of this.relays) {
      const alive = r.ws && (r.state !== "online" || now - r.heard < SILENT_MS);
      if (!alive) this.reconnect(r);
    }
  }

  /** Runs `fn` after `ms`, unless the transport is closed first. */
  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.retries.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.retries.add(t);
  }

  private subId(hex: string): string {
    return `veil-${hex.slice(0, 16)}`;
  }

  /** The relay ended one of our subscriptions: subscribe again, unless it keeps refusing us. */
  private onClosed(r: Relay, sub: unknown, reason: string): void {
    const hex = [...this.topics.keys()].find((h) => this.subId(h) === sub);
    if (!hex || !r.ws) return;
    const tries = r.closedTries.get(hex) ?? 0;
    if (REFUSED.test(reason) && tries >= REFUSED_TRIES) {
      r.detail = `subscription refused: ${reason}`.slice(0, 120);
      this.emit();
      return;
    }
    r.closedTries.set(hex, tries + 1);
    const ws = r.ws;
    this.later(() => {
      if (r.ws === ws && r.state === "online" && this.topics.has(hex))
        ws.send(JSON.stringify(this.req(hex)));
    }, backoff(tries));
  }

  /** A relay that rate-limited one of our events gets it once more, a little later. */
  private onRateLimited(r: Relay, id: unknown): void {
    const entry = typeof id === "string" ? this.sent.get(id) : undefined;
    if (!entry || entry.retried.has(r.url) || !r.ws) return;
    entry.retried.add(r.url);
    const ws = r.ws;
    this.later(() => {
      if (r.ws === ws && r.state === "online") ws.send(entry.frame);
    }, backoff(1));
  }

  private req(hex: string): unknown[] {
    return [
      "REQ",
      this.subId(hex),
      { kinds: [this.kind], "#t": [hex], since: Math.floor(Date.now() / 1000) - 60 },
    ];
  }

  private onMessage(r: Relay, data: unknown): void {
    r.heard = Date.now();
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
      const reason = String(msg[3] ?? "");
      r.detail = `rejected: ${reason}`.slice(0, 120);
      if (reason.startsWith("rate-limited")) this.onRateLimited(r, msg[1]);
      this.emit();
    } else if (msg[0] === "CLOSED" || msg[0] === "NOTICE") {
      const reason = String(msg[msg.length - 1] ?? "");
      r.detail = reason.slice(0, 120);
      if (msg[0] === "CLOSED") this.onClosed(r, msg[1], reason);
      this.emit();
    } else if (msg[0] === "AUTH") {
      // NIP-42 is not implemented: a relay that insists on it will refuse us, and this says why.
      r.detail = "asks for authentication (NIP-42), which Veil does not do";
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
    const frame = JSON.stringify(["CLOSE", this.subId(hex)]);
    for (const r of this.relays) if (r.state === "online") r.ws?.send(frame);
  }

  send(topic: Uint8Array, wire: string): void {
    const ev = signEvent(this.sk, wire, [["t", toHex(topic)]], this.kind);
    const frame = JSON.stringify(["EVENT", ev]);
    this.sent.set(ev.id, { frame, retried: new Set() });
    for (const id of this.sent.keys()) {
      if (this.sent.size <= SENT_MAX) break;
      this.sent.delete(id);
    }
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
    for (const t of this.retries) clearTimeout(t);
    this.retries.clear();
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
