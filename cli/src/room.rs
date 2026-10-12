//! A room member, as in `src/mesh/room.ts`: roster from signed presence
//! gossip, bootstrap through sealed signaling envelopes, mesh-routed offers,
//! sender-key encrypted application messages, key rotation on departure.
//!
//! Everything runs in one task; the app talks to it through `RoomCmd` and
//! receives `RoomEvent`s.

use crate::crypto::{b64u, compute_sas, from_b64u, now_ms, open, random, seal, RoomSecrets, SasParty};
use crate::envelope::{Outgoing, SignalMessage};
use crate::identity::{peer_id_of, verify, Decrypted, Identity, SenderKeys, StaticKey};
use crate::peer::{self, Frame, PeerCmd, PeerEvent, PeerOptions, CHAT, CTRL, FILE};
use crate::signal::{SignalConfig, Signaling};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use webrtc::peer_connection::RTCIceServer;

const PRESENCE_EVERY: Duration = Duration::from_secs(10);
const MEMBER_TIMEOUT: Duration = Duration::from_secs(35);
const MAX_SKEW_MS: u64 = 5 * 60_000;
const TTL: u64 = 10;

#[derive(Debug)]
pub enum RoomEvent {
    MemberJoined { peer_id: String, nick: String },
    MemberLeft { nick: String },
    LinkUp { peer_id: String, sas: String },
    LinkDown { peer_id: String },
    App { author: String, msg: Value },
    File { peer_id: String, frame: Frame },
}

#[derive(Debug)]
pub enum RoomCmd {
    SendApp(Value),
    SendFile {
        peer_id: String,
        frame: Frame,
    },
    /// Keep a direct link with this member (file transfers).
    Require(String),
    Leave(tokio::sync::oneshot::Sender<()>),
}

pub struct RoomOptions {
    pub key: [u8; 32],
    pub passphrase: Option<String>,
    pub nick: String,
    pub signal: SignalConfig,
    pub ice_servers: Vec<RTCIceServer>,
}

#[derive(Clone)]
pub struct RoomHandle {
    pub tx: mpsc::UnboundedSender<RoomCmd>,
}

impl RoomHandle {
    pub fn send_app(&self, msg: Value) {
        let _ = self.tx.send(RoomCmd::SendApp(msg));
    }
    pub fn send_file(&self, peer_id: &str, frame: Frame) {
        let _ = self.tx.send(RoomCmd::SendFile { peer_id: peer_id.to_string(), frame });
    }
    pub fn require(&self, peer_id: &str) {
        let _ = self.tx.send(RoomCmd::Require(peer_id.to_string()));
    }
    pub async fn leave(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.tx.send(RoomCmd::Leave(tx)).is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(2), rx).await;
        }
    }
}

struct Slot {
    key: u64,
    session: String,
    tx: mpsc::UnboundedSender<PeerCmd>,
    ready: bool,
    mesh: bool,
}

struct Member {
    nick: String,
    x_pub: Vec<u8>,
    last_seen: Instant,
}

struct Room {
    id: Arc<Identity>,
    statik: StaticKey,
    keys: SenderKeys,
    secrets: RoomSecrets,
    nick: String,
    joined_at: u64,
    signaling: Signaling,
    ice_servers: Vec<RTCIceServer>,
    peers: HashMap<String, Slot>,
    keys_by_slot: HashMap<u64, String>,
    next_slot: u64,
    members: HashMap<String, Member>,
    presence_frames: HashMap<String, Value>,
    own_presence: Option<Value>,
    seen: HashMap<String, Instant>,
    seq: u64,
    pending: HashMap<String, Vec<Vec<u8>>>,
    want: HashSet<String>,
    last_key_send: HashMap<String, Instant>,
    required: HashSet<String>,
    rounds: HashMap<String, u32>,
    hellos: HashMap<String, Instant>,
    hello_count: u32,
    next_hello: Instant,
    events: mpsc::UnboundedSender<RoomEvent>,
    peer_tx: mpsc::UnboundedSender<(u64, PeerEvent)>,
}

