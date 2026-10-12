//! Signaling transports (Nostr relays, WebTorrent trackers) and the room
//! signaling layer, as in `src/signal/{nostr,torrent,mux}.ts`. Transports only
//! ever carry sealed envelopes under a daily rotating topic.

use crate::crypto::{b64u, now_ms, random, utc_day, RoomSecrets};
use crate::envelope::{seal_envelope, Opener, Outgoing, SignalMessage, MAX_AGE_MS};
use crate::identity::Identity;
use futures_util::{SinkExt, StreamExt};
use k256::schnorr::SigningKey;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const NOSTR_KIND: u64 = 21_917;
pub const DEFAULT_RELAYS: [&str; 4] =
    ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"];
pub const DEFAULT_TRACKERS: [&str; 2] = ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"];

#[derive(Clone, Debug)]
pub enum OutCmd {
    Join([u8; 32]),
    Leave([u8; 32]),
    Send { topic: [u8; 32], wire: String, to: Option<String> },
}

pub type Inbound = mpsc::UnboundedSender<(String, [u8; 32])>;

fn backoff(attempt: u32) -> Duration {
    let base = 1000u64.saturating_mul(1 << attempt.min(5)).min(30_000);
    Duration::from_millis(base / 2 + rand::random::<u64>() % (base / 2 + 1))
}

// ── Nostr ───────────────────────────────────────────────────────────────────

fn nostr_req(hex_topic: &str) -> String {
    let since = now_ms() / 1000 - 60;
    json!(["REQ", format!("veil-{}", &hex_topic[..16]), {"kinds": [NOSTR_KIND], "#t": [hex_topic], "since": since}])
        .to_string()
}

pub fn sign_event(sk: &SigningKey, content: &str, tags: Value) -> Value {
    let pubkey = hex::encode(sk.verifying_key().to_bytes());
    let created_at = now_ms() / 1000;
    let serial = json!([0, pubkey, created_at, NOSTR_KIND, tags, content]).to_string();
    let id = crate::crypto::sha256(serial.as_bytes());
    let sig = sk.sign_raw(&id, &random::<32>()).expect("schnorr signing");
    json!({"id": hex::encode(id), "pubkey": pubkey, "created_at": created_at, "kind": NOSTR_KIND, "tags": tags, "content": content, "sig": hex::encode(sig.to_bytes())})
}

pub fn spawn_nostr(url: String, inbound: Inbound) -> mpsc::UnboundedSender<OutCmd> {
    let sk = SigningKey::random(&mut rand::rngs::OsRng);
    let own = hex::encode(sk.verifying_key().to_bytes());
    let (tx, mut rx) = mpsc::unbounded_channel::<OutCmd>();
    tokio::spawn(async move {
        let mut topics: HashMap<String, [u8; 32]> = HashMap::new();
        let mut attempt = 0u32;
        loop {
            let conn =
                tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(url.as_str())).await;
            let Ok(Ok((mut ws, _))) = conn else {
                if !wait_offline(&mut rx, &mut topics, backoff(attempt), apply_topic).await {
                    return;
                }
                attempt += 1;
                continue;
            };
            attempt = 0;
            for hex_topic in topics.keys() {
                let _ = ws.send(Message::text(nostr_req(hex_topic))).await;
            }
            loop {
                tokio::select! {
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                            if v.get(0).and_then(Value::as_str) != Some("EVENT") { continue; }
                            let ev = &v[2];
                            if ev["pubkey"].as_str() == Some(own.as_str()) || ev["kind"].as_u64() != Some(NOSTR_KIND) { continue; }
                            let Some(content) = ev["content"].as_str() else { continue };
                            let tag = ev["tags"].as_array().and_then(|tags| tags.iter().find(|t| t[0] == "t")).and_then(|t| t[1].as_str());
                            if let Some(topic) = tag.and_then(|h| topics.get(h)) { let _ = inbound.send((content.to_string(), *topic)); }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    cmd = rx.recv() => {
                        let Some(cmd) = cmd else { let _ = ws.close(None).await; return };
                        let frame = match &cmd {
                            OutCmd::Join(t) => { let h = hex::encode(t); let f = (!topics.contains_key(&h)).then(|| nostr_req(&h)); topics.insert(h, *t); f }
                            OutCmd::Leave(t) => { let h = hex::encode(t); topics.remove(&h).map(|_| json!(["CLOSE", format!("veil-{}", &h[..16])]).to_string()) }
                            OutCmd::Send { topic, wire, .. } => Some(json!(["EVENT", sign_event(&sk, wire, json!([["t", hex::encode(topic)]]))]).to_string()),
                        };
                        if let Some(f) = frame { if ws.send(Message::text(f)).await.is_err() { break; } }
                    }
                }
            }
            tokio::time::sleep(backoff(attempt)).await;
            attempt += 1;
        }
    });
    tx
}

