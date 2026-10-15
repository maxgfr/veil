/**
 * Microphone and camera selection. A device is identified by its deviceId;
 * "" means the system default. A saved device that is gone (unplugged,
 * different machine) falls back to the default instead of failing.
 */

export type MediaKind = "audio" | "video";

/** What to open: absent = not requested, "" = system default, else a deviceId. */
export interface DeviceRequest {
  audio?: string;
  video?: string;
}

export interface DeviceInfo {
  id: string;
  label: string;
}

export const AUDIO_PROCESSING = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};
export const VIDEO_SHAPE = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export function constraintsFor(
  kind: MediaKind,
  deviceId: string,
  alias = true,
): MediaTrackConstraints {
  const base = kind === "audio" ? AUDIO_PROCESSING : VIDEO_SHAPE;
  if (deviceId) return { ...base, deviceId: { exact: deviceId } };
  // Chromium's "default" alias follows the system's default microphone. Without it, Chrome opens
  // the device it ranks first for the site (the one picked last), not the system's. Exact: Chrome
  // ignores it as an ideal. Browsers without the alias are asked again without it (alias = false).
  return kind === "audio" && alias ? { ...base, deviceId: { exact: "default" } } : { ...base };
}

type GetUserMedia = (c: MediaStreamConstraints) => Promise<MediaStream>;

const defaultGum: GetUserMedia = (c) => navigator.mediaDevices.getUserMedia(c);

/** The chosen device cannot be opened, but the default one may. */
function deviceGone(err: unknown): boolean {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  return name === "OverconstrainedError" || name === "NotFoundError" || name === "NotReadableError";
}

/**
 * Opens the requested devices. If a specific device cannot be opened, retries
 * with the system default and reports which kinds fell back. Permission
 * errors are not retried.
 */
export async function openDevices(
  want: DeviceRequest,
  gum: GetUserMedia = defaultGum,
): Promise<{ stream: MediaStream; fellBack: MediaKind[] }> {
  const build = (r: DeviceRequest, alias: boolean): MediaStreamConstraints => ({
    audio: r.audio === undefined ? false : constraintsFor("audio", r.audio, alias),
    video: r.video === undefined ? false : constraintsFor("video", r.video, alias),
  });
  // The default microphone by its alias first; a browser without the alias opens its own default.
  const tryOpen = async (r: DeviceRequest): Promise<MediaStream> => {
    try {
      return await gum(build(r, true));
    } catch (err) {
      if (r.audio !== "" || !deviceGone(err)) throw err;
      return gum(build(r, false));
    }
  };
  try {
    return { stream: await tryOpen(want), fellBack: [] };
  } catch (err) {
    const specific: MediaKind[] = [];
    if (want.audio) specific.push("audio");
    if (want.video) specific.push("video");
    if (!specific.length || !deviceGone(err)) throw err;
    const defaults: DeviceRequest = {};
    if (want.audio !== undefined) defaults.audio = "";
    if (want.video !== undefined) defaults.video = "";
    return { stream: await tryOpen(defaults), fellBack: specific };
  }
}

/** Input devices, in system order. Labels are empty until the user has granted access once. */
export async function listDevices(): Promise<{
  mics: DeviceInfo[];
  cams: DeviceInfo[];
  /** Name of the system's default microphone, "" when the browser doesn't tell. */
  defaultMic: string;
  labeled: boolean;
}> {
  const all = await navigator.mediaDevices.enumerateDevices();
  // "default" / "communications" are aliases of a real device on Chromium: "System default" covers them.
  const real = all.filter(
    (d) => d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications",
  );
  const pick = (kind: MediaDeviceKind, fallback: string) =>
    real
      .filter((d) => d.kind === kind)
      .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  // The microphone behind the "default" alias: the real one of the same group, named without the
  // browser's localized "Default - " prefix.
  const alias = all.find((d) => d.kind === "audioinput" && d.deviceId === "default");
  const behind = alias && real.find((d) => d.kind === "audioinput" && d.groupId === alias.groupId);
  return {
    mics: pick("audioinput", "Microphone"),
    cams: pick("videoinput", "Camera"),
    defaultMic: behind?.label || alias?.label || "",
    labeled: real.some((d) => d.label),
  };
}
