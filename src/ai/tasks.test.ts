import { describe, expect, test } from "bun:test";
import type { Availability, BuiltinApis, LanguageDetectorApi, TranslatorApi } from "./builtin";
import { builtinApis } from "./builtin";
import { canTranslate, detectLang, type TaskDeps, translate } from "./tasks";

const detector = (lang: string, confidence = 0.9, avail: Availability = "available") =>
  ({
    availability: async () => avail,
    create: async () => ({
      detect: async () => [{ detectedLanguage: lang, confidence }],
    }),
  }) satisfies LanguageDetectorApi;

const translator = (avail: Availability = "available") =>
  ({
    availability: async () => avail,
    create: async ({ targetLanguage }) => ({
      translate: async (text: string) => `[${targetLanguage}] ${text}`,
    }),
  }) satisfies TranslatorApi;

const deps = (builtin: BuiltinApis): TaskDeps => ({ builtin });

describe("builtinApis", () => {
  test("picks up only usable globals", () => {
    const scope = { Translator: translator(), LanguageDetector: { availability: 1 } };
    const apis = builtinApis(scope);
    expect(apis.translator).toBe(scope.Translator);
    expect(apis.languageDetector).toBeUndefined();
    expect(builtinApis({})).toEqual({});
  });
});

describe("detectLang", () => {
  test("uses the built-in detector and keeps the base tag", async () => {
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("fr-FR") }))).toBe("fr");
  });

  test("unknown without a ready detector, at low confidence, or for und", async () => {
    expect(await detectLang("Bonjour", deps({}))).toBeNull();
    const downloadable = detector("fr", 0.9, "downloadable");
    expect(await detectLang("Bonjour", deps({ languageDetector: downloadable }))).toBeNull();
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("fr", 0.2) }))).toBeNull();
    expect(await detectLang("Bonjour", deps({ languageDetector: detector("und") }))).toBeNull();
  });
});

describe("translate", () => {
  test("uses the built-in translator", async () => {
    expect(await translate("Bonjour", "fr", "en-US", deps({ translator: translator() }))).toBe(
      "[en] Bonjour",
    );
  });

  test("a downloadable pair still counts", async () => {
    const d = deps({ translator: translator("downloadable") });
    expect(await translate("Bonjour", "fr", "en", d)).toBe("[en] Bonjour");
  });

  test("an unknown source is detected first", async () => {
    const d = deps({ translator: translator(), languageDetector: detector("fr") });
    expect(await translate("Bonjour", null, "en", d)).toBe("[en] Bonjour");
    expect(await translate("Bonjour", null, "en", deps({ translator: translator() }))).toBeNull();
  });

  test("same language is returned as is; nothing available is null", async () => {
    expect(await translate("Hi", "en-GB", "en", deps({}))).toBe("Hi");
    expect(await translate("Bonjour", "fr", "en", deps({}))).toBeNull();
    const d = deps({ translator: translator("unavailable") });
    expect(await translate("Bonjour", "fr", "en", d)).toBeNull();
  });
});

describe("canTranslate", () => {
  test("follows the built-in translator", async () => {
    expect(await canTranslate("fr", "en", deps({ translator: translator() }))).toBe(true);
    expect(await canTranslate("en", "en-US", deps({ translator: translator() }))).toBe(false);
    expect(await canTranslate(null, "en", deps({ translator: translator() }))).toBe(false);
    expect(await canTranslate("fr", "en", deps({ translator: translator("unavailable") }))).toBe(
      false,
    );
  });
});