pub fn spawn(opts: RoomOptions) -> (RoomHandle, mpsc::UnboundedReceiver<RoomEvent>) {
    let id = Arc::new(Identity::generate());
    let secrets = RoomSecrets::derive(&opts.key, opts.passphrase.as_deref());
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    let (ev_tx, ev_rx) = mpsc::unbounded_channel();
    let (peer_tx, peer_rx) = mpsc::unbounded_channel();
    let room = Room {
        signaling: Signaling::new(secrets.clone(), id.clone(), &opts.signal),
        id: id.clone(),
        statik: StaticKey::generate(),
        keys: SenderKeys::new(),
        secrets,
        nick: opts.nick,
        joined_at: now_ms(),
        ice_servers: opts.ice_servers,
        peers: HashMap::new(),
        keys_by_slot: HashMap::new(),
        next_slot: 1,
        members: HashMap::new(),
        presence_frames: HashMap::new(),
        own_presence: None,
        seen: HashMap::new(),
        seq: 0,
        pending: HashMap::new(),
        want: HashSet::new(),
        last_key_send: HashMap::new(),
        required: HashSet::new(),
        rounds: HashMap::new(),
        hellos: HashMap::new(),
        hello_count: 0,
        next_hello: Instant::now(),
        events: ev_tx,
        peer_tx,
    };
    tokio::spawn(room.run(cmd_rx, peer_rx));
    (RoomHandle { tx: cmd_tx }, ev_rx)
}

fn distance(a: &str, b: &str) -> u64 {
    a.bytes().zip(b.bytes()).take(8).fold(0u64, |d, (x, y)| d * 16 + ((hex_val(x) ^ hex_val(y)) as u64))
}

fn hex_val(c: u8) -> u8 {
    (c as char).to_digit(16).unwrap_or(0) as u8
}

impl Room {
    async fn run(
        mut self,
        mut cmds: mpsc::UnboundedReceiver<RoomCmd>,
        mut peer_rx: mpsc::UnboundedReceiver<(u64, PeerEvent)>,
    ) {
        let mut tick = tokio::time::interval(Duration::from_millis(500));
        let mut last_presence = Instant::now() - PRESENCE_EVERY;
        let mut last_maintain = Instant::now();
        loop {
            tokio::select! {
                msg = self.signaling.next() => if let Some(m) = msg { self.on_signal(m) },
                ev = peer_rx.recv() => if let Some((key, ev)) = ev { self.on_peer_event(key, ev) },
                cmd = cmds.recv() => match cmd {
                    None => { self.leave(); return; }
                    Some(RoomCmd::Leave(done)) => { self.leave(); tokio::time::sleep(Duration::from_millis(200)).await; let _ = done.send(()); return; }
                    Some(RoomCmd::SendApp(msg)) => self.send_app(&msg),
                    Some(RoomCmd::SendFile { peer_id, frame }) => {
                        if let Some(s) = self.peers.get(&peer_id) { let _ = s.tx.send(PeerCmd::Send { channel: FILE, frame }); }
                    }
                    Some(RoomCmd::Require(id)) => { self.required.insert(id); self.maintain(); }
                },
                _ = tick.tick() => {
                    let now = Instant::now();
                    self.signaling.rotate();
                    if now >= self.next_hello { self.hello(); }
                    let due: Vec<String> = self.hellos.iter().filter(|(_, t)| now >= **t).map(|(k, _)| k.clone()).collect();
                    for from in due {
                        self.hellos.remove(&from);
                        self.connect(&from, false);
                    }
                    if now.duration_since(last_presence) >= PRESENCE_EVERY { last_presence = now; self.heartbeat(); }
                    if now.duration_since(last_maintain) >= Duration::from_secs(3) { last_maintain = now; self.maintain(); }
                    if self.keys.needs_rotation() { self.rotate_and_distribute(); }
                }
            }
        }
    }

    fn ready_ids(&self) -> Vec<String> {
        self.peers.iter().filter(|(_, s)| s.ready).map(|(k, _)| k.clone()).collect()
    }

    fn emit(&self, ev: RoomEvent) {
        let _ = self.events.send(ev);
    }

    // ── signaling ───────────────────────────────────────────────────────────

    fn hello(&mut self) {
        self.signaling.send(Outgoing { kind: "hello".into(), ..Default::default() });
        self.hello_count += 1;
        let alone = self.ready_ids().is_empty();
        let next = if alone {
            if self.hello_count < 8 {
                3
            } else {
                15
            }
        } else {
            60
        };
        self.next_hello = Instant::now() + Duration::from_secs(next);
    }

