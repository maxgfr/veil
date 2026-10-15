import { afterEach, describe, expect, test } from "bun:test";
import { baseLang, languageName, myLang } from "./language";
import { defaultSettings, settings } from "./settings";

afterEach(() => {
  settings.value = defaultSettings();
});

describe("language", () => {
  test("follows the browser until one is picked", () => {
    settings.value = { ...defaultSettings(), language: "" };
    expect(myLang()).toBe(baseLang(navigator.language || "en-US"));
    settings.value = { ...defaultSettings(), language: "ja-JP" };
    expect(myLang()).toBe("ja");
  });

  test("names a tag, and keeps an odd one as is", () => {
    expect(baseLang("pt-BR")).toBe("pt");
    expect(languageName("fr")).toBe("French");
    expect(languageName("not a tag")).toBe("not a tag");
  });
});
