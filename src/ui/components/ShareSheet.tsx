import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { RoomSession } from "../session";
import { CopyButton, copyText } from "./CopyButton";
import { Icon } from "./Icons";
import { QrCode } from "./QrCode";
import { QrScanner } from "./QrScanner";
import { Sheet } from "./Sheet";

export function ShareSheet(props: {
  open: boolean;
  onClose: () => void;
  link: string;
  hasPassphrase: boolean;
  session: RoomSession;
}): JSX.Element {
  const [tab, setTab] = useState<"link" | "manual">("link");
  const canShare = typeof navigator.share === "function";

  return (
    <Sheet open={props.open} onClose={props.onClose} title="Invite people" testid="share-sheet">
      <div class="segmented" role="tablist" aria-label="Invite method">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "link"}
          onClick={() => setTab("link")}
        >
          Link
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "manual"}
          onClick={() => setTab("manual")}
          data-testid="manual-tab"
        >
          Manual connect
        </button>
      </div>
      {tab === "link" ? (
        <div class="stack">
          <div class="qr-wrap">
            <QrCode value={props.link} label="QR code of the room link" />
          </div>
          <div class="copy-row">
            <input
              class="input mono"
              readOnly
              value={props.link}
              aria-label="Room link"
              data-testid="room-link"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton text={props.link} />
          </div>
          {canShare && (
            <button
              type="button"
              class="btn btn-primary btn-block"
              onClick={() =>
                void navigator
                  .share({ title: "Join my Veil room", url: props.link })
                  .catch(() => {})
              }
            >
              <Icon name="share" size={18} />
              Share…
            </button>
          )}
          <p class="note">
            <Icon name="lock" size={16} />
            <span>
              The key is in the part after <code>#</code>, which browsers never send to any server.
              Anyone with the link can join
              {props.hasPassphrase ? " if they also know the passphrase" : ""}.
              {props.hasPassphrase && " Send the passphrase through a different channel."}
            </span>
          </p>
        </div>
      ) : (
        <ManualConnect session={props.session} />
      )}
    </Sheet>
  );
}

function ManualConnect(props: { session: RoomSession }): JSX.Element {
  const code = props.session.manualCode.value;
  const [input, setInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = (text: string) => {
    setError(null);
    if (!props.session.ingestManual(text)) setError("That is not a Veil code.");
    else setInput("");
  };

  return (
    <div class="stack">
      <p class="muted">
        Connect without any relay or tracker: exchange two codes by QR or copy-paste. Works offline
        on a local network.
      </p>
      <ol class="steps">
        <li>One person creates an invite code and shows it.</li>
        <li>The other pastes or scans it, and shows back the answer code.</li>
        <li>The first person pastes or scans the answer.</li>
      </ol>
      <button
        type="button"
        class="btn btn-secondary"
        onClick={() => props.session.createManualOffer()}
        data-testid="manual-create"
      >
        <Icon name="plus" size={18} />
        Create invite code
      </button>
      {code && (
        <div class="stack-sm">
          <span class="label">
            {code.kind === "offer"
              ? "Invite code: show it to the other person"
              : "Answer code: show it back"}
          </span>
          <div class="qr-wrap">
            <QrCode
              value={code.code}
              label={code.kind === "offer" ? "Invite code" : "Answer code"}
              size={240}
            />
          </div>
          <div class="copy-row">
            <textarea
              class="input mono code-box"
              readOnly
              rows={3}
              value={code.code}
              data-testid={`manual-${code.kind}`}
              aria-label="Code"
            />
            <button
              type="button"
              class="btn btn-secondary"
              onClick={async () => setCopied(await copyText(code.code))}
            >
              <Icon name={copied ? "check" : "copy"} size={18} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}
      <label class="field">
        <span class="label">Paste a code</span>
        <textarea
          class="input mono code-box"
          rows={3}
          value={input}
          placeholder="veil1:…"
          data-testid="manual-input"
          onInput={(e) => setInput(e.currentTarget.value)}
        />
      </label>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="row">
        <button
          type="button"
          class="btn btn-primary"
          disabled={!input.trim()}
          onClick={() => submit(input)}
          data-testid="manual-submit"
        >
          Connect
        </button>
        <button type="button" class="btn btn-ghost" onClick={() => setScanning(true)}>
          <Icon name="scan" size={18} />
          Scan
        </button>
      </div>
      {scanning && (
        <QrScanner
          onCancel={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            submit(text);
          }}
        />
      )}
    </div>
  );
}
