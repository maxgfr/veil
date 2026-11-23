/**
 * WebTorrent tracker transport. Trackers relay WebRTC offers between peers
 * announcing the same info_hash, which makes them a free rendezvous service.
 * We announce on info_hash = first 20 bytes of the topic and put the sealed
 * envelope in the `sdp` field:
 *   - broadcast → `offers` (the tracker hands each to a random swarm member),
 *   - direct    → an `answer` with `to_peer_id` (routed to that peer only).
 * ICE is gathered before sending (non-trickle), so one message is enough.
 */
import { randomBytes, toB64u } from "../crypto/bytes";
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

export { DEFAULT_TRACKERS } from "./defaults";

const FANOUT = 10;
const REANNOUNCE_MS = 50_000;
/** Sends made while no tracker is up wait this long for one, as on Nostr. */
const QUEUE_TTL_MS = 30_000;
const QUEUE_MAX = 64;
/** An open socket that heard nothing for this long (trackers answer every announce) may be dead. */
const SILENT_MS = 60_000;

/** The tracker protocol carries binary ids as latin1 strings. */
export function infoHash(topic: Uint8Array): string {
  return String.fromCharCode(...topic.subarray(0, 20));
}

interface Tracker {
  url: string;
  ws: WebSocket | null;
  state: TransportState;
  detail?: string;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Last time the socket opened or carried a message. */
  heard: number;
}

interface Queued {
  at: number;
  hash: string;
  wire: string;
  to?: string;
}

interface TrackerMessage {
  action?: string;
  info_hash?: string;
  peer_id?: string;
  offer?: { sdp?: unknown };
  answer?: { sdp?: unknown };
  "failure reason"?: string;
  "warning message"?: string;
}

export interface TorrentOptions {
  WebSocket?: WebSocketCtor;
}

export class TorrentTransport implements SignalTransport {
  readonly name = "torrent" as const;
  private readonly trackers: Tracker[];
  private readonly topics = new Map<string, Uint8Array>();
  private queue: Queued[] = [];
  private closed = false;
  private readonly WS: WebSocketCtor;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(
    urls: string[],
    /** 20-char peer id, also used as the tracker peer_id so answers can be routed. */
    private readonly peerId: string,
    private readonly handlers: TransportHandlers,
    opts: TorrentOptions = {},
  ) {
    if (peerId.length !== 20) throw new Error("tracker peer_id must be 20 chars");
    this.WS = opts.WebSocket ?? WebSocket;
    this.trackers = [...new Set(urls)].map((url) => ({
      url,
      ws: null,
      state: "connecting",
      attempt: 0,
      heard: 0,
    }));
    for (const t of this.trackers) this.connect(t);
    this.interval = setInterval(() => {
      for (const t of this.trackers) for (const hash of this.topics.keys()) this.announce(t, hash);
    }, REANNOUNCE_MS);
    this.emit();
  }

  private connect(t: Tracker): void {
    if (this.closed) return;
    t.state = "connecting";
    let ws: WebSocket;
    try {
      ws = new this.WS(t.url);
    } catch (err) {
      t.state = "error";
      t.detail = err instanceof Error ? err.message : "invalid URL";
      this.emit();
      return;
    }
    t.ws = ws;
    ws.onopen = () => {
      t.state = "online";
      t.attempt = 0;
      t.heard = Date.now();
      delete t.detail;
      for (const hash of this.topics.keys()) this.announce(t, hash, "started");
      const now = Date.now();
      this.queue = this.queue.filter((q) => now - q.at < QUEUE_TTL_MS);
      for (const q of this.queue) this.deliver(t, q.hash, q.wire, q.to);
      this.emit();
    };
    ws.onmessage = (e) => this.onMessage(t, e.data);
    ws.onerror = () => {
      t.detail = "connection error";
    };
    ws.onclose = () => {
      if (t.ws !== ws) return;
      t.ws = null;
      if (this.closed) return;
      t.state = "error";
      t.detail ??= "disconnected";
      t.timer = setTimeout(() => this.connect(t), backoff(t.attempt++));
      this.emit();
    };
    this.emit();
  }

