/**
 * Runs every enabled transport in parallel: an envelope is broadcast on all
 * of them and the first copy to arrive wins (duplicates are dropped). The
 * RoomSignaling layer on top seals/opens envelopes, follows the daily topic
 * rotation (listening on today and yesterday) and filters what is ours.
 */
import type { RoomSecrets } from "../crypto/room";
import { utcDay } from "../crypto/room";
import { EnvelopeOpener, type EnvelopeSigner, type Outgoing, sealEnvelope } from "./envelope";
import { ManualTransport } from "./manual";
import { DEFAULT_RELAYS, NostrTransport } from "./nostr";
import { DEFAULT_TRACKERS, TorrentTransport } from "./torrent";
import type {
  SignalMessage,
  SignalTransport,
  TransportHandlers,
  TransportName,
  TransportStatus,
} from "./types";

export interface SignalConfig {
  nostr: { enabled: boolean; relays: string[] };
  torrent: { enabled: boolean; trackers: string[] };
  manual: { enabled: boolean };
}

export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  nostr: { enabled: true, relays: DEFAULT_RELAYS },
  torrent: { enabled: true, trackers: DEFAULT_TRACKERS },
  manual: { enabled: true },
};

export type TransportFactory = (
  name: TransportName,
  cfg: SignalConfig,
  peerId: string,
  handlers: TransportHandlers,
  onManualOutgoing: (code: string, to?: string) => void,
) => SignalTransport | null;

export const defaultTransportFactory: TransportFactory = (
  name,
  cfg,
  peerId,
  handlers,
  onManual,
) => {
  if (name === "nostr" && cfg.nostr.enabled && cfg.nostr.relays.length > 0) {
    return new NostrTransport(cfg.nostr.relays, handlers);
  }
  if (name === "torrent" && cfg.torrent.enabled && cfg.torrent.trackers.length > 0) {
    return new TorrentTransport(cfg.torrent.trackers, peerId, handlers);
  }
  if (name === "manual" && cfg.manual.enabled) return new ManualTransport(handlers, onManual);
  return null;
};

const NETWORK: readonly TransportName[] = ["nostr", "torrent"];
const DEDUP_MS = 5 * 60_000;

export interface MuxHandlers {
  onEnvelope(wire: string, topic: Uint8Array, via: TransportName): void;
  onStatus(statuses: TransportStatus[]): void;
  onManualOutgoing(code: string, to?: string): void;
}

export class SignalMux {
  readonly transports = new Map<TransportName, SignalTransport>();
  private readonly statuses = new Map<TransportName, TransportStatus>();
  private readonly seen = new Map<string, number>();

  constructor(
    cfg: SignalConfig,
    peerId: string,
    private readonly handlers: MuxHandlers,
    factory = defaultTransportFactory,
  ) {
    for (const name of ["nostr", "torrent", "manual"] as const) {
      const t = factory(
        name,
        cfg,
        peerId,
        {
          onEnvelope: (wire, topic) => this.deliver(wire, topic, name),
          onStatus: (s) => {
            this.statuses.set(name, s);
            this.handlers.onStatus(this.status());
          },
        },
        (code, to) => this.handlers.onManualOutgoing(code, to),
      );
      if (t) this.transports.set(name, t);
    }
  }

  private deliver(wire: string, topic: Uint8Array, via: TransportName): void {
    // The sealed part starts with a random nonce, so its prefix identifies the envelope.
    const key = `${topic[0]}:${topic[1]}:${wire.slice(0, 60)}`;
    const now = Date.now();
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    if (this.seen.size > 2048)
      for (const [k, t] of this.seen) if (now - t > DEDUP_MS) this.seen.delete(k);
    this.handlers.onEnvelope(wire, topic, via);
  }

  join(topic: Uint8Array): void {
    for (const t of this.transports.values()) t.join(topic);
  }

  leave(topic: Uint8Array): void {
    for (const t of this.transports.values()) t.leave(topic);
  }

  /** Sends on the network transports, plus any explicitly requested in `via` (e.g. manual). */
  send(
    topic: Uint8Array,
    wire: string,
    opts: { to?: string; via?: readonly TransportName[] } = {},
  ): void {
    const names = opts.via ?? NETWORK;
    for (const name of names) this.transports.get(name)?.send(topic, wire, opts.to);
  }

