import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { parseRoomLink, parseRoomMode, type RoomMode } from "../../crypto/room";
import { Icon, Logo } from "../components/Icons";
import { QrScanner } from "../components/QrScanner";
import { Sheet } from "../components/Sheet";

export function Home(props: {
  onCreate: (passphrase: string, mode: RoomMode) => void;
  onJoin: (key: Uint8Array, passphrase: string, mode: RoomMode) => void;
  onSettings: () => void;
}): JSX.Element {
  const [link, setLink] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [about, setAbout] = useState(false);

  const join = (value: string) => {
    const key = parseRoomLink(value);
    if (!key) {
      setError("That doesn't look like a Veil room link.");
      return;
    }
    props.onJoin(key, passphrase, parseRoomMode(value));
  };

  return (
    <main class="home">
      <header class="topbar">
        <div class="brand">
          <Logo size={28} />
          <span>Veil</span>
        </div>
        <button type="button" class="icon-btn" aria-label="Settings" onClick={props.onSettings}>
          <Icon name="settings" />
        </button>
      </header>

      <section class="hero">
        <h1>Private rooms, between browsers.</h1>
        <p class="lede">
          Chat, send files of any size and call, peer-to-peer and end-to-end encrypted. No account,
          no server in the middle, nothing stored.
        </p>
      </section>

      <section class="card home-card">
        <div class="home-actions">
          <button
            type="button"
            class="btn btn-primary btn-lg"
            data-testid="new-room"
            onClick={() => props.onCreate(passphrase, "call")}
          >
            <Icon name="plus" size={20} />
            New room
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-lg"
            data-testid="send-files"
            onClick={() => props.onCreate(passphrase, "files")}
          >
            <Icon name="attach" size={20} />
            Send files
          </button>
        </div>

        <div class="divider">
          <span>or join one</span>
        </div>

        <form
          class="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            join(link);
          }}
        >
          <div class="row">
            <input
              class="input"
              placeholder="Paste a room link"
              value={link}
              aria-label="Room link"
              data-testid="join-input"
              autoComplete="off"
              spellcheck={false}
              onInput={(e) => {
                setLink(e.currentTarget.value);
                setError(null);
              }}
            />
            <button
              type="button"
              class="icon-btn icon-btn-boxed"
              aria-label="Scan a QR code"
              onClick={() => setScanning(true)}
            >
              <Icon name="scan" />
            </button>
          </div>
          {error && (
            <p class="error" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            class="btn btn-secondary btn-block"
            disabled={!link.trim()}
            data-testid="join"
          >
            Join
          </button>
        </form>

        <div class="passphrase">
          <button
            type="button"
            class="link-btn"
            aria-expanded={showPass}
            onClick={() => setShowPass(!showPass)}
          >
            <Icon name="lock" size={16} />
            {showPass ? "Room passphrase" : "Add a room passphrase (optional)"}
          </button>
          {showPass && (
            <label class="field">
              <input
                class="input"
                type="password"
                value={passphrase}
                autoComplete="off"
                aria-label="Room passphrase"
                placeholder="Shared separately from the link"
                onInput={(e) => setPassphrase(e.currentTarget.value)}
              />
              <span class="hint">
                Mixed into the room key. Send the link and the passphrase through two different
                channels.
              </span>
            </label>
          )}
        </div>
      </section>

      <ul class="pillars" aria-label="How Veil protects you">
        <li>
          <Icon name="shield" size={18} />
          <span>End-to-end encrypted chat, files and media</span>
        </li>
        <li>
          <Icon name="link" size={18} />
          <span>Direct peer-to-peer connections</span>
        </li>
        <li>
          <Icon name="lock" size={18} />
          <span>The room key never leaves the link</span>
        </li>
      </ul>

      <footer class="footer">
        <button type="button" class="link-btn" onClick={() => setAbout(true)}>
          How it works
        </button>
        <a
          class="link-btn"
          href="https://github.com/maxgfr/veil"
          rel="noopener noreferrer"
          target="_blank"
        >
          Source code
        </a>
      </footer>

      <Sheet open={scanning} title="Scan a room QR code" onClose={() => setScanning(false)}>
        {scanning && (
          <QrScanner
            onCancel={() => setScanning(false)}
            onResult={(text) => {
              setScanning(false);
              setLink(text);
              join(text);
            }}
          />
        )}
      </Sheet>

      <Sheet open={about} title="How Veil works" onClose={() => setAbout(false)}>
        <div class="prose">
          <p>
            A room is a random 256-bit key. It lives in the part of the link after <code>#</code>,
            which your browser never sends to any server, GitHub Pages included.
          </p>
          <p>
            To find each other, members post sealed messages on public Nostr relays and WebTorrent
            trackers (or exchange codes by hand). Those services only see ciphertext under a topic
            that changes every day. As soon as one direct connection exists, everything else goes
            through the encrypted peer-to-peer mesh.
          </p>
          <p>
            Every link is encrypted twice: by WebRTC (DTLS) and by Veil's own layer, bound to the
            room key and to both ends of the connection. Group messages and media frames are
            encrypted once with a per-member key that rotates when someone leaves. Compare the four
            emojis with someone to rule out any interception.
          </p>
          <p>Nothing is stored: close the tab and the conversation is gone.</p>
        </div>
      </Sheet>
    </main>
  );
}
