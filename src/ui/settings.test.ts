import { describe, expect, test } from "bun:test";
import { defaultSettings, parseSettings } from "./settings";

describe("parseSettings ai", () => {
  test("keeps valid values", () => {
    expect(parseSettings(JSON.stringify({ ai: { translateChat: true } })).ai).toEqual({
      translateChat: true,
    });
  });

  test("missing or bad ai falls back to the defaults", () => {
    expect(parseSettings(JSON.stringify({ nick: "Ana" })).ai).toEqual({ translateChat: false });
    expect(parseSettings(null).ai).toEqual(defaultSettings().ai);
    expect(parseSettings(JSON.stringify({ ai: "on" })).ai).toEqual(defaultSettings().ai);
    expect(parseSettings(JSON.stringify({ ai: { translateChat: "yes" } })).ai).toEqual({
      translateChat: false,
    });
  });

  test("the old on-device model choices are dropped", () => {
    const s = parseSettings(
      JSON.stringify({
        ai: { model: "Qwen3.5-4B-q4f16_1-MLC", translateChat: true, speechModel: "whisper" },
      }),
    );
    expect(s.ai).toEqual({ translateChat: true });
  });
});

describe("parseSettings screenQuality", () => {
  test("defaults to detail", () => {
    expect(defaultSettings().screenQuality).toBe("detail");
    expect(parseSettings(null).screenQuality).toBe("detail");
    expect(parseSettings(JSON.stringify({ nick: "Ana" })).screenQuality).toBe("detail");
  });

  test("keeps a known value", () => {
    expect(parseSettings(JSON.stringify({ screenQuality: "motion" })).screenQuality).toBe("motion");
    expect(parseSettings(JSON.stringify({ screenQuality: "detail" })).screenQuality).toBe("detail");
  });

  test("an unknown value falls back to the default", () => {
    expect(parseSettings(JSON.stringify({ screenQuality: "4k" })).screenQuality).toBe("detail");
    expect(parseSettings(JSON.stringify({ screenQuality: 1 })).screenQuality).toBe("detail");
  });
});

describe("parseSettings layout", () => {
  test("defaults to auto", () => {
    expect(defaultSettings().layout).toBe("auto");
    expect(parseSettings(null).layout).toBe("auto");
  });

  test("keeps a known value", () => {
    for (const layout of ["auto", "grid", "spotlight"] as const)
      expect(parseSettings(JSON.stringify({ layout })).layout).toBe(layout);
  });

  test("an unknown value falls back to the default", () => {
    expect(parseSettings(JSON.stringify({ layout: "tiles" })).layout).toBe("auto");
    expect(parseSettings(JSON.stringify({ layout: null })).layout).toBe("auto");
  });
});

describe("parseSettings videoFit", () => {
  test("defaults to the whole picture", () => {
    expect(defaultSettings().videoFit).toBe("contain");
    expect(parseSettings(null).videoFit).toBe("contain");
  });

  test("keeps a known value", () => {
    for (const videoFit of ["contain", "cover", "fill"] as const)
      expect(parseSettings(JSON.stringify({ videoFit })).videoFit).toBe(videoFit);
  });

  test("an unknown value falls back to the default", () => {
    expect(parseSettings(JSON.stringify({ videoFit: "zoom" })).videoFit).toBe("contain");
    expect(parseSettings(JSON.stringify({ videoFit: 1 })).videoFit).toBe("contain");
  });
});

describe("parseSettings language", () => {
  test("defaults to the browser's", () => {
    expect(defaultSettings().language).toBe("");
    expect(parseSettings(null).language).toBe("");
  });

  test("keeps a language tag", () => {
    expect(parseSettings(JSON.stringify({ language: "fr-FR" })).language).toBe("fr-FR");
    expect(parseSettings(JSON.stringify({ language: "ja" })).language).toBe("ja");
  });

  test("anything else falls back to the browser's", () => {
    expect(parseSettings(JSON.stringify({ language: "<b>" })).language).toBe("");
    expect(parseSettings(JSON.stringify({ language: 7 })).language).toBe("");
  });
});
