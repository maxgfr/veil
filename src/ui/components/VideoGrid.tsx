import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { MemberView, RoomSession } from "../session";
import { hueOf, initials } from "./format";
import { Icon } from "./Icons";

function Video(props: {
  stream: MediaStream;
  muted: boolean;
  mirror: boolean;
  testid: string;
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== props.stream) v.srcObject = props.stream;
  }, [props.stream]);
  return (
    <video
      ref={ref}
      class={props.mirror ? "mirror" : undefined}
      autoPlay
      playsInline
      muted={props.muted}
      data-testid={props.testid}
    />
  );
}

function AudioOut(props: { stream: MediaStream }): JSX.Element {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (a && a.srcObject !== props.stream) a.srcObject = props.stream;
  }, [props.stream]);
  return <audio ref={ref} autoPlay />;
}

export function VideoGrid(props: { session: RoomSession; members: MemberView[] }): JSX.Element {
  const s = props.session;
  const tiles = props.members.filter(
    (m) =>
      m.self || m.media.audio || m.media.video || m.media.screen || s.media.remote.has(m.peerId),
  );
  const n = tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return (
    <div class="grid" style={{ "--cols": String(cols) }} data-count={n}>
      {tiles.map((m) => {
        const remote = s.media.remote.get(m.peerId);
        const stream = m.self ? s.media.preview : remote?.stream;
        const videoTrack = stream?.getVideoTracks()[0];
        const showVideo =
          !!stream &&
          !!videoTrack &&
          (m.self
            ? m.media.video || m.media.screen
            : (m.media.video || m.media.screen) &&
              !videoTrack.muted &&
              (remote?.wantVideo ?? true));
        return (
          <figure
            key={m.peerId}
            class={`tile${m.speaking ? " speaking" : ""}`}
            data-testid={m.self ? "tile-self" : "tile-remote"}
          >
            {showVideo && stream ? (
              <Video
                stream={stream}
                muted={m.self}
                mirror={m.self && !m.media.screen}
                testid={m.self ? "video-self" : "video-remote"}
              />
            ) : (
              <div
                class="avatar avatar-lg"
                style={{ "--hue": String(hueOf(m.peerId)) }}
                aria-hidden="true"
              >
                {initials(m.nick)}
              </div>
            )}
            {!m.self && remote && <AudioOut stream={remote.stream} />}
            <figcaption class="tile-label">
              {!m.media.audio && <Icon name="micOff" size={14} label="Muted" />}
              <span>{m.self ? `${m.nick} (you)` : m.nick}</span>
              {m.media.screen && <span class="chip">Screen</span>}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
