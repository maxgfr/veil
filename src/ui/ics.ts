/**
 * iCalendar (RFC 5545) for a scheduled meeting: one VEVENT, built in the page
 * and downloaded, never uploaded. Times are UTC ("Z"), text is escaped, lines
 * end in CRLF and are folded at 75 octets.
 */
import type { Meeting } from "./meetings";

export interface IcsEvent {
  uid: string;
  /** When the file is made, ms since the epoch. */
  stamp: number;
  start: number;
  end: number;
  summary: string;
  description: string;
  url: string;
}

const MAX_OCTETS = 75;
const utf8 = new TextEncoder();

/** `20261016T090000Z`. */
export function icsTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** TEXT value escaping: backslash, semicolon, comma, and newlines as `\n`. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** Splits a content line into lines of at most 75 octets, never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = "";
  let octets = 0;
  for (const ch of line) {
    const n = utf8.encode(ch).length;
    if (octets + n > MAX_OCTETS) {
      out.push(cur);
      // A continuation line starts with one space, which counts.
      cur = " ";
      octets = 1;
    }
    cur += ch;
    octets += n;
  }
  out.push(cur);
  return out.join("\r\n");
}

export function buildIcs(e: IcsEvent): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Veil//Scheduled meeting//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${icsTime(e.stamp)}`,
    `DTSTART:${icsTime(e.start)}`,
    `DTEND:${icsTime(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    `DESCRIPTION:${escapeText(e.description)}`,
    // URL is a URI value, not TEXT: it is not escaped.
    `URL:${e.url}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

export const DEFAULT_TITLE = "Veil meeting";

export function meetingIcs(m: Meeting, stamp: number = Date.now()): string {
  return buildIcs({
    uid: `${m.id}@veil`,
    stamp,
    start: m.start,
    end: m.start + m.minutes * 60_000,
    summary: m.title || DEFAULT_TITLE,
    description: `Join: ${m.link}\nThe link is the key to the room: share it only with attendees.`,
    url: m.link,
  });
}

/** A file name from the title, ASCII only. */
export function icsFileName(m: Meeting): string {
  const slug = m.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return `${slug || "veil-meeting"}.ics`;
}

/** Saves the meeting's .ics: made in the page, handed to the browser as a download. */
export function downloadIcs(m: Meeting): void {
  const url = URL.createObjectURL(
    new Blob([meetingIcs(m)], { type: "text/calendar;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = icsFileName(m);
  a.click();
  // The download has started by then.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
