import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  defaultSettings,
  parseUrlList,
  resetSettings,
  type Settings,
  saveSettings,
  settings,
} from "../settings";
import { Sheet } from "./Sheet";

function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testid?: string;
}): JSX.Element {
  return (
    <label class="toggle">
      <span>
        <span class="toggle-label">{props.label}</span>
        <span class="toggle-hint">{props.hint}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        checked={props.checked}
        data-testid={props.testid}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
    </label>
  );
}

export function SettingsSheet(props: {
  open: boolean;
  onClose: () => void;
  inRoom: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<Settings>(settings.value);
  const [relays, setRelays] = useState("");
  const [trackers, setTrackers] = useState("");
  const [stun, setStun] = useState("");

  useEffect(() => {
    if (!props.open) return;
    const s = settings.value;
    setDraft(s);
    setRelays(s.nostr.relays.join("\n"));
    setTrackers(s.torrent.trackers.join("\n"));
    setStun(s.stun.join("\n"));
  }, [props.open]);

  const save = () => {
    saveSettings({
      ...draft,
      nostr: { ...draft.nostr, relays: parseUrlList(relays, ["wss://", "ws://"]) },
      torrent: { ...draft.torrent, trackers: parseUrlList(trackers, ["wss://", "ws://"]) },
      stun: parseUrlList(stun, ["stun:", "stuns:"]),
    });
    props.onClose();
  };

  const turn = draft.turn ?? { urls: "", username: "", credential: "" };
  const setTurn = (patch: Partial<typeof turn>) => {
    const next = { ...turn, ...patch };
    setDraft({ ...draft, turn: next.urls ? next : null });
  };

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Settings" wide testid="settings-sheet">
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {props.inRoom && (
          <p class="note">Connection settings apply the next time you join a room.</p>
        )}
        <label class="field">
          <span class="label">Your name</span>
          <input
            class="input"
            maxLength={40}
            value={draft.nick}
            autoComplete="nickname"
            onInput={(e) => setDraft({ ...draft, nick: e.currentTarget.value })}
          />
        </label>

        <fieldset class="group">
          <legend>How peers find each other</legend>
          <p class="muted small">
            Used only to exchange the first, encrypted connection offer. Relays and trackers see
            ciphertext and a topic that changes every day, never who you are talking to.
          </p>
          <Toggle
            label="Nostr relays"
            hint="Ephemeral events, never stored"
            checked={draft.nostr.enabled}
            testid="toggle-nostr"
            onChange={(v) => setDraft({ ...draft, nostr: { ...draft.nostr, enabled: v } })}
          />
          {draft.nostr.enabled && (
            <textarea
              class="input mono"
              rows={4}
              value={relays}
              aria-label="Nostr relays, one per line"
              onInput={(e) => setRelays(e.currentTarget.value)}
            />
          )}
          <Toggle
            label="WebTorrent trackers"
            hint="Public trackers as a rendezvous"
            checked={draft.torrent.enabled}
            testid="toggle-torrent"
            onChange={(v) => setDraft({ ...draft, torrent: { ...draft.torrent, enabled: v } })}
          />
          {draft.torrent.enabled && (
            <textarea
              class="input mono"
              rows={3}
              value={trackers}
              aria-label="Trackers, one per line"
              onInput={(e) => setTrackers(e.currentTarget.value)}
            />
          )}
          <Toggle
            label="Manual connect"
            hint="Exchange codes by QR or copy-paste, no network"
            checked={draft.manual.enabled}
            onChange={(v) => setDraft({ ...draft, manual: { enabled: v } })}
          />
        </fieldset>

        <fieldset class="group">
          <legend>Network traversal</legend>
          <label class="field">
            <span class="label">STUN servers</span>
            <textarea
              class="input mono"
              rows={2}
              value={stun}
              onInput={(e) => setStun(e.currentTarget.value)}
            />
            <span class="hint">
              They see your public IP address, nothing else. Leave empty for local networks only.
            </span>
          </label>
          <label class="field">
            <span class="label">TURN server (optional)</span>
            <input
              class="input mono"
              placeholder="turns:turn.example.com:443"
              value={turn.urls}
              onInput={(e) => setTurn({ urls: e.currentTarget.value.trim() })}
            />
            <span class="hint">
              Relays encrypted traffic when a direct connection is impossible (strict NATs, some
              mobile carriers).
            </span>
          </label>
          {turn.urls && (
            <div class="row">
              <input
                class="input"
                placeholder="Username"
                value={turn.username}
                onInput={(e) => setTurn({ username: e.currentTarget.value })}
                aria-label="TURN username"
              />
              <input
                class="input"
                type="password"
                placeholder="Credential"
                value={turn.credential}
                onInput={(e) => setTurn({ credential: e.currentTarget.value })}
                aria-label="TURN credential"
              />
            </div>
          )}
        </fieldset>

        <div class="row row-between">
          <button
            type="button"
            class="btn btn-ghost"
            onClick={() => {
              resetSettings();
              const d = { ...defaultSettings(), nick: draft.nick };
              setDraft(d);
              setRelays(d.nostr.relays.join("\n"));
              setTrackers(d.torrent.trackers.join("\n"));
              setStun(d.stun.join("\n"));
            }}
          >
            Reset to defaults
          </button>
          <button type="submit" class="btn btn-primary" data-testid="settings-save">
            Save
          </button>
        </div>
      </form>
    </Sheet>
  );
}