  /** Reconnects now, dropping the current socket (if any) without waiting for its close. */
  private reconnect(t: Tracker): void {
    clearTimeout(t.timer);
    const ws = t.ws;
    t.ws = null;
    t.attempt = 0;
    ws?.close();
    this.connect(t);
  }

  resume(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const t of this.trackers) {
      const alive = t.ws && (t.state !== "online" || now - t.heard < SILENT_MS);
      if (!alive) this.reconnect(t);
    }
  }

  private sendTo(t: Tracker, msg: unknown): void {
    if (t.state === "online" && t.ws) t.ws.send(JSON.stringify(msg));
  }

  private announce(t: Tracker, hash: string, event?: "started" | "stopped"): void {
    const msg: Record<string, unknown> = {
      action: "announce",
      info_hash: hash,
      peer_id: this.peerId,
      numwant: 0,
      offers: [],
    };
    if (event) msg.event = event;
    this.sendTo(t, msg);
  }

  private onMessage(t: Tracker, data: unknown): void {
    t.heard = Date.now();
    if (typeof data !== "string") return;
    let msg: TrackerMessage;
    try {
      msg = JSON.parse(data) as TrackerMessage;
    } catch {
      return;
    }
    if (msg["failure reason"]) {
      t.detail = String(msg["failure reason"]).slice(0, 120);
      this.emit();
      return;
    }
    if (msg.action !== "announce" || !msg.info_hash || msg.peer_id === this.peerId) return;
    const topic = this.topics.get(msg.info_hash);
    if (!topic) return;
    const sdp = msg.offer?.sdp ?? msg.answer?.sdp;
    if (typeof sdp === "string") this.handlers.onEnvelope(sdp, topic);
  }

  join(topic: Uint8Array): void {
    const hash = infoHash(topic);
    if (this.topics.has(hash)) return;
    this.topics.set(hash, topic);
    for (const t of this.trackers) this.announce(t, hash, "started");
  }

  leave(topic: Uint8Array): void {
    const hash = infoHash(topic);
    if (!this.topics.delete(hash)) return;
    for (const t of this.trackers) this.announce(t, hash, "stopped");
  }

  send(topic: Uint8Array, wire: string, to?: string): void {
    const hash = infoHash(topic);
    let sent = false;
    for (const t of this.trackers) {
      if (t.state === "online" && t.ws) {
        this.deliver(t, hash, wire, to);
        sent = true;
      }
    }
    if (!sent)
      this.queue.push(to ? { at: Date.now(), hash, wire, to } : { at: Date.now(), hash, wire });
    if (this.queue.length > QUEUE_MAX) this.queue.shift();
  }

  private deliver(t: Tracker, hash: string, wire: string, to?: string): void {
    if (to) {
      this.sendTo(t, {
        action: "announce",
        info_hash: hash,
        peer_id: this.peerId,
        to_peer_id: to,
        offer_id: toB64u(randomBytes(15)),
        answer: { type: "answer", sdp: wire },
      });
    } else {
      const offers = Array.from({ length: FANOUT }, () => ({
        offer_id: toB64u(randomBytes(15)),
        offer: { type: "offer", sdp: wire },
      }));
      this.sendTo(t, {
        action: "announce",
        info_hash: hash,
        peer_id: this.peerId,
        numwant: FANOUT,
        offers,
      });
    }
  }

  status(): TransportStatus {
    const endpoints: EndpointStatus[] = this.trackers.map((t) =>
      t.detail ? { url: t.url, state: t.state, detail: t.detail } : { url: t.url, state: t.state },
    );
    const state = aggregateState(endpoints);
    return { name: this.name, state, endpoints };
  }

  private emit(): void {
    this.handlers.onStatus(this.status());
  }

  close(): void {
    for (const t of this.trackers)
      for (const hash of this.topics.keys()) this.announce(t, hash, "stopped");
    this.closed = true;
    clearInterval(this.interval);
    for (const t of this.trackers) {
      clearTimeout(t.timer);
      const ws = t.ws;
      t.ws = null;
      t.state = "off";
      ws?.close();
    }
    this.emit();
  }
}
