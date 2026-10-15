/**
 * Scheduled meetings, kept on this device only (localStorage). A meeting is a
 * plain room link plus a title and a time: the room itself exists whenever
 * people open the link. The link holds the room key, so it never leaves the
 * device from here. Every read is defensive: storage may be unavailable or
 * corrupted, and anything malformed is dropped.
 */
import { type Signal, signal } from "@preact/signals";
import { parseRoomLink } from "../crypto/room";

export const DURATIONS = [15, 30, 45, 60, 90, 120] as const;
export const DEFAULT_DURATION = 30;
export const MAX_TITLE = 120;
export const MAX_MEETINGS = 50;
/** A meeting stays listed this long after its end. */
export const KEEP_AFTER_END_MS = 12 * 3_600_000;
/** "Starts in N min" shows from this long before the start. */
export const SOON_MS = 15 * 60_000;

export interface Meeting {
  /** Random, also the calendar event's UID. */
  id: string;
  /** May be empty. */
  title: string;
  /** ms since the epoch. */
  start: number;
  minutes: number;
  link: string;
}

const KEY = "veil.meetings.v1";

export const meetingEnd = (m: Meeting): number => m.start + m.minutes * 60_000;

export function newMeetingId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** A local date ("2026-10-16") and time ("09:30") as ms since the epoch; null if invalid. */
export function localStart(date: string, time: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!d || !t) return null;
  const y = Number(d[1]);
  const mo = Number(d[2]) - 1;
  const day = Number(d[3]);
  const h = Number(t[1]);
  const min = Number(t[2]);
  if (h > 23 || min > 59) return null;
  const at = new Date(y, mo, day, h, min);
  // Date rolls 31 February over into March: refuse it instead.
  if (at.getFullYear() !== y || at.getMonth() !== mo || at.getDate() !== day) return null;
  return at.getTime();
}

function isLink(s: string): boolean {
  if (s.length > 2048 || !parseRoomLink(s)) return false;
  try {
    const { protocol } = new URL(s);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function parseMeeting(v: unknown): Meeting | null {
  if (typeof v !== "object" || v === null) return null;
  const x = v as Record<string, unknown>;
  if (typeof x.id !== "string" || !/^[0-9a-f]{8,64}$/.test(x.id)) return null;
  if (typeof x.title !== "string" || x.title.length > MAX_TITLE) return null;
  if (typeof x.start !== "number" || !Number.isFinite(x.start)) return null;
  if (!DURATIONS.some((d) => d === x.minutes)) return null;
  if (typeof x.link !== "string" || !isLink(x.link)) return null;
  return {
    id: x.id,
    title: x.title,
    start: x.start,
    minutes: x.minutes as number,
    link: x.link,
  };
}

/**
 * Valid meetings from stored JSON, sorted by start: malformed entries and
 * duplicates are dropped, meetings that ended more than 12 h before `now`
 * are pruned, and at most 50 are kept (the soonest).
 */
export function parseMeetings(raw: string | null, now: number): Meeting[] {
  if (!raw) return [];
  let x: unknown;
  try {
    x = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(x)) return [];
  const seen = new Set<string>();
  const out: Meeting[] = [];
  for (const v of x) {
    const m = parseMeeting(v);
    if (!m || seen.has(m.id) || meetingEnd(m) < now - KEEP_AFTER_END_MS) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_MEETINGS);
}

export type MeetingStatus =
  | { kind: "now" }
  | { kind: "soon"; minutes: number }
  | { kind: "ended" }
  | null;

export function meetingStatus(m: Meeting, now: number): MeetingStatus {
  if (now >= meetingEnd(m)) return { kind: "ended" };
  if (now >= m.start) return { kind: "now" };
  if (m.start - now <= SOON_MS)
    return { kind: "soon", minutes: Math.ceil((m.start - now) / 60_000) };
  return null;
}

/** The part of `Storage` the store uses: localStorage, or a stand-in in tests. */
export type MeetingStorage = Pick<Storage, "getItem" | "setItem">;

export interface MeetingStore {
  meetings: Signal<Meeting[]>;
  /** Adds a meeting; false when the list is already full. */
  add(m: Meeting): boolean;
  remove(id: string): void;
  /** False when this device couldn't keep the list (storage blocked or full): it lasts until the tab closes. */
  saved: Signal<boolean>;
  /** Re-reads storage, after another tab changed it. */
  refresh(): void;
}

/**
 * The meetings over one storage. Every change is a read-modify-write against
 * storage, never a write of this tab's copy: another tab may have scheduled or
 * removed a meeting since, and its room key must not be lost. Without storage
 * (private mode, blocked), the list lives in memory.
 */
export function meetingStore(
  storage: MeetingStorage | null,
  now: () => number = Date.now,
): MeetingStore {
  const read = (): Meeting[] | null => {
    if (!storage) return null;
    try {
      return parseMeetings(storage.getItem(KEY), now());
    } catch {
      // Storage refused the read: fall back to the in-memory list.
      return null;
    }
  };
  const meetings = signal<Meeting[]>(read() ?? []);
  const saved = signal(storage !== null);
  /** Applies `change` to the current list; `null` from it means refused. */
  const update = (change: (current: Meeting[]) => Meeting[] | null): boolean => {
    const current = read() ?? meetings.value;
    const next = change(current);
    meetings.value = next ?? current;
    if (!next) return false;
    if (!storage) return true;
    try {
      storage.setItem(KEY, JSON.stringify(next));
      saved.value = true;
    } catch (err) {
      // Storage full or blocked: keep the in-memory list, and say it won't last.
      console.warn("meetings not saved on this device", err);
      saved.value = false;
    }
    return true;
  };
  return {
    meetings,
    saved,
    add: (m) =>
      update((cur) =>
        cur.length >= MAX_MEETINGS
          ? null
          : [...cur.filter((x) => x.id !== m.id), m].sort((a, b) => a.start - b.start),
      ),
    remove: (id) => {
      update((cur) => cur.filter((m) => m.id !== id));
    },
    refresh: () => {
      const stored = read();
      if (stored) meetings.value = stored;
    },
  };
}

/** Keeps a store in step with other tabs: they fire `storage` events on this one's window. */
export function followOtherTabs(store: MeetingStore, target: EventTarget): void {
  target.addEventListener("storage", (e) => {
    const key = (e as StorageEvent).key;
    // A null key means the whole storage was cleared.
    if (key === KEY || key === null) store.refresh();
  });
}

function browserStorage(): MeetingStorage | null {
  try {
    return localStorage;
  } catch {
    // No storage here (blocked for this origin): meetings live in memory only.
    return null;
  }
}

const store = meetingStore(browserStorage());
if (typeof window !== "undefined") followOtherTabs(store, window);

export const meetings = store.meetings;
export const addMeeting = store.add;
export const removeMeeting = store.remove;
export const meetingsSaved = store.saved;
