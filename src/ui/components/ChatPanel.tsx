import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { myLang } from "../language";
import type { RoomSession } from "../session";
import { settings } from "../settings";
import { FileCard } from "./FileCard";
import { formatTime, hueOf } from "./format";
import { Icon } from "./Icons";

export function ChatPanel(props: { session: RoomSession; onClose?: () => void }): JSX.Element {
  const s = props.session;
  s.tick.value;
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const messages = s.messages();
  const typing = s.chat.typingNow().map((id) => s.nickOf(id));

  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, typing.length]);

  useEffect(() => {
    s.setChatOpen(true);
    return () => s.setChatOpen(false);
  }, []);

  const send = () => {
    const t = text;
    if (!t.trim()) return;
    setText("");
    stick.current = true;
    void s.sendText(t);
  };

  return (
    <section class="chat" aria-label="Chat">
      <header class="panel-head">
        <h2>Chat</h2>
        {props.onClose && (
          <button type="button" class="icon-btn" onClick={props.onClose} aria-label="Close chat">
            <Icon name="x" />
          </button>
        )}
      </header>
      <div
        class="messages"
        ref={list}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        data-testid="messages"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {messages.length === 0 && (
          <div class="empty-chat">
            <Icon name="lock" size={22} />
            <p>
              Messages are end-to-end encrypted and never stored. They disappear when you leave.
            </p>
          </div>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const grouped =
            prev &&
            prev.author === m.author &&
            m.ts - prev.ts < 120_000 &&
            !m.fileId &&
            !prev.fileId;
          const view = m.fileId ? s.fileView(m.fileId) : null;
          return (
            <div
              key={m.id}
              class={`msg${m.mine ? " mine" : ""}${grouped ? " grouped" : ""}`}
              data-testid="message"
            >
              {!grouped && (
                <div class="msg-head">
                  <span
                    class="msg-author"
                    style={{
                      color: m.mine ? undefined : `oklch(var(--name-l) 0.12 ${hueOf(m.author)})`,
                    }}
                  >
                    {m.mine ? "You" : s.nickOf(m.author)}
                  </span>
                  <time class="msg-time tabular">{formatTime(m.ts)}</time>
                </div>
              )}
              {view ? (
                <FileCard view={view} session={s} />
              ) : !m.mine ? (
                <TheirText text={m.text} />
              ) : (
                <div class="bubble">
                  {m.text}
                  {m.mine && (
                    <span
                      class="receipt"
                      title={m.delivered.size ? `Delivered to ${m.delivered.size}` : "Sent"}
                    >
                      <Icon name="check" size={14} />
                      {m.delivered.size > 0 && <span class="tabular">{m.delivered.size}</span>}
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div class="typing" aria-live="polite">
        {typing.length > 0 &&
          `${typing.slice(0, 2).join(", ")}${typing.length > 2 ? " and others" : ""} typing…`}
      </div>
      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            const files = e.currentTarget.files;
            if (files?.length) void s.offerFiles([...files]);
            e.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          class="icon-btn"
          aria-label="Send a file"
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="attach" />
        </button>
        <textarea
          class="composer-input"
          rows={1}
          value={text}
          placeholder="Message"
          aria-label="Message"
          data-testid="composer"
          maxLength={8000}
          onInput={(e) => {
            setText(e.currentTarget.value);
            s.chat.setTyping(e.currentTarget.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="submit"
          class="icon-btn icon-btn-accent"
          aria-label="Send"
          disabled={!text.trim()}
          data-testid="send"
        >
          <Icon name="send" />
        </button>
      </form>
    </section>
  );
}

/**
 * Someone else's message, with "Translate" when it is in another language.
 * Without a language detector the action only shows on hover or focus.
 */
function TheirText(props: { text: string }): JSX.Element {
  // Read in render: a language picked in Settings re-checks and re-translates.
  const mine = myLang();
  const [offer, setOffer] = useState<"no" | "known" | "unknown">("no");
  const [lang, setLang] = useState<string | null>(null);
  /** The last translation, with the language it is in. */
  const [translated, setTranslated] = useState<{ to: string; text: string } | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  // A translation into another language than ours is stale: the original shows.
  const current = translated?.to === mine ? translated.text : null;
  const shown = showing && current !== null;

  const run = async (from: string | null) => {
    setBusy(true);
    try {
      const { translate } = await import("../../ai/tasks");
      const text = await translate(props.text, from, mine);
      if (text !== null && text !== props.text) {
        setTranslated({ to: mine, text });
        setShowing(true);
      }
    } catch (err) {
      console.warn("message translation failed", err);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let live = true;
    setOffer("no");
    void (async () => {
      const { canTranslate, detectLang } = await import("../../ai/tasks");
      const detector = "LanguageDetector" in globalThis;
      const from = detector ? await detectLang(props.text) : null;
      if (!live || (detector && (from === null || from === mine))) return;
      if (!(await canTranslate(from, mine)) || !live) return;
      setLang(from);
      setOffer(from === null ? "unknown" : "known");
      if (settings.value.ai.translateChat && from !== null) void run(from);
    })().catch((err) => console.warn("language check failed", err));
    return () => {
      live = false;
    };
  }, [props.text, mine]);

  return (
    <>
      <div class="bubble" lang={shown ? mine : (lang ?? undefined)}>
        {shown ? current : props.text}
      </div>
      {offer !== "no" && (
        <button
          type="button"
          class={`translate-msg${offer === "unknown" && !current ? " on-hover" : ""}`}
          disabled={busy}
          onClick={() => {
            if (current) setShowing(!showing);
            else void run(lang);
          }}
          data-testid="translate-msg"
        >
          {shown ? "Show original" : busy ? "Translating…" : "Translate"}
        </button>
      )}
    </>
  );
}
