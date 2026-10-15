/**
 * Microphone and camera: pick the devices, test the microphone (live input
 * level) and preview the camera. In a call, a new choice applies right away.
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type DeviceInfo, listDevices, type MediaKind, openDevices } from "../../features/devices";
import type { RoomSession } from "../session";
import { type ScreenQuality, saveSettings, settings } from "../settings";
import { Icon } from "./Icons";
import { Toggle } from "./SettingsSheet";

const SCREEN_QUALITIES: { value: ScreenQuality; label: string }[] = [
  { value: "detail", label: "Text & detail" },
  { value: "motion", label: "Motion" },
];

/** Input level of a stream, 0–1, sampled ~15 times per second. */
export function useAudioLevel(stream: MediaStream | null): number {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!stream?.getAudioTracks().length || typeof AudioContext === "undefined") {
      setLevel(0);
      return;
    }
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    void ctx.resume().catch(() => {});
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 66) return;
      last = t;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      // RMS of speech sits around 0.02–0.2: scale so normal speech fills most of the bar.
      setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 5));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ctx.close().catch(() => {});
    };
  }, [stream]);
  return level;
}

export function LevelMeter(props: { level: number; label: string }): JSX.Element {
  const pct = Math.round(props.level * 100);
  return (
    <meter
      class="meter"
      min={0}
      max={100}
      value={pct}
      aria-label={props.label}
      data-testid="mic-level"
      data-level={pct}
    />
  );
}

