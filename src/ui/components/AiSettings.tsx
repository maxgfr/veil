/**
 * "AI on this device": the browser's built-in models, the on-device model
 * (size, memory, why), the Whisper model for speech, their downloads, the AI
 * options, and deleting it all. Loaded lazily by the Settings sheet; detection runs the first
 * time it is shown. Nothing downloads without a click, and the size is always
 * shown first.
 */
import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { formatGb, type ModelChoice, type Recommendation } from "../../ai/models";
import { formatMb, type SpeechChoice } from "../../ai/speechModels";
import {
  cancelSpeechLoad,
  loadSpeechModel,
  removeSpeechModel,
  selectSpeechModel,
  speechCache,
  speechError,
  speechModelId,
  speechProgress,
  speechRecommendation,
  speechStatus,
} from "../../ai/speechStore";
import {
  aiBuiltin,
  aiBuiltinProgress,
  aiCache,
  aiDataBytes,
  aiDetecting,
  aiError,
  aiModelId,
  aiProgress,
  aiRecommendation,
  aiStatus,
  aiWipe,
  type BuiltinName,
  type BuiltinState,
  cancelLoad,
  deleteAllAiData,
  detectAi,
  downloadBuiltin,
  loadModel,
  recheckBuiltin,
  refreshCache,
  removeModel,
  selectModel,
} from "../../ai/store";
import { clearTemporaryFiles } from "../../features/files";
import { saveSettings, settings } from "../settings";
import { Icon } from "./Icons";
import { Toggle } from "./SettingsSheet";

const UNSUPPORTED: Record<NonNullable<Recommendation["unsupported"]>, string> = {
  "no-webgpu": "This browser has no WebGPU, so it can't run an on-device model.",
  "no-adapter": "WebGPU is present but found no usable graphics adapter.",
  "too-little-memory": "This device's graphics memory is too small for any on-device model.",
};

const BUILTIN: { name: BuiltinName; label: string }[] = [
  { name: "summarizer", label: "Summarizer" },
  { name: "translator", label: "Translator" },
  { name: "languageDetector", label: "Language detection" },
];

const AVAILABILITY: Record<BuiltinState, string> = {
  available: "Ready",
  downloadable: "Downloads on first use",
  downloading: "Downloading…",
  unavailable: "Not available",
  unknown: "Couldn't check",
};

const SUMMARIZER_HINT =
  "Chrome needs its Gemini Nano model for this, which requires lots of free disk space. " +
  "Meeting notes still work with a downloaded model.";

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

