import { describe, expect, test } from "bun:test";
import { newRoomKey, roomLink } from "../crypto/room";
import {
  followOtherTabs,
  KEEP_AFTER_END_MS,
  MAX_MEETINGS,
  type Meeting,
  type MeetingStorage,
  meetingStatus,
  meetingStore,
  newMeetingId,
  parseMeetings,
} from "./meetings";

const NOW = Date.UTC(2026, 9, 15, 12, 0);
const MIN = 60_000;
const link = roomLink("https://veil.example/", newRoomKey());
const filesLink = roomLink("https://veil.example/", newRoomKey(), "files");

let n = 0;
const meeting = (o: Partial<Meeting> = {}): Meeting => ({
  id: (n++).toString(16).padStart(32, "0"),
  title: "Sync",
  start: NOW + 60 * MIN,
  minutes: 30,
  link,
  ...o,
});

const parse = (v: unknown) => parseMeetings(JSON.stringify(v), NOW);

describe("parseMeetings", () => {
  test("keeps valid meetings as they are", () => {
    const list = [meeting(), meeting({ title: "", minutes: 120, link: filesLink })];
    expect(parse(list)).toEqual(list);
  });

  test("nothing stored, corrupt JSON or not a list gives no meetings", () => {
    expect(parseMeetings(null, NOW)).toEqual([]);
    expect(parseMeetings("", NOW)).toEqual([]);
    expect(parseMeetings("{not json", NOW)).toEqual([]);
    expect(parse({ meetings: [meeting()] })).toEqual([]);
    expect(parse("x")).toEqual([]);
  });

  test("drops entries with bad types, keeps the rest", () => {
    const good = meeting();
    const bad: unknown[] = [
      null,
      42,
      "meeting",
      { ...meeting(), id: 7 },
      { ...meeting(), id: "not-hex!" },
      { ...meeting(), title: 3 },
      { ...meeting(), title: "x".repeat(121) },
      { ...meeting(), start: "tomorrow" },
      { ...meeting(), minutes: 25 },
      { ...meeting(), minutes: "30" },
      { ...meeting(), link: "https://veil.example/#not-a-key" },
      { ...meeting(), link: 5 },
      { ...meeting(), link: `javascript:alert(1)//${link.slice(link.indexOf("#"))}` },
    ];
    expect(parse([...bad, good])).toEqual([good]);
    expect(parseMeetings(`[${JSON.stringify(good)}, {"start": 1e999}]`, NOW)).toEqual([good]);
  });

  test("duplicate ids are dropped", () => {
    const m = meeting();
    expect(parse([m, { ...m, title: "Copy" }])).toEqual([m]);
  });

  test("sorts by start", () => {
    const a = meeting({ start: NOW + 300 * MIN });
    const b = meeting({ start: NOW - 10 * MIN });
    const c = meeting({ start: NOW + 5 * MIN });
    expect(parse([a, b, c]).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  });

  test("prunes meetings that ended more than 12 hours ago", () => {
    const end = (ago: number) => NOW - ago - 30 * MIN;
    const old = meeting({ start: end(KEEP_AFTER_END_MS + MIN) });
    const recent = meeting({ start: end(KEEP_AFTER_END_MS - MIN) });
    expect(parse([old, recent])).toEqual([recent]);
  });

  test("keeps at most 50, the soonest", () => {
    const list = Array.from({ length: 60 }, (_, i) => meeting({ start: NOW + (60 - i) * MIN }));
    const out = parse(list);
    expect(out.length).toBe(MAX_MEETINGS);
    expect(out[0]?.start).toBe(NOW + MIN);
    expect(out.at(-1)?.start).toBe(NOW + 50 * MIN);
  });
});

describe("meetingStatus", () => {
  test("now, soon, ended or nothing", () => {
    expect(meetingStatus(meeting({ start: NOW - 5 * MIN }), NOW)).toEqual({ kind: "now" });
    expect(meetingStatus(meeting({ start: NOW }), NOW)).toEqual({ kind: "now" });
    expect(meetingStatus(meeting({ start: NOW + 15 * MIN }), NOW)).toEqual({
      kind: "soon",
      minutes: 15,
    });
    expect(meetingStatus(meeting({ start: NOW + 30_000 }), NOW)).toEqual({
      kind: "soon",
      minutes: 1,
    });
    expect(meetingStatus(meeting({ start: NOW + 16 * MIN }), NOW)).toBeNull();
    expect(meetingStatus(meeting({ start: NOW - 30 * MIN }), NOW)).toEqual({ kind: "ended" });
  });
});

describe("newMeetingId", () => {
  test("random 128-bit hex that the parser accepts", () => {
    const a = newMeetingId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newMeetingId()).not.toBe(a);
    expect(parse([meeting({ id: a })]).length).toBe(1);
  });
});

