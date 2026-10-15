import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { newRoomKey, roomLink } from "../crypto/room";
import { buildIcs, escapeText, foldLine, icsFileName, icsTime, meetingIcs } from "./ics";
import { localStart, type Meeting } from "./meetings";

const link = roomLink("https://veil.example/app/", newRoomKey());

const meeting = (o: Partial<Meeting> = {}): Meeting => ({
  id: "0123456789abcdef0123456789abcdef",
  title: "Weekly sync",
  start: Date.UTC(2026, 9, 16, 9, 0),
  minutes: 30,
  link,
  ...o,
});

/** Undoes RFC 5545 folding: CRLF followed by one space. */
const unfold = (ics: string) => ics.replace(/\r\n /g, "");

const prop = (ics: string, name: string) =>
  unfold(ics)
    .split("\r\n")
    .find((l) => l.startsWith(`${name}:`))
    ?.slice(name.length + 1);

describe("escapeText", () => {
  test("escapes backslash, semicolon, comma and newlines", () => {
    expect(escapeText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeText("one\ntwo\r\nthree\rfour")).toBe("one\\ntwo\\nthree\\nfour");
    expect(escapeText("\\n")).toBe("\\\\n");
  });
});

describe("foldLine", () => {
  test("short lines are left alone", () => {
    expect(foldLine("SUMMARY:Hi")).toBe("SUMMARY:Hi");
    const exactly = `SUMMARY:${"x".repeat(75 - 8)}`;
    expect(foldLine(exactly)).toBe(exactly);
  });

  test("folds at 75 octets with a leading space on continuation lines", () => {
    const line = `DESCRIPTION:${"abcdefghij".repeat(20)}`;
    const folded = foldLine(line);
    const parts = folded.split("\r\n");
    expect(parts.length).toBe(3);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts[0]?.length).toBe(75);
    for (const p of parts.slice(1)) expect(p.startsWith(" ")).toBe(true);
    expect(unfold(folded)).toBe(line);
  });

  test("never splits a multi-byte character", () => {
    const line = `SUMMARY:${"é🙂日本".repeat(30)}`;
    const folded = foldLine(line);
    const strict = new TextDecoder("utf-8", { fatal: true });
    for (const p of folded.split("\r\n")) {
      const bytes = new TextEncoder().encode(p);
      expect(bytes.length).toBeLessThanOrEqual(75);
      expect(strict.decode(bytes)).toBe(p);
    }
    expect(unfold(folded)).toBe(line);
  });
});

describe("buildIcs", () => {
  const ics = buildIcs({
    uid: "abc@veil",
    stamp: Date.UTC(2026, 9, 15, 12, 34, 56, 789),
    start: Date.UTC(2026, 9, 16, 9, 0),
    end: Date.UTC(2026, 9, 16, 9, 30),
    summary: "Plan, review; ship\\done",
    description: "Line one\nLine two",
    url: link,
  });

  test("one VEVENT with CRLF line endings throughout", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\r\nEND:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)?.length).toBe(1);
    expect(/[^\r]\n/.test(ics)).toBe(false);
    expect(/\r[^\n]/.test(ics)).toBe(false);
    for (const l of ics.split("\r\n"))
      expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });

  test("times are UTC in the basic Z form", () => {
    expect(prop(ics, "DTSTAMP")).toBe("20261015T123456Z");
    expect(prop(ics, "DTSTART")).toBe("20261016T090000Z");
    expect(prop(ics, "DTEND")).toBe("20261016T093000Z");
  });

  test("text values are escaped, the URL is not", () => {
    expect(prop(ics, "SUMMARY")).toBe("Plan\\, review\\; ship\\\\done");
    expect(prop(ics, "DESCRIPTION")).toBe("Line one\\nLine two");
    expect(prop(ics, "URL")).toBe(link);
    expect(prop(ics, "UID")).toBe("abc@veil");
  });
});

describe("meetingIcs", () => {
  test("the link is in URL and DESCRIPTION, with the warning", () => {
    const ics = meetingIcs(meeting(), Date.UTC(2026, 9, 15));
    expect(prop(ics, "URL")).toBe(link);
    const desc = prop(ics, "DESCRIPTION") ?? "";
    expect(desc).toContain(link);
    expect(desc).toContain("share it only with attendees");
    expect(prop(ics, "SUMMARY")).toBe("Weekly sync");
    expect(prop(ics, "UID")).toBe("0123456789abcdef0123456789abcdef@veil");
    expect(prop(ics, "DTEND")).toBe("20261016T093000Z");
  });

  test("an empty title becomes Veil meeting", () => {
    expect(prop(meetingIcs(meeting({ title: "" })), "SUMMARY")).toBe("Veil meeting");
  });

  test("a long title is folded and comes back whole", () => {
    const title = "Quarterly planning, budget; and the roadmap ".repeat(2).trim();
    const ics = meetingIcs(meeting({ title }));
    expect(ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(prop(ics, "SUMMARY")).toBe(escapeText(title));
  });

  test("file names are plain ASCII", () => {
    expect(icsFileName(meeting({ title: "Café: Q4 review!" }))).toBe("cafe-q4-review.ics");
    expect(icsFileName(meeting({ title: "" }))).toBe("veil-meeting.ics");
    expect(icsFileName(meeting({ title: "日本" }))).toBe("veil-meeting.ics");
  });
});

describe("local times across a DST change", () => {
  // Europe/Paris leaves summer time on 2026-10-25 at 03:00 (UTC+2 → UTC+1).
  const tz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "Europe/Paris";
  });
  afterAll(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  test("the same local time maps to different UTC times either side", () => {
    const before = localStart("2026-10-24", "10:00");
    const after = localStart("2026-10-26", "10:00");
    expect(before).toBe(Date.UTC(2026, 9, 24, 8, 0));
    expect(after).toBe(Date.UTC(2026, 9, 26, 9, 0));
    expect(icsTime(before ?? 0)).toBe("20261024T080000Z");
    expect(icsTime(after ?? 0)).toBe("20261026T090000Z");
  });

  test("a meeting spanning the change keeps its real duration in UTC", () => {
    // 01:30 summer time (23:30 UTC), two hours: the local clock reads 02:30 at the end.
    const start = localStart("2026-10-25", "01:30") ?? 0;
    const ics = meetingIcs(meeting({ start, minutes: 120 }));
    expect(prop(ics, "DTSTART")).toBe("20261024T233000Z");
    expect(prop(ics, "DTEND")).toBe("20261025T013000Z");
  });

  test("dates that do not exist are refused", () => {
    expect(localStart("2026-02-31", "10:00")).toBeNull();
    expect(localStart("2026-10-24", "25:00")).toBeNull();
    expect(localStart("2026-10-24", "10:75")).toBeNull();
    expect(localStart("tomorrow", "10:00")).toBeNull();
    expect(localStart("2026-10-24", "")).toBeNull();
  });
});