    fn on_signal(&mut self, m: SignalMessage) {
        let from = m.from.clone();
        match m.kind.as_str() {
            "hello" => {
                if self.peers.contains_key(&from) || self.hellos.contains_key(&from) {
                    return;
                }
                // The members closest to the newcomer answer at once; the others only if still needed.
                let mine = distance(&self.id.peer_id, &from);
                let closer = self.members.keys().filter(|k| **k != from && distance(k, &from) < mine).count();
                let delay = if closer < 3 {
                    0
                } else if self.members.contains_key(&from) {
                    return;
                } else {
                    3000 + rand::random::<u64>() % 2000
                };
                self.hellos.insert(from, Instant::now() + Duration::from_millis(delay));
            }
            "offer" => {
                if let (Some(sdp), Some(session)) = (m.sdp, m.session) {
                    self.on_offer(&from, sdp, session, false);
                }
            }
            "answer" => {
                if let (Some(sdp), Some(session)) = (m.sdp, m.session) {
                    self.on_answer(&from, sdp, &session);
                }
            }
            "bye" => self.remove_member(&from),
            _ => {}
        }
    }

    fn new_slot(&mut self, remote: &str, session: String, initiator: bool, mesh: bool) {
        let key = self.next_slot;
        self.next_slot += 1;
        let tx = peer::spawn(
            key,
            PeerOptions {
                identity: self.id.clone(),
                remote_id: remote.to_string(),
                bind_key: self.secrets.bind_key,
                ice_servers: self.ice_servers.clone(),
                initiator,
            },
            self.peer_tx.clone(),
        );
        self.keys_by_slot.insert(key, remote.to_string());
        self.peers.insert(remote.to_string(), Slot { key, session, tx, ready: false, mesh });
    }

    fn connect(&mut self, to: &str, mesh: bool) {
        if self.peers.contains_key(to) || to == self.id.peer_id {
            return;
        }
        self.new_slot(to, b64u(&random::<12>()), true, mesh);
    }

    fn on_offer(&mut self, from: &str, sdp: String, session: String, mesh: bool) {
        if let Some(slot) = self.peers.get(from) {
            if slot.session == session {
                let _ = slot.tx.send(PeerCmd::Remote { kind: "offer".into(), sdp });
                return;
            }
            // Both sides started at once: the polite (smaller id) side yields.
            if !slot.ready && self.id.peer_id.as_str() > from {
                return;
            }
            self.drop_slot(from, "replaced");
        }
        self.new_slot(from, session, false, mesh);
        if let Some(slot) = self.peers.get(from) {
            let _ = slot.tx.send(PeerCmd::Remote { kind: "offer".into(), sdp });
        }
    }

    fn on_answer(&mut self, from: &str, sdp: String, session: &str) {
        if let Some(slot) = self.peers.get(from).filter(|s| s.session == session) {
            let _ = slot.tx.send(PeerCmd::Remote { kind: "answer".into(), sdp });
        }
    }

    fn drop_slot(&mut self, id: &str, reason: &str) {
        if let Some(slot) = self.peers.remove(id) {
            self.keys_by_slot.remove(&slot.key);
            let _ = slot.tx.send(PeerCmd::Close(reason.to_string()));
            if slot.ready {
                self.emit(RoomEvent::LinkDown { peer_id: id.to_string() });
            }
        }
    }

    fn can_route_via_mesh(&self, to: &str) -> bool {
        self.members.contains_key(to) && self.peers.iter().any(|(k, s)| s.ready && k != to)
    }

    fn route_signal(&mut self, to: &str, kind: &str, sdp: String) {
        let Some(slot) = self.peers.get(to) else { return };
        let session = slot.session.clone();
        if slot.mesh && self.can_route_via_mesh(to) {
            self.send_routed(to, kind, &sdp, &session);
        } else {
            self.signaling.send(Outgoing {
                kind: kind.into(),
                to: Some(to.into()),
                sdp: Some(sdp),
                session: Some(session),
            });
        }
    }

    fn send_routed(&mut self, to: &str, kind: &str, sdp: &str, session: &str) {
        let Some(m) = self.members.get(to) else { return };
        let Ok(key) = self.statik.pair_key(&self.id.peer_id, to, &m.x_pub, &self.secrets.bind_key, "sig") else {
            return;
        };
        let msg = json!({"kind": kind, "sdp": sdp, "session": session}).to_string();
        let ct = seal(&key, msg.as_bytes(), format!("veil/sig/v1|{}|{to}", self.id.peer_id).as_bytes());
        let body = json!({"to": to, "xPub": b64u(&self.statik.public), "ct": b64u(&ct)});
        self.publish("sig", body.to_string().as_bytes(), None);
    }

