/**
 * Every file offered in the room, incoming and outgoing, with their progress,
 * plus a drop zone. The main view of a files room, and a side panel in calls.
 */
import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { RoomSession } from "../session";
import { FileCard } from "./FileCard";
import { formatTime } from "./format";
import { Icon } from "./Icons";

export function FilesPanel(props: {
  session: RoomSession;
  variant: "main" | "side";
  onClose?: () => void;
  onInvite?: () => void;
}): JSX.Element {
  const s = props.session;
  s.tick.value;
  const input = useRef<HTMLInputElement>(null);
  const entries = s.fileEntries();
  const others = s.room.members.size;

  useEffect(() => {
    s.setFilesVisible(true);
    return () => s.setFilesVisible(false);
  }, [s]);

  return (
    <section class={`files files-${props.variant}`} aria-label="Files" data-testid="files-panel">
      {props.variant === "side" && (
        <header class="panel-head">
          <h2>Files</h2>
          {props.onClose && (
            <button type="button" class="icon-btn" onClick={props.onClose} aria-label="Close files">
              <Icon name="x" />
            </button>
          )}
        </header>
      )}
      <div class="files-body">
        <button
          type="button"
          class="dropzone"
          onClick={() => input.current?.click()}
          data-testid="dropzone"
        >
          <span class="dropzone-icon" aria-hidden="true">
            <Icon name="attach" size={24} />
          </span>
          <span class="dropzone-title">Choose files or drop them here</span>
          <span class="dropzone-hint">
            Any size. They go straight from your device to each person who accepts them, end-to-end
            encrypted.
          </span>
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          data-testid="files-input"
          onChange={(e) => {
            const files = e.currentTarget.files;
            if (files?.length) void s.offerFiles([...files]);
            e.currentTarget.value = "";
          }}
        />
        {props.variant === "main" && others === 0 && (
          <div class="files-alone">
            <span>Nobody can receive yet: invite people with the room link.</span>
            {props.onInvite && (
              <button type="button" class="btn btn-secondary btn-sm" onClick={props.onInvite}>
                <Icon name="share" size={16} />
                Invite
              </button>
            )}
          </div>
        )}
        {entries.length === 0 ? (
          <p class="files-empty">No files yet. Files sent to the room appear here.</p>
        ) : (
          <ul class="file-list" data-testid="file-list">
            {entries.map((e) => {
              const view = s.fileView(e.fileId);
              if (!view) return null;
              return (
                <li key={e.fileId} class="file-entry">
                  <div class="file-entry-head">
                    <span>{e.mine ? "You" : `From ${s.nickOf(e.author)}`}</span>
                    <time class="tabular">{formatTime(e.ts)}</time>
                  </div>
                  <FileCard view={view} session={s} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
