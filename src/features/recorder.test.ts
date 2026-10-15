import { describe, expect, test } from "bun:test";
import {
  gridLayout,
  initials,
  pickMime,
  type Rect,
  recordingNames,
  spotlightLayout,
} from "./recorder";

describe("gridLayout", () => {
  test("no tiles for no sources", () => {
    expect(gridLayout(0, 1280, 720)).toEqual([]);
  });

  test("one source fills the canvas", () => {
    expect(gridLayout(1, 1280, 720)).toEqual([{ x: 0, y: 0, w: 1280, h: 720 }]);
  });

  test("two sources sit side by side", () => {
    expect(gridLayout(2, 1280, 720)).toEqual([
      { x: 0, y: 0, w: 640, h: 720 },
      { x: 640, y: 0, w: 640, h: 720 },
    ]);
  });

  test("three sources: a full row and a centred short row", () => {
    expect(gridLayout(3, 1280, 720)).toEqual([
      { x: 0, y: 0, w: 640, h: 360 },
      { x: 640, y: 0, w: 640, h: 360 },
      { x: 320, y: 360, w: 640, h: 360 },
    ]);
  });

  test("tiles never overflow and never overlap", () => {
    for (let n = 1; n <= 16; n++) {
      const rects = gridLayout(n, 1280, 720);
      expect(rects).toHaveLength(n);
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1280);
        expect(r.y + r.h).toBeLessThanOrEqual(720);
      }
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = rects[i] as Rect;
          const b = rects[j] as Rect;
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
    }
  });
});

describe("spotlightLayout", () => {
  test("no camera: the screen fills the canvas", () => {
    expect(spotlightLayout(0, 1280, 720)).toEqual({
      screen: { x: 0, y: 0, w: 1280, h: 720 },
      cameras: [],
    });
  });

  test("the screen is largest, and no tile overflows or overlaps", () => {
    for (const n of [1, 3, 8]) {
      const { screen, cameras } = spotlightLayout(n, 1280, 720);
      expect(cameras).toHaveLength(n);
      const rects = [screen, ...cameras];
      for (const r of rects) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        expect(r.x + r.w).toBeLessThanOrEqual(1280);
        expect(r.y + r.h).toBeLessThanOrEqual(720);
      }
      for (const c of cameras) expect(screen.w * screen.h).toBeGreaterThan(c.w * c.h);
      for (let i = 0; i < rects.length; i++)
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i] as Rect;
          const b = rects[j] as Rect;
          const apart =
            a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
    }
  });

  test("without a screen the grid is unchanged", () => {
    expect(gridLayout(3, 1280, 720)).toEqual([
      { x: 0, y: 0, w: 640, h: 360 },
      { x: 640, y: 0, w: 640, h: 360 },
      { x: 320, y: 360, w: 640, h: 360 },
    ]);
  });
});

describe("pickMime", () => {
  const only =
    (...ok: string[]) =>
    (m: string) =>
      ok.includes(m);

  test("video prefers vp9, then vp8, then plain webm, then mp4", () => {
    const all = only(
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
      "video/mp4",
    );
    expect(pickMime(all, "video")).toBe("video/webm;codecs=vp9,opus");
    expect(pickMime(only("video/webm;codecs=vp8,opus", "video/webm"), "video")).toBe(
      "video/webm;codecs=vp8,opus",
    );
    expect(pickMime(only("video/webm", "video/mp4"), "video")).toBe("video/webm");
    expect(pickMime(only("video/mp4"), "video")).toBe("video/mp4");
  });

  test("audio prefers Opus in WebM", () => {
    expect(pickMime(() => true, "audio")).toBe("audio/webm;codecs=opus");
    expect(pickMime(only("audio/ogg;codecs=opus", "audio/mp4"), "audio")).toBe(
      "audio/ogg;codecs=opus",
    );
    expect(pickMime(only("audio/mp4"), "audio")).toBe("audio/mp4");
  });

  test("null when nothing is supported", () => {
    expect(pickMime(() => false, "video")).toBeNull();
    expect(pickMime(() => false, "audio")).toBeNull();
  });
});

describe("recordingNames", () => {
  const date = new Date(2026, 2, 7, 9, 5, 42);

  test("names each part after the local start time", () => {
    expect(recordingNames(date, "video")).toBe("veil-meeting-2026-03-07-0905.webm");
    expect(recordingNames(date, "audio")).toBe("veil-meeting-2026-03-07-0905.audio.webm");
  });

  test("follows the container of the chosen MIME type", () => {
    expect(recordingNames(date, "video", "video/webm;codecs=vp9,opus")).toBe(
      "veil-meeting-2026-03-07-0905.webm",
    );
    expect(recordingNames(date, "video", "video/mp4")).toBe("veil-meeting-2026-03-07-0905.mp4");
    expect(recordingNames(date, "audio", "audio/ogg;codecs=opus")).toBe(
      "veil-meeting-2026-03-07-0905.audio.ogg",
    );
  });
});

describe("initials", () => {
  test("two letters from one or two words", () => {
    expect(initials("alice")).toBe("AL");
    expect(initials("Jean  Dupont")).toBe("JD");
    expect(initials("  ")).toBe("?");
  });
});
