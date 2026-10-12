import type { JSX } from "preact";
import type { FileView, RoomSession } from "../session";
import { formatBytes } from "./format";
import { Icon } from "./Icons";

const IN_LABEL: Record<string, string> = {
  offered: "Wants to send you a file",
  waiting: "Connecting…",
  receiving: "Receiving",
  paused: "Paused, reconnecting…",
  verifying: "Checking integrity…",
  done: "Received and verified",
  failed: "Failed",
  declined: "Declined",
  cancelled: "Cancelled",
};

export function FileCard(props: { view: FileView; session: RoomSession }): JSX.Element {
  const { view, session } = props;
  const f = view.file;
  let pct = 0;
  let status = "";
  let actions: JSX.Element | null = null;

  if (view.dir === "in") {
    const inc = view.file;
    pct = inc.size ? (inc.received / inc.size) * 100 : inc.state === "done" ? 100 : 0;
    status = inc.error ?? IN_LABEL[inc.state] ?? inc.state;
    if (inc.state === "receiving" && inc.rate > 0) status += ` · ${formatBytes(inc.rate)}/s`;
    if (inc.state === "offered") {
      actions = (
        <>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => session.files.decline(inc.id)}
          >
            Decline
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            data-testid="file-accept"
            onClick={() => void session.acceptFile(inc.id)}
          >
            Accept
          </button>
        </>
      );
    } else if (inc.state === "done" && inc.url) {
      actions = (
        <a
          class="btn btn-secondary btn-sm"
          href={inc.url}
          download={inc.name}
          data-testid="file-save"
        >
          <Icon name="download" size={16} />
          Save
        </a>
      );
    } else if (["waiting", "receiving", "paused"].includes(inc.state)) {
      actions = (
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void session.files.cancelIncoming(inc.id)}
        >
          Cancel
        </button>
      );
    }
  } else {
    const out = view.file;
    const progress = [...out.progress.values()];
    const best = progress.length ? Math.max(...progress) : 0;
    pct = out.size ? (best / out.size) * 100 : 0;
    status = out.cancelled
      ? "Cancelled"
      : out.done.size
        ? `Delivered to ${out.done.size}`
        : progress.length
          ? "Sending"
          : "Offered to the room";
    if (!out.cancelled && out.done.size === 0) {
      actions = (
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          onClick={() => void session.files.cancelOutgoing(out.id)}
        >
          Cancel
        </button>
      );
    }
  }

  const active =
    view.dir === "in"
      ? ["receiving", "verifying", "paused"].includes(view.file.state)
      : pct > 0 && pct < 100;
  return (
    <div
      class="file-card"
      data-testid="file-card"
      data-state={view.dir === "in" ? view.file.state : "out"}
    >
      <div class="file-icon">
        <Icon name="file" size={22} />
      </div>
      <div class="file-main">
        <div class="file-name" title={f.name}>
          {f.name}
        </div>
        <div class="file-meta">
          <span class="tabular">{formatBytes(f.size)}</span>
          <span class="file-status">{status}</span>
        </div>
        {active && (
          <div
            class="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
          >
            <div class="progress-bar" style={{ transform: `scaleX(${Math.min(1, pct / 100)})` }} />
          </div>
        )}
      </div>
      {actions && <div class="file-actions">{actions}</div>}
    </div>
  );
}
