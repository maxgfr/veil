/**
 * Preferences, persisted in localStorage. Only preferences live here
 * (nickname, transports, relays, STUN/TURN, language, built-in AI): never a room key, a message or
 * a file. Every read is defensive: storage may be unavailable or corrupted.
 */
import { signal } from "@preact/signals";

import { DEFAULT_RELAYS, DEFAULT_TRACKERS } from "../signal/defaults";

export { DEFAULT_RELAYS, DEFAULT_TRACKERS };
export const DEFAULT_STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

export interface TurnServer {
  urls: string;
  username: string;
  credential: string;
}

export interface AiSettings {
  /** Translate chat messages into the user's language as they arrive. */
  translateChat: boolean;
}

/** How a screen share is captured: sharp text at a low frame rate, or smooth motion. */
export type ScreenQuality = "detail" | "motion";
/** How the call stage is laid out on this device. */
export type Layout = "auto" | "grid" | "spotlight";

export interface Settings {
  nick: string;
  nostr: { enabled: boolean; relays: string[] };
  torrent: { enabled: boolean; trackers: string[] };
  manual: { enabled: boolean };
  stun: string[];
  turn: TurnServer | null;
  audioDevice: string;
  videoDevice: string;
  ai: AiSettings;
  screenQuality: ScreenQuality;
  layout: Layout;
  /**
   * The language translations land in, as a BCP 47 tag;
   * "" follows the browser's.
   */
  language: string;
}

export function defaultSettings(): Settings {
  return {
    nick: "",
    nostr: { enabled: true, relays: [...DEFAULT_RELAYS] },
    torrent: { enabled: true, trackers: [...DEFAULT_TRACKERS] },
    manual: { enabled: true },
    stun: [...DEFAULT_STUN],
    turn: null,
    audioDevice: "",
    videoDevice: "",
    ai: { translateChat: false },
    screenQuality: "detail",
    layout: "auto",
    language: "",
  };
}

const KEY = "veil.settings.v1";

const strList = (x: unknown, fallback: string[]): string[] =>
  Array.isArray(x)
    ? x.filter((s): s is string => typeof s === "string" && s.length < 512).slice(0, 32)
    : fallback;

/** Merges stored JSON over the defaults, dropping anything malformed. */
export function parseSettings(raw: string | null): Settings {
  const d = defaultSettings();
  if (!raw) return d;
  let x: Record<string, unknown>;
  try {
    x = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return d;
  }
  if (typeof x !== "object" || x === null) return d;
  const obj = (v: unknown) =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const nostr = obj(x.nostr);
  const torrent = obj(x.torrent);
  const manual = obj(x.manual);
  const turn = obj(x.turn);
  const ai = obj(x.ai);
  return {
    nick: typeof x.nick === "string" ? x.nick.slice(0, 40) : d.nick,
    nostr: {
      enabled: typeof nostr.enabled === "boolean" ? nostr.enabled : d.nostr.enabled,
      relays: strList(nostr.relays, d.nostr.relays),
    },
    torrent: {
      enabled: typeof torrent.enabled === "boolean" ? torrent.enabled : d.torrent.enabled,
      trackers: strList(torrent.trackers, d.torrent.trackers),
    },
    manual: { enabled: typeof manual.enabled === "boolean" ? manual.enabled : d.manual.enabled },
    stun: strList(x.stun, d.stun),
    turn:
      typeof turn.urls === "string" && turn.urls
        ? {
            urls: turn.urls,
            username: String(turn.username ?? ""),
            credential: String(turn.credential ?? ""),
          }
        : null,
    audioDevice: typeof x.audioDevice === "string" ? x.audioDevice : "",
    videoDevice: typeof x.videoDevice === "string" ? x.videoDevice : "",
    ai: {
      translateChat: typeof ai.translateChat === "boolean" ? ai.translateChat : d.ai.translateChat,
    },
    screenQuality:
      x.screenQuality === "detail" || x.screenQuality === "motion"
        ? x.screenQuality
        : d.screenQuality,
    layout:
      x.layout === "auto" || x.layout === "grid" || x.layout === "spotlight" ? x.layout : d.layout,
    language:
      typeof x.language === "string" && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(x.language)
        ? x.language
        : d.language,
  };
}

function load(): Settings {
  try {
    return parseSettings(localStorage.getItem(KEY));
  } catch {
    return defaultSettings();
  }
}

export const settings = signal<Settings>(load());

export function saveSettings(next: Settings): void {
  settings.value = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: keep the in-memory value.
  }
}

export function resetSettings(): void {
  const nick = settings.value.nick;
  saveSettings({ ...defaultSettings(), nick });
}

export function iceServers(s: Settings): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  if (s.stun.length) out.push({ urls: s.stun });
  if (s.turn)
    out.push({ urls: s.turn.urls, username: s.turn.username, credential: s.turn.credential });
  return out;
}

/** Splits a textarea into URLs, keeping only ws(s)/stun(s)/turn(s) schemes. */
export function parseUrlList(text: string, schemes: readonly string[]): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s && schemes.some((p) => s.startsWith(p)));
}