fn apply_topic(cmd: &OutCmd, topics: &mut HashMap<String, [u8; 32]>) {
    match cmd {
        OutCmd::Join(t) => {
            topics.insert(hex::encode(t), *t);
        }
        OutCmd::Leave(t) => {
            topics.remove(&hex::encode(t));
        }
        OutCmd::Send { .. } => {}
    }
}

/// Waits out a reconnect delay while still tracking topic changes. Returns false when the sender is gone.
async fn wait_offline(
    rx: &mut mpsc::UnboundedReceiver<OutCmd>,
    topics: &mut HashMap<String, [u8; 32]>,
    delay: Duration,
    apply: impl Fn(&OutCmd, &mut HashMap<String, [u8; 32]>),
) -> bool {
    let wait = tokio::time::sleep(delay);
    tokio::pin!(wait);
    loop {
        tokio::select! {
            _ = &mut wait => return true,
            cmd = rx.recv() => match cmd { Some(c) => apply(&c, topics), None => return false },
        }
    }
}

// ── WebTorrent tracker ──────────────────────────────────────────────────────

/// The tracker protocol carries binary ids as latin1 strings.
pub fn info_hash(topic: &[u8]) -> String {
    topic[..20].iter().map(|&b| b as char).collect()
}

fn announce(hash: &str, peer_id: &str, event: Option<&str>) -> String {
    let mut v = json!({"action": "announce", "info_hash": hash, "peer_id": peer_id, "numwant": 0, "offers": []});
    if let Some(e) = event {
        v["event"] = json!(e);
    }
    v.to_string()
}

pub fn spawn_tracker(url: String, peer_id: String, inbound: Inbound) -> mpsc::UnboundedSender<OutCmd> {
    let (tx, mut rx) = mpsc::unbounded_channel::<OutCmd>();
    tokio::spawn(async move {
        let mut topics: HashMap<String, [u8; 32]> = HashMap::new();
        let mut attempt = 0u32;
        let key = |t: &[u8; 32]| info_hash(t);
        loop {
            let conn =
                tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(url.as_str())).await;
            let Ok(Ok((mut ws, _))) = conn else {
                let apply = |c: &OutCmd, t: &mut HashMap<String, [u8; 32]>| match c {
                    OutCmd::Join(x) => {
                        t.insert(info_hash(x), *x);
                    }
                    OutCmd::Leave(x) => {
                        t.remove(&info_hash(x));
                    }
                    OutCmd::Send { .. } => {}
                };
                if !wait_offline(&mut rx, &mut topics, backoff(attempt), apply).await {
                    return;
                }
                attempt += 1;
                continue;
            };
            attempt = 0;
            for h in topics.keys() {
                let _ = ws.send(Message::text(announce(h, &peer_id, Some("started")))).await;
            }
            let mut reannounce = tokio::time::interval(Duration::from_secs(50));
            reannounce.tick().await;
            loop {
                tokio::select! {
                    _ = reannounce.tick() => {
                        for h in topics.keys() { let _ = ws.send(Message::text(announce(h, &peer_id, None))).await; }
                    }
                    msg = ws.next() => match msg {
                        Some(Ok(Message::Text(t))) => {
                            let Ok(v) = serde_json::from_str::<Value>(t.as_str()) else { continue };
                            if v["action"] != "announce" || v["peer_id"].as_str() == Some(peer_id.as_str()) { continue; }
                            let Some(topic) = v["info_hash"].as_str().and_then(|h| topics.get(h)) else { continue };
                            let sdp = v["offer"]["sdp"].as_str().or_else(|| v["answer"]["sdp"].as_str());
                            if let Some(wire) = sdp { let _ = inbound.send((wire.to_string(), *topic)); }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = ws.send(Message::Pong(p)).await; }
                        Some(Ok(_)) => {}
                        _ => break,
                    },
                    cmd = rx.recv() => {
                        let Some(cmd) = cmd else { let _ = ws.close(None).await; return };
                        let frame = match &cmd {
                            OutCmd::Join(t) => { let h = key(t); let f = announce(&h, &peer_id, Some("started")); topics.insert(h, *t); Some(f) }
                            OutCmd::Leave(t) => { let h = key(t); topics.remove(&h).map(|_| announce(&h, &peer_id, Some("stopped"))) }
                            OutCmd::Send { topic, wire, to } => Some(match to {
                                Some(to) => json!({"action": "announce", "info_hash": key(topic), "peer_id": peer_id, "to_peer_id": to,
                                    "offer_id": b64u(&random::<15>()), "answer": {"type": "answer", "sdp": wire}}).to_string(),
                                None => {
                                    let offers: Vec<Value> = (0..10).map(|_| json!({"offer_id": b64u(&random::<15>()), "offer": {"type": "offer", "sdp": wire}})).collect();
                                    json!({"action": "announce", "info_hash": key(topic), "peer_id": peer_id, "numwant": 10, "offers": offers}).to_string()
                                }
                            }),
                        };
                        if let Some(f) = frame { if ws.send(Message::text(f)).await.is_err() { break; } }
                    }
                }
            }
            tokio::time::sleep(backoff(attempt)).await;
            attempt += 1;
        }
    });
    tx
}

