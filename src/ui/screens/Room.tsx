import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { openAiSettings } from "../../ai/store";
import type { RoomMode } from "../../crypto/room";
import { ChatPanel } from "../components/ChatPanel";
import { ConnectionSheet } from "../components/ConnectionSheet";
import { ControlBar, type SidePanel } from "../components/ControlBar";
import { FilesPanel } from "../components/FilesPanel";
import { hueOf, initials } from "../components/format";
import { Icon } from "../components/Icons";
import { LiveCaptions } from "../components/LiveCaptions";
import { RecordingSheet } from "../components/RecordingSheet";
import { SettingsSheet } from "../components/SettingsSheet";
import { ShareSheet } from "../components/ShareSheet";
import { Sheet } from "../components/Sheet";
import { Stage } from "../components/Spotlight";
import { Toasts } from "../components/Toast";
import { VerifySheet } from "../components/VerifySheet";
import { browserOnline, connectionSummary, LINK_LABEL } from "../connection";
import type { MemberView, RecordingFiles, RoomSession } from "../session";

/** "Ada", "Ada and Bob", "Ada, Bob and Cy". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function wideScreen(): boolean {
  return typeof matchMedia === "function" && matchMedia("(min-width: 900px)").matches;
}

export function Room(props: {
  session: RoomSession;
  link: string;
  mode: RoomMode;
  onLeave: () => void;
}): JSX.Element {
  const s = props.session;
  s.tick.value;
  const files = props.mode === "files";
  // A files room keeps the Files view uncluttered: chat is one button away.
  const [side, setSide] = useState<SidePanel>(() => (!files && wideScreen() ? "chat" : null));
  const [share, setShare] = useState(false);
  const [people, setPeople] = useState(false);
  const [connection, setConnection] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [verify, setVerify] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recordingFiles, setRecordingFiles] = useState<RecordingFiles | null>(null);
  const [leaveAfterRecording, setLeaveAfterRecording] = useState(false);
  // The tile in large, `${peerId}:camera` or `${peerId}:screen`: yours alone, never sent.
  const [pinned, setPinned] = useState<string | null>(null);

  const members = s.members();
  const others = members.filter((m) => !m.self);
  // A files room never shows the call stage, even if someone else has a camera on.
  const inCall = !files && members.some((m) => m.media.audio || m.media.video || m.media.screen);
  const netOnline = browserOnline.value;
  const summary = connectionSummary({ online: netOnline, transports: s.transports, others });
  const count = others.length === 0 ? "Waiting for others" : `${others.length + 1} in the room`;
  const online = s.transports.filter((t) => t.state === "online").map((t) => t.name);
  const e2eeMedia = inCall && s.mediaE2ee();
  const recorders = members.filter((m) => m.media.recording).map((m) => m.nick);
  const captioners = files ? [] : members.filter((m) => m.media.captions).map((m) => m.nick);

  const toggleRecording = async () => {
    if (s.recording.value === "idle") {
      return s.startRecording();
    }
    const done = await s.stopRecording();
    if (done) showRecording(done);
  };

  const showRecording = (done: RecordingFiles) => setRecordingFiles(done);

  // Leaving while recording stops it first and offers the files before going.
  const leave = async () => {
    if (s.recording.value !== "idle") {
      const done = await s.stopRecording();
      if (done) {
        showRecording(done);
        setLeaveAfterRecording(true);
        return;
      }
    }
    props.onLeave();
  };

  useEffect(() => {
    const leave = () => void s.leave();
    addEventListener("pagehide", leave);
    return () => removeEventListener("pagehide", leave);
  }, [s]);

  // Drop files anywhere in the room to share them.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      const files = e.dataTransfer?.files;
      if (files?.length) {
        void s.offerFiles([...files]);
        if (props.mode === "call") setSide("files");
      }
    };
    addEventListener("dragover", over);
    addEventListener("dragleave", leave);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragover", over);
      removeEventListener("dragleave", leave);
      removeEventListener("drop", drop);
    };
  }, [s, props.mode]);

  // Escape puts a pinned tile back, unless something else (a sheet, a menu) took the key.
  useEffect(() => {
    if (!pinned) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector("dialog[open]"))
        setPinned(null);
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [pinned]);

  // Open the invite sheet right away when you are alone in a brand-new room.
  useEffect(() => {
    const t = setTimeout(() => {
      if (s.room.members.size === 0) setShare(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [s]);

  return (
    <div
      class={`room room-${props.mode}${side ? " chat-open" : ""}${dragging ? " dragging" : ""}`}
      data-testid="room"
      data-mode={props.mode}
      data-peer-id={s.peerId}
      data-key-id={String(s.room.keys.keyId)}
      data-members={String(others.length)}
      data-links={String(s.room.readyIds().length)}
      data-mic-device={s.media.activeDeviceId("audio")}
      data-cam-device={s.media.activeDeviceId("video")}
    >
      <header class="room-head">
        <div class="room-id" title={`Room ${s.badgeNames.join(" · ")}`}>
          <span class="room-badge" role="img" aria-label={`Room ${s.badgeNames.join(", ")}`}>
            {s.badge.join("")}
          </span>
          <button
            type="button"
            class="status"
            onClick={() => setConnection(true)}
            aria-label={`${count} · ${summary.label}`}
            data-state={summary.tone}
            data-testid="status"
          >
            <span class={`dot dot-${summary.tone}`} aria-hidden="true" />
            <span class="tabular">
              {count}
              <span class="hide-sm"> · {summary.label}</span>
            </span>
          </button>
          {files && (
            <span
              class="chip chip-ok hide-sm"
              title="A room for sending files: no camera or microphone"
            >
              <Icon name="file" size={14} />
              Files
            </span>
          )}
          {recorders.length > 0 && (
            <span
              class="chip chip-rec"
              role="img"
              aria-label={`${joinNames(recorders)} ${recorders.length > 1 ? "are" : "is"} recording`}
              title={`${joinNames(recorders)} ${recorders.length > 1 ? "are" : "is"} recording`}
              data-testid="rec-indicator"
            >
              <span class="rec-dot" aria-hidden="true" />
              REC
            </span>
          )}
          {captioners.length > 0 && (
            <span
              class="chip chip-cc"
              role="img"
              aria-label={`Captions on for ${joinNames(captioners)}`}
              title={`Captions on for ${joinNames(captioners)}`}
              data-testid="captions-indicator"
            >
              <Icon name="captions" size={14} />
              CC
            </span>
          )}
          {e2eeMedia && (
            <span
              class="chip chip-ok"
              data-testid="e2ee-badge"
              title="Audio and video frames are encrypted end to end"
            >
              <Icon name="shield" size={14} />
              E2EE media
            </span>
          )}
        </div>
        <div class="room-actions">
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onClick={() => setShare(true)}
            data-testid="invite"
          >
            <Icon name="share" size={16} />
            <span class="hide-sm">Invite</span>
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="People"
            onClick={() => setPeople(true)}
          >
            <Icon name="users" />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="settings" />
          </button>
        </div>
      </header>

      {!netOnline ? (
        <div class="banner banner-bad" role="status" data-testid="offline">
          <Icon name="wifi" size={18} />
          <span>You're offline. The room reconnects when the network comes back.</span>
        </div>
      ) : (
        s.connectivityHint && (
          <div class="banner banner-warn" role="status">
            <Icon name="alert" size={18} />
            <span>{s.connectivityHint}</span>
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              onClick={() => setSettingsOpen(true)}
            >
              Settings
            </button>
          </div>
        )
      )}

      <main class="stage">
        {files ? (
          <FilesPanel session={s} variant="main" onInvite={() => setShare(true)} />
        ) : inCall ? (
          <Stage session={s} members={members} pinned={pinned} onPin={setPinned} />
        ) : (
          <div class="empty-stage">
            {others.length === 0 ? (
              <>
                <div class="pulse" aria-hidden="true">
                  <Icon name="wifi" size={28} />
                </div>
                <h2>Waiting for others to join</h2>
                <p class="muted">
                  Share the link. People who open it connect to you directly.
                  {online.length === 0 &&
                    s.transports.length > 0 &&
                    " Still reaching the rendezvous relays…"}
                </p>
                <button type="button" class="btn btn-primary" onClick={() => setShare(true)}>
                  <Icon name="share" size={18} />
                  Invite people
                </button>
              </>
            ) : (
              <>
                <ul class="avatars" aria-label="People in the room">
                  {members.slice(0, 8).map((m) => (
                    <li
                      key={m.peerId}
                      class="avatar"
                      style={{ "--hue": String(hueOf(m.peerId)) }}
                      title={m.nick}
                    >
                      {initials(m.nick)}
                    </li>
                  ))}
                </ul>
                <h2>No one is on a call</h2>
                <p class="muted">
                  Turn on your microphone or camera to start one. You can keep chatting either way.
                </p>
              </>
            )}
          </div>
        )}
        {!files && <LiveCaptions session={s} />}
      </main>

      <aside class="side" aria-hidden={!side}>
        {side === "chat" && <ChatPanel session={s} onClose={() => setSide(null)} />}
        {side === "files" && (
          <FilesPanel session={s} variant="side" onClose={() => setSide(null)} />
        )}
      </aside>

      <ControlBar
        session={s}
        mode={props.mode}
        side={side}
        onSide={setSide}
        onRecord={() => void toggleRecording()}
        onLeave={() => void leave()}
      />

      {dragging && (
        <div class="drop-overlay" aria-hidden="true">
          <Icon name="attach" size={32} />
          <span>Drop to share with the room</span>
        </div>
      )}

      <ShareSheet
        open={share}
        onClose={() => setShare(false)}
        link={props.link}
        hasPassphrase={!!s.params.passphrase}
        session={s}
      />
      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        inRoom
        session={s}
      />
      <VerifySheet peerId={verify} session={s} onClose={() => setVerify(null)} />
      <Sheet open={people} onClose={() => setPeople(false)} title="People" testid="people-sheet">
        <PeopleList
          members={members}
          onVerify={(id) => {
            setPeople(false);
            setVerify(id);
          }}
        />
      </Sheet>
      <ConnectionSheet
        open={connection}
        onClose={() => setConnection(false)}
        session={s}
        others={others}
        online={netOnline}
        summary={summary}
      />
      <RecordingSheet
        files={recordingFiles}
        lines={recordingFiles?.lines ?? []}
        onSetupAi={() => {
          openAiSettings();
          setSettingsOpen(true);
        }}
        onClose={() => {
          setRecordingFiles(null);
          setLeaveAfterRecording(false);
        }}
        onLeave={leaveAfterRecording ? props.onLeave : undefined}
      />
      <Toasts toasts={s.toasts} />
    </div>
  );
}

function PeopleList(props: { members: MemberView[]; onVerify: (id: string) => void }): JSX.Element {
  return (
    <ul class="people">
      {props.members.map((m) => (
        <li key={m.peerId} class="person" data-testid="person">
          <span class="avatar" style={{ "--hue": String(hueOf(m.peerId)) }} aria-hidden="true">
            {initials(m.nick)}
          </span>
          <span class="person-main">
            <span class="person-name">
              {m.nick}
              {m.self && <span class="muted"> (you)</span>}
            </span>
            <span class="person-meta">
              {m.self
                ? "This device"
                : m.blocked
                  ? "Verification failed · disconnected"
                  : m.link
                    ? `${LINK_LABEL[m.link] ?? m.link}${m.rtt !== null && m.link === "connected" ? ` · ${m.rtt} ms` : ""}${m.relayed ? " · via TURN" : ""}`
                    : "Reached through the mesh"}
            </span>
          </span>
          {!m.self && m.link === "connected" && (
            <button
              type="button"
              class={`btn btn-sm ${m.verified ? "btn-verified" : "btn-secondary"}`}
              onClick={() => props.onVerify(m.peerId)}
              data-testid="verify"
            >
              <Icon name={m.verified ? "check" : "shield"} size={16} />
              {m.verified ? "Verified" : "Verify"}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
