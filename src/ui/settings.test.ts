import { describe, expect, test } from "bun:test";
import { defaultSettings, parseSettings } from "./settings";

describe("parseSettings ai", () => {
  test("keeps valid values", () => {
    const s = parseSettings(
      JSON.stringify({
        ai: {
          model: "Qwen3.5-4B-q4f16_1-MLC",
          translateChat: true,
          speechModel: "onnx-community/whisper-small",
        },
      }),
    );
    expect(s.ai).toEqual({
      model: "Qwen3.5-4B-q4f16_1-MLC",
      translateChat: true,
      speechModel: "onnx-community/whisper-small",
    });
  });

  test("missing ai falls back to the defaults", () => {
    expect(parseSettings(JSON.stringify({ nick: "Ana" })).ai).toEqual({
      model: null,
      translateChat: false,
      speechModel: null,
    });
    expect(parseSettings(null).ai).toEqual(defaultSettings().ai);
  });

  test("missing fields fall back one by one", () => {
    const s = parseSettings(JSON.stringify({ ai: { translateChat: true } }));
    expect(s.ai).toEqual({ model: null, translateChat: true, speechModel: null });
  });

  test("bad types fall back to the defaults", () => {
    const s = parseSettings(
      JSON.stringify({ ai: { model: 42, translateChat: "yes", speechModel: true } }),
    );
    expect(s.ai).toEqual({ model: null, translateChat: false, speechModel: null });
    expect(parseSettings(JSON.stringify({ ai: "on" })).ai).toEqual(defaultSettings().ai);
    expect(parseSettings(JSON.stringify({ ai: { model: "x".repeat(300) } })).ai.model).toBeNull();
    expect(
      parseSettings(JSON.stringify({ ai: { speechModel: "x".repeat(300) } })).ai.speechModel,
    ).toBeNull();
  });

  test("the old Gemma transcription switch is ignored", () => {
    const s = parseSettings(
      JSON.stringify({ ai: { model: "gemma-4-E2B-it-q4f16_1-MLC", modelTranscribe: true } }),
    );
    expect(s.ai).toEqual({
      model: "gemma-4-E2B-it-q4f16_1-MLC",
      translateChat: false,
      speechModel: null,
    });
    expect("modelTranscribe" in s.ai).toBe(false);
  });
});
