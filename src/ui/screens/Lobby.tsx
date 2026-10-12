import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type DeviceInfo, listDevices, openDevices } from "../../features/devices";
import { DeviceSelect, LevelMeter, useAudioLevel } from "../components/DeviceSettings";
import { Icon } from "../components/Icons";
import { saveSettings, settings } from "../settings";

export interface LobbyChoice {
  nick: string;
  passphrase: string;
  audio: boolean;
  video: boolean;
}

export function Lobby(props: {
  passphrase: string;
  busy: boolean;
  error: string | null;
  onJoin: (c: LobbyChoice) => void;
  onBack: () => void;
}): JSX.Element {
  const [nick, setNick] = useState(settings.value.nick);
  const [passphrase, setPassphrase] = useState(props.passphrase);
  const [audio, setAudio] = useState(false);
  const [video, setVideo] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [mics, setMics] = useState<DeviceInfo[]>([]);
  const [cams, setCams] = useState<DeviceInfo[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const videoEl = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Preview only what is switched on; nothing is requested before the user asks.
  useEffect(() => {
    let cancelled = false;
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
    setStream(null);
    if (!audio && !video) return;
    const s = settings.value;
    openDevices({
      ...(audio ? { audio: s.audioDevice } : {}),
      ...(video ? { video: s.videoDevice } : {}),
    })
      .then(async ({ stream: st, fellBack }) => {
        if (cancelled) {
          for (const t of st.getTracks()) t.stop();
          return;
        }
        streamRef.current = st;
        setStream(st);
        setMediaError(
          fellBack.length ? "The selected device is unavailable: using the system default." : null,
        );
        const d = await listDevices();
        setMics(d.mics);
        setCams(d.cams);
      })
      .catch(() => {
        if (cancelled) return;
        setMediaError("Camera or microphone access was denied or is unavailable.");
        setAudio(false);
        setVideo(false);
      });
    return () => {
      cancelled = true;
    };
  }, [audio, video, settings.value.audioDevice, settings.value.videoDevice]);

  useEffect(
    () => () => {
      for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    },
    [],
  );

  useEffect(() => {
    if (videoEl.current) videoEl.current.srcObject = stream;
  }, [stream]);

  const level = useAudioLevel(audio ? stream : null);

  const submit = () => {
    const name = nick.trim().slice(0, 40);
    saveSettings({ ...settings.value, nick: name });
    for (const t of streamRef.current?.getTracks() ?? []) t.stop();
    streamRef.current = null;
    props.onJoin({ nick: name || "Guest", passphrase, audio, video });
  };

  return (
    <main class="lobby">
      <header class="topbar">
        <button type="button" class="icon-btn" aria-label="Back" onClick={props.onBack}>
          <Icon name="arrowLeft" />
        </button>
        <span class="topbar-title">Ready to join?</span>
        <span class="topbar-spacer" />
      </header>
      <div class="lobby-body">
        <div class="preview">
          {video && stream ? (
            <video
              ref={videoEl}
              class="mirror"
              autoPlay
              playsInline
              muted
              data-testid="lobby-preview"
            />
          ) : (
            <div class="preview-off">
              <Icon name="camOff" size={28} />
              <span>Camera is off</span>
            </div>
          )}
          <div class="preview-controls">
            <button
              type="button"
              class={`control ${audio ? "control-on" : "control-off"}`}
              aria-pressed={audio}
              aria-label={audio ? "Microphone on" : "Microphone off"}
              onClick={() => setAudio(!audio)}
              data-testid="lobby-mic"
            >
              <Icon name={audio ? "mic" : "micOff"} size={22} />
            </button>
            <button
              type="button"
              class={`control ${video ? "control-on" : "control-off"}`}
              aria-pressed={video}
              aria-label={video ? "Camera on" : "Camera off"}
              onClick={() => setVideo(!video)}
              data-testid="lobby-cam"
            >
              <Icon name={video ? "cam" : "camOff"} size={22} />
            </button>
          </div>
        </div>

        <form
          class="card stack lobby-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label class="field">
            <span class="label">Your name</span>
            <input
              class="input"
              value={nick}
              maxLength={40}
              placeholder="How others will see you"
              autoComplete="nickname"
              data-testid="nick"
              onInput={(e) => setNick(e.currentTarget.value)}
            />
          </label>
          {((audio && mics.length > 0) || (video && cams.length > 0)) && (
            <div class="row">
              {audio && mics.length > 0 && (
                <DeviceSelect
                  kind="audio"
                  devices={mics}
                  value={settings.value.audioDevice}
                  onChange={(id) => saveSettings({ ...settings.value, audioDevice: id })}
                />
              )}
              {video && cams.length > 0 && (
                <DeviceSelect
                  kind="video"
                  devices={cams}
                  value={settings.value.videoDevice}
                  onChange={(id) => saveSettings({ ...settings.value, videoDevice: id })}
                />
              )}
            </div>
          )}
          {audio && stream && <LevelMeter level={level} label="Microphone input level" />}
          <label class="field">
            <span class="label">Room passphrase (if any)</span>
            <input
              class="input"
              type="password"
              value={passphrase}
              autoComplete="off"
              placeholder="Leave empty if there is none"
              onInput={(e) => setPassphrase(e.currentTarget.value)}
            />
          </label>
          {(mediaError || props.error) && (
            <p class="error" role="alert">
              {props.error ?? mediaError}
            </p>
          )}
          <button
            type="submit"
            class="btn btn-primary btn-lg btn-block"
            disabled={props.busy}
            data-testid="enter-room"
          >
            {props.busy ? "Joining…" : "Join room"}
          </button>
          <p class="hint center">You can turn your camera and microphone on later.</p>
        </form>
      </div>
    </main>
  );
}
