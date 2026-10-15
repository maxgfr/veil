import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "../crypto/bytes";
import type { SenderKeys } from "../crypto/senderkeys";
import type { Peer } from "../mesh/peer";
import type { MediaState } from "../mesh/protocol";
import type { ScreenQuality } from "../ui/settings";
import { clearBytes, decryptFrame, encryptFrame, TRAILER_BYTES } from "../workers/e2ee-worker";
import { Media, mediaKey, pickVideoSources, SCREEN_PROFILES, videoBudget } from "./media";

const aes = async (raw: Uint8Array) =>
  crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);

describe("media E2EE frames", () => {
  test("encrypt/decrypt round-trip keeps the codec header in the clear", async () => {
    const key = await aes(randomBytes(32));
    for (const [kind, isKey] of [
      ["video", true],
      ["video", false],
      ["audio", false],
    ] as const) {
      const frame = randomBytes(1200);
      const clear = clearBytes(kind, isKey);
      const enc = new Uint8Array(await encryptFrame(frame.slice().buffer, clear, key, 42));
      expect(enc.length).toBe(frame.length + 16 + TRAILER_BYTES);
      expect(enc.subarray(0, clear)).toEqual(frame.subarray(0, clear));
      expect(enc.subarray(clear, clear + 32)).not.toEqual(frame.subarray(clear, clear + 32));
      const dec = await decryptFrame(enc.buffer, clear, (id) => (id === 42 ? key : undefined));
      expect(new Uint8Array(dec as ArrayBuffer)).toEqual(frame);
    }
  });

  test("tampered frames, wrong keys and unknown key ids are dropped", async () => {
    const key = await aes(randomBytes(32));
    const other = await aes(randomBytes(32));
    const enc = new Uint8Array(await encryptFrame(randomBytes(500).buffer, 3, key, 7));
    expect(await decryptFrame(enc.buffer, 3, () => other)).toBeNull();
    expect(await decryptFrame(enc.buffer, 3, () => undefined)).toBeNull();
    const header = enc.slice();
    header[0] = (header[0] as number) ^ 1;
    expect(await decryptFrame(header.buffer, 3, () => key)).toBeNull();
    expect(await decryptFrame(new Uint8Array(10).buffer, 3, () => key)).toBeNull();
  });

  test("tiny frames (shorter than the clear header) still round-trip", async () => {
    const key = await aes(randomBytes(32));
    const frame = randomBytes(2);
    const enc = await encryptFrame(frame.slice().buffer, 10, key, 1);
    // The receiver bounds the clear prefix by the payload length, exactly like the sender.
    const dec = await decryptFrame(enc, 10, () => key);
    expect(new Uint8Array(dec as ArrayBuffer)).toEqual(frame);
  });

  test("media keys are derived from, and differ from, the sender key", async () => {
    const sk = randomBytes(32);
    const mk = await mediaKey(sk);
    expect(mk.length).toBe(32);
    expect(mk).not.toEqual(sk);
    expect(await mediaKey(sk)).toEqual(mk);
  });
});

describe("media budget", () => {
  test("bitrate per receiver shrinks with the audience and resolution follows", () => {
    const one = videoBudget({ uplinkBps: 5_000_000, videoReceivers: 1, cores: 8 });
    const many = videoBudget({ uplinkBps: 5_000_000, videoReceivers: 20, cores: 8 });
    expect(one.maxBitrate).toBe(1_500_000);
    expect(one.scaleResolutionDownBy).toBe(1);
    expect(many.maxBitrate).toBeLessThan(250_000);
    expect(many.scaleResolutionDownBy).toBe(4);
    expect(videoBudget({ uplinkBps: 0, videoReceivers: 50, cores: 2 }).maxBitrate).toBe(80_000);
    expect(videoBudget({ uplinkBps: 1e6, videoReceivers: 1, cores: 2 }).maxVideoIn).toBe(4);
  });

  test("video goes to screen shares first, then the most recent speakers", () => {
    const picks = pickVideoSources(
      [
        { peerId: "a", lastSpoke: 10, screen: false, video: true },
        { peerId: "b", lastSpoke: 50, screen: false, video: true },
        { peerId: "c", lastSpoke: 0, screen: true, video: false },
        { peerId: "d", lastSpoke: 99, screen: false, video: false },
        { peerId: "e", lastSpoke: 30, screen: false, video: true },
      ],
      3,
    );
    expect([...picks]).toEqual(["c", "b", "e"]);
  });
});