    fn on_routed(&mut self, author: &str, body: &Value) {
        if body["to"].as_str() != Some(self.id.peer_id.as_str()) {
            return;
        }
        let (Some(x), Some(ct)) = (body["xPub"].as_str(), body["ct"].as_str()) else { return };
        let (Ok(x), Ok(ct)) = (from_b64u(x), from_b64u(ct)) else { return };
        let Ok(key) = self.statik.pair_key(&self.id.peer_id, author, &x, &self.secrets.bind_key, "sig") else { return };
        let Ok(plain) = open(&key, &ct, format!("veil/sig/v1|{author}|{}", self.id.peer_id).as_bytes()) else { return };
        let Ok(msg) = serde_json::from_slice::<Value>(&plain) else { return };
        let (Some(kind), Some(sdp), Some(session)) =
            (msg["kind"].as_str(), msg["sdp"].as_str(), msg["session"].as_str())
        else {
            return;
        };
        if kind == "offer" {
            self.on_offer(author, sdp.to_string(), session.to_string(), true);
        } else if kind == "answer" {
            self.on_answer(author, sdp.to_string(), session);
        }
    }

    fn maintain(&mut self) {
        let candidates: Vec<String> = self.members.keys().filter(|k| !self.peers.contains_key(*k)).cloned().collect();
        for id in candidates {
            let rounds = self.rounds.entry(id.clone()).or_insert(0);
            *rounds += 1;
            // The smaller id initiates; the other side steps in if nothing happened after a while.
            if !self.required.contains(&id) && self.id.peer_id > id && *rounds < 3 {
                continue;
            }
            let mesh = self.can_route_via_mesh(&id);
            self.connect(&id, mesh);
        }
    }

    // ── peers ───────────────────────────────────────────────────────────────

    fn on_peer_event(&mut self, key: u64, ev: PeerEvent) {
        let Some(id) = self.keys_by_slot.get(&key).cloned() else { return };
        match ev {
            PeerEvent::Signal { kind, sdp } => self.route_signal(&id, kind, sdp),
            PeerEvent::Connected { remote_ed_pub, local_fp, remote_fp } => {
                if let Some(s) = self.peers.get_mut(&id) {
                    s.ready = true;
                }
                self.rounds.remove(&id);
                let mut frames: Vec<Value> = self.presence_frames.values().cloned().collect();
                if let Some(p) = &self.own_presence {
                    frames.push(p.clone());
                }
                if let Some(s) = self.peers.get(&id) {
                    let _ = s.tx.send(PeerCmd::Send {
                        channel: CTRL,
                        frame: Frame::Json(json!({"t": "roster", "frames": frames})),
                    });
                }
                self.publish_presence();
                if self.members.contains_key(&id) {
                    self.send_key_to(&id);
                }
                let sas = compute_sas(
                    &self.secrets.sas_salt,
                    &SasParty { peer_id: &self.id.peer_id, ed_pub: &self.id.ed_pub, fingerprint: &local_fp },
                    &SasParty { peer_id: &id, ed_pub: &remote_ed_pub, fingerprint: &remote_fp },
                );
                let sas = sas.iter().map(|(e, n)| format!("{e} {n}")).collect::<Vec<_>>().join("  ");
                self.emit(RoomEvent::LinkUp { peer_id: id, sas });
            }
            PeerEvent::Ctrl(v) => {
                if v["t"] == "roster" {
                    if let Some(frames) = v["frames"].as_array() {
                        for f in frames.clone() {
                            self.gossip_receive(f, &id);
                        }
                    }
                }
            }
            PeerEvent::Gossip(v) => self.gossip_receive(v, &id),
            PeerEvent::File(frame) => self.emit(RoomEvent::File { peer_id: id, frame }),
            PeerEvent::Closed(reason) => {
                if std::env::var_os("VEIL_DEBUG").is_some() {
                    eprintln!("[debug] link {} closed: {reason}", &id[..6]);
                }
                if self.peers.get(&id).is_some_and(|s| s.key == key) {
                    let slot = self.peers.remove(&id).expect("present");
                    if slot.ready {
                        self.emit(RoomEvent::LinkDown { peer_id: id });
                    }
                }
                self.keys_by_slot.remove(&key);
            }
        }
    }

    // ── gossip ──────────────────────────────────────────────────────────────

    fn signed_bytes(author: &str, kind: &str, seq: u64, ts: u64, body: &[u8]) -> Vec<u8> {
        let mut b = format!("veil/g/v1|{author}|{kind}|{seq}|{ts}|").into_bytes();
        b.extend_from_slice(body);
        b
    }

