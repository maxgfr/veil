/** The files of a finished recording, saved from private storage with a click. */
import type { JSX } from "preact";
import { pickMime, type RecordingPart, recordingNames } from "../../features/recorder";
import type { RecordingFiles } from "../session";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

const PARTS: { part: RecordingPart; label: string }[] = [
  { part: "video", label: "Video with everyone's sound" },
  { part: "audio", label: "Audio only" },
];

/** The recorder picks the same MIME type, so the extension matches the file. */
function fileName(started: number, part: RecordingPart): string {
  const mime =
    typeof MediaRecorder === "undefined"
      ? ""
      : (pickMime((m) => MediaRecorder.isTypeSupported(m), part) ?? "");
  return recordingNames(new Date(started), part, mime);
}

export function RecordingSheet(props: {
  files: RecordingFiles | null;
  onClose: () => void;
  /** Set when the recording was stopped to leave the room. */
  onLeave?: (() => void) | undefined;
}): JSX.Element {
  const f = props.files;
  return (
    <Sheet open={!!f} onClose={props.onClose} title="Recording" testid="recording-sheet">
      {f && (
        <div class="stack">
          <p class="muted small">
            Saved on this device only. Download what you want to keep: the files are gone once you
            leave the room.
          </p>
          <ul class="recording-files">
            {PARTS.map(({ part, label }) => {
              const url = f[part];
              const name = fileName(f.started, part);
              return (
                <li key={part}>
                  <span class="recording-file">
                    <span>{label}</span>
                    <span class="muted small">{url ? name : "Not available"}</span>
                  </span>
                  {url && (
                    <a
                      class="btn btn-secondary btn-sm"
                      href={url}
                      download={name}
                      data-testid={`recording-${part}`}
                    >
                      <Icon name="download" size={16} />
                      Save
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
          {props.onLeave && (
            <button
              type="button"
              class="btn btn-primary"
              onClick={props.onLeave}
              data-testid="recording-leave"
            >
              Leave now
            </button>
          )}
        </div>
      )}
    </Sheet>
  );
}
