/** In-memory signaling bus: every transport on the bus hears every broadcast on its topics. */
import type { TransportFactory } from "../src/signal/mux";
import type { SignalTransport, TransportHandlers, TransportStatus } from "../src/signal/types";

export class MemoryBus {
  readonly members = new Set<MemoryTransport>();
  sent = 0;

  factory(): TransportFactory {
    return (name, _cfg, peerId, handlers) =>
      name === "nostr" ? new MemoryTransport(this, peerId, handlers) : null;
  }
}

export class MemoryTransport implements SignalTransport {
  readonly name = "nostr" as const;
  readonly topics = new Map<string, Uint8Array>();

  constructor(
    private readonly bus: MemoryBus,
    readonly peerId: string,
    private readonly handlers: TransportHandlers,
  ) {
    bus.members.add(this);
    queueMicrotask(() => handlers.onStatus(this.status()));
  }

  join(topic: Uint8Array): void {
    this.topics.set(topic.join(","), topic);
  }

  leave(topic: Uint8Array): void {
    this.topics.delete(topic.join(","));
  }

  send(topic: Uint8Array, wire: string): void {
    const key = topic.join(",");
    this.bus.sent++;
    for (const m of this.bus.members) {
      const t = m.topics.get(key);
      if (m !== this && t) setTimeout(() => m.handlers.onEnvelope(wire, t), 1);
    }
  }

  status(): TransportStatus {
    return { name: "nostr", state: "online", endpoints: [] };
  }

  close(): void {
    this.bus.members.delete(this);
  }
}
