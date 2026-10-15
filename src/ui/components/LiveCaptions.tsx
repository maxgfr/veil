/**
 * Live captions over the stage: each speaker's last two lines, in our language when it can be,
 * and what the captions are doing (listening, or who can't be captioned).
 */
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { baseLang, languageName, myLang, speechLang } from "../language";
import type { LiveCaption, RoomSession } from "../session";

/** A line stays this long after it arrives. */
const SHOW_MS = 6000;
const PER_SPEAKER = 2;

export function LiveCaptions(props: {
  session: RoomSession;
  /** Opens the Settings where the language is picked. */
  onSettings: () => void;
}): JSX.Element | null {
  const s = props.session;
  const on = s.captionsOn.value;
  const all = s.liveCaptions.value;
  const arrived = useRef(new WeakMap<LiveCaption, number>());
  const translated = useRef(new WeakMap<LiveCaption, string>());
  const [, redraw] = useState(0);
  const now = Date.now();
  for (const c of all) if (!arrived.current.has(c)) arrived.current.set(c, now);

  const shown = on ? visible(all, arrived.current, now) : [];
  const mine = myLang();

  // Translate each foreign line once; the original shows until the translation lands.
  useEffect(() => {
    if (!on) return;
    for (const c of shown) {
      if (!c.lang || baseLang(c.lang) === mine || translated.current.has(c)) continue;
      translated.current.set(c, "");
      void translateLine(c, mine).then((text) => {
        if (text === null) return;
        translated.current.set(c, text);
        redraw((n) => n + 1);
      });
    }
  });

  // Redraw when the oldest line is due to go.
  useEffect(() => {
    const due = shown.map((c) => (arrived.current.get(c) ?? now) + SHOW_MS - Date.now());
    if (due.length === 0) return;
    const t = setTimeout(() => redraw((n) => n + 1), Math.max(0, Math.min(...due)) + 20);
    return () => clearTimeout(t);
  });

  if (!on) return null;
  const unavailable = s.captionsUnavailable.value;
  const selfOut = s.media.micOn && unavailable.has(s.peerId);
  const othersOut = [...unavailable].filter((id) => id !== s.peerId && s.room.members.has(id));
  const spoken = languageName(speechLang());
  return (
    <div class="live-captions" aria-live="polite" data-testid="live-captions">
      {selfOut && (
        <p class="live-caption-status" data-testid="captions-unavailable">
          This browser can't recognize {spoken} on this device: what you say isn't captioned.{" "}
          <button type="button" class="live-caption-action" onClick={props.onSettings}>
            Change language
          </button>
        </p>
      )}
      {othersOut.map((id) => (
        <p key={id} class="live-caption-status" data-testid="captions-unavailable-member">
          {s.nickOf(id)}'s browser can't caption their speech.
        </p>
      ))}
      {shown.length === 0 && !selfOut && (
        <p class="live-caption-status" data-testid="captions-listening">
          Captions on, in {spoken}.{" "}
          <button type="button" class="live-caption-action" onClick={props.onSettings}>
            Change
          </button>
        </p>
      )}
      {shown.map((c) => {
        const text = translated.current.get(c);
        return (
          <p key={`${c.nick}-${c.ts}`} class="live-caption" data-testid="live-caption">
            <span class="live-caption-nick">{c.nick}</span> {text || c.text}
            {text && <span class="live-caption-note"> (translated)</span>}
          </p>
        );
      })}
    </div>
  );
}

/** The recent lines, at most two per speaker, oldest first. */
function visible(all: LiveCaption[], arrived: WeakMap<LiveCaption, number>, now: number) {
  const recent = all.filter((c) => now - (arrived.get(c) ?? now) < SHOW_MS);
  const count = new Map<string, number>();
  const keep: LiveCaption[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    if (!c) continue;
    const n = count.get(c.nick) ?? 0;
    if (n >= PER_SPEAKER) continue;
    count.set(c.nick, n + 1);
    keep.unshift(c);
  }
  return keep;
}

async function translateLine(c: LiveCaption, to: string): Promise<string | null> {
  try {
    const { translate } = await import("../../ai/tasks");
    return await translate(c.text, c.lang ?? null, to);
  } catch (err) {
    console.warn("caption translation failed", err);
    return null;
  }
}
