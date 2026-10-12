//! Cryptography, byte-compatible with the web app (`src/crypto/*.ts`).
//!
//! Every derivation, label and byte layout here mirrors the TypeScript side:
//! a CLI and a browser in the same room derive the same topic, keys and SAS.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

pub const PBKDF2_ITERATIONS: u32 = 600_000;
const SALT: &[u8] = b"veil/v1";
const DAY_MS: u64 = 86_400_000;

pub fn b64u(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

pub fn from_b64u(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(s).map_err(|_| anyhow!("invalid base64url"))
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b
}

pub fn hkdf(ikm: &[u8], salt: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = vec![0u8; len];
    hk.expand(info, &mut out).expect("valid HKDF length");
    out
}

pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> [u8; 32] {
    hkdf(ikm, salt, info, 32).try_into().expect("32 bytes")
}

pub fn pbkdf2(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let pass: String = passphrase.nfkc().collect();
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, iterations, &mut out);
    out
}

/// AES-256-GCM, sealed = nonce (12) || ciphertext+tag.
pub fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(key.into());
    let nonce: [u8; 12] = random();
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad }).expect("AES-GCM encryption");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    out
}

pub fn open(key: &[u8; 32], sealed: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        bail!("decryption failed");
    }
    let cipher = Aes256Gcm::new(key.into());
    cipher
        .decrypt(Nonce::from_slice(&sealed[..12]), Payload { msg: &sealed[12..], aad })
        .map_err(|_| anyhow!("decryption failed"))
}

pub fn utc_day(ms: u64) -> u64 {
    ms / DAY_MS
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn new_room_key() -> [u8; 32] {
    random()
}

const FILES_PREFIX: &str = "files/";

/// Accepts a full link, a "#fragment" or a bare key, for a call room (`<key>`) or a files room (`files/<key>`).
pub fn parse_room_link(input: &str) -> Option<[u8; 32]> {
    let s = input.trim();
    let frag = s.rsplit('#').next().unwrap_or(s);
    let frag = frag.strip_prefix(FILES_PREFIX).unwrap_or(frag);
    if frag.len() != 43 || !frag.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return None;
    }
    from_b64u(frag).ok()?.try_into().ok()
}

/// The share link; `files` opens the web app's files interface (no camera or microphone).
pub fn room_link(base: &str, key: &[u8; 32], files: bool) -> String {
    let prefix = if files { FILES_PREFIX } else { "" };
    format!("{}#{prefix}{}", base.split('#').next().unwrap_or(base), b64u(key))
}

/// Everything derived from the room key (and optional passphrase).
#[derive(Clone)]
pub struct RoomSecrets {
    master: Vec<u8>,
    pub sig_key: [u8; 32],
    pub sas_salt: [u8; 32],
    pub bind_key: [u8; 32],
}

impl RoomSecrets {
    pub fn derive(key: &[u8; 32], passphrase: Option<&str>) -> Self {
        let master = match passphrase.filter(|p| !p.is_empty()) {
            None => key.to_vec(),
            Some(p) => {
                let mut salt = b"veil/v1/passphrase".to_vec();
                salt.extend_from_slice(key);
                let stretched = pbkdf2(p, &salt, PBKDF2_ITERATIONS);
                let mut ikm = key.to_vec();
                ikm.extend_from_slice(&stretched);
                hkdf(&ikm, SALT, b"master", 32)
            }
        };
        Self {
            sig_key: hkdf32(&master, SALT, b"sig"),
            sas_salt: hkdf32(&master, SALT, b"sas"),
            bind_key: hkdf32(&master, SALT, b"bind"),
            master,
        }
    }

    pub fn topic(&self, day: u64) -> [u8; 32] {
        hkdf32(&self.master, SALT, format!("topic/{day}").as_bytes())
    }
}

/// "sha-256 ab:cd" → "sha-256 AB:CD".
pub fn normalize_fingerprint(fp: &str) -> String {
    let mut it = fp.split_whitespace();
    let alg = it.next().unwrap_or("").to_lowercase();
    let value = it.next().unwrap_or("").to_uppercase();
    format!("{alg} {value}")
}

pub fn sdp_fingerprint(sdp: &str) -> String {
    for line in sdp.lines() {
        if let Some(rest) = line.trim_end().strip_prefix("a=fingerprint:") {
            return normalize_fingerprint(rest);
        }
    }
    String::new()
}

