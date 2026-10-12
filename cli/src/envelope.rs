//! Signaling envelopes, as in `src/signal/envelope.ts`:
//! wire = <sender peerId> "." base64url(AES-GCM(deflate-raw(JSON))), AAD = topic || sender.

use crate::crypto::{b64u, from_b64u, open, random, seal, sha256};
use crate::identity::{peer_id_of, verify, Identity};
use anyhow::{bail, Result};
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};

pub const MAX_AGE_MS: u64 = 120_000;
pub const MANUAL_MAX_AGE_MS: u64 = 600_000;
const MAX_PLAINTEXT: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignalMessage {
    pub v: u8,
    pub id: String,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub ts: u64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sdp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Sender's Ed25519 identity key; its hash is `from`.
    #[serde(rename = "edPub")]
    pub ed_pub: String,
    /// Ed25519 signature over the other fields: proves the sender owns `from`.
    pub sig: String,
}

/// What the sender signs, byte for byte as `signedEnvelopeBytes` in the web app.
pub fn signed_bytes(m: &SignalMessage) -> Vec<u8> {
    let head = format!(
        "veil/env-sig/v1|{}|{}|{}|{}|{}|{}|",
        m.id,
        m.from,
        m.to.as_deref().unwrap_or(""),
        m.ts,
        m.kind,
        m.session.as_deref().unwrap_or("")
    );
    let mut out = head.into_bytes();
    out.extend_from_slice(&sha256(m.sdp.as_deref().unwrap_or("").replace("\r\n", "\n").as_bytes()));
    out
}

pub fn is_peer_id(s: &str) -> bool {
    s.len() == 20 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn aad(topic: &[u8], from: &str) -> Vec<u8> {
    format!("veil/env/v1|{}|{}", hex::encode(topic), from).into_bytes()
}

pub fn deflate(data: &[u8]) -> Vec<u8> {
    let mut e = DeflateEncoder::new(Vec::new(), Compression::default());
    e.write_all(data).expect("in-memory write");
    e.finish().expect("in-memory deflate")
}

pub fn inflate(data: &[u8], limit: u64) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(data).take(limit + 1).read_to_end(&mut out)?;
    if out.len() as u64 > limit {
        bail!("too large");
    }
    Ok(out)
}

pub fn new_envelope_id() -> String {
    b64u(&random::<12>())
}

/// Outgoing message fields (id, ts and from are filled in when sealing).
#[derive(Debug, Clone, Default)]
pub struct Outgoing {
    pub kind: String,
    pub to: Option<String>,
    pub sdp: Option<String>,
    pub session: Option<String>,
}

pub fn seal_envelope(sig_key: &[u8; 32], topic: &[u8], signer: &Identity, out: &Outgoing, now: u64) -> String {
    let from = signer.peer_id.as_str();
    let mut msg = SignalMessage {
        v: 1,
        id: new_envelope_id(),
        from: from.to_string(),
        to: out.to.clone(),
        ts: now,
        kind: out.kind.clone(),
        // CRLF → LF on the wire, restored on open (lossless).
        sdp: out.sdp.as_ref().map(|s| s.replace("\r\n", "\n")),
        session: out.session.clone(),
        ed_pub: b64u(&signer.ed_pub),
        sig: String::new(),
    };
    msg.sig = b64u(&signer.sign(&signed_bytes(&msg)));
    let json = serde_json::to_vec(&msg).expect("serializable");
    let sealed = seal(sig_key, &deflate(&json), &aad(topic, from));
    format!("{from}.{}", b64u(&sealed))
}

fn validate(m: &SignalMessage, from: &str) -> bool {
    m.v == 1
        && m.from == from
        && m.id.len() == 16
        && m.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        && ["hello", "offer", "answer", "bye"].contains(&m.kind.as_str())
        && m.to.as_deref().is_none_or(is_peer_id)
        && m.sdp.as_ref().is_none_or(|s| s.len() <= 32_768)
        && m.session.as_ref().is_none_or(|s| s.len() <= 64)
        && m.ed_pub.len() == 43
        && m.sig.len() == 86
}

/// The sender owns `from`: its key hashes to it and signed the message.
fn authentic(m: &SignalMessage) -> bool {
    let (Ok(ed_pub), Ok(sig)) = (from_b64u(&m.ed_pub), from_b64u(&m.sig)) else { return false };
    peer_id_of(&ed_pub) == m.from && verify(&ed_pub, &sig, &signed_bytes(m))
}

