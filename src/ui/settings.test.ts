import { describe, expect, test } from "bun:test";
import { defaultSettings, parseSettings } from "./settings";

describe("parseSettings ai", () => {
  test("keeps valid values", () => {
    const s = parseSettings(
      JSON.stringify({
        ai: { model: "Qwen3.5-4B-q4f16_1-MLC", translateChat: true, modelTranscribe: true },
      }),
    );
    expect(s.ai).toEqual({
      model: "Qwen3.5-4B-q4f16_1-MLC",
      translateChat: true,
      modelTranscribe: true,
    });
  });

  test("missing ai falls back to the defaults", () => {
    expect(parseSettings(JSON.stringify({ nick: "Ana" })).ai).toEqual({
      model: null,
      translateChat: false,
      modelTranscribe: false,
    });
    expect(parseSettings(null).ai).toEqual(defaultSettings().ai);
  });

  test("missing fields fall back one by one", () => {
    const s = parseSettings(JSON.stringify({ ai: { translateChat: true } }));
    expect(s.ai).toEqual({ model: null, translateChat: true, modelTranscribe: false });
  });

  test("bad types fall back to the defaults", () => {
    const s = parseSettings(
      JSON.stringify({ ai: { model: 42, translateChat: "yes", modelTranscribe: 1 } }),
    );
    expect(s.ai).toEqual({ model: null, translateChat: false, modelTranscribe: false });
    expect(parseSettings(JSON.stringify({ ai: "on" })).ai).toEqual(defaultSettings().ai);
    expect(parseSettings(JSON.stringify({ ai: { model: "x".repeat(300) } })).ai.model).toBeNull();
  });
});