/// De-duplication key for an envelope received on several transports. Works on
/// bytes: the content is untrusted and may not even be ASCII.
fn dedup_key(topic: &[u8], wire: &str) -> Vec<u8> {
    let mut k = vec![topic[0], topic[1]];
    k.extend_from_slice(&wire.as_bytes()[..wire.len().min(60)]);
    k
}

// ── room signaling ──────────────────────────────────────────────────────────

pub struct SignalConfig {
    pub relays: Vec<String>,
    pub trackers: Vec<String>,
}

pub struct Signaling {
    secrets: RoomSecrets,
    identity: Arc<Identity>,
    outs: Vec<mpsc::UnboundedSender<OutCmd>>,
    rx: mpsc::UnboundedReceiver<(String, [u8; 32])>,
    opener: Opener,
    seen: HashSet<Vec<u8>>,
    day: u64,
}

impl Signaling {
    pub fn new(secrets: RoomSecrets, identity: Arc<Identity>, cfg: &SignalConfig) -> Self {
        let peer_id = identity.peer_id.clone();
        let (in_tx, rx) = mpsc::unbounded_channel();
        let mut outs = Vec::new();
        for r in &cfg.relays {
            outs.push(spawn_nostr(r.clone(), in_tx.clone()));
        }
        for t in &cfg.trackers {
            outs.push(spawn_tracker(t.clone(), peer_id.clone(), in_tx.clone()));
        }
        let mut s = Self { secrets, identity, outs, rx, opener: Opener::default(), seen: HashSet::new(), day: 0 };
        s.rotate();
        s
    }

    fn broadcast(&self, cmd: OutCmd) {
        for o in &self.outs {
            let _ = o.send(cmd.clone());
        }
    }

    /// Listens on today's and yesterday's topics; call periodically to follow UTC midnight.
    pub fn rotate(&mut self) {
        let day = utc_day(now_ms());
        if day == self.day {
            return;
        }
        if self.day > 0 {
            self.broadcast(OutCmd::Leave(self.secrets.topic(self.day - 1)));
        }
        self.broadcast(OutCmd::Join(self.secrets.topic(day)));
        self.broadcast(OutCmd::Join(self.secrets.topic(day - 1)));
        self.day = day;
    }

    pub fn send(&self, out: Outgoing) {
        let topic = self.secrets.topic(utc_day(now_ms()));
        let wire = seal_envelope(&self.secrets.sig_key, &topic, &self.identity, &out, now_ms());
        self.broadcast(OutCmd::Send { topic, wire, to: out.to.clone() });
    }

    /// Next message addressed to us (or broadcast), from another peer.
    pub async fn next(&mut self) -> Option<SignalMessage> {
        loop {
            let (wire, topic) = self.rx.recv().await?;
            if !self.seen.insert(dedup_key(&topic, &wire)) {
                continue;
            }
            if self.seen.len() > 4096 {
                self.seen.clear();
            }
            let Some(msg) = self.opener.open(&self.secrets.sig_key, &wire, &topic, MAX_AGE_MS, now_ms()) else {
                continue;
            };
            if msg.from == self.identity.peer_id || msg.to.as_deref().is_some_and(|t| t != self.identity.peer_id) {
                continue;
            }
            return Some(msg);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedup_key_survives_non_ascii_relay_content() {
        let hostile = "é".repeat(40);
        let k = dedup_key(&[1u8; 32], &hostile);
        assert_eq!(k.len(), 2 + 60);
        assert_ne!(k, dedup_key(&[1u8; 32], "x"));
    }
}