/** One origin's localStorage, shared by every tab. */
function sharedStorage(): MeetingStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const ids = (list: Meeting[]) => list.map((m) => m.id);
const storageEvent = (key: string | null) => Object.assign(new Event("storage"), { key });

describe("meetingStore across tabs", () => {
  test("a meeting scheduled in another tab survives this tab's own change", () => {
    const storage = sharedStorage();
    const tabA = meetingStore(storage, () => NOW);
    const tabB = meetingStore(storage, () => NOW);
    const x = meeting({ start: NOW + 10 * MIN });
    const y = meeting({ start: NOW + 20 * MIN });
    expect(tabB.add(x)).toBe(true);
    // Tab A still shows its old list, then schedules Y.
    expect(tabA.meetings.value).toEqual([]);
    expect(tabA.add(y)).toBe(true);
    expect(ids(tabA.meetings.value)).toEqual([x.id, y.id]);
    const stored = parseMeetings(storage.data.get("veil.meetings.v1") ?? null, NOW);
    expect(ids(stored)).toEqual([x.id, y.id]);
    expect(tabA.saved.value).toBe(true);
  });

  test("a removal in one tab neither drops nor brings back the other tab's meetings", () => {
    const storage = sharedStorage();
    const tabA = meetingStore(storage, () => NOW);
    const tabB = meetingStore(storage, () => NOW);
    const x = meeting({ start: NOW + 10 * MIN });
    const y = meeting({ start: NOW + 20 * MIN });
    const z = meeting({ start: NOW + 30 * MIN });
    tabA.add(x);
    tabA.add(y);
    // Tab B removes Y; tab A, unaware, removes X: Y must not come back.
    tabB.remove(y.id);
    tabA.remove(x.id);
    expect(tabA.meetings.value).toEqual([]);
    // Tab B, unaware of A's removal, adds Z: X must not come back either.
    tabB.add(z);
    expect(ids(tabB.meetings.value)).toEqual([z.id]);
    tabA.refresh();
    expect(ids(tabA.meetings.value)).toEqual([z.id]);
  });

  test("the cap counts what is stored, not this tab's copy", () => {
    const storage = sharedStorage();
    const tabA = meetingStore(storage, () => NOW);
    const tabB = meetingStore(storage, () => NOW);
    for (let i = 0; i < MAX_MEETINGS; i++) tabB.add(meeting({ start: NOW + (i + 1) * MIN }));
    expect(tabA.add(meeting())).toBe(false);
    expect(tabA.meetings.value.length).toBe(MAX_MEETINGS);
  });

  test("a storage event from another tab updates the list", () => {
    const storage = sharedStorage();
    const tabA = meetingStore(storage, () => NOW);
    const tabB = meetingStore(storage, () => NOW);
    const win = new EventTarget();
    followOtherTabs(tabA, win);
    const x = meeting();
    tabB.add(x);
    win.dispatchEvent(storageEvent("veil.settings.v1"));
    expect(tabA.meetings.value).toEqual([]);
    win.dispatchEvent(storageEvent("veil.meetings.v1"));
    expect(tabA.meetings.value).toEqual([x]);
    // The whole storage cleared elsewhere comes with a null key.
    storage.data.clear();
    win.dispatchEvent(storageEvent(null));
    expect(tabA.meetings.value).toEqual([]);
  });

  test("without storage, meetings live in memory", () => {
    const tab = meetingStore(null, () => NOW);
    const x = meeting();
    expect(tab.add(x)).toBe(true);
    expect(tab.meetings.value).toEqual([x]);
    expect(tab.saved.value).toBe(false);
    tab.remove(x.id);
    expect(tab.meetings.value).toEqual([]);
  });

  test("a storage that refuses reads and writes falls back to memory", () => {
    const broken: MeetingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const tab = meetingStore(broken, () => NOW);
    const x = meeting();
    expect(tab.saved.value).toBe(true);
    expect(tab.add(x)).toBe(true);
    expect(tab.meetings.value).toEqual([x]);
    expect(tab.saved.value).toBe(false);
  });
});
