import { describe, expect, test } from "bun:test";
import { newRoomKey, roomLink } from "../crypto/room";
import {
  followOtherTabs,
  KEEP_AFTER_END_MS,
  MAX_MEETINGS,
  type Meeting,
  type MeetingStorage,
  type MeetingStore,
  meetingStatus,
  meetingStore,
  newMeetingId,
  parseMeetings,
} from "./meetings";
import { type Sealer, sealerFor } from "./sealed";

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
    removeItem: (k) => {
      data.delete(k);
    },
  };
}

// The device key, without IndexedDB: one per test file, shared by its "tabs".
const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
  "encrypt",
  "decrypt",
]);
const sealer: Sealer = sealerFor(() => key, "veil.meetings.v2");
const tab = (storage: MeetingStorage | null) => meetingStore(storage, () => NOW, sealer);
/** A store's first read of storage has settled. */
const opened = async (s: MeetingStore) => {
  await s.refresh();
  return s;
};
const stored = async (storage: { data: Map<string, string> }) =>
  parseMeetings(await sealer.open(storage.data.get("veil.meetings.v2") ?? ""), NOW);

const ids = (list: Meeting[]) => list.map((m) => m.id);
const storageEvent = (key: string | null) => Object.assign(new Event("storage"), { key });
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("meetingStore across tabs", () => {
  test("the list is stored sealed: no room link or title in clear", async () => {
    const storage = sharedStorage();
    const a = await opened(tab(storage));
    const x = meeting({ title: "Board meeting" });
    expect(await a.add(x)).toBe(true);
    const raw = [...storage.data.values()].join("");
    expect(raw).not.toContain(x.link);
    expect(raw).not.toContain("veil.example");
    expect(raw).not.toContain("Board meeting");
    expect(await stored(storage)).toEqual([x]);
    // Another tab of this device opens it.
    expect((await opened(tab(storage))).meetings.value).toEqual([x]);
  });

  test("a list kept in clear by an earlier version is sealed, then removed", async () => {
    const storage = sharedStorage();
    const x = meeting();
    storage.data.set("veil.meetings.v1", JSON.stringify([x]));
    const a = await opened(tab(storage));
    expect(a.meetings.value).toEqual([x]);
    expect(storage.data.has("veil.meetings.v1")).toBe(false);
    expect(await stored(storage)).toEqual([x]);
  });

  test("without a sealing key, nothing is written in clear and the list lives in memory", async () => {
    const storage = sharedStorage();
    const legacy = meeting();
    storage.data.set("veil.meetings.v1", JSON.stringify([legacy]));
    const noKey = sealerFor(() => Promise.reject(new Error("no IndexedDB")), "veil.meetings.v2");
    const a = await opened(meetingStore(storage, () => NOW, noKey));
    // The clear copy is still shown, and kept until it can be sealed.
    expect(a.meetings.value).toEqual([legacy]);
    expect(storage.data.has("veil.meetings.v1")).toBe(true);
    const x = meeting();
    expect(await a.add(x)).toBe(true);
    expect(ids(a.meetings.value)).toEqual([legacy.id, x.id].sort());
    expect(a.saved.value).toBe(false);
    expect(storage.data.has("veil.meetings.v2")).toBe(false);
  });

  test("a meeting scheduled in another tab survives this tab's own change", async () => {
    const storage = sharedStorage();
    const tabA = await opened(tab(storage));
    const tabB = await opened(tab(storage));
    const x = meeting({ start: NOW + 10 * MIN });
    const y = meeting({ start: NOW + 20 * MIN });
    expect(await tabB.add(x)).toBe(true);
    // Tab A still shows its old list, then schedules Y.
    expect(tabA.meetings.value).toEqual([]);
    expect(await tabA.add(y)).toBe(true);
    expect(ids(tabA.meetings.value)).toEqual([x.id, y.id]);
    expect(ids(await stored(storage))).toEqual([x.id, y.id]);
    expect(tabA.saved.value).toBe(true);
  });

  test("a removal in one tab neither drops nor brings back the other tab's meetings", async () => {
    const storage = sharedStorage();
    const tabA = await opened(tab(storage));
    const tabB = await opened(tab(storage));
    const x = meeting({ start: NOW + 10 * MIN });
    const y = meeting({ start: NOW + 20 * MIN });
    const z = meeting({ start: NOW + 30 * MIN });
    await tabA.add(x);
    await tabA.add(y);
    // Tab B removes Y; tab A, unaware, removes X: Y must not come back.
    await tabB.remove(y.id);
    await tabA.remove(x.id);
    expect(tabA.meetings.value).toEqual([]);
    // Tab B, unaware of A's removal, adds Z: X must not come back either.
    await tabB.add(z);
    expect(ids(tabB.meetings.value)).toEqual([z.id]);
    await tabA.refresh();
    expect(ids(tabA.meetings.value)).toEqual([z.id]);
  });

  test("the cap counts what is stored, not this tab's copy", async () => {
    const storage = sharedStorage();
    const tabA = await opened(tab(storage));
    const tabB = await opened(tab(storage));
    for (let i = 0; i < MAX_MEETINGS; i++) await tabB.add(meeting({ start: NOW + (i + 1) * MIN }));
    expect(await tabA.add(meeting())).toBe(false);
    expect(tabA.meetings.value.length).toBe(MAX_MEETINGS);
  });

  test("a storage event from another tab updates the list", async () => {
    const storage = sharedStorage();
    const tabA = await opened(tab(storage));
    const tabB = await opened(tab(storage));
    const win = new EventTarget();
    followOtherTabs(tabA, win);
    const x = meeting();
    await tabB.add(x);
    win.dispatchEvent(storageEvent("veil.settings.v1"));
    await settle();
    expect(tabA.meetings.value).toEqual([]);
    win.dispatchEvent(storageEvent("veil.meetings.v2"));
    await settle();
    expect(tabA.meetings.value).toEqual([x]);
    // The whole storage cleared elsewhere comes with a null key.
    storage.data.clear();
    win.dispatchEvent(storageEvent(null));
    await settle();
    expect(tabA.meetings.value).toEqual([]);
  });

  test("without storage, meetings live in memory", async () => {
    const t = await opened(tab(null));
    const x = meeting();
    expect(await t.add(x)).toBe(true);
    expect(t.meetings.value).toEqual([x]);
    expect(t.saved.value).toBe(false);
    await t.remove(x.id);
    expect(t.meetings.value).toEqual([]);
  });

  test("a storage that refuses reads and writes falls back to memory", async () => {
    const broken: MeetingStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    const t = await opened(tab(broken));
    const x = meeting();
    expect(t.saved.value).toBe(true);
    expect(await t.add(x)).toBe(true);
    expect(t.meetings.value).toEqual([x]);
    expect(t.saved.value).toBe(false);
  });
});