function BuiltinList(): JSX.Element {
  const found = aiBuiltin.value;
  const progress = aiBuiltinProgress.value;
  return (
    <div class="stack-sm">
      <span class="label">Built into this browser</span>
      {!found ? (
        <p class="muted small">Checking…</p>
      ) : (
        <ul class="ai-builtin" data-testid="ai-builtin">
          {BUILTIN.map(({ name, label }) => {
            const loaded = progress[name];
            const state = found[name];
            return (
              <li key={name} data-testid={`ai-builtin-${name}`}>
                <span>{label}</span>
                {loaded !== undefined ? (
                  <span class="ai-builtin-progress">
                    <Progress pct={loaded * 100} />
                  </span>
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
      )}
      {found?.summarizer === "unavailable" && <p class="muted small">{SUMMARIZER_HINT}</p>}
    </div>
  );
}

function memory(m: ModelChoice): string {
  return `${(m.vramMb / 1000).toFixed(1)} GB`;
}

function ModelActions(props: { model: ModelChoice; canDownload: boolean }): JSX.Element {
  const { model } = props;
  const mine = aiModelId.value === model.id;
  const cache = aiCache.value[model.id];
  const progress = aiProgress.value;
  if (mine && aiStatus.value === "loading") {
    return (
      <div class="stack-sm">
        <Progress pct={(progress?.progress ?? 0) * 100} />
        <div class="row row-between">
          <span class="muted small">{progress?.text || "Starting…"}</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void cancelLoad()}>
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const remove = cache?.cached && (
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      data-testid="ai-delete"
      onClick={() => void removeModel(model.id)}
    >
      Delete
    </button>
  );
  if (mine && aiStatus.value === "ready") {
    return (
      <div class="row row-between">
        <span class="small">
          <Icon name="check" size={16} /> Ready
        </span>
        {remove}
      </div>
    );
  }
  const label = cache?.complete ? "Load" : cache?.cached ? "Resume download" : "Download";
  return (
    <div class="row row-between">
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="ai-download"
        disabled={!props.canDownload && !cache?.complete}
        onClick={() => void loadModel(model.id)}
      >
        <Icon name="download" size={16} />
        {label}
      </button>
      {remove}
    </div>
  );
}

function ModelCard(props: { model: ModelChoice; canDownload: boolean }): JSX.Element {
  const { model } = props;
  return (
    <div class="ai-model" data-testid="ai-model">
      <div class="ai-model-head">
        <Icon name="sparkle" size={20} />
        <span class="file-name">{model.label}</span>
      </div>
      <div class="file-meta">
        <span class="tabular">
          {formatGb(model.downloadBytes)} download · {memory(model)} of memory
        </span>
        <span>{model.reason}</span>
      </div>
      <ModelActions model={model} canDownload={props.canDownload} />
    </div>
  );
}

function FreeSpace(props: { keep: string }): JSX.Element {
  const others = Object.entries(aiCache.value).filter(([id, c]) => c.cached && id !== props.keep);
  const rec = aiRecommendation.value;
  const labelOf = (id: string) =>
    [rec?.best, rec?.fits, ...(rec?.alternatives ?? [])].find((m) => m?.id === id)?.label ?? id;
  return (
    <div class="stack-sm" data-testid="ai-free-space">
      <span class="label">Free up space</span>
      <div class="row row-between">
        <span class="small">Veil's temporary files</span>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          onClick={() => void clearTemporaryFiles().then(detectAi)}
        >
          Clear
        </button>
      </div>
      {others.map(([id]) => (
        <div class="row row-between" key={id}>
          <span class="small">{labelOf(id)}</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void removeModel(id).then(detectAi)}
          >
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

function use(id: string): void {
  selectModel(id);
  void refreshCache(id);
}

/** Download, resume, cancel or delete one Whisper model; a downloaded one is used, or can be. */
function SpeechActions(props: { choice: SpeechChoice }): JSX.Element {
  const { choice } = props;
  const mine = speechModelId.value === choice.id;
  const cache = speechCache.value[choice.id];
  const progress = speechProgress.value;
  if (mine && speechStatus.value === "loading") {
    return (
      <div class="stack-sm ai-grow">
        <Progress pct={(progress?.progress ?? 0) * 100} />
        <div class="row row-between">
          <span class="muted small tabular">{progress?.text || "Starting…"}</span>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            onClick={() => void cancelSpeechLoad()}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }
  const remove = cache?.cached && (
    <button
      type="button"
      class="btn btn-ghost btn-sm"
      data-testid="speech-delete"
      onClick={() => void removeSpeechModel(choice.id)}
    >
      Delete
    </button>
  );
  if (cache?.complete) {
    return (
      <div class="row row-between">
        {settings.value.ai.speechModel === choice.id ? (
          <span class="small" data-testid="speech-in-use">
            <Icon name="check" size={16} /> Downloaded, in use
          </span>
        ) : (
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            onClick={() => selectSpeechModel(choice.id)}
          >
            Use
          </button>
        )}
        {remove}
      </div>
    );
  }
  return (
    <div class="row row-between">
      <button
        type="button"
        class="btn btn-primary btn-sm"
        data-testid="speech-download"
        // One download at a time: the others wait for it to end (or its Cancel).
        disabled={!choice.runs || !choice.fits || speechStatus.value === "loading"}
        onClick={() => void loadSpeechModel(choice.id)}
      >
        <Icon name="download" size={16} />
        {cache?.cached ? "Resume download" : "Download"}
      </button>
      {remove}
    </div>
  );
}

/**
 * Whisper, for captions and recordings when the browser can't recognize speech
 * on the device: the model in use (else the one recommended), the others below.
 */
function SpeechModels(): JSX.Element {
  const rec = speechRecommendation.value;
  const all = rec ? [rec.pick, ...rec.others] : [];
  const main = all.find((c) => c.id === settings.value.ai.speechModel) ?? rec?.pick;
  const others = all.filter((c) => c !== main);
  return (
    <div class="stack-sm" data-testid="speech-settings">
      <span class="label">Speech recognition</span>
      <p class="muted small">
        Used for captions and recordings when this browser can't recognize speech on the device.
        Running it during a call may slow video.
      </p>
      {!main ? (
        <p class="muted small">Checking…</p>
      ) : (
        <>
          <div class="ai-model" data-testid="speech-model">
            <div class="ai-model-head">
              <Icon name="captions" size={20} />
              <span class="file-name">{main.label}</span>
            </div>
            <div class="file-meta">
              <span class="tabular">{formatMb(main.downloadBytes)} download</span>
              <span>{main.reason}</span>
            </div>
            <SpeechActions choice={main} />
          </div>
          <details class="ai-alternatives">
            <summary>Other Whisper models</summary>
            <ul>
              {others.map((c) => (
                <li key={c.id}>
                  <span class="file-meta">
                    <span class="file-name">{c.label}</span>
                    <span class="tabular">{formatMb(c.downloadBytes)} download</span>
                    <span>{c.reason}</span>
                  </span>
                  <SpeechActions choice={c} />
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {speechError.value && (
        <p class="error" role="alert">
          {speechError.value}
        </p>
      )}
    </div>
  );
}

/** "Delete all AI data", in two steps: the button, then a confirmation with the size freed. */
function DeleteAll(): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const bytes = aiDataBytes.value;
  const size = bytes >= 1e9 ? formatGb(bytes) : formatMb(bytes);
  const { busy, error } = aiWipe.value;
  return (
    <div class="stack-sm" data-testid="ai-delete-all">
      {confirming ? (
        <div class="row">
          <button
            type="button"
            class="btn btn-danger-ghost btn-sm"
            data-testid="ai-delete-all-confirm"
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              void deleteAllAiData();
            }}
          >
            Confirm — free {size}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          class="btn btn-danger-ghost btn-sm"
          data-testid="ai-delete-all-button"
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {busy ? "Deleting…" : `Delete all AI data (${size})`}
        </button>
      )}
      <p class="muted small">
        Chrome's built-in models (Summarizer, Translator, Language detection) are managed by Chrome
        itself, at chrome://on-device-internals.
      </p>
      {error && (
        <p class="error" role="alert" data-testid="ai-delete-all-error">
          {error}
        </p>
      )}
    </div>
  );
}

function LocalModel(props: { rec: Recommendation }): JSX.Element | null {
  const { rec } = props;
  if (rec.unsupported) {
    return (
      <p class="note" data-testid="ai-unsupported">
        <Icon name="alert" size={16} />
        {UNSUPPORTED[rec.unsupported]}
      </p>
    );
  }
  const all = [rec.fits, rec.best, ...rec.alternatives].filter((m): m is ModelChoice => !!m);
  const picked = settings.value.ai.model;
  // Nothing picked: the best model for the device, and an offer below if it doesn't fit.
  const model = all.find((m) => m.id === picked) ?? rec.best ?? rec.fits;
  if (!model) return null;
  const fitting = [rec.fits, ...rec.alternatives].some((m) => m?.id === model.id);
  const alternatives = [rec.fits, ...rec.alternatives]
    .filter((m): m is ModelChoice => !!m && m.id !== model.id)
    .slice(0, 3);
  return (
    <>
      <ModelCard model={model} canDownload={fitting} />
      {!fitting && (
        <div class="stack-sm" data-testid="ai-space">
          {rec.spaceNote && (
            <p class="note">
              <Icon name="alert" size={16} />
              {rec.spaceNote}
            </p>
          )}
          {rec.fits && rec.fits.id !== model.id && (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={() => use((rec.fits as ModelChoice).id)}
            >
              Use {rec.fits.label} ({formatGb(rec.fits.downloadBytes)})
            </button>
          )}
          <FreeSpace keep={model.id} />
        </div>
      )}
      {alternatives.length > 0 && (
        <details class="ai-alternatives">
          <summary>Other models</summary>
          <ul>
            {alternatives.map((m) => (
              <li key={m.id}>
                <span class="file-meta">
                  <span class="file-name">{m.label}</span>
                  <span class="tabular">
                    {formatGb(m.downloadBytes)} download · {memory(m)} of memory
                  </span>
                  <span>{m.reason}</span>
                </span>
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => use(m.id)}>
                  Use
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

export function AiSettings(): JSX.Element {
  useEffect(() => {
    if (!aiRecommendation.value && !aiDetecting.value) void detectAi();
  }, []);
  const rec = aiRecommendation.value;
  const ai = settings.value.ai;
  return (
    <fieldset class="group" id="ai-settings" data-testid="ai-settings">
      <legend>AI on this device</legend>
      <p class="muted small">
        Runs on this device. Weights come once from Hugging Face; nothing you type or say is sent.
      </p>
      <BuiltinList />
      {!rec ? (
        <p class="muted small">Checking what this device can run…</p>
      ) : (
        <LocalModel rec={rec} />
      )}
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
      <SpeechModels />
      <DeleteAll />
    </fieldset>
  );
}
