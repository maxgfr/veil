import type { JSX } from "preact";
import { useRef } from "preact/hooks";
import type { RoomMode } from "../../crypto/room";
import type { RoomSession } from "../session";
import { Icon, type IconName } from "./Icons";

function Control(props: {
  icon: IconName;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "off" | "danger" | "on" | undefined;
  badge?: number;
  testid?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      class={`control${props.tone ? ` control-${props.tone}` : ""}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      onClick={props.onClick}
      data-testid={props.testid}
    >
      <Icon name={props.icon} size={22} />
      {!!props.badge && <span class="badge tabular">{props.badge > 99 ? "99+" : props.badge}</span>}
    </button>
  );
}

export type SidePanel = "chat" | "files" | null;

export function ControlBar(props: {
  session: RoomSession;
  mode: RoomMode;
  side: SidePanel;
  onSide: (side: SidePanel) => void;
  onRecord: () => void;
  onLeave: () => void;
}): JSX.Element {
  const s = props.session;
  const m = s.media;
  const canScreen = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const canRecord = typeof MediaRecorder !== "undefined";
  const recording = s.recording.value !== "idle";
  const input = useRef<HTMLInputElement>(null);
  const toggle = (panel: Exclude<SidePanel, null>) =>
    props.onSide(props.side === panel ? null : panel);
  return (
    <nav class="controls" aria-label={props.mode === "files" ? "Room controls" : "Call controls"}>
      {props.mode === "call" ? (
        <>
          <Control
            icon={m.micOn ? "mic" : "micOff"}
            label={m.micOn ? "Mute microphone" : "Unmute microphone"}
            pressed={m.micOn}
            tone={m.micOn ? "on" : "off"}
            onClick={() => void s.toggleMic()}
            testid="toggle-mic"
          />
          <Control
            icon={m.camOn ? "cam" : "camOff"}
            label={m.camOn ? "Turn camera off" : "Turn camera on"}
            pressed={m.camOn}
            tone={m.camOn ? "on" : "off"}
            onClick={() => void s.toggleCam()}
            testid="toggle-cam"
          />
          {canScreen && (
            <Control
              icon="screen"
              label={m.screenOn ? "Stop sharing screen" : "Share screen"}
              pressed={m.screenOn}
              tone={m.screenOn ? "on" : undefined}
              onClick={() => void s.toggleScreen()}
            />
          )}
          {canRecord && (
            <Control
              icon="record"
              label={recording ? "Stop recording" : "Start recording"}
              pressed={recording}
              tone={recording ? "danger" : undefined}
              onClick={props.onRecord}
              testid="toggle-record"
            />
          )}
          <Control
            icon="captions"
            label={s.captionsOn.value ? "Turn captions off" : "Turn captions on"}
            pressed={s.captionsOn.value}
            tone={s.captionsOn.value ? "on" : undefined}
            onClick={() => s.toggleCaptions()}
            testid="toggle-captions"
          />
          <Control
            icon="file"
            label={props.side === "files" ? "Hide files" : "Show files"}
            pressed={props.side === "files"}
            badge={s.pendingFiles.value}
            onClick={() => toggle("files")}
            testid="toggle-files"
          />
        </>
      ) : (
        <>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = e.currentTarget.files;
              if (files?.length) void s.offerFiles([...files]);
              e.currentTarget.value = "";
            }}
          />
          <Control
            icon="attach"
            label="Send files"
            onClick={() => input.current?.click()}
            testid="add-files"
          />
        </>
      )}
      <Control
        icon="chat"
        label={props.side === "chat" ? "Hide chat" : "Show chat"}
        pressed={props.side === "chat"}
        badge={s.unread.value}
        onClick={() => toggle("chat")}
        testid="toggle-chat"
      />
      <Control
        icon="leave"
        label="Leave room"
        tone="danger"
        onClick={props.onLeave}
        testid="leave"
      />
    </nav>
  );
}