    fn mark_seen(&mut self, sig: &str) {
        if self.seen.len() > 4096 {
            self.seen.retain(|_, t| t.elapsed() < Duration::from_millis(2 * MAX_SKEW_MS));
        }
        self.seen.insert(sig.to_string(), Instant::now());
    }

    fn publish(&mut self, kind: &str, body: &[u8], only: Option<&str>) -> Value {
        let seq = self.seq;
        self.seq += 1;
        let ts = now_ms();
        let sig = self.id.sign(&Self::signed_bytes(&self.id.peer_id, kind, seq, ts, body));
        let frame = json!({"t": "g", "v": 1, "author": self.id.peer_id, "edPub": b64u(&self.id.ed_pub), "kind": kind,
            "seq": seq, "ts": ts, "ttl": TTL, "body": b64u(body), "sig": b64u(&sig)});
        self.mark_seen(&b64u(&sig));
        for (id, s) in &self.peers {
            if s.ready && only.is_none_or(|o| o == id) {
                let _ = s.tx.send(PeerCmd::Send { channel: CHAT, frame: Frame::Json(frame.clone()) });
            }
        }
        frame
    }

    fn gossip_receive(&mut self, f: Value, from: &str) {
        let (Some(author), Some(ed), Some(kind), Some(seq), Some(ts), Some(ttl), Some(body), Some(sig)) = (
            f["author"].as_str(),
            f["edPub"].as_str(),
            f["kind"].as_str(),
            f["seq"].as_u64(),
            f["ts"].as_u64(),
            f["ttl"].as_u64(),
            f["body"].as_str(),
            f["sig"].as_str(),
        ) else {
            return;
        };
        if f["t"] != "g" || f["v"] != 1 || self.seen.contains_key(sig) || author == self.id.peer_id {
            return;
        }
        if now_ms().abs_diff(ts) > MAX_SKEW_MS || ttl > 32 {
            return;
        }
        let (Ok(ed_pub), Ok(body_bytes), Ok(sig_bytes)) = (from_b64u(ed), from_b64u(body), from_b64u(sig)) else {
            return;
        };
        if peer_id_of(&ed_pub) != author
            || !verify(&ed_pub, &sig_bytes, &Self::signed_bytes(author, kind, seq, ts, &body_bytes))
        {
            return;
        }
        self.mark_seen(sig);
        if ttl > 1 {
            let mut fwd = f.clone();
            fwd["ttl"] = json!(ttl - 1);
            for (id, s) in &self.peers {
                if s.ready && id != from && id != author {
                    let _ = s.tx.send(PeerCmd::Send { channel: CHAT, frame: Frame::Json(fwd.clone()) });
                }
            }
        }
        let author = author.to_string();
        match kind {
            "presence" => {
                if let Ok(p) = serde_json::from_slice::<Value>(&body_bytes) {
                    self.on_presence(&author, &f, &p, ts);
                }
            }
            "bye" => self.remove_member(&author),
            "skey" => {
                if let Ok(b) = serde_json::from_slice::<Value>(&body_bytes) {
                    if self.keys.receive(&self.id.peer_id, &self.statik, &self.secrets.bind_key, &author, &b) {
                        self.want.remove(&author);
                        for data in self.pending.remove(&author).unwrap_or_default() {
                            self.on_data(&author, &data);
                        }
                    }
                }
            }
            "data" => self.on_data(&author, &body_bytes),
            "sig" => {
                if let Ok(b) = serde_json::from_slice::<Value>(&body_bytes) {
                    self.on_routed(&author, &b);
                }
            }
            _ => {}
        }
    }

    fn on_presence(&mut self, author: &str, frame: &Value, p: &Value, ts: u64) {
        if self.presence_frames.get(author).and_then(|f| f["ts"].as_u64()).is_some_and(|prev| prev > ts) {
            return;
        }
        let Some(x_pub) = p["xPub"].as_str().and_then(|x| from_b64u(x).ok()) else { return };
        let nick: String = p["nick"].as_str().unwrap_or("").trim().chars().take(40).collect();
        let nick = if nick.is_empty() { "Guest".to_string() } else { nick };
        self.presence_frames.insert(author.to_string(), frame.clone());
        let is_new = !self.members.contains_key(author);
        self.members.insert(author.to_string(), Member { nick: nick.clone(), x_pub, last_seen: Instant::now() });
        let asked =
            p["want"].as_array().is_some_and(|w| w.iter().any(|x| x.as_str() == Some(self.id.peer_id.as_str())));
        if is_new || asked {
            self.send_key_to(author);
        }
        if let Some(key_id) = p["keyId"].as_u64().and_then(|k| u32::try_from(k).ok()) {
            if !self.keys.has_key(author, key_id) && self.want.insert(author.to_string()) {
                self.publish_presence();
            }
        }
        if is_new {
            self.emit(RoomEvent::MemberJoined { peer_id: author.to_string(), nick });
            self.maintain();
        }
    }

