/** The files of a finished recording, saved from private storage with a click. */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  type CaptionLine,
  formatTranscript,
  pickMime,
  type RecordingPart,
  recordingNames,
} from "../../features/recorder";
import { baseLang, languageName, myLang } from "../language";
import type { RecordingFiles } from "../session";
import { Icon } from "./Icons";
import { Sheet } from "./Sheet";

const PARTS: { part: RecordingPart; label: string }[] = [
  { part: "video", label: "Video with everyone's sound" },
  { part: "audio", label: "Audio only" },
  { part: "transcript", label: "Transcript" },
];

/** The recorder picks the same MIME type, so the extension matches the file. */
function fileName(started: number, part: RecordingPart): string {
  const mime =
    part === "transcript" || typeof MediaRecorder === "undefined"
      ? ""
      : (pickMime((m) => MediaRecorder.isTypeSupported(m), part) ?? "");
  return recordingNames(new Date(started), part, mime);
}

/** "veil-meeting-….txt" → "veil-meeting-….<suffix>". */
function derivedName(started: number, suffix: string): string {
  return recordingNames(new Date(started), "transcript").replace(/\.txt$/, `.${suffix}`);
}

type Made =
  | { state: "idle" }
  | { state: "running"; preview: string }
  | { state: "done"; url: string; preview: string }
  | { state: "none" }
  | { state: "error"; message: string };

/** Object URLs made here, released when the sheet closes. */
function useUrls(): (blob: Blob) => string {
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current = [];
    },
    [],
  );
  return (blob) => {
    const url = URL.createObjectURL(blob);
    urls.current.push(url);
    return url;
  };
}

export function RecordingSheet(props: {
  files: RecordingFiles | null;
  /** What was said during the recording, for the notes and the translation. */
  lines: CaptionLine[];
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
                    <span class="muted small">
                      {url
                        ? name
                        : part === "transcript"
                          ? "Nothing was transcribed"
                          : "Not available"}
                    </span>
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
            <AiRows key={f.started} started={f.started} lines={props.lines} />
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

/** Meeting notes and a translated transcript, from the browser's built-in models. */
function AiRows(props: { started: number; lines: CaptionLine[] }): JSX.Element | null {
  const said = props.lines.some((l) => l.text !== null);
  const mine = myLang();
  const foreign = props.lines.some(
    (l) => l.text !== null && l.lang !== undefined && baseLang(l.lang) !== mine,
  );
  const [canSummarize, setCanSummarize] = useState<boolean | null>(null);
  const [summary, setSummary] = useState<Made>({ state: "idle" });
  const [translated, setTranslated] = useState<Made>({ state: "idle" });
  const abort = useRef<AbortController | null>(null);
  const urlOf = useUrls();

  useEffect(() => {
    if (!said) return;
    let live = true;
    void (async () => {
      const { summaryAvailable } = await import("../../ai/tasks");
      const ok = await summaryAvailable();
      if (live) setCanSummarize(ok);
    })().catch((err) => {
      console.warn("summary check failed", err);
      if (live) setCanSummarize(false);
    });
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [said]);

  if (!said) return null;

  const summarize = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setSummary({ state: "running", preview: "" });
    try {
      const { summarizeMeeting } = await import("../../ai/tasks");
      const out = await summarizeMeeting(props.lines, mine, {
        signal: ctl.signal,
        onPartial: (preview) => setSummary({ state: "running", preview }),
      });
      if (ctl.signal.aborted) return;
      if (!out) {
        setSummary({ state: "none" });
        return;
      }
      const url = urlOf(new Blob([out.markdown], { type: "text/markdown" }));
      setSummary({ state: "done", url, preview: out.markdown });
    } catch (err) {
      if (ctl.signal.aborted) return;
      setSummary({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const translate = async () => {
    setTranslated({ state: "running", preview: "" });
    try {
      const { transcriptIn } = await import("../../ai/tasks");
      const out = await transcriptIn(props.lines, mine);
      if (!out) {
        setTranslated({ state: "none" });
        return;
      }
      const text = formatTranscript(props.started, out);
      const url = urlOf(new Blob([text], { type: "text/plain" }));
      setTranslated({ state: "done", url, preview: "" });
    } catch (err) {
      setTranslated({ state: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const summaryName = derivedName(props.started, "notes.md");
  const translatedName = derivedName(props.started, `${mine}.txt`);

  return (
    <>
      {canSummarize !== null && (
        <li class="recording-ai" data-testid="recording-summary">
          <span class="recording-file">
            <span>Meeting notes</span>
            <span class="muted small" role="status">
              {summary.state === "running"
                ? "Summarizing on this device…"
                : summary.state === "done"
                  ? summaryName
                  : summary.state === "error"
                    ? `Couldn't summarize: ${summary.message}`
                    : summary.state === "none" || !canSummarize
                      ? "This browser has no built-in summarizer"
                      : "The key points, made on this device"}
            </span>
          </span>
          {summary.state === "done" ? (
            <a
              class="btn btn-secondary btn-sm"
              href={summary.url}
              download={summaryName}
              data-testid="recording-summary-save"
            >
              <Icon name="download" size={16} />
              Save
            </a>
          ) : summary.state === "none" || !canSummarize ? null : (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={summary.state === "running"}
              onClick={() => void summarize()}
              data-testid="recording-summarize"
            >
              <Icon name="sparkle" size={16} />
              Summarize
            </button>
          )}
          {(summary.state === "running" || summary.state === "done") && summary.preview && (
            <pre class="recording-preview">{summary.preview}</pre>
          )}
        </li>
      )}
      {foreign && (
        <li class="recording-ai" data-testid="recording-translated">
          <span class="recording-file">
            <span>Transcript in {languageName(mine)}</span>
            <span class="muted small" role="status">
              {translated.state === "running"
                ? "Translating on this device…"
                : translated.state === "done"
                  ? translatedName
                  : translated.state === "error"
                    ? `Couldn't translate: ${translated.message}`
                    : translated.state === "none"
                      ? "This browser has no built-in translator"
                      : "Lines in other languages, translated"}
            </span>
          </span>
          {translated.state === "done" ? (
            <a
              class="btn btn-secondary btn-sm"
              href={translated.url}
              download={translatedName}
              data-testid="recording-translated-save"
            >
              <Icon name="download" size={16} />
              Save
            </a>
          ) : translated.state === "none" ? null : (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              disabled={translated.state === "running"}
              onClick={() => void translate()}
            >
              Translate
            </button>
          )}
        </li>
      )}
    </>
  );
}
