# Security

Veil is designed so that nothing beyond your browser (or the `veil` CLI) and
the static files needs to be trusted with your content. This page lists what
each party can and cannot learn, and the known limits.

Report a vulnerability privately through
[GitHub security advisories](https://github.com/maxgfr/veil/security/advisories/new).

## Keys

- **Room key**: 256 random bits in the link's `#fragment`. Fragments are never
  sent in HTTP requests, so GitHub Pages does not receive it.
- **Passphrase** (optional): stretched with PBKDF2-SHA256 (600,000 iterations)
  and mixed into the room key with HKDF. A link without the passphrase is useless.
- From these, HKDF-SHA256 derives:
  - a **topic** that changes every UTC day (used to find each other),
  - **sigKey**, an AES-256-GCM key sealing signaling envelopes,
  - a **bind key** that ties every pairwise session to the room,
  - a **SAS salt** for the verification emojis.
- Every member has an **ephemeral Ed25519 identity** for the session. Its peer
  id is a hash of the public key, so ids cannot be claimed by someone else.

## Layers

1. **Signaling envelopes** (offers, answers, hellos) are compressed, then sealed with
   sigKey; the AAD binds the topic and the sender. The recipient is inside the
   ciphertext. Envelopes older than 120 s, from the future, or replayed are
   rejected. Because the SDP (with its DTLS fingerprint) is authenticated, a
   relay or tracker cannot substitute itself in the connection.
2. **DTLS** (WebRTC) encrypts every connection.
3. **Pairwise layer on top of DTLS**: on the first DataChannel, both sides
   exchange a fresh X25519 key signed by their Ed25519 identity, over a
   transcript that includes both DTLS fingerprints. HKDF, salted with the bind
   key, derives per-channel, per-direction AES-256-GCM keys. Each message
   carries a strictly increasing counter: replays and reordering are rejected,
   and a message that fails to decrypt closes the connection. A changed DTLS
   fingerprint during renegotiation also closes it.
4. **Group messages (sender keys)**: each member encrypts its chat, receipts and
   file announcements once with its own random key, and signs every frame with
   its Ed25519 identity. Frames are flooded through a partial mesh; relaying
   members can neither read nor forge them. Sender keys are distributed wrapped
   for each member (X25519 between static session keys, HKDF bound to the room)
   and **rotated whenever a member leaves**, every 10 minutes and every 10,000
   messages. A member who left never receives the next key.
5. **Media**: when the browser supports Encoded Transforms
   (`RTCRtpScriptTransform`, or `createEncodedStreams` in older Chromium), every
   audio and video frame is encrypted with a key derived from the sender key
   (AES-GCM; only the first few codec header bytes stay in the clear so packetization works).
   A frame that cannot be authenticated is dropped. The **E2EE media** badge only
   shows when all current media peers support it. Without support, media is
   still protected by DTLS-SRTP, as in any WebRTC call.
6. **Files** travel over a direct link only, chunk by chunk, inside the pairwise
   layer, with a SHA-256 per chunk and for the whole file.

## Who sees what

| Party | Sees | Does not see |
|---|---|---|
| GitHub Pages | That someone loaded the app (IP, user agent) | The room key, anything about rooms |
| Nostr relays / WebTorrent trackers | Your IP, timing and size of sealed envelopes, a daily topic (a hash) | Content, SDP, who talks to whom (the recipient is encrypted), the room key |
| STUN servers | Your public IP address | Anything else |
| A TURN server (if you add one) | Your IP, the other side's IP, traffic volume | Content (DTLS + Veil layer) |
| Your network / ISP | That you use WebRTC with certain IPs | Content |
| A member of the room | Your nickname, your IP (direct connection), what you send to the room | Messages after they left (keys rotate) |
| Someone holding the link (and passphrase) | They can join, which members see in the roster | Past messages (nothing is stored) |

## Verification (SAS)

A link holder could try to sit between two members by answering both of their
offers. The 4 emojis are computed from both identities and both DTLS
fingerprints: if you compare them over another channel (voice, in person) and
they match, there is no one in the middle. "They don't match" disconnects that
member.

## Browser hardening

- Strict CSP in a `<meta>` tag: `default-src 'none'`, scripts and styles from
  `'self'` only, `connect-src 'self' wss:`, `require-trusted-types-for 'script'`.
- Chat translation uses only the browser's built-in APIs, Chrome's Translator
  and LanguageDetector. The browser runs them on the device; Veil downloads no
  model, so the CSP has no exception for them, and no message is sent anywhere.
- No inline script or style, no third-party script, font, CDN or analytics.
  The build fails if the page has an inline script or an external URL.
- `no-referrer`, and the app refuses to run inside a frame (clickjacking),
  since `frame-ancestors` cannot be set from a meta tag.
- Remote text is only ever rendered as text, never as HTML. Every message
  received is validated against a typed schema; unknown messages are ignored.
- Nothing of a conversation is persisted: `localStorage` only holds preferences
  (nickname, transports, relays, STUN/TURN) and the meetings you schedule. A
  scheduled meeting is stored with its link, so this device keeps its room key:
  the same trust as the browser holding the open room, and it never leaves the
  device (the `.ics` file is built in the page). Messages live in memory;
  received files go to the location you choose, or to the origin's private
  storage until you save them (cleared on the next visit).
- Dependencies are pinned with a lockfile; GitHub Actions are pinned by commit.

## Known limits

- **Metadata**: relays and trackers see your IP and when you are online. Use a
  VPN or Tor-friendly relays if that matters. Members you connect to directly
  see your IP (that is how peer-to-peer works); a TURN server hides it from
  them, not from the TURN operator.
- **Membership is the link**: anyone holding the link (and passphrase) can join.
  Treat it like a key.
- **Ephemeral identities**: there are no long-term identities, so verification
  holds for the session only.
- **No forward secrecy inside a sender-key period**: a member who stays in the
  room can decrypt everything sent under keys they received. Rotation bounds
  this to 10 minutes or 10,000 messages and cuts off departed members.
- **Large calls**: without an SFU, video is limited by each device's uplink;
  Veil degrades to audio for the least recent speakers rather than refusing.
- **Browser trust**: the app is only as safe as the files GitHub Pages serves.
  The service worker pins the version you installed until you accept an update,
  and the code is public for review.
