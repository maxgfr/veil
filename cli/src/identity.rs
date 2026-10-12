//! Ephemeral identity and group keys, as in `src/crypto/{session,senderkeys}.ts`.

use crate::crypto::{b64u, from_b64u, hkdf32, open, random, seal, sha256};
use anyhow::{anyhow, bail, Result};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use x25519_dalek::{PublicKey, StaticSecret};

pub const ROTATE_AFTER: Duration = Duration::from_secs(600);
pub const ROTATE_MESSAGES: u64 = 10_000;
const KEEP_REMOTE_KEYS: usize = 4;

pub struct Identity {
    signing: SigningKey,
    pub ed_pub: [u8; 32],
    pub peer_id: String,
}

pub fn peer_id_of(ed_pub: &[u8]) -> String {
    let mut data = b"veil/id/v1".to_vec();
    data.extend_from_slice(ed_pub);
    hex::encode(sha256(&data))[..20].to_string()
}

pub fn verify(ed_pub: &[u8], sig: &[u8], data: &[u8]) -> bool {
    let (Ok(pk), Ok(sig)) = (<[u8; 32]>::try_from(ed_pub), <[u8; 64]>::try_from(sig)) else { return false };
    let Ok(vk) = VerifyingKey::from_bytes(&pk) else { return false };
    vk.verify(data, &Signature::from_bytes(&sig)).is_ok()
}

impl Identity {
    pub fn generate() -> Self {
        let signing = SigningKey::generate(&mut rand::rngs::OsRng);
        let ed_pub = signing.verifying_key().to_bytes();
        Self { peer_id: peer_id_of(&ed_pub), ed_pub, signing }
    }

    pub fn sign(&self, data: &[u8]) -> [u8; 64] {
        self.signing.sign(data).to_bytes()
    }
}

/// Static X25519 key for the session, used for pairwise keys with members we may not be linked to.
pub struct StaticKey {
    secret: StaticSecret,
    pub public: [u8; 32],
}

impl StaticKey {
    pub fn generate() -> Self {
        let secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let public = PublicKey::from(&secret).to_bytes();
        Self { secret, public }
    }

    /// Symmetric pairwise key, bound to the room, both ids and both public keys.
    pub fn pair_key(&self, me: &str, them: &str, their_pub: &[u8], bind_key: &[u8], purpose: &str) -> Result<[u8; 32]> {
        let their: [u8; 32] = their_pub.try_into().map_err(|_| anyhow!("bad public key"))?;
        let shared = self.secret.diffie_hellman(&PublicKey::from(their));
        if shared.as_bytes().iter().all(|b| *b == 0) {
            bail!("bad public key");
        }
        let (lo, hi) = if me < them {
            ((me, &self.public[..]), (them, &their[..]))
        } else {
            ((them, &their[..]), (me, &self.public[..]))
        };
        let mut info = format!("veil/pair/v1/{purpose}|{}|{}|", lo.0, hi.0).into_bytes();
        info.extend_from_slice(lo.1);
        info.extend_from_slice(hi.1);
        Ok(hkdf32(shared.as_bytes(), bind_key, &info))
    }
}

fn wrap_aad(author: &str, recipient: &str, key_id: u32) -> Vec<u8> {
    let mut a = format!("veil/skwrap/v1|{author}|{recipient}|").into_bytes();
    a.extend_from_slice(&key_id.to_be_bytes());
    a
}

fn data_aad(author: &str, key_id: u32) -> Vec<u8> {
    let mut a = format!("veil/sk/v1|{author}|").into_bytes();
    a.extend_from_slice(&key_id.to_be_bytes());
    a
}

pub enum Decrypted {
    Ok(Vec<u8>),
    UnknownKey,
    Invalid,
}

/// Our sender key, and the ones members wrapped for us.
pub struct SenderKeys {
    pub key_id: u32,
    raw: [u8; 32],
    created: Instant,
    count: u64,
    remote: HashMap<String, Vec<(u32, [u8; 32])>>,
}

impl SenderKeys {
    pub fn new() -> Self {
        let mut s = Self { key_id: 0, raw: [0; 32], created: Instant::now(), count: 0, remote: HashMap::new() };
        s.rotate();
        s
    }

    pub fn rotate(&mut self) {
        let mut id = u32::from_be_bytes(random());
        if id == self.key_id {
            id = id.wrapping_add(1);
        }
        self.key_id = id;
        self.raw = random();
        self.created = Instant::now();
        self.count = 0;
    }

    pub fn needs_rotation(&self) -> bool {
        self.created.elapsed() >= ROTATE_AFTER || self.count >= ROTATE_MESSAGES
    }

