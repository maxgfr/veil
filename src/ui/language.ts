/** The language the user reads and speaks: the one picked in Settings, else the browser's. */
import { settings } from "./settings";

/** The languages offered in Settings, as recognition tags. */
export const LANGUAGES = [
  "ar-SA",
  "de-DE",
  "en-GB",
  "en-US",
  "es-ES",
  "fr-FR",
  "hi-IN",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "nl-NL",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ru-RU",
  "sv-SE",
  "tr-TR",
  "uk-UA",
  "vi-VN",
  "zh-CN",
] as const;

/** "en-US" → "en". */
export function baseLang(tag: string): string {
  return tag.split("-")[0]?.toLowerCase() ?? tag;
}

/** The base language translations land in, such as "fr": the one picked, else the browser's. */
export function myLang(): string {
  return baseLang(settings.value.language || navigator.language || "en-US");
}

/** "fr-FR" → "French (France)"; an odd tag is shown as is. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