/// Matrix's SAS emoji table, as in `src/crypto/sas.ts`.
pub const SAS_EMOJIS: [(&str, &str); 64] = [
    ("🐶", "Dog"),
    ("🐱", "Cat"),
    ("🦁", "Lion"),
    ("🐎", "Horse"),
    ("🦄", "Unicorn"),
    ("🐷", "Pig"),
    ("🐘", "Elephant"),
    ("🐰", "Rabbit"),
    ("🐼", "Panda"),
    ("🐓", "Rooster"),
    ("🐧", "Penguin"),
    ("🐢", "Turtle"),
    ("🐟", "Fish"),
    ("🐙", "Octopus"),
    ("🦋", "Butterfly"),
    ("🌷", "Flower"),
    ("🌳", "Tree"),
    ("🌵", "Cactus"),
    ("🍄", "Mushroom"),
    ("🌏", "Globe"),
    ("🌙", "Moon"),
    ("☁️", "Cloud"),
    ("🔥", "Fire"),
    ("🍌", "Banana"),
    ("🍎", "Apple"),
    ("🍓", "Strawberry"),
    ("🌽", "Corn"),
    ("🍕", "Pizza"),
    ("🎂", "Cake"),
    ("❤️", "Heart"),
    ("😀", "Smiley"),
    ("🤖", "Robot"),
    ("🎩", "Hat"),
    ("👓", "Glasses"),
    ("🔧", "Spanner"),
    ("🎅", "Santa"),
    ("👍", "Thumbs up"),
    ("☂️", "Umbrella"),
    ("⌛", "Hourglass"),
    ("⏰", "Clock"),
    ("🎁", "Gift"),
    ("💡", "Light bulb"),
    ("📕", "Book"),
    ("✏️", "Pencil"),
    ("📎", "Paperclip"),
    ("✂️", "Scissors"),
    ("🔒", "Lock"),
    ("🔑", "Key"),
    ("🔨", "Hammer"),
    ("☎️", "Telephone"),
    ("🏁", "Flag"),
    ("🚂", "Train"),
    ("🚲", "Bicycle"),
    ("✈️", "Aeroplane"),
    ("🚀", "Rocket"),
    ("🏆", "Trophy"),
    ("⚽", "Ball"),
    ("🎸", "Guitar"),
    ("🎺", "Trumpet"),
    ("🔔", "Bell"),
    ("⚓", "Anchor"),
    ("🎧", "Headphones"),
    ("📁", "Folder"),
    ("📌", "Pin"),
];

pub struct SasParty<'a> {
    pub peer_id: &'a str,
    pub ed_pub: &'a [u8],
    pub fingerprint: &'a str,
}

