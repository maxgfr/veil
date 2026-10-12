# Veil

Private rooms between browsers: chat, files of any size and audio/video calls,
peer-to-peer and end-to-end encrypted. No account, no backend, nothing stored.

**→ [maxgfr.github.io/veil](https://maxgfr.github.io/veil/)** · installable as an app on phone and desktop.
Terminal users get the same protocol with the [`veil` CLI](#cli).

## How it works

1. **New room** creates a random 256-bit key. The link is `…/veil/#<key>`: the
   part after `#` never leaves your browser, so neither GitHub Pages nor any
   relay ever sees it.
2. Share the link (copy, QR code, or the system share sheet). An optional
   passphrase is mixed into the key, so the link and the passphrase can travel
   on two different channels.
3. People who open the link find each other through public **Nostr relays** and
   **WebTorrent trackers** in parallel, or with **manual codes** (QR or
   copy-paste, no network at all). Those services only see sealed envelopes under
   a topic that changes every day.
4. As soon as one direct connection exists, everything else (new members,
   renegotiation for video) goes through the encrypted peer-to-peer mesh.

| | |
|---|---|
| Chat | Plain text, delivery receipts, typing indicator. Messages live in memory only. |
| Files | No size limit. Streamed from disk to disk in 63 KiB chunks, SHA-256 per chunk and per file, resumes after a disconnection. |
| Calls | Camera, microphone, screen sharing. Media frames are end-to-end encrypted (Encoded Transforms) when the browser supports it, shown by the **E2EE media** badge. |
| Rooms | No participant cap: a partial mesh (about 6 links each) relays data; video goes to the most recent speakers when a device's uplink runs out. |
| Verify | Compare 4 emojis with someone to rule out any interception, even by someone holding the link. |

The cryptography and its limits are described in [SECURITY.md](SECURITY.md).

### Connectivity

Direct connections need [STUN](https://en.wikipedia.org/wiki/STUN) (public
servers are used by default, editable in Settings). Some networks, like strict
corporate NATs and some mobile carriers, block direct connections: Veil tells you so and
you can add your own TURN server in Settings. Veil runs no TURN server.

## CLI

`veil` sends and receives files, or chats, in the same rooms as the web app.

```sh
brew install maxgfr/tap/veil

veil send report.pdf photos.zip       # opens a room, prints its link and a QR code
veil receive 'https://maxgfr.github.io/veil/#…' --out ~/Downloads
veil chat 'https://maxgfr.github.io/veil/#…'
veil new                              # just print a fresh room link
```

Files go straight to whoever accepts them, verified by SHA-256, with the same
encryption as the browser. Useful options: `--passphrase` (or
`VEIL_PASSPHRASE`), `--yes` to accept without asking, `--once` to exit after one
transfer, `--relay`/`--tracker`/`--stun`/`--turn` to choose the network. Prebuilt
binaries for macOS and Linux are on the
[releases page](https://github.com/maxgfr/veil/releases).

## Development

Requirements: [Bun](https://bun.sh) 1.4+, and Rust (stable) for the CLI.

```sh
bun install
bun run dev          # http://localhost:5173, with a local relay and tracker
bun run test         # unit tests
bun run test:e2e     # Playwright: Chromium, WebKit, phones, CLI interop
bun run typecheck && bun run lint && bun run build && bun run check-size

cargo test --manifest-path cli/Cargo.toml
cargo build --release --manifest-path cli/Cargo.toml
```

The dev server and the end-to-end tests use a local Nostr relay and WebTorrent
tracker (`test/`), so they never touch the public network.

```
src/crypto     room keys, AEAD, pairwise sessions, sender keys, SAS
src/signal     sealed envelopes, Nostr, WebTorrent, manual codes
src/mesh       peer connections, gossip, roster, key rotation
src/features   chat, files, media (+ src/workers/e2ee-worker.ts)
src/ui         Preact screens and components
cli/           the Rust CLI (same protocol)
```

The initial JavaScript is about 18 KB gzip; the room engine, the QR scanner and
the media worker load on demand. The page ships a strict Content Security
Policy with Trusted Types, and has no third-party scripts, fonts or analytics.

## License

[MIT](LICENSE)
