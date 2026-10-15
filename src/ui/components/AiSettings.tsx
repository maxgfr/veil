/**
 * "Language and AI": the language captions and translations use, and the browser's built-in
 * models (speech recognition for captions, Translator, Summarizer, Language detection). The
 * browser runs them on the device; Veil downloads no model of its own. Loaded lazily by the
 * Settings sheet; detection runs the first time it is shown.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  aiBuiltin,
  aiBuiltinProgress,
  aiError,
  type BuiltinName,
  type BuiltinState,
  detectBuiltin,
  downloadBuiltin,
  recheckBuiltin,
} from "../../ai/store";
import { speechRecognition } from "../../features/captions";
import { LANGUAGES, languageName, speechLang } from "../language";
import { saveSettings, settings } from "../settings";
import { Icon } from "./Icons";
import { Toggle } from "./SettingsSheet";

const BUILTIN: { name: BuiltinName; label: string }[] = [
  { name: "translator", label: "Translator" },
  { name: "languageDetector", label: "Language detection" },
  { name: "summarizer", label: "Summarizer (meeting notes)" },
];

const AVAILABILITY: Record<BuiltinState, string> = {
  available: "Ready",
  downloadable: "Downloads on first use",
  downloading: "Downloading…",
  unavailable: "Not available",
  unknown: "Couldn't check",
};

const SUMMARIZER_HINT =
  "Chrome needs its Gemini Nano model for this, which requires lots of free disk space.";

function Progress(props: { pct: number }): JSX.Element {
  return (
    <div
      class="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.pct)}
    >
      <div class="progress-bar" style={{ transform: `scaleX(${Math.min(1, props.pct / 100)})` }} />
    </div>
  );
}

/**
 * Whether the browser recognizes speech in `lang` on the device (captions never go online).
 * Probed on a click only: the probe can take the page down in some Chromium builds.
 */
function useSpeechAvailability(
  lang: string,
): [BuiltinState | "checking" | null, () => void, () => void] {
  const [state, setState] = useState<BuiltinState | "checking" | null>(null);
  const supported = !!speechRecognition()?.available;
  // A new language needs a new check.
  useEffect(() => setState(supported ? null : "unavailable"), [lang, supported]);
  const check = () => {
    const Recognition = speechRecognition();
    if (!Recognition?.available) return;
    setState("checking");
    Recognition.available({ langs: [lang], processLocally: true })
      .then((s) => setState(s))
      .catch(() => setState("unavailable"));
  };
  // From the click: Chrome downloads a model only while handling one.
  const download = () => {
    const Recognition = speechRecognition();
    if (!Recognition?.install) return;
    setState("downloading");
    Recognition.install({ langs: [lang], processLocally: true })
      .then((ok) => setState(ok ? "available" : "unavailable"))
      .catch(() => setState("unavailable"));
  };
  return [state, check, download];
}

function LanguagePicker(): JSX.Element {
  const picked = settings.value.language;
  const browser = navigator.language || "en-US";
  // A language saved earlier but no longer offered still shows as picked.
  const offered: string[] = [...LANGUAGES];
  if (picked && !offered.includes(picked)) offered.push(picked);
  return (
    <label class="field">
      <span class="label">Language</span>
      <select
        class="input"
        data-testid="language-select"
        value={picked}
        onChange={(e) => {
          saveSettings({ ...settings.value, language: e.currentTarget.value });
          void recheckBuiltin();
        }}
      >
        <option value="">Same as the browser ({languageName(browser)})</option>
        {offered
          .map((tag) => ({ tag, name: languageName(tag) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(({ tag, name }) => (
            <option key={tag} value={tag}>
              {name}
            </option>
          ))}
      </select>
      <span class="hint">
        What you speak, for your captions, and what others' captions and messages are translated
        into.
      </span>
    </label>
  );
}

function BuiltinList(): JSX.Element {
  const found = aiBuiltin.value;
  const progress = aiBuiltinProgress.value;
  const [speech, checkSpeech, downloadSpeech] = useSpeechAvailability(speechLang());
  return (
    <div class="stack-sm">
      <span class="label">Built into this browser</span>
      <ul class="ai-builtin" data-testid="ai-builtin">
        <li data-testid="ai-builtin-speech">
          <span>Speech recognition (captions)</span>
          {speech === null ? (
            <button
              type="button"
              class="btn btn-ghost btn-sm"
              data-testid="speech-check"
              onClick={checkSpeech}
            >
              Check
            </button>
          ) : speech === "downloadable" ? (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              data-testid="speech-download"
              onClick={downloadSpeech}
            >
              <Icon name="download" size={16} />
              Download
            </button>
          ) : (
            <span class="muted small" data-testid="ai-builtin-status">
              {speech === "checking" ? "Checking…" : AVAILABILITY[speech]}
            </span>
          )}
        </li>
        {BUILTIN.map(({ name, label }) => {
          const loaded = progress[name];
          const state = found?.[name];
          return (
            <li key={name} data-testid={`ai-builtin-${name}`}>
              <span>{label}</span>
              {loaded !== undefined ? (
                <span class="ai-builtin-progress">
                  <Progress pct={loaded * 100} />
                </span>
              ) : state === undefined ? (
                <span class="muted small">Checking…</span>
              ) : state === "downloadable" ? (
                <button
                  type="button"
                  class="btn btn-secondary btn-sm"
                  onClick={() => void downloadBuiltin(name)}
                >
                  <Icon name="download" size={16} />
                  Download
                </button>
              ) : state === "unknown" ? (
                <span class="row">
                  <span class="muted small" data-testid="ai-builtin-status">
                    {AVAILABILITY.unknown}
                  </span>
                  <button
                    type="button"
                    class="btn btn-ghost btn-sm"
                    onClick={() => void recheckBuiltin()}
                  >
                    Retry
                  </button>
                </span>
              ) : (
                <span class="muted small" data-testid="ai-builtin-status">
                  {AVAILABILITY[state]}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {speech === "unavailable" && (
        <p class="muted small" data-testid="speech-unavailable">
          Captions need a browser that recognizes speech on the device, such as a recent Chrome on a
          computer.
        </p>
      )}
      {found?.summarizer === "unavailable" && <p class="muted small">{SUMMARIZER_HINT}</p>}
    </div>
  );
}

export function AiSettings(): JSX.Element {
  useEffect(() => {
    if (!aiBuiltin.value) void detectBuiltin();
  }, []);
  const ai = settings.value.ai;
  return (
    <fieldset class="group" id="ai-settings" data-testid="ai-settings">
      <legend>Language and AI</legend>
      <p class="muted small">
        Uses only what your browser runs on this device: nothing you type or say is sent.
      </p>
      <LanguagePicker />
      <BuiltinList />
      {aiError.value && (
        <p class="error" role="alert">
          {aiError.value}
        </p>
      )}
      <Toggle
        label="Translate chat"
        hint="Messages in another language show in yours."
        checked={ai.translateChat}
        testid="toggle-translate-chat"
        onChange={(v) => saveSettings({ ...settings.value, ai: { ...ai, translateChat: v } })}
      />
      <p class="muted small">
        Chrome manages its built-in models itself, at chrome://on-device-internals.
      </p>
    </fieldset>
  );
}
