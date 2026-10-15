/**
 * "AI on this device": the browser's built-in models, the on-device model
 * (size, memory, why), its download, and the AI options. Loaded lazily by the
 * Settings sheet; detection runs the first time it is shown. Nothing
 * downloads without a click, and the size is always shown first.
 */
import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import type { Availability } from "../../ai/builtin";
import { formatGb, isAudioModel, type ModelChoice, type Recommendation } from "../../ai/models";
import {
  aiAudioFit,
  aiBuiltin,
  aiBuiltinProgress,
  aiCache,
  aiDetecting,
  aiError,
  aiModelId,
  aiProgress,
  aiRecommendation,
  aiStatus,
  type BuiltinName,
  cancelLoad,
  detectAi,
  downloadBuiltin,
  loadModel,
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

const AVAILABILITY: Record<Availability, string> = {
  available: "Ready",
  downloadable: "Downloads on first use",
  downloading: "Downloading…",
  unavailable: "Not available",
};

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
            return (
              <li key={name}>
                <span>{label}</span>
                {loaded !== undefined ? (
                  <span class="ai-builtin-progress">
                    <Progress pct={loaded * 100} />
                  </span>
                ) : found[name] === "downloadable" ? (
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    onClick={() => void downloadBuiltin(name)}
                  >
                    <Icon name="download" size={16} />
                    Download
                  </button>
                ) : (
                  <span class="muted small">{AVAILABILITY[found[name]]}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
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

function Transcription(props: { chosen: ModelChoice | null }): JSX.Element {
  const ai = settings.value.ai;
  const { chosen } = props;
  const audioOk = chosen !== null && isAudioModel(chosen.id);
  // Checked on its own: Gemma may fit even when other models rank above it.
  const audioFits = aiAudioFit.value;
  return (
    <>
      <Toggle
        label="Transcribe with Gemma"
        hint="On-device transcription for captions and recordings. Running it during a call may slow video."
        checked={ai.modelTranscribe}
        testid="toggle-model-transcribe"
        onChange={(v) => saveSettings({ ...settings.value, ai: { ...ai, modelTranscribe: v } })}
      />
      {ai.modelTranscribe && !audioOk && (
        <div class="row row-between">
          <span class="small">Requires Gemma 4 E2B</span>
          {audioFits ? (
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              onClick={() => use(audioFits.id)}
            >
              Use {audioFits.label} ({formatGb(audioFits.downloadBytes)})
            </button>
          ) : (
            <span class="muted small">It doesn't fit on this device.</span>
          )}
        </div>
      )}
    </>
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
  const all = [rec.fits, rec.best, ...rec.alternatives, aiAudioFit.value].filter(
    (m): m is ModelChoice => !!m,
  );
  const picked = settings.value.ai.model;
  // Nothing picked: the best model for the device, and an offer below if it doesn't fit.
  const model = all.find((m) => m.id === picked) ?? rec.best ?? rec.fits;
  if (!model) return null;
  const fitting = [rec.fits, ...rec.alternatives, aiAudioFit.value].some((m) => m?.id === model.id);
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
  const all = rec ? [rec.fits, rec.best, ...rec.alternatives, aiAudioFit.value] : [];
  const chosen = all.find((m) => m?.id === (ai.model ?? rec?.best?.id)) ?? null;
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
      {rec && !rec.unsupported && <Transcription chosen={chosen} />}
    </fieldset>
  );
}