    pub fn has_key(&self, author: &str, key_id: u32) -> bool {
        self.remote.get(author).is_some_and(|l| l.iter().any(|(id, _)| *id == key_id))
    }

    /// `{keyId, xPub, wraps: {peerId: sealed key}}` for the given recipients.
    pub fn wrap(&self, me: &str, statik: &StaticKey, bind_key: &[u8], recipients: &[(String, Vec<u8>)]) -> Value {
        let mut wraps = Map::new();
        for (id, x_pub) in recipients {
            if id == me {
                continue;
            }
            if let Ok(k) = statik.pair_key(me, id, x_pub, bind_key, "sk") {
                wraps.insert(id.clone(), json!(b64u(&seal(&k, &self.raw, &wrap_aad(me, id, self.key_id)))));
            }
        }
        json!({"keyId": self.key_id, "xPub": b64u(&statik.public), "wraps": wraps})
    }

    pub fn receive(&mut self, me: &str, statik: &StaticKey, bind_key: &[u8], author: &str, body: &Value) -> bool {
        let (Some(key_id), Some(x_pub), Some(wrapped)) =
            (body["keyId"].as_u64(), body["xPub"].as_str(), body["wraps"][me].as_str())
        else {
            return false;
        };
        let Ok(key_id) = u32::try_from(key_id) else { return false };
        let (Ok(x_pub), Ok(wrapped)) = (from_b64u(x_pub), from_b64u(wrapped)) else { return false };
        let Ok(k) = statik.pair_key(me, author, &x_pub, bind_key, "sk") else { return false };
        let Ok(raw) = open(&k, &wrapped, &wrap_aad(author, me, key_id)) else { return false };
        let Ok(raw) = <[u8; 32]>::try_from(raw) else { return false };
        let list = self.remote.entry(author.to_string()).or_default();
        if !list.iter().any(|(id, _)| *id == key_id) {
            list.insert(0, (key_id, raw));
            list.truncate(KEEP_REMOTE_KEYS);
        }
        true
    }

    /// data = keyId (4, BE) || AES-GCM(payload).
    pub fn encrypt(&mut self, me: &str, payload: &[u8]) -> Vec<u8> {
        self.count += 1;
        let mut out = self.key_id.to_be_bytes().to_vec();
        out.extend_from_slice(&seal(&self.raw, payload, &data_aad(me, self.key_id)));
        out
    }

    pub fn decrypt(&self, author: &str, data: &[u8]) -> Decrypted {
        if data.len() < 4 {
            return Decrypted::Invalid;
        }
        let key_id = u32::from_be_bytes(data[..4].try_into().expect("4 bytes"));
        let Some((_, raw)) = self.remote.get(author).and_then(|l| l.iter().find(|(id, _)| *id == key_id)) else {
            return Decrypted::UnknownKey;
        };
        match open(raw, &data[4..], &data_aad(author, key_id)) {
            Ok(pt) => Decrypted::Ok(pt),
            Err(_) => Decrypted::Invalid,
        }
    }

    pub fn forget(&mut self, author: &str) {
        self.remote.remove(author);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_and_rotate() {
        let bind = [7u8; 32];
        let (a, b, gone) = (Identity::generate(), Identity::generate(), Identity::generate());
        let (sa, sb, sg) = (StaticKey::generate(), StaticKey::generate(), StaticKey::generate());
        let mut ka = SenderKeys::new();
        let mut kb = SenderKeys::new();
        let mut kg = SenderKeys::new();
        let all = vec![(b.peer_id.clone(), sb.public.to_vec()), (gone.peer_id.clone(), sg.public.to_vec())];
        let body = ka.wrap(&a.peer_id, &sa, &bind, &all);
        assert!(kb.receive(&b.peer_id, &sb, &bind, &a.peer_id, &body));
        assert!(kg.receive(&gone.peer_id, &sg, &bind, &a.peer_id, &body));
        ka.rotate();
        let body = ka.wrap(&a.peer_id, &sa, &bind, &all[..1]);
        assert!(kb.receive(&b.peer_id, &sb, &bind, &a.peer_id, &body));
        assert!(!kg.receive(&gone.peer_id, &sg, &bind, &a.peer_id, &body));
        let ct = ka.encrypt(&a.peer_id, b"after");
        assert!(matches!(kb.decrypt(&a.peer_id, &ct), Decrypted::Ok(p) if p == b"after"));
        assert!(matches!(kg.decrypt(&a.peer_id, &ct), Decrypted::UnknownKey));
    }

    #[test]
    fn peer_ids() {
        let id = Identity::generate();
        assert_eq!(id.peer_id.len(), 20);
        let sig = id.sign(b"x");
        assert!(verify(&id.ed_pub, &sig, b"x"));
        assert!(!verify(&id.ed_pub, &sig, b"y"));
    }
}