// ── fakes: just enough of MediaStream, tracks, senders and RTCPeerConnection ──

let ids = 0;

class FakeTrack extends EventTarget {
  readonly id = `track-${++ids}`;
  enabled = true;
  contentHint = "";
  readyState: "live" | "ended" = "live";
  constraints: MediaTrackConstraints[] = [];
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  stop(): void {
    this.readyState = "ended";
  }
  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
  async applyConstraints(c: MediaTrackConstraints): Promise<void> {
    this.constraints.push(c);
  }
  getSettings(): MediaTrackSettings {
    return {};
  }
}

class FakeStream {
  readonly id: string;
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = [], id = `{stream-${++ids}-0000}`) {
    this.tracks = [...tracks];
    this.id = id;
  }
  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "audio");
  }
  getVideoTracks(): FakeTrack[] {
    return this.tracks.filter((t) => t.kind === "video");
  }
  addTrack(t: FakeTrack): void {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack): void {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

interface FakeParams {
  encodings: Record<string, unknown>[];
  degradationPreference?: string;
}

class FakeSender {
  track: FakeTrack | null = null;
  params: FakeParams = { encodings: [{}] };
  async replaceTrack(t: FakeTrack | null): Promise<void> {
    this.track = t;
  }
  getParameters(): FakeParams {
    return structuredClone(this.params);
  }
  async setParameters(p: FakeParams): Promise<void> {
    this.params = p;
  }
}

interface FakeTransceiver {
  kind: string;
  streams: FakeStream[];
  sender: FakeSender;
}

class FakePc {
  transceivers: FakeTransceiver[] = [];
  addTransceiver(kind: string, init: { streams: FakeStream[] }): FakeTransceiver {
    const t = { kind, streams: init.streams, sender: new FakeSender() };
    this.transceivers.push(t);
    return t;
  }
  getReceivers(): never[] {
    return [];
  }
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const asTracks = (...t: FakeTrack[]) => t as unknown as MediaStreamTrack[];

let display = new FakeTrack("video");

beforeAll(() => {
  Object.assign(globalThis, { MediaStream: FakeStream });
  Object.assign(navigator, {
    mediaDevices: {
      getDisplayMedia: async () => {
        display = new FakeTrack("video");
        return new FakeStream([display]);
      },
    },
  });
});

const live: Media[] = [];
afterEach(() => {
  for (const m of live.splice(0)) m.dispose();
});

/** A Media linked to fake members; `caps` and `media` stand for their presence. */
function setup(members: string[], quality: ScreenQuality = "detail") {
  const caps = new Map<string, string[]>();
  const media = new Map<string, MediaState>();
  const published: MediaState[] = [];
  const peers = new Map<string, Peer>();
  const pcs = new Map<string, FakePc>();
  for (const id of members) {
    const pc = new FakePc();
    pcs.set(id, pc);
    peers.set(id, { remoteId: id, ready: true, pc, sendCtrl: async () => {} } as unknown as Peer);
  }
  const m = new Media({
    peers: () => peers.values(),
    peer: (id) => peers.get(id),
    keys: {} as SenderKeys,
    memberMedia: (id) => media.get(id),
    memberE2ee: () => false,
    memberCaps: (id) => caps.get(id) ?? [],
    screenQuality: () => quality,
    publish: (s) => published.push(s),
    onChange: () => {},
    workerUrl: "",
    mode: "none",
    preferredDevices: () => ({ audio: "", video: "" }),
  });
  live.push(m);
  const pc = (id: string) => pcs.get(id) ?? new FakePc();
  const peer = (id: string) => peers.get(id) as Peer;
  return { m, caps, media, published, pc, peer };
}

describe("media screen sending", () => {
  test("a capable link gets a third sender with the screen; the camera stays on video", async () => {
    const { m, caps, pc, published } = setup(["alice"]);
    caps.set("alice", ["screen-track"]);
    await m.start({ audio: false, video: false });
    const cam = new FakeTrack("video");
    m.cameraTrack = cam as unknown as MediaStreamTrack;
    await m.setCam(true);
    expect(pc("alice").transceivers).toHaveLength(2);
    await m.setScreen(true);
    await flush();
    const [, video, screen] = pc("alice").transceivers;
    expect(pc("alice").transceivers).toHaveLength(3);
    expect(video?.sender.track).toBe(cam);
    expect(screen?.sender.track).toBe(display);
    expect(screen?.streams[0]).toBe(m.screenStream as unknown as FakeStream);
    expect(m.screenStream.getVideoTracks()).toEqual(asTracks(display));
    expect(m.preview.getVideoTracks()).toEqual(asTracks(cam));
    expect(published.at(-1)?.screenStream).toBe(m.screenStream.id.replace(/[{}]/g, ""));
    // The camera goes small, the screen has priority.
    expect(video?.sender.params.encodings[0]?.scaleResolutionDownBy).toBe(4);
    expect(screen?.sender.params.encodings[0]?.priority).toBe("high");
    expect(screen?.sender.params.encodings[0]?.scaleResolutionDownBy).toBe(1);

    // Sharing again reuses the same sender: no new transceiver.
    await m.setScreen(false);
    await m.setScreen(true);
    expect(pc("alice").transceivers).toHaveLength(3);
    expect(pc("alice").transceivers[2]?.sender.track).toBe(display);
  });

  test("a link without screen-track keeps the screen on the video sender", async () => {
    const { m, pc } = setup(["bob"]);
    await m.start({ audio: false, video: false });
    await m.setScreen(true);
    await flush();
    expect(pc("bob").transceivers).toHaveLength(2);
    expect(pc("bob").transceivers[1]?.sender.track).toBe(display);
    expect(pc("bob").transceivers[1]?.sender.params.encodings[0]?.scaleResolutionDownBy).toBe(1);
    await m.setScreen(false);
    expect(pc("bob").transceivers[1]?.sender.track).toBeNull();
  });

  test("stopping the share sets the screen sender to null and drops screenStream", async () => {
    const { m, caps, pc, published } = setup(["alice"]);
    caps.set("alice", ["screen-track"]);
    await m.start({ audio: false, video: false });
    await m.setScreen(true);
    await m.setScreen(false);
    expect(pc("alice").transceivers[2]?.sender.track).toBeNull();
    expect(m.screenStream.getTracks()).toHaveLength(0);
    expect("screenStream" in (published.at(-1) ?? {})).toBe(false);
  });

  test("a member announcing screen-track mid-share gets the screen sender", async () => {
    const { m, caps, pc } = setup(["alice"]);
    await m.start({ audio: false, video: false });
    await m.setScreen(true);
    expect(pc("alice").transceivers).toHaveLength(2);
    caps.set("alice", ["screen-track"]);
    m.onMembers();
    expect(pc("alice").transceivers).toHaveLength(3);
    expect(pc("alice").transceivers[1]?.sender.track).toBeNull();
    expect(pc("alice").transceivers[2]?.sender.track).toBe(display);
  });

  test("the screen is not subject to the video want", async () => {
    const { m, caps, pc, peer } = setup(["alice"]);
    caps.set("alice", ["screen-track"]);
    await m.start({ audio: false, video: false });
    await m.setScreen(true);
    m.onCtrl(peer("alice"), { t: "video", want: false });
    expect(pc("alice").transceivers[2]?.sender.track).toBe(display);
  });

  test("the quality is applied at capture and changed live", async () => {
    const { m, caps, pc } = setup(["alice"], "motion");
    caps.set("alice", ["screen-track"]);
    await m.start({ audio: false, video: false });
    await m.setScreen(true);
    await flush();
    expect(display.contentHint).toBe("motion");
    const screen = pc("alice").transceivers[2]?.sender;
    expect(screen?.params.degradationPreference).toBe("maintain-framerate");
    await m.setScreenQuality("detail");
    expect(display.contentHint).toBe("detail");
    expect(display.constraints.at(-1)?.frameRate).toEqual({
      ideal: SCREEN_PROFILES.detail.frameRate,
      max: SCREEN_PROFILES.detail.frameRate,
    });
    expect(screen?.params.degradationPreference).toBe("maintain-resolution");
    // Not sharing: kept for the next share.
    await m.setScreen(false);
    await m.setScreenQuality("motion");
    await m.setScreen(true);
    expect(display.contentHint).toBe("motion");
  });
});

describe("media screen receiving", () => {
  const SCREEN = "screen-stream-0001";
  const CAMERA = "camera-stream-0001";

  function arrive(m: Media, peer: Peer, kind: "audio" | "video", msid: string): FakeTrack {
    const t = new FakeTrack(kind);
    m.onTrack(peer, {
      track: t,
      streams: [new FakeStream([t], msid)],
      receiver: {},
    } as unknown as RTCTrackEvent);
    return t;
  }

  test("tracks are routed by stream id: the screen apart, the camera with the audio", () => {
    const { m, media, peer } = setup(["alice"]);
    media.set("alice", { audio: true, video: true, screen: true, screenStream: SCREEN });
    const audio = arrive(m, peer("alice"), "audio", CAMERA);
    const cam = arrive(m, peer("alice"), "video", CAMERA);
    const screen = arrive(m, peer("alice"), "video", SCREEN);
    const r = m.remote.get("alice");
    expect(r?.stream.getTracks()).toEqual(asTracks(audio, cam));
    expect(r?.screen?.getVideoTracks()).toEqual(asTracks(screen));
  });

  test("a screen track arriving before the presence is moved when the presence arrives", () => {
    const { m, media, peer } = setup(["alice"]);
    media.set("alice", { audio: true, video: true, screen: false });
    arrive(m, peer("alice"), "audio", CAMERA);
    const cam = arrive(m, peer("alice"), "video", CAMERA);
    const screen = arrive(m, peer("alice"), "video", SCREEN);
    const r = m.remote.get("alice");
    expect(r?.stream.getVideoTracks()).toEqual(asTracks(cam));
    expect(r?.screen).toBeNull();
    media.set("alice", { audio: true, video: true, screen: true, screenStream: SCREEN });
    m.onMembers();
    expect(r?.screen?.getVideoTracks()).toEqual(asTracks(screen));
    expect(r?.stream.getVideoTracks()).toEqual(asTracks(cam));
  });

  test("a presence arriving before the track routes it at once (braces ignored)", () => {
    const { m, media, peer } = setup(["alice"]);
    media.set("alice", { audio: false, video: false, screen: true, screenStream: SCREEN });
    const screen = arrive(m, peer("alice"), "video", `{${SCREEN}}`);
    const r = m.remote.get("alice");
    expect(r?.screen?.getVideoTracks()).toEqual(asTracks(screen));
    expect(r?.stream.getVideoTracks()).toHaveLength(0);
  });

  test("the screen is cleared when the share ends, without taking the camera's place", () => {
    const { m, media, peer } = setup(["alice"]);
    media.set("alice", { audio: true, video: true, screen: true, screenStream: SCREEN });
    arrive(m, peer("alice"), "audio", CAMERA);
    const cam = arrive(m, peer("alice"), "video", CAMERA);
    const screen = arrive(m, peer("alice"), "video", SCREEN);
    const r = m.remote.get("alice");
    media.set("alice", { audio: true, video: true, screen: false });
    m.onMembers();
    expect(r?.screen).toBeNull();
    expect(r?.stream.getVideoTracks()).toEqual(asTracks(cam));
    // Shared again, then the track ends.
    media.set("alice", { audio: true, video: true, screen: true, screenStream: SCREEN });
    m.onMembers();
    expect(r?.screen?.getVideoTracks()).toEqual(asTracks(screen));
    screen.end();
    expect(r?.screen).toBeNull();
    expect(r?.stream.getVideoTracks()).toEqual(asTracks(cam));
  });

  test("a member without screen-track sends its screen as its camera", () => {
    const { m, media, peer } = setup(["bob"]);
    media.set("bob", { audio: true, video: false, screen: true });
    arrive(m, peer("bob"), "audio", CAMERA);
    const v = arrive(m, peer("bob"), "video", CAMERA);
    const r = m.remote.get("bob");
    expect(r?.stream.getVideoTracks()).toEqual(asTracks(v));
    expect(r?.screen).toBeNull();
  });
});
