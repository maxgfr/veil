/**
 * "Schedule a meeting": a fresh room link for later, kept under Upcoming on
 * this device, with an .ics to put it in any calendar. The link is an ordinary
 * room link (the time and title never go into it). Loaded lazily by Home's
 * sheet.
 */
import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { RoomMode } from "../../crypto/room";
import { DEFAULT_TITLE, downloadIcs } from "../ics";
import {
  addMeeting,
  DEFAULT_DURATION,
  DURATIONS,
  localStart,
  MAX_MEETINGS,
  MAX_TITLE,
  type Meeting,
  meetingsSaved,
  newMeetingId,
} from "../meetings";
import { CopyButton } from "./CopyButton";
import { Icon } from "./Icons";
import { QrCode } from "./QrCode";
import { durationLabel, meetingWhen } from "./Upcoming";

const pad = (n: number) => String(n).padStart(2, "0");
const dateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The next full half hour, at least 5 minutes away. */
function nextSlot(now: number): Date {
  const step = 30 * 60_000;
  return new Date(Math.ceil((now + 5 * 60_000) / step) * step);
}

export function ScheduleMeeting(props: {
  /** A fresh room link, made like "New room" makes one. */
  newLink: (mode: RoomMode) => string;
  onClose: () => void;
}): JSX.Element {
  const [made, setMade] = useState<Meeting | null>(null);
  return made ? (
    <Scheduled meeting={made} onClose={props.onClose} />
  ) : (
    <ScheduleForm newLink={props.newLink} onMade={setMade} />
  );
}

function ScheduleForm(props: {
  newLink: (mode: RoomMode) => string;
  onMade: (m: Meeting) => void;
}): JSX.Element {
  const [slot] = useState(() => nextSlot(Date.now()));
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(() => dateInput(slot));
  const [time, setTime] = useState(() => timeInput(slot));
  const [minutes, setMinutes] = useState<number>(DEFAULT_DURATION);
  const [mode, setMode] = useState<RoomMode>("call");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const start = localStart(date, time);
    if (start === null) {
      setError("Pick a date and a start time.");
      return;
    }
    if (start <= Date.now()) {
      setError("Pick a start time in the future.");
      return;
    }
    const m: Meeting = {
      id: newMeetingId(),
      title: title.trim().slice(0, MAX_TITLE),
      start,
      minutes,
      link: props.newLink(mode),
    };
    if (!addMeeting(m)) {
      setError(`You already have ${MAX_MEETINGS} meetings scheduled. Remove one first.`);
      return;
    }
    props.onMade(m);
  };

  return (
    <form
      class="stack"
      noValidate
      data-testid="schedule-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label class="field">
        <span class="label">Title (optional)</span>
        <input
          class="input"
          value={title}
          maxLength={MAX_TITLE}
          placeholder="Veil meeting"
          autoComplete="off"
          data-testid="schedule-title"
          onInput={(e) => setTitle(e.currentTarget.value)}
        />
      </label>
      <div class="schedule-grid">
        <label class="field">
          <span class="label">Date</span>
          <input
            class="input"
            type="date"
            required
            value={date}
            min={dateInput(new Date())}
            data-testid="schedule-date"
            onInput={(e) => {
              setDate(e.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <label class="field">
          <span class="label">Start time</span>
          <input
            class="input"
            type="time"
            required
            value={time}
            data-testid="schedule-time"
            onInput={(e) => {
              setTime(e.currentTarget.value);
              setError(null);
            }}
          />
        </label>
        <label class="field">
          <span class="label">Duration</span>
          <select
            class="input"
            value={String(minutes)}
            data-testid="schedule-duration"
            onChange={(e) => setMinutes(Number(e.currentTarget.value))}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={String(d)}>
                {durationLabel(d)}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span class="label">Room</span>
          <select
            class="input"
            value={mode}
            data-testid="schedule-mode"
            onChange={(e) => setMode(e.currentTarget.value === "files" ? "files" : "call")}
          >
            <option value="call">Call</option>
            <option value="files">Files</option>
          </select>
        </label>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" class="btn btn-primary btn-block" data-testid="schedule-create">
        <Icon name="link" size={18} />
        Create link
      </button>
    </form>
  );
}

function Scheduled(props: { meeting: Meeting; onClose: () => void }): JSX.Element {
  const m = props.meeting;
  const canShare = typeof navigator.share === "function";
  return (
    <div class="stack" data-testid="schedule-done">
      <div class="stack-sm">
        <span class="meeting-title">{m.title || DEFAULT_TITLE}</span>
        <span class="muted small tabular">{meetingWhen(m)}</span>
      </div>
      {!meetingsSaved.value && (
        <p class="error" role="alert" data-testid="schedule-not-saved">
          This browser couldn't save the meeting on this device. Keep the link or the .ics file.
        </p>
      )}
      <div class="qr-wrap">
        <QrCode value={m.link} label="QR code of the meeting link" />
      </div>
      <div class="copy-row">
        <input
          class="input mono"
          readOnly
          value={m.link}
          aria-label="Meeting link"
          data-testid="schedule-link"
          onFocus={(e) => e.currentTarget.select()}
        />
        <CopyButton text={m.link} />
      </div>
      <button
        type="button"
        class="btn btn-primary btn-block"
        data-testid="schedule-ics"
        onClick={() => downloadIcs(m)}
      >
        <Icon name="calendar" size={18} />
        Add to calendar (.ics)
      </button>
      {canShare && (
        <button
          type="button"
          class="btn btn-secondary btn-block"
          onClick={() =>
            void navigator
              .share({ title: m.title || DEFAULT_TITLE, url: m.link })
              .catch((e: unknown) => {
                // Closing the share panel rejects with AbortError: nothing to report.
                if (!(e instanceof DOMException && e.name === "AbortError")) console.error(e);
              })
          }
        >
          <Icon name="share" size={18} />
          Share…
        </button>
      )}
      <p class="note">
        <Icon name="lock" size={16} />
        <span>
          The link is the key to the room: share it only with attendees. It works at any time, and
          it is saved under Upcoming on this device only.
        </span>
      </p>
      <button type="button" class="btn btn-ghost btn-block" onClick={props.onClose}>
        Done
      </button>
    </div>
  );
}