pub fn compute_sas(sas_salt: &[u8], a: &SasParty<'_>, b: &SasParty<'_>) -> Vec<(&'static str, &'static str)> {
    use hmac::{Hmac, Mac};
    let (lo, hi) = if a.peer_id < b.peer_id { (a, b) } else { (b, a) };
    let mut msg = b"veil/sas/v1".to_vec();
    msg.extend_from_slice(lo.ed_pub);
    msg.extend_from_slice(hi.ed_pub);
    msg.extend_from_slice(
        format!("{}|{}", normalize_fingerprint(lo.fingerprint), normalize_fingerprint(hi.fingerprint)).as_bytes(),
    );
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(sas_salt).expect("any key length");
    mac.update(&msg);
    let tag = mac.finalize().into_bytes();
    let bits = ((tag[0] as u32) << 16) | ((tag[1] as u32) << 8) | tag[2] as u32;
    [18, 12, 6, 0].iter().map(|s| SAS_EMOJIS[((bits >> s) & 63) as usize]).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hkdf_rfc5869_case1() {
        let okm = hkdf(
            &[0x0b; 22],
            &hex::decode("000102030405060708090a0b0c").unwrap(),
            &hex::decode("f0f1f2f3f4f5f6f7f8f9").unwrap(),
            42,
        );
        assert_eq!(
            hex::encode(okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }

    #[test]
    fn pbkdf2_vectors() {
        assert_eq!(
            hex::encode(pbkdf2("password", b"salt", 1)),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
        assert_eq!(
            hex::encode(pbkdf2("password", b"salt", 4096)),
            "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"
        );
    }

    #[test]
    fn seal_open_and_tamper() {
        let key: [u8; 32] = random();
        let sealed = seal(&key, b"hello", b"aad");
        assert_eq!(open(&key, &sealed, b"aad").unwrap(), b"hello");
        assert!(open(&key, &sealed, b"other").is_err());
        let mut bad = sealed.clone();
        bad[20] ^= 1;
        assert!(open(&key, &bad, b"aad").is_err());
    }

    #[test]
    fn base64_is_canonical_only() {
        let s = b64u(&[0xab; 64]);
        assert_eq!(from_b64u(&s).unwrap(), vec![0xab; 64]);
        // Same bytes, different unused trailing bits: must not decode (gossip de-duplication relies on it).
        let mut tweaked = s.clone().into_bytes();
        let last = tweaked.last_mut().unwrap();
        *last = if *last == b'A' { b'B' } else { *last ^ 1 };
        assert!(from_b64u(std::str::from_utf8(&tweaked).unwrap()).is_err());
    }

    #[test]
    fn links() {
        let key = new_room_key();
        let link = room_link("https://maxgfr.github.io/veil/", &key, false);
        assert_eq!(parse_room_link(&link), Some(key));
        let files = room_link("https://maxgfr.github.io/veil/", &key, true);
        assert_eq!(files, format!("https://maxgfr.github.io/veil/#files/{}", b64u(&key)));
        assert_eq!(parse_room_link(&files), Some(key));
        assert_eq!(parse_room_link(&format!("#other/{}", b64u(&key))), None);
        assert_eq!(parse_room_link("https://maxgfr.github.io/veil/"), None);
    }

    #[test]
    fn fingerprints() {
        assert_eq!(normalize_fingerprint(" SHA-256 ab:cd "), "sha-256 AB:CD");
        assert_eq!(sdp_fingerprint("v=0\r\na=fingerprint:sha-256 aa:bb\r\n"), "sha-256 AA:BB");
    }
}

#[cfg(test)]
mod interop {
    //! Vectors produced by the web app (`bun scripts/vectors.ts`).
    use super::*;
    use crate::envelope::{Opener, MAX_AGE_MS};
    use serde_json::Value;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors.json"))).unwrap()
    }

    fn h(v: &Value) -> Vec<u8> {
        hex::decode(v.as_str().unwrap()).unwrap()
    }

    #[test]
    fn room_derivation_matches_the_web_app() {
        let v = vectors();
        let key: [u8; 32] = h(&v["key"]).try_into().unwrap();
        let day = v["day"].as_u64().unwrap();
        for (secrets, expected) in [
            (RoomSecrets::derive(&key, None), &v["plain"]),
            (RoomSecrets::derive(&key, v["passphrase"].as_str()), &v["withPassphrase"]),
        ] {
            assert_eq!(secrets.topic(day).to_vec(), h(&expected["topic"]));
            assert_eq!(secrets.sas_salt.to_vec(), h(&expected["sasSalt"]));
            assert_eq!(secrets.bind_key.to_vec(), h(&expected["bindKey"]));
        }
    }

    #[test]
    fn opens_an_envelope_sealed_by_the_web_app() {
        let v = vectors();
        let key: [u8; 32] = h(&v["key"]).try_into().unwrap();
        let secrets = RoomSecrets::derive(&key, None);
        let topic = secrets.topic(v["day"].as_u64().unwrap());
        let e = &v["envelope"];
        let msg = Opener::default()
            .open(&secrets.sig_key, e["wire"].as_str().unwrap(), &topic, MAX_AGE_MS, e["ts"].as_u64().unwrap())
            .expect("opens");
        assert_eq!(msg.from, e["from"].as_str().unwrap());
        assert_eq!(msg.to.as_deref(), e["to"].as_str());
        assert_eq!(msg.sdp.as_deref(), e["sdp"].as_str());
        assert_eq!(msg.session.as_deref(), e["session"].as_str());
        assert_eq!(msg.kind, "offer");
    }

    #[test]
    fn sas_matches_the_web_app() {
        let v = vectors();
        let s = &v["sas"];
        let (ea, eb) = (h(&s["a"]["edPub"]), h(&s["b"]["edPub"]));
        let a = SasParty {
            peer_id: s["a"]["peerId"].as_str().unwrap(),
            ed_pub: &ea,
            fingerprint: s["a"]["fingerprint"].as_str().unwrap(),
        };
        let b = SasParty {
            peer_id: s["b"]["peerId"].as_str().unwrap(),
            ed_pub: &eb,
            fingerprint: s["b"]["fingerprint"].as_str().unwrap(),
        };
        let names: Vec<&str> = compute_sas(&h(&s["salt"]), &a, &b).iter().map(|(_, n)| *n).collect();
        let expected: Vec<&str> = s["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
        assert_eq!(names, expected);
    }
}
