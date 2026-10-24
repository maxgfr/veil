/**
 * The call stage: a grid of equal tiles, or one tile in large (a pinned tile,
 * else the latest shared screen, else whoever speaks) with the rest in a strip.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { MemberView, RoomSession } from "../session";
import { type ScreenQuality, settings, type VideoFit } from "../settings";
import { hueOf, initials } from "./format";
import { Icon } from "./Icons";
import {
  FITS,
  RemoteAudio,
  type StageTile,
  stageTiles,
  toggleFullscreen,
  Video,
  VideoGrid,
} from "./VideoGrid";

const QUALITIES: { value: ScreenQuality; label: string }[] = [
  { value: "detail", label: "Text & detail" },
  { value: "motion", label: "Motion" },
];

function Spotlight(props: {
  session: RoomSession;
  tile: StageTile;
  fit: VideoFit;
  onFit: (fit: VideoFit) => void;
  screens: StageTile[];
  pinned: boolean;
  onPin: (key: string | null) => void;
}): JSX.Element {
  const s = props.session;
  const { tile, fit } = props;
  const m = tile.member;
  const box = useRef<HTMLElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const screen = tile.kind === "screen" || tile.legacyScreen;
  const next = FITS[fit].next;
  const sharing = m.self && tile.kind === "screen";
  const name = m.self ? `${m.nick} (you)` : m.nick;
  const title = screen ? `${name}'s screen` : name;
  return (
    <section class="spotlight" ref={box} aria-label={title} data-testid="spotlight">
      {tile.live && tile.stream ? (
        <Video
          stream={tile.stream}
          muted
          mirror={m.self && !screen}
          fit={fit}
          testid="spotlight-video"
          inner={video}
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
      {sharing && (
        <p class="spotlight-note" role="status">
          <Icon name="screen" size={16} />
          You're sharing your screen
        </p>
      )}
      {props.screens.length > 1 && (
        <fieldset class="spotlight-pills" aria-label="Shared screens">
          {props.screens.map((t) => (
            <button
              key={t.key}
              type="button"
              class="pill"
              aria-pressed={t.key === tile.key}
              onClick={() => props.onPin(t.key)}
            >
              {t.member.self ? "Your screen" : t.member.nick}
            </button>
          ))}
        </fieldset>
      )}
      <div class="spotlight-bar">
        <span class="spotlight-title">{title}</span>
        {sharing && (
          <fieldset class="segmented segmented-sm" aria-label="Sharing quality">
            {QUALITIES.map((q) => (
              <button
                key={q.value}
                type="button"
                aria-pressed={settings.value.screenQuality === q.value}
                onClick={() => void s.setScreenQuality(q.value)}
              >
                {q.label}
              </button>
            ))}
          </fieldset>
        )}
        <button
          type="button"
          class="tile-btn"
          aria-label={`Picture: ${FITS[fit].label}. Switch to ${FITS[next].label}`}
          title={`${FITS[fit].label} · switch to ${FITS[next].label}`}
          onClick={() => props.onFit(next)}
          data-testid="spotlight-fit"
        >
          <Icon name="fit" size={18} />
        </button>
        <button
          type="button"
          class="tile-btn"
          aria-label={props.pinned ? "Unpin" : "Pin"}
          title={props.pinned ? "Unpin" : "Pin"}
          aria-pressed={props.pinned}
          onClick={() => props.onPin(props.pinned ? null : tile.key)}
          data-testid="spotlight-pin"
        >
          <Icon name="pin" size={18} />
        </button>
        <button
          type="button"
          class="tile-btn"
          aria-label="Fullscreen"
          title="Fullscreen"
          onClick={() => toggleFullscreen(box.current, video.current)}
          data-testid="spotlight-fullscreen"
        >
          <Icon name="fullscreen" size={18} />
        </button>
        {sharing && (
          <button
            type="button"
            class="btn btn-danger btn-sm"
            onClick={() => void s.toggleScreen()}
            data-testid="stop-sharing"
          >
            Stop sharing
          </button>
        )}
      </div>
    </section>
  );
}

/** Grid or spotlight, after the Layout choice, the pinned tile and the shared screens. */
export function Stage(props: {
  session: RoomSession;
  members: MemberView[];
  pinned: string | null;
  onPin: (key: string | null) => void;
}): JSX.Element {
  const s = props.session;
  const tiles = stageTiles(s, props.members);
  // Fit, Fill or Stretch per tile, over the default: a screen starts whole,
  // a camera as the Layout menu says.
  const [fits, setFits] = useState<Record<string, VideoFit>>({});
  // A new default in the Layout menu applies to every tile, picked ones included.
  const videoFit = settings.value.videoFit;
  useEffect(() => setFits({}), [videoFit]);
  const fitOf = (t: StageTile): VideoFit =>
    fits[t.key] ?? (t.kind === "screen" || t.legacyScreen ? "contain" : videoFit);
  const screens = tiles.filter((t) => t.kind === "screen" || t.legacyScreen);
  // When each screen appeared: the most recent one goes in large.
  const seen = useRef(new Map<string, number>());
  for (const k of [...seen.current.keys()]) {
    if (!screens.some((t) => t.key === k)) seen.current.delete(k);
  }
  for (const t of screens) if (!seen.current.has(t.key)) seen.current.set(t.key, Date.now());
  screens.sort((a, b) => (seen.current.get(b.key) ?? 0) - (seen.current.get(a.key) ?? 0));
  // The last speaker stays in large through pauses, so the spotlight does not flicker.
  const speaker = useRef<string | null>(null);
  const speaking = tiles.find((t) => t.kind === "camera" && t.member.speaking && !t.member.self);
  if (speaking) speaker.current = speaking.key;

  const pinned = tiles.find((t) => t.key === props.pinned) ?? null;
  const layout = settings.value.layout;
  const spotlight = !!pinned || layout === "spotlight" || (layout === "auto" && screens.length > 0);
  const main = spotlight
    ? (pinned ??
      (layout !== "grid" ? screens[0] : undefined) ??
      tiles.find((t) => t.key === speaker.current) ??
      tiles.find((t) => !t.member.self) ??
      tiles[0])
    : undefined;
  return (
    <div class="stage-view" data-layout={main ? "spotlight" : "grid"}>
      {main ? (
        <>
          <Spotlight
            session={s}
            tile={main}
            fit={fitOf(main)}
            onFit={(fit) => setFits({ ...fits, [main.key]: fit })}
            screens={screens}
            pinned={pinned === main}
            onPin={props.onPin}
          />
          {tiles.length > 1 && (
            <VideoGrid
              strip
              tiles={tiles.filter((t) => t !== main)}
              fitOf={fitOf}
              pinned={props.pinned}
              onPin={props.onPin}
            />
          )}
        </>
      ) : (
        <VideoGrid tiles={tiles} fitOf={fitOf} pinned={props.pinned} onPin={props.onPin} />
      )}
      <RemoteAudio session={s} members={props.members} />
    </div>
  );
}
