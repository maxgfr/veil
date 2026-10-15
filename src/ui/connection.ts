/**
 * Connection state shown across the app: whether the browser has a network,
 * and a short summary of how a room is doing. Imports only types, so the home
 * screen can load it without pulling in the transports.
 */
import { signal } from "@preact/signals";
import type { TransportName, TransportStatus } from "../signal/types";
import type { MemberView } from "./session";

export const LINK_LABEL: Record<string, string> = {
  connecting: "Connecting",
  securing: "Securing",
  connected: "Direct",
  reconnecting: "Reconnecting",
  closed: "Disconnected",
};

export const browserOnline = signal(true);

export function watchOnline(): void {
  browserOnline.value = navigator.onLine;
  addEventListener("online", () => {
    browserOnline.value = true;
  });
  addEventListener("offline", () => {
    browserOnline.value = false;
  });
}

export type Tone = "ok" | "wait" | "bad";

export interface ConnectionSummary {
  tone: Tone;
  label: string;
  hint: string;
}

export function connectionSummary(input: {
  online: boolean;
  transports: readonly Pick<TransportStatus, "state">[];
  others: readonly Pick<MemberView, "link">[];
}): ConnectionSummary {
  if (!input.online) {
    return {
      tone: "bad",
      label: "Offline",
      hint: "This device has no network. Rooms need one to connect.",
    };
  }
  if (input.others.some((m) => m.link === "connected")) {
    return { tone: "ok", label: "Connected", hint: "Linked directly to people in the room." };
  }
  // A reconnecting peer still counts as connected: the dot waits, it never turns red.
  if (input.others.some((m) => m.link === "reconnecting")) {
    return { tone: "wait", label: "Reconnecting", hint: "A link dropped. Trying to restore it." };
  }
  if (input.transports.some((t) => t.state === "online")) {
    return {
      tone: "wait",
      label: "Looking for peers",
      hint: "Rendezvous relays are reachable. Waiting for others to show up.",
    };
  }
  if (input.transports.some((t) => t.state === "connecting")) {
    return { tone: "wait", label: "Reaching relays", hint: "Contacting the rendezvous relays…" };
  }
  return {
    tone: "bad",
    label: "No relay reachable",
    hint: "None of the rendezvous relays answered. Check Settings or your network.",
  };
}

export function transportLabel(name: TransportName): string {
  return name === "nostr"
    ? "Nostr relays"
    : name === "torrent"
      ? "WebTorrent trackers"
      : "Manual codes";
}