export function DeviceSelect(props: {
  kind: MediaKind;
  devices: DeviceInfo[];
  value: string;
  onChange: (id: string) => void;
}): JSX.Element {
  const label = props.kind === "audio" ? "Microphone" : "Camera";
  // A saved device the list doesn't show (unplugged, or names not allowed yet) keeps its own
  // option: shown as "System default", picking the default would change nothing.
  const unlisted = props.value !== "" && !props.devices.some((d) => d.id === props.value);
  return (
    <label class="field">
      <span class="label">{label}</span>
      <select
        class="input"
        value={props.value}
        data-testid={props.kind === "audio" ? "select-mic" : "select-cam"}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">System default</option>
        {unlisted && (
          <option value={props.value}>
            {props.kind === "audio" ? "Microphone chosen earlier" : "Camera chosen earlier"}
          </option>
        )}
        {props.devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function stopAll(stream: MediaStream | null): void {
  for (const t of stream?.getTracks() ?? []) t.stop();
}

export function DeviceSettings(props: {
  session?: RoomSession | undefined;
  open: boolean;
}): JSX.Element {
  const [mics, setMics] = useState<DeviceInfo[]>([]);
  const [cams, setCams] = useState<DeviceInfo[]>([]);
  const [labeled, setLabeled] = useState(true);
  const [micTest, setMicTest] = useState<MediaStream | null>(null);
  const [camTest, setCamTest] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const level = useAudioLevel(micTest);
  const tests = useRef<{ mic: MediaStream | null; cam: MediaStream | null }>({
    mic: null,
    cam: null,
  });
  tests.current = { mic: micTest, cam: camTest };

  const refresh = async () => {
    try {
      const d = await listDevices();
      setMics(d.mics);
      setCams(d.cams);
      setLabeled(d.labeled);
    } catch {
      setLabeled(false);
    }
  };

  useEffect(() => {
    if (!props.open) return;
    void refresh();
    const md = navigator.mediaDevices;
    md?.addEventListener?.("devicechange", refresh);
    return () => {
      md?.removeEventListener?.("devicechange", refresh);
      // Closing the sheet releases the test devices.
      stopAll(tests.current.mic);
      stopAll(tests.current.cam);
      setMicTest(null);
      setCamTest(null);
    };
  }, [props.open]);

  useEffect(() => {
    if (video.current) video.current.srcObject = camTest;
  }, [camTest]);

  const open = async (kind: MediaKind, deviceId: string): Promise<MediaStream | null> => {
    try {
      const { stream } = await openDevices(
        kind === "audio" ? { audio: deviceId } : { video: deviceId },
      );
      setError(null);
      void refresh();
      return stream;
    } catch {
      setError(
        `Could not open the ${kind === "audio" ? "microphone" : "camera"}. Check the browser's permission.`,
      );
      return null;
    }
  };

  const toggleMicTest = async () => {
    if (micTest) {
      stopAll(micTest);
      setMicTest(null);
    } else {
      setMicTest(await open("audio", settings.value.audioDevice));
    }
  };

  const toggleCamTest = async () => {
    if (camTest) {
      stopAll(camTest);
      setCamTest(null);
    } else {
      setCamTest(await open("video", settings.value.videoDevice));
    }
  };

  const choose = async (kind: MediaKind, id: string) => {
    if (props.session) await props.session.selectDevice(kind, id);
    else
      saveSettings({ ...settings.value, [kind === "audio" ? "audioDevice" : "videoDevice"]: id });
    // Keep testing, now on the new device.
    if (kind === "audio" && micTest) {
      stopAll(micTest);
      setMicTest(await open("audio", id));
    }
    if (kind === "video" && camTest) {
      stopAll(camTest);
      setCamTest(await open("video", id));
    }
  };

  const chooseNoiseReduction = async (on: boolean) => {
    if (props.session) await props.session.setNoiseReduction(on);
    else saveSettings({ ...settings.value, noiseReduction: on });
  };

  const chooseQuality = async (screenQuality: ScreenQuality) => {
    if (props.session) await props.session.setScreenQuality(screenQuality);
    else saveSettings({ ...settings.value, screenQuality });
  };

  return (
    <fieldset class="group" data-testid="device-settings">
      <legend>Microphone & camera</legend>
      {!labeled && (
        <p class="muted small">Device names appear once you allow access: start a test below.</p>
      )}
      <DeviceSelect
        kind="audio"
        devices={mics}
        value={settings.value.audioDevice}
        onChange={(id) => void choose("audio", id)}
      />
      <div class="device-test">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onClick={() => void toggleMicTest()}
          data-testid="mic-test"
        >
          <Icon name={micTest ? "micOff" : "mic"} size={16} />
          {micTest ? "Stop test" : "Test microphone"}
        </button>
        {micTest && (
          <div class="device-test-meter">
            <LevelMeter level={level} label="Microphone input level" />
            <span class="hint">
              {level > 0.05 ? "We hear you." : "Say something: the bar should move."}
            </span>
          </div>
        )}
      </div>
      <Toggle
        label="Strong noise reduction"
        hint="Removes keyboards, fans and voices around you, on this device. Downloads about 0.4 MB the first time."
        checked={settings.value.noiseReduction}
        testid="toggle-noise-reduction"
        onChange={(on) => void chooseNoiseReduction(on)}
      />
      <DeviceSelect
        kind="video"
        devices={cams}
        value={settings.value.videoDevice}
        onChange={(id) => void choose("video", id)}
      />
      <div class="device-test">
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onClick={() => void toggleCamTest()}
          data-testid="cam-test"
        >
          <Icon name={camTest ? "camOff" : "cam"} size={16} />
          {camTest ? "Stop preview" : "Preview camera"}
        </button>
      </div>
      {camTest && (
        <div class="device-preview">
          <video ref={video} class="mirror" autoPlay playsInline muted data-testid="cam-preview" />
        </div>
      )}
      <fieldset class="field field-set">
        <legend class="label">Screen sharing</legend>
        <div class="segmented">
          {SCREEN_QUALITIES.map((q) => (
            <button
              key={q.value}
              type="button"
              aria-pressed={settings.value.screenQuality === q.value}
              onClick={() => void chooseQuality(q.value)}
              data-testid={`screen-quality-${q.value}`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <span class="hint">
          Text & detail keeps slides and code sharp. Motion keeps video smooth.
        </span>
      </fieldset>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      {props.session && <p class="hint">Changes apply to your call right away.</p>}
    </fieldset>
  );
}
