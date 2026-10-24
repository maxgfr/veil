import type { JSX, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { MemberView, RoomSession } from "../session";
import type { VideoFit } from "../settings";
import { hueOf, initials } from "./format";
import { Icon } from "./Icons";

/** The ways a video can sit in its tile, each with the one a click moves to. */
export const FITS: Record<VideoFit, { label: string; hint: string; next: VideoFit }> = {
  contain: { label: "Fit", hint: "The whole picture, with bars", next: "cover" },
  cover: { label: "Fill", hint: "Fills the tile, crops the edges", next: "fill" },
  fill: { label: "Stretch", hint: "Fills the tile, stretches the picture", next: "contain" },
};

/** One thing on the stage: a member's camera, or a screen they share. */
export interface StageTile {
  /** `${peerId}:camera` or `${peerId}:screen`: the pin key. */
  key: string;
  member: MemberView;
  kind: "camera" | "screen";
  stream: MediaStream | null;
  /** The stream has a live video track worth showing. */
  live: boolean;
  /** The camera tile carries a screen (a peer without a separate screen track). */
  legacyScreen: boolean;
}

export function Video(props: {
  stream: MediaStream;
  muted: boolean;
  mirror: boolean;
  testid: string;
  fit: VideoFit;
  inner?: RefObject<HTMLVideoElement>;
}): JSX.Element {
  const own = useRef<HTMLVideoElement>(null);
  const ref = props.inner ?? own;
  useEffect(() => {
    const v = ref.current;
    if (v && v.srcObject !== props.stream) v.srcObject = props.stream;
  }, [props.stream, ref]);
  return (
    <video
      ref={ref}
      class={`fit-${props.fit}${props.mirror ? " mirror" : ""}`}
      autoPlay
      playsInline
      muted={props.muted}
      data-testid={props.testid}
      data-fit={props.fit}
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

/** Everyone's sound, kept apart from the tiles so a layout change never cuts it. */
export function RemoteAudio(props: { session: RoomSession; members: MemberView[] }): JSX.Element {
  const remote = props.session.media.remote;
  return (
    <>
      {props.members.map((m) => {
        const r = m.self ? undefined : remote.get(m.peerId);
        return r ? <AudioOut key={m.peerId} stream={r.stream} /> : null;
      })}
    </>
  );
}

/**
 * A camera tile for every member, even one with neither microphone nor camera
 * on (shown by their initials), then a tile per shared screen.
 */
export function stageTiles(s: RoomSession, members: MemberView[]): StageTile[] {
  const cameras: StageTile[] = [];
  const screens: StageTile[] = [];
  for (const m of members) {
    const remote = s.media.remote.get(m.peerId);
    const screen = m.self ? (s.media.screenOn ? s.media.screenStream : null) : remote?.screen;
    // A peer without a separate screen track sends its screen in place of the camera.
    const legacyScreen = !m.self && m.media.screen && !screen;
    const stream = m.self ? s.media.preview : (remote?.stream ?? null);
    const track = stream?.getVideoTracks()[0];
    const live =
      !!track &&
      (m.self
        ? m.media.video
        : (m.media.video || legacyScreen) && !track.muted && (remote?.wantVideo ?? true));
    cameras.push({
      key: `${m.peerId}:camera`,
      member: m,
      kind: "camera",
      stream,
      live,
      legacyScreen,
    });
    if (screen) {
      const t = screen.getVideoTracks()[0];
      screens.push({
        key: `${m.peerId}:screen`,
        member: m,
        kind: "screen",
        stream: screen,
        live: !!t && (m.self || !t.muted),
        legacyScreen: false,
      });
    }
  }
  return [...cameras, ...screens];
}

type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Fullscreen on the container, or on the bare <video> where only that works (iOS). */
export function toggleFullscreen(container: HTMLElement | null, video: HTMLVideoElement | null) {
  if (document.fullscreenElement) {
    void document.exitFullscreen();
    return;
  }
  const ios = (): boolean => {
    const v: IosVideo | null = video;
    if (!v?.webkitEnterFullscreen) return false;
    v.webkitEnterFullscreen();
    return true;
  };
  if (container && typeof container.requestFullscreen === "function") {
    container.requestFullscreen().catch((err: unknown) => {
      if (!ios()) console.warn("Fullscreen was refused", err);
    });
  } else if (!ios()) {
    console.warn("Fullscreen is not available here");
  }
}

function Tile(props: {
  tile: StageTile;
  fit: VideoFit;
  pinned: boolean;
  onPin: (key: string | null) => void;
}): JSX.Element {
  const { tile, pinned } = props;
  const m = tile.member;
  const box = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const screen = tile.kind === "screen";
  const name = m.self ? `${m.nick} (you)` : m.nick;
  const pin = () => props.onPin(pinned ? null : tile.key);
  return (
    <figure
      ref={box}
      class={`tile${m.speaking && !screen ? " speaking" : ""}${screen ? " tile-screen" : ""}`}
      data-testid={screen ? "tile-screen" : m.self ? "tile-self" : "tile-remote"}
      data-peer={m.peerId}
      onClick={(e) => {
        // Keyboard users pin with the Enlarge button; the buttons inside act on their own.
        // A double-click enlarges with its first click: the later ones would land on
        // whichever tile the layout change moved under the pointer.
        if (e.detail > 1 || (e.target instanceof Element && e.target.closest("button"))) return;
        props.onPin(tile.key);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && pinned) props.onPin(null);
      }}
    >
      {tile.live && tile.stream ? (
        <Video
          stream={tile.stream}
          muted
          mirror={m.self && !screen}
          fit={props.fit}
          testid={screen ? "video-screen" : m.self ? "video-self" : "video-remote"}
          inner={video}
        />
      ) : (
        <div
          class="avatar avatar-lg"
          style={{ "--hue": String(hueOf(m.peerId)) }}
          aria-hidden="true"
        >
          {screen ? <Icon name="screen" size={28} /> : initials(m.nick)}
        </div>
      )}
      <div class="tile-actions">
        <button
          type="button"
          class="tile-btn"
          aria-label={pinned ? `Unpin ${name}` : `Enlarge ${screen ? `${name}'s screen` : name}`}
          title={pinned ? "Unpin" : "Enlarge"}
          aria-pressed={pinned}
          onClick={pin}
          data-testid="tile-enlarge"
        >
          <Icon name="spotlight" size={16} />
        </button>
        <button
          type="button"
          class="tile-btn"
          aria-label={`Fullscreen ${screen ? `${name}'s screen` : name}`}
          title="Fullscreen"
          onClick={() => toggleFullscreen(box.current, video.current)}
          data-testid="tile-fullscreen"
        >
          <Icon name="fullscreen" size={16} />
        </button>
      </div>
      <figcaption class="tile-label">
        {!screen && !m.media.audio && <Icon name="micOff" size={14} label="Muted" />}
        <span>{screen ? `${name}'s screen` : name}</span>
        {(screen || tile.legacyScreen) && <span class="chip">Screen</span>}
        {!screen && m.media.recording && <span class="chip chip-rec">REC</span>}
      </figcaption>
    </figure>
  );
}

/** Every tile at the same size, or (as the strip) the tiles beside the spotlight. */
export function VideoGrid(props: {
  tiles: StageTile[];
  fitOf: (tile: StageTile) => VideoFit;
  pinned: string | null;
  onPin: (key: string | null) => void;
  strip?: boolean;
}): JSX.Element {
  const n = props.tiles.length;
  const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
  return (
    <div
      class={props.strip ? "strip" : "grid"}
      style={props.strip ? undefined : { "--cols": String(cols) }}
      data-count={n}
      data-testid={props.strip ? "strip" : undefined}
    >
      {props.tiles.map((t) => (
        <Tile
          key={t.key}
          tile={t}
          fit={props.fitOf(t)}
          pinned={props.pinned === t.key}
          onPin={props.onPin}
        />
      ))}
    </div>
  );
}
