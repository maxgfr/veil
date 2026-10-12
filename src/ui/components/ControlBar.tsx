import type { JSX } from "preact";
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

export function ControlBar(props: {
  session: RoomSession;
  chatOpen: boolean;
  onToggleChat: () => void;
  onLeave: () => void;
}): JSX.Element {
  const s = props.session;
  const m = s.media;
  const canScreen = typeof navigator.mediaDevices?.getDisplayMedia === "function";
  return (
    <nav class="controls" aria-label="Call controls">
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
      <Control
        icon="chat"
        label={props.chatOpen ? "Hide chat" : "Show chat"}
        pressed={props.chatOpen}
        badge={s.unread.value}
        onClick={props.onToggleChat}
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