/// Opens envelopes, rejecting forgeries, stale or future timestamps and replays.
#[derive(Default)]
pub struct Opener {
    seen: HashMap<String, u64>,
}

impl Opener {
    pub fn open(
        &mut self,
        sig_key: &[u8; 32],
        wire: &str,
        topic: &[u8],
        max_age: u64,
        now: u64,
    ) -> Option<SignalMessage> {
        if wire.len() > 100_000 || wire.as_bytes().get(20) != Some(&b'.') {
            return None;
        }
        let from = &wire[..20];
        if !is_peer_id(from) {
            return None;
        }
        let sealed = from_b64u(&wire[21..]).ok()?;
        let plain = open(sig_key, &sealed, &aad(topic, from)).ok()?;
        let mut msg: SignalMessage = serde_json::from_slice(&inflate(&plain, MAX_PLAINTEXT).ok()?).ok()?;
        if !validate(&msg, from) || !authentic(&msg) || now.abs_diff(msg.ts) > max_age {
            return None;
        }
        if self.seen.len() > 512 {
            self.seen.retain(|_, t| now.saturating_sub(*t) < MANUAL_MAX_AGE_MS * 2);
        }
        if self.seen.insert(msg.id.clone(), now).is_some() {
            return None;
        }
        msg.sdp = msg.sdp.map(|s| s.replace("\r\n", "\n").replace('\n', "\r\n"));
        Some(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_rejections() {
        let key: [u8; 32] = random();
        let topic: [u8; 32] = random();
        let sdp = "v=0\r\na=fingerprint:sha-256 AA:BB\r\n";
        let out = Outgoing {
            kind: "offer".into(),
            to: Some("fedcba9876543210fedc".into()),
            sdp: Some(sdp.into()),
            session: Some("s".into()),
        };
        let now = crate::crypto::now_ms();
        let me = Identity::generate();
        let wire = seal_envelope(&key, &topic, &me, &out, now);
        let mut o = Opener::default();
        let msg = o.open(&key, &wire, &topic, MAX_AGE_MS, now).unwrap();
        assert_eq!(msg.sdp.as_deref(), Some(sdp));
        assert!(o.open(&key, &wire, &topic, MAX_AGE_MS, now).is_none(), "replay");
        let other: [u8; 32] = random();
        assert!(Opener::default().open(&other, &wire, &topic, MAX_AGE_MS, now).is_none(), "forged");
        assert!(Opener::default().open(&key, &wire, &other, MAX_AGE_MS, now).is_none(), "topic");
        assert!(Opener::default().open(&key, &wire, &topic, MAX_AGE_MS, now + MAX_AGE_MS + 1).is_none(), "stale");
    }

    #[test]
    fn a_member_cannot_speak_for_another() {
        let key: [u8; 32] = random();
        let topic: [u8; 32] = random();
        let now = crate::crypto::now_ms();
        let (victim, mallory) = (Identity::generate(), Identity::generate());
        let bye = Outgoing { kind: "bye".into(), ..Default::default() };
        // Re-sign a genuine envelope's fields with another key, keeping the victim's id and key.
        let genuine = seal_envelope(&key, &topic, &victim, &bye, now);
        let plain = open(&key, &from_b64u(&genuine[21..]).unwrap(), &aad(&topic, &victim.peer_id)).unwrap();
        let mut msg: SignalMessage = serde_json::from_slice(&inflate(&plain, MAX_PLAINTEXT).unwrap()).unwrap();
        msg.id = new_envelope_id();
        msg.sig = b64u(&mallory.sign(&signed_bytes(&msg)));
        let forged = seal(&key, &deflate(&serde_json::to_vec(&msg).unwrap()), &aad(&topic, &victim.peer_id));
        let wire = format!("{}.{}", victim.peer_id, b64u(&forged));
        assert!(Opener::default().open(&key, &wire, &topic, MAX_AGE_MS, now).is_none(), "wrong signature");
        msg.ed_pub = b64u(&mallory.ed_pub);
        let forged = seal(&key, &deflate(&serde_json::to_vec(&msg).unwrap()), &aad(&topic, &victim.peer_id));
        let wire = format!("{}.{}", victim.peer_id, b64u(&forged));
        assert!(Opener::default().open(&key, &wire, &topic, MAX_AGE_MS, now).is_none(), "key not hashing to from");
        assert!(Opener::default().open(&key, &genuine, &topic, MAX_AGE_MS, now).is_some(), "genuine");
    }
}
