/** Signaling: how two strangers holding the same room link find each other. */

export type TransportName = "nostr" | "torrent" | "manual";
export type TransportState = "off" | "connecting" | "online" | "error";

export interface EndpointStatus {
  url: string;
  state: TransportState;
  detail?: string;
}

export interface TransportStatus {
  name: TransportName;
  state: TransportState;
  detail?: string;
  endpoints: EndpointStatus[];
}

export interface TransportHandlers {
  /** A raw (still sealed) envelope arrived on `topic`. */
  onEnvelope(wire: string, topic: Uint8Array): void;
  onStatus(status: TransportStatus): void;
}

/**
 * A transport only moves opaque strings around a rendezvous topic. It never
 * sees plaintext: envelopes are sealed before they reach it.
 */
export interface SignalTransport {
  readonly name: TransportName;
  join(topic: Uint8Array): void;
  leave(topic: Uint8Array): void;
  /** Broadcast to the topic, or best-effort direct delivery when the transport can route by peer. */
  send(topic: Uint8Array, wire: string, to?: string): void;
  status(): TransportStatus;
  close(): void;
}

export type SignalKind = "hello" | "offer" | "answer" | "bye";

/** Plaintext of an envelope. `to` lives inside the ciphertext: relays never learn who talks to whom. */
export interface SignalMessage {
  v: 1;
  id: string;
  from: string;
  to?: string;
  ts: number;
  kind: SignalKind;
  /** Offer/answer SDP (non-trickle: ICE candidates are already gathered). */
  sdp?: string;
  /** Distinguishes successive negotiations between the same pair. */
  session?: string;
  /** Sender's Ed25519 identity key: its hash is `from`. */
  edPub: string;
  /** Ed25519 signature over the fields above: proves the sender owns `from`. */
  sig: string;
}

export type WebSocketCtor = new (url: string) => WebSocket;

/** Exponential backoff with jitter, capped at 30 s. */
export function backoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/** Overall state of a transport from its endpoints: online if any endpoint is. */
export function aggregateState(endpoints: readonly EndpointStatus[]): TransportState {
  if (endpoints.some((e) => e.state === "online")) return "online";
  if (endpoints.some((e) => e.state === "connecting")) return "connecting";
  return endpoints.length === 0 ? "off" : "error";
}