  manual(): ManualTransport | undefined {
    const t = this.transports.get("manual");
    return t instanceof ManualTransport ? t : undefined;
  }

  status(): TransportStatus[] {
    return [...this.transports.keys()].map(
      (name) => this.statuses.get(name) ?? { name, state: "connecting", endpoints: [] },
    );
  }

  close(): void {
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
  }
}

export interface RoomSignalingOptions {
  secrets: RoomSecrets;
  /** Signs our envelopes; its peer id is the `from` of everything we send. */
  identity: EnvelopeSigner;
  config: SignalConfig;
  factory?: TransportFactory;
  now?: () => number;
}

export interface SignalingEvents {
  onMessage(msg: SignalMessage, via: TransportName): void;
  onStatus(statuses: TransportStatus[]): void;
  onManualOutgoing(code: string, to?: string): void;
}

/** Manual codes travel by hand, so they get a longer validity window than network envelopes. */
const MANUAL_MAX_AGE_MS = 10 * 60_000;

export class RoomSignaling {
  readonly mux: SignalMux;
  private readonly opener: EnvelopeOpener;
  private readonly manualOpener: EnvelopeOpener;
  private readonly now: () => number;
  private day = -1;
  private rollover?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private readonly opts: RoomSignalingOptions,
    private readonly events: SignalingEvents,
  ) {
    this.now = opts.now ?? Date.now;
    this.opener = new EnvelopeOpener(opts.secrets.sigKey, { now: this.now });
    this.manualOpener = new EnvelopeOpener(opts.secrets.sigKey, {
      now: this.now,
      maxAgeMs: MANUAL_MAX_AGE_MS,
    });
    this.mux = new SignalMux(
      opts.config,
      opts.identity.peerId,
      {
        onEnvelope: (wire, topic, via) => void this.receive(wire, topic, via),
        onStatus: (s) => events.onStatus(s),
        onManualOutgoing: (code, to) => events.onManualOutgoing(code, to),
      },
      opts.factory,
    );
  }

  get peerId(): string {
    return this.opts.identity.peerId;
  }

  /** Joins today's and yesterday's topics, and rotates at UTC midnight. */
  async start(): Promise<void> {
    const day = utcDay(this.now());
    if (day !== this.day) {
      const { secrets } = this.opts;
      const [today, yesterday] = await Promise.all([secrets.topic(day), secrets.topic(day - 1)]);
      if (this.stopped) return;
      if (this.day >= 0) this.mux.leave(await secrets.topic(this.day - 1));
      this.mux.join(today);
      this.mux.join(yesterday);
      this.day = day;
    }
    const msToMidnight = (day + 1) * 86_400_000 - this.now();
    clearTimeout(this.rollover);
    this.rollover = setTimeout(() => void this.start(), Math.max(1000, msToMidnight + 1000));
  }

  private async receive(wire: string, topic: Uint8Array, via: TransportName): Promise<void> {
    const msg = await (via === "manual" ? this.manualOpener : this.opener).open(wire, topic);
    if (!msg || this.stopped) return;
    if (msg.from === this.opts.identity.peerId) return;
    if (msg.to !== undefined && msg.to !== this.opts.identity.peerId) return;
    this.events.onMessage(msg, via);
  }

  async send(out: Outgoing, via?: readonly TransportName[]): Promise<SignalMessage> {
    const topic = await this.opts.secrets.topic(utcDay(this.now()));
    const { wire, message } = await sealEnvelope(
      this.opts.secrets.sigKey,
      topic,
      this.opts.identity,
      out,
      this.now(),
    );
    const opts: { to?: string; via?: readonly TransportName[] } = {};
    if (out.to) opts.to = out.to;
    if (via) opts.via = via;
    this.mux.send(topic, wire, opts);
    return message;
  }

  /** Returns false when the text is not a Veil code. */
  ingestManual(code: string): boolean {
    return this.mux.manual()?.ingest(code) ?? false;
  }

  status(): TransportStatus[] {
    return this.mux.status();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.rollover);
    this.mux.close();
  }
}