    fn send_key_to(&mut self, id: &str) {
        if self.last_key_send.get(id).is_some_and(|t| t.elapsed() < Duration::from_secs(2)) {
            return;
        }
        let Some(m) = self.members.get(id) else { return };
        self.last_key_send.insert(id.to_string(), Instant::now());
        let body = self.keys.wrap(
            &self.id.peer_id,
            &self.statik,
            &self.secrets.bind_key,
            &[(id.to_string(), m.x_pub.clone())],
        );
        self.publish("skey", body.to_string().as_bytes(), None);
    }

    fn on_data(&mut self, author: &str, data: &[u8]) {
        match self.keys.decrypt(author, data) {
            Decrypted::Ok(pt) => {
                if let Ok(msg) = serde_json::from_slice::<Value>(&pt) {
                    self.emit(RoomEvent::App { author: author.to_string(), msg });
                }
            }
            Decrypted::UnknownKey => {
                let list = self.pending.entry(author.to_string()).or_default();
                list.push(data.to_vec());
                if list.len() > 256 {
                    list.remove(0);
                }
                if self.want.insert(author.to_string()) {
                    self.publish_presence();
                }
            }
            Decrypted::Invalid => {}
        }
    }

    fn send_app(&mut self, msg: &Value) {
        let ct = self.keys.encrypt(&self.id.peer_id, msg.to_string().as_bytes());
        self.publish("data", &ct, None);
    }

    fn publish_presence(&mut self) {
        let mut p = json!({"nick": self.nick, "xPub": b64u(&self.statik.public),
            "media": {"audio": false, "video": false, "screen": false}, "links": self.ready_ids(),
            "joinedAt": self.joined_at, "e2ee": false, "keyId": self.keys.key_id});
        if !self.want.is_empty() {
            p["want"] = json!(self.want.iter().collect::<Vec<_>>());
        }
        self.own_presence = Some(self.publish("presence", p.to_string().as_bytes(), None));
    }

    fn heartbeat(&mut self) {
        let gone: Vec<String> = self
            .members
            .iter()
            .filter(|(id, m)| m.last_seen.elapsed() > MEMBER_TIMEOUT && !self.peers.get(*id).is_some_and(|s| s.ready))
            .map(|(id, _)| id.clone())
            .collect();
        for id in gone {
            self.remove_member(&id);
        }
        self.publish_presence();
    }

    fn remove_member(&mut self, id: &str) {
        let had = self.members.remove(id);
        self.presence_frames.remove(id);
        self.keys.forget(id);
        self.pending.remove(id);
        self.want.remove(id);
        self.required.remove(id);
        self.drop_slot(id, "left");
        // Offers/answers routed through the departed member may be lost: retry those attempts.
        let stale: Vec<String> =
            self.peers.iter().filter(|(_, s)| !s.ready && s.mesh).map(|(k, _)| k.clone()).collect();
        for s in stale {
            self.drop_slot(&s, "route lost");
            self.rounds.insert(s, 3);
        }
        if let Some(m) = had {
            self.emit(RoomEvent::MemberLeft { nick: m.nick });
            // Forward secrecy for the group: the departed member never gets our next key.
            self.rotate_and_distribute();
        }
    }

    fn rotate_and_distribute(&mut self) {
        self.keys.rotate();
        let recipients: Vec<(String, Vec<u8>)> =
            self.members.iter().map(|(k, m)| (k.clone(), m.x_pub.clone())).collect();
        let body = self.keys.wrap(&self.id.peer_id, &self.statik, &self.secrets.bind_key, &recipients);
        self.publish("skey", body.to_string().as_bytes(), None);
    }

    fn leave(&mut self) {
        self.publish("bye", b"", None);
        self.signaling.send(Outgoing { kind: "bye".into(), ..Default::default() });
        for (_, s) in self.peers.drain() {
            let _ = s.tx.send(PeerCmd::Close("leaving".into()));
        }
    }
}
