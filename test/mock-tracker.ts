/**
 * Minimal WebTorrent (WebSocket) tracker for tests and local dev: it forwards
 * offers to random swarm members and routes answers to `to_peer_id`, exactly
 * like bittorrent-tracker's server does.
 */
export interface TrackerSocket {
  send(data: string): unknown;
}

export interface MockTracker {
  open(ws: TrackerSocket): void;
  message(ws: TrackerSocket, data: string): void;
  close(ws: TrackerSocket): void;
  /** Raw announce payloads received (for assertions). */
  readonly seen: unknown[];
}

interface Announce {
  action?: string;
  info_hash?: string;
  peer_id?: string;
  numwant?: number;
  event?: string;
  offers?: { offer_id: string; offer: unknown }[];
  answer?: unknown;
  to_peer_id?: string;
  offer_id?: string;
}

export function createMockTracker(): MockTracker {
  const swarms = new Map<string, Map<string, TrackerSocket>>();
  const seen: unknown[] = [];
  const send = (ws: TrackerSocket, m: unknown) => ws.send(JSON.stringify(m));
  return {
    seen,
    open() {},
    close(ws) {
      for (const swarm of swarms.values()) {
        for (const [id, s] of swarm) if (s === ws) swarm.delete(id);
      }
    },
    message(ws, data) {
      let m: Announce;
      try {
        m = JSON.parse(data) as Announce;
      } catch {
        return;
      }
      seen.push(m);
      if (m.action !== "announce" || !m.info_hash || !m.peer_id) return;
      let swarm = swarms.get(m.info_hash);
      if (!swarm) {
        swarm = new Map();
        swarms.set(m.info_hash, swarm);
      }
      if (m.event === "stopped") {
        swarm.delete(m.peer_id);
        return;
      }
      swarm.set(m.peer_id, ws);

      if (m.answer !== undefined && m.to_peer_id) {
        const to = swarm.get(m.to_peer_id);
        if (to) {
          send(to, {
            action: "announce",
            info_hash: m.info_hash,
            peer_id: m.peer_id,
            offer_id: m.offer_id,
            answer: m.answer,
          });
        }
        return;
      }

      send(ws, {
        action: "announce",
        info_hash: m.info_hash,
        interval: 120,
        complete: 0,
        incomplete: swarm.size,
      });

      const offers = m.offers ?? [];
      const others = [...swarm.entries()].filter(([id]) => id !== m.peer_id);
      others.sort(() => Math.random() - 0.5);
      const n = Math.min(offers.length, m.numwant ?? offers.length, others.length);
      for (let i = 0; i < n; i++) {
        const offer = offers[i];
        const peer = others[i];
        if (!offer || !peer) continue;
        send(peer[1], {
          action: "announce",
          info_hash: m.info_hash,
          peer_id: m.peer_id,
          offer_id: offer.offer_id,
          offer: offer.offer,
        });
      }
    },
  };
}
