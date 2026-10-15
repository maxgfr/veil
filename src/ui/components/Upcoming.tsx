/** The meetings scheduled on this device, soonest first. Renders nothing when there are none. */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { parseRoomMode } from "../../crypto/room";
import { DEFAULT_TITLE, downloadIcs } from "../ics";
import { type Meeting, meetingStatus, meetings, removeMeeting } from "../meetings";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icons";

const whenFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** "45 min", "1 h", "1 h 30 min". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const r = minutes % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** "Fri 16 Oct, 09:00 · 30 min", in the user's locale and time zone. */
export function meetingWhen(m: Meeting): string {
  return `${whenFormat.format(m.start)} · ${durationLabel(m.minutes)}`;
}

export function Upcoming(props: { onJoin: (link: string) => void }): JSX.Element | null {
  const list = meetings.value;
  const [now, setNow] = useState(Date.now);
  const any = list.length > 0;
  // "Starts in N min" and "Now" follow the clock.
  useEffect(() => {
    if (!any) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, [any]);
  if (!any) return null;
  return (
    <section class="card upcoming" aria-labelledby="upcoming-title" data-testid="upcoming">
      <h2 id="upcoming-title" class="upcoming-title">
        Upcoming
      </h2>
      <ul class="meetings">
        {list.map((m) => (
          <MeetingRow key={m.id} meeting={m} now={now} onJoin={props.onJoin} />
        ))}
      </ul>
    </section>
  );
}

function MeetingRow(props: {
  meeting: Meeting;
  now: number;
  onJoin: (link: string) => void;
}): JSX.Element {
  const m = props.meeting;
  const status = meetingStatus(m, props.now);
  const titleId = `meeting-${m.id}`;
  return (
    <li class="meeting" data-testid="meeting">
      <div class="meeting-main">
        <span class="meeting-title" id={titleId} data-testid="meeting-title">
          {m.title || DEFAULT_TITLE}
        </span>
        <span class="muted small tabular" data-testid="meeting-when">
          {meetingWhen(m)}
          {parseRoomMode(m.link) === "files" && " · Files"}
        </span>
        {status && status.kind !== "ended" && (
          <span class="chip chip-ok meeting-status" data-testid="meeting-status">
            {status.kind === "now" ? "Now" : `Starts in ${status.minutes} min`}
          </span>
        )}
        {status?.kind === "ended" && (
          <span class="muted small" data-testid="meeting-status">
            Ended
          </span>
        )}
      </div>
      <div class="meeting-actions">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          aria-describedby={titleId}
          data-testid="meeting-join"
          onClick={() => props.onJoin(m.link)}
        >
          Join
        </button>
        <CopyButton
          text={m.link}
          class="btn btn-ghost btn-sm"
          describedby={titleId}
          testid="meeting-copy"
        />
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          aria-describedby={titleId}
          data-testid="meeting-ics"
          onClick={() => downloadIcs(m)}
        >
          <Icon name="calendar" size={18} />
          .ics
        </button>
        <button
          type="button"
          class="icon-btn meeting-remove"
          aria-label="Remove"
          aria-describedby={titleId}
          data-testid="meeting-remove"
          onClick={() => removeMeeting(m.id)}
        >
          <Icon name="x" size={18} />
        </button>
      </div>
    </li>
  );
}
