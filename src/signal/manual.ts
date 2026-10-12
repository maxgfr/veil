/**
 * Manual transport: no network at all. The sealed envelope (SDP already
 * minimized and deflate-compressed by the envelope layer, then encrypted) is
 * shown as a QR code / text that the other person scans or pastes, and their
 * answer comes back the same way. Works offline on a LAN, or when you do not
 * want any relay or tracker to even see a topic.
 */
import type { SignalTransport, TransportHandlers, TransportStatus } from "./types";

export const MANUAL_PREFIX = "veil1:";

export function encodeManual(wire: string): string {
  return MANUAL_PREFIX + wire;
}

/** Accepts the code with arbitrary whitespace or line breaks (QR scanners, chat apps). */
export function decodeManual(code: string): string | null {
  const s = code.replace(/\s+/g, "");
  if (!s.startsWith(MANUAL_PREFIX)) return null;
  const wire = s.slice(MANUAL_PREFIX.length);
  return /^[0-9a-f]{20}\.[A-Za-z0-9_-]+$/.test(wire) ? wire : null;
}

export class ManualTransport implements SignalTransport {
  readonly name = "manual" as const;
  private readonly topics = new Map<string, Uint8Array>();

  constructor(
    private readonly handlers: TransportHandlers,
    /** Called with a code to display; `to` is the intended recipient when known. */
    private readonly onOutgoing: (code: string, to?: string) => void,
  ) {
    this.handlers.onStatus(this.status());
  }

  join(topic: Uint8Array): void {
    this.topics.set(Array.from(topic.subarray(0, 8)).join(","), topic);
  }

  leave(topic: Uint8Array): void {
    this.topics.delete(Array.from(topic.subarray(0, 8)).join(","));
  }

  send(_topic: Uint8Array, wire: string, to?: string): void {
    this.onOutgoing(encodeManual(wire), to);
  }

  /** Feeds a pasted/scanned code in. The envelope is bound to its day's topic, so try each. */
  ingest(code: string): boolean {
    const wire = decodeManual(code);
    if (!wire) return false;
    for (const topic of this.topics.values()) this.handlers.onEnvelope(wire, topic);
    return true;
  }

  status(): TransportStatus {
    return { name: this.name, state: "online", endpoints: [] };
  }

  close(): void {
    this.topics.clear();
  }
}
