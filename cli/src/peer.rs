//! One WebRTC connection to one member, as in `src/mesh/peer.ts`: three
//! negotiated DataChannels (ctrl 0, chat 1, file 2), non-trickle ICE, an
//! in-band handshake bound to both DTLS fingerprints, then every message
//! encrypted by a counter-based SecureChannel.
//!
//! Each peer runs as an actor task; the room talks to it with `PeerCmd` and
//! hears back through `PeerEvent`.

use crate::crypto::{b64u, from_b64u, hkdf32, normalize_fingerprint, random, sas_commit, sdp_fingerprint, sha256};
use crate::identity::{peer_id_of, verify, Identity};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Result};
use bytes::BytesMut;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use webrtc::data_channel::{DataChannel, DataChannelEvent, RTCDataChannelInit};
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCConfigurationBuilder,
    RTCIceGatheringState, RTCIceServer, RTCPeerConnectionState, RTCSdpType, RTCSessionDescription, SettingEngine,
};
use x25519_dalek::{EphemeralSecret, PublicKey};

pub const LABELS: [&str; 3] = ["ctrl", "chat", "file"];
pub const CTRL: usize = 0;
pub const CHAT: usize = 1;
pub const FILE: usize = 2;
const GATHER_TIMEOUT: Duration = Duration::from_secs(3);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const PING_EVERY: Duration = Duration::from_secs(5);

/// A plaintext frame inside a SecureChannel: JSON (tag 0) or binary (tag 1).
#[derive(Debug, Clone)]
pub enum Frame {
    Json(Value),
    Binary(Vec<u8>),
}

impl Frame {
    pub fn encode(&self) -> Vec<u8> {
        match self {
            Frame::Json(v) => {
                let mut out = vec![0u8];
                out.extend_from_slice(v.to_string().as_bytes());
                out
            }
            Frame::Binary(b) => {
                let mut out = vec![1u8];
                out.extend_from_slice(b);
                out
            }
        }
    }

    pub fn decode(b: &[u8]) -> Option<Frame> {
        match b.first()? {
            0 => serde_json::from_slice(&b[1..]).ok().map(Frame::Json),
            1 => Some(Frame::Binary(b[1..].to_vec())),
            _ => None,
        }
    }
}

/// msg = counter (8, BE) || AES-GCM(nonce = 0^4 || counter, aad = counter). Rejects replay/reorder.
pub struct SecureChannel {
    send: Aes256Gcm,
    recv: Aes256Gcm,
    send_ctr: u64,
    recv_ctr: Option<u64>,
}

impl SecureChannel {
    pub fn new(send_key: &[u8; 32], recv_key: &[u8; 32]) -> Self {
        Self {
            send: Aes256Gcm::new(send_key.into()),
            recv: Aes256Gcm::new(recv_key.into()),
            send_ctr: 0,
            recv_ctr: None,
        }
    }

    pub fn encrypt(&mut self, pt: &[u8]) -> Vec<u8> {
        let ctr = self.send_ctr.to_be_bytes();
        self.send_ctr += 1;
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&ctr);
        let ct = self.send.encrypt(Nonce::from_slice(&nonce), Payload { msg: pt, aad: &ctr }).expect("AES-GCM");
        let mut out = ctr.to_vec();
        out.extend_from_slice(&ct);
        out
    }

    pub fn decrypt(&mut self, msg: &[u8]) -> Result<Vec<u8>> {
        if msg.len() < 8 + 16 {
            bail!("short");
        }
        let ctr: [u8; 8] = msg[..8].try_into()?;
        let n = u64::from_be_bytes(ctr);
        if self.recv_ctr.is_some_and(|last| n <= last) {
            bail!("replay");
        }
        let mut nonce = [0u8; 12];
        nonce[4..].copy_from_slice(&ctr);
        let pt = self
            .recv
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &msg[8..], aad: &ctr })
            .map_err(|_| anyhow!("decryption failed"))?;
        self.recv_ctr = Some(n);
        Ok(pt)
    }
}

fn transcript(bind_key: &[u8], x_pub: &[u8], own_fp: &str, other_fp: &str) -> Vec<u8> {
    let mut t = b"veil/hs/v1".to_vec();
    t.extend_from_slice(&sha256(bind_key));
    t.extend_from_slice(x_pub);
    t.extend_from_slice(format!("{}|{}", normalize_fingerprint(own_fp), normalize_fingerprint(other_fp)).as_bytes());
    t
}

/// The SAS commitment gets its own signature, so `sig` stays verifiable by peers that predate it.
fn commit_transcript(t: &[u8], commit: &[u8]) -> Vec<u8> {
    let mut out = b"veil/hs-commit/v1".to_vec();
    out.extend_from_slice(t);
    out.extend_from_slice(commit);
    out
}

/// Inputs of the pairwise session derivation (both ends of one DTLS association).
pub struct SessionInputs<'a> {
    pub shared: &'a [u8],
    pub bind_key: &'a [u8],
    pub me: &'a str,
    pub them: &'a str,
    pub my_x: &'a [u8],
    pub their_x: &'a [u8],
    pub local_fp: &'a str,
    pub remote_fp: &'a str,
}

/// Session keys for the three channels, exactly as `PeerSession` derives them.
pub fn session_channels(i: &SessionInputs<'_>) -> Vec<SecureChannel> {
    let SessionInputs { shared, bind_key, me, them, my_x, their_x, local_fp, remote_fp } = *i;
    let me_low = me < them;
    let (lo_x, hi_x) = if me_low { (my_x, their_x) } else { (their_x, my_x) };
    let (lo_fp, hi_fp) = if me_low { (local_fp, remote_fp) } else { (remote_fp, local_fp) };
    let mut info = b"veil/session/v1".to_vec();
    info.extend_from_slice(lo_x);
    info.extend_from_slice(hi_x);
    info.extend_from_slice(format!("{}|{}", normalize_fingerprint(lo_fp), normalize_fingerprint(hi_fp)).as_bytes());
    let secret = hkdf32(shared, bind_key, &info);
    LABELS
        .iter()
        .map(|label| {
            let send = hkdf32(&secret, b"veil/v1", format!("chan/{label}/{me}>{them}").as_bytes());
            let recv = hkdf32(&secret, b"veil/v1", format!("chan/{label}/{them}>{me}").as_bytes());
            SecureChannel::new(&send, &recv)
        })
        .collect()
}

#[derive(Debug)]
pub enum PeerEvent {
    /// A description to deliver outside the ctrl channel (bootstrap, ICE restart).
    Signal {
        kind: &'static str,
        sdp: String,
    },
    /// `outdated`: the peer predates the SAS commitment, so no emojis can be trusted.
    Connected {
        outdated: bool,
    },
    /// The peer revealed the SAS nonce it had committed to: the emojis can be computed.
    Sas {
        remote_ed_pub: Vec<u8>,
        local_fp: String,
        remote_fp: String,
        local_nonce: [u8; 32],
        remote_nonce: [u8; 32],
    },
    Ctrl(Value),
    Gossip(Value),
    File(Frame),
    Closed(String),
}

#[derive(Debug)]
pub enum PeerCmd {
    Remote { kind: String, sdp: String },
    Send { channel: usize, frame: Frame },
    Close(String),
}

pub struct PeerOptions {
    pub identity: Arc<Identity>,
    pub remote_id: String,
    pub bind_key: [u8; 32],
    pub ice_servers: Vec<RTCIceServer>,
    pub initiator: bool,
}

enum Internal {
    Gathering(RTCIceGatheringState),
    Conn(RTCPeerConnectionState),
    Dc(usize, DataChannelEvent),
}

struct Handler {
    tx: mpsc::UnboundedSender<Internal>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        let _ = self.tx.send(Internal::Gathering(state));
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        let _ = self.tx.send(Internal::Conn(state));
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        // We never play media: drain it so the driver is never blocked on us.
        tokio::spawn(async move { while track.poll().await.is_some() {} });
    }
}

/// Spawns the actor. Events are tagged with `key` so the room can route them.
pub fn spawn(
    key: u64,
    opts: PeerOptions,
    events: mpsc::UnboundedSender<(u64, PeerEvent)>,
) -> mpsc::UnboundedSender<PeerCmd> {
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        let ev = events.clone();
        if let Err(e) = run(key, opts, cmd_rx, events).await {
            let _ = ev.send((key, PeerEvent::Closed(e.to_string())));
        }
    });
    cmd_tx
}

struct Actor {
    key: u64,
    opts: PeerOptions,
    pc: Arc<dyn PeerConnection>,
    events: mpsc::UnboundedSender<(u64, PeerEvent)>,
    internal_tx: mpsc::UnboundedSender<Internal>,
    dcs: Vec<Arc<dyn DataChannel>>,
    open: [bool; 3],
    gathered: bool,
    have_local_offer: bool,
    connected: bool,
    secure: Option<Vec<SecureChannel>>,
    hs: Option<(EphemeralSecret, [u8; 32])>,
    /// Our SAS nonce (committed to in our hello) and the peer's commitment, if it sent one.
    sas_nonce: [u8; 32],
    remote_commit: Option<[u8; 32]>,
    sas_revealed: bool,
    local_fp: String,
    remote_fp: String,
    remote_ed_pub: Vec<u8>,
    pending: Vec<(usize, Vec<u8>)>,
    last_heard: Instant,
    started: Instant,
    down_since: Option<Instant>,
}

async fn run(
    key: u64,
    opts: PeerOptions,
    mut cmds: mpsc::UnboundedReceiver<PeerCmd>,
    events: mpsc::UnboundedSender<(u64, PeerEvent)>,
) -> Result<()> {
    let (internal_tx, mut internal) = mpsc::unbounded_channel();
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let mut setting = SettingEngine::default();
    // Browsers send 64 KiB+ messages; accept up to the 256 KiB WebRTC norm.
    setting.set_sctp_max_message_size(
        rtc::peer_connection::configuration::setting_engine::SctpMaxMessageSize::Bounded(262_144),
    );
    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().with_ice_servers(opts.ice_servers.clone()).build())
        .with_media_engine(media)
        .with_setting_engine(setting)
        .with_handler(Arc::new(Handler { tx: internal_tx.clone() }))
        .with_udp_addrs(vec!["0.0.0.0:0".to_string()])
        .with_data_channel_send_buffer_limit(16 * 1024 * 1024)
        .build()
        .await?;
    let mut a = Actor {
        key,
        opts,
        pc: Arc::new(pc),
        events,
        internal_tx,
        dcs: Vec::new(),
        open: [false; 3],
        gathered: false,
        have_local_offer: false,
        connected: false,
        secure: None,
        hs: None,
        sas_nonce: random(),
        remote_commit: None,
        sas_revealed: false,
        local_fp: String::new(),
        remote_fp: String::new(),
        remote_ed_pub: Vec::new(),
        pending: Vec::new(),
        last_heard: Instant::now(),
        started: Instant::now(),
        down_since: None,
    };
    if a.opts.initiator {
        a.create_channels().await?;
        let offer = a.pc.create_offer(None).await?;
        a.pc.set_local_description(offer).await?;
        a.have_local_offer = true;
        a.wait_gathered(&mut internal).await;
        a.emit_description().await?;
    }
    let mut ping = tokio::time::interval(PING_EVERY);
    loop {
        tokio::select! {
            cmd = cmds.recv() => match cmd {
                None => break,
                Some(PeerCmd::Close(reason)) => { a.close(&reason).await; return Ok(()); }
                Some(PeerCmd::Send { channel, frame }) => a.send(channel, &frame).await,
                Some(PeerCmd::Remote { kind, sdp }) => {
                    if let Err(e) = a.accept_remote(&kind, sdp, &mut internal).await {
                        if e.to_string() == "fingerprint changed" { a.close("fingerprint changed").await; return Ok(()); }
                    }
                }
            },
            ev = internal.recv() => match ev {
                None => break,
                Some(ev) => if let Some(reason) = a.on_internal(ev).await { a.close(&reason).await; return Ok(()); },
            },
            _ = ping.tick() => {
                if a.secure.is_none() && a.started.elapsed() > CONNECT_TIMEOUT { a.close("timeout").await; return Ok(()); }
                if a.down_since.is_some_and(|d| d.elapsed() > Duration::from_secs(45)) { a.close("unreachable").await; return Ok(()); }
                if a.secure.is_some() {
                    let ts = crate::crypto::now_ms();
                    a.send(CTRL, &Frame::Json(json!({"t": "ping", "ts": ts}))).await;
                }
            }
        }
    }
    a.close("closed").await;
    Ok(())
}

impl Actor {
    async fn create_channels(&mut self) -> Result<()> {
        if !self.dcs.is_empty() {
            return Ok(());
        }
        for (i, label) in LABELS.iter().enumerate() {
            let init = RTCDataChannelInit { ordered: true, negotiated: Some(i as u16), ..Default::default() };
            let dc = self.pc.create_data_channel(label, Some(init)).await?;
            let tx = self.internal_tx.clone();
            let poll = dc.clone();
            tokio::spawn(async move {
                while let Some(ev) = poll.poll().await {
                    if tx.send(Internal::Dc(i, ev)).is_err() {
                        break;
                    }
                }
            });
            self.dcs.push(dc);
        }
        Ok(())
    }

    async fn wait_gathered(&mut self, internal: &mut mpsc::UnboundedReceiver<Internal>) {
        if self.gathered {
            return;
        }
        let deadline = tokio::time::sleep(GATHER_TIMEOUT);
        tokio::pin!(deadline);
        let mut deferred = Vec::new();
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                ev = internal.recv() => match ev {
                    Some(Internal::Gathering(RTCIceGatheringState::Complete)) => { self.gathered = true; break; }
                    Some(other) => deferred.push(other),
                    None => break,
                },
            }
        }
        // Events that arrived while waiting are replayed in order.
        for ev in deferred {
            let _ = self.internal_tx.send(ev);
        }
    }

    async fn emit_description(&mut self) -> Result<()> {
        let Some(desc) = self.pc.local_description().await else { return Ok(()) };
        if self.local_fp.is_empty() {
            self.local_fp = sdp_fingerprint(&desc.sdp);
        }
        let kind = if desc.sdp_type == RTCSdpType::Offer { "offer" } else { "answer" };
        if self.secure.is_some() && self.connected && self.open[CTRL] {
            self.send(CTRL, &Frame::Json(json!({"t": "sdp", "type": kind, "sdp": desc.sdp}))).await;
        } else {
            let _ = self.events.send((self.key, PeerEvent::Signal { kind, sdp: desc.sdp }));
        }
        Ok(())
    }

    async fn accept_remote(
        &mut self,
        kind: &str,
        sdp: String,
        internal: &mut mpsc::UnboundedReceiver<Internal>,
    ) -> Result<()> {
        let fp = sdp_fingerprint(&sdp);
        if !self.remote_fp.is_empty() && !fp.is_empty() && fp != self.remote_fp {
            bail!("fingerprint changed");
        }
        let polite = self.opts.identity.peer_id < self.opts.remote_id;
        if kind == "offer" {
            if self.have_local_offer {
                // Glare: the impolite side keeps its offer, the polite one rolls back.
                if !polite {
                    return Ok(());
                }
                self.pc.set_local_description(RTCSessionDescription::rollback(None)?).await?;
                self.have_local_offer = false;
            }
            self.pc.set_remote_description(RTCSessionDescription::offer(sdp)?).await?;
            if self.remote_fp.is_empty() {
                self.remote_fp = fp;
            }
            self.create_channels().await?;
            let answer = self.pc.create_answer(None).await?;
            self.pc.set_local_description(answer).await?;
            self.wait_gathered(internal).await;
            self.emit_description().await?;
        } else if kind == "answer" && self.have_local_offer {
            self.pc.set_remote_description(RTCSessionDescription::answer(sdp)?).await?;
            self.have_local_offer = false;
            if self.remote_fp.is_empty() {
                self.remote_fp = fp;
            }
        }
        Ok(())
    }

    /// Returns a close reason when the connection must end.
    async fn on_internal(&mut self, ev: Internal) -> Option<String> {
        match ev {
            Internal::Gathering(s) => self.gathered = s == RTCIceGatheringState::Complete,
            Internal::Conn(s) => match s {
                RTCPeerConnectionState::Connected => {
                    self.connected = true;
                    self.down_since = None;
                }
                RTCPeerConnectionState::Disconnected | RTCPeerConnectionState::Failed => {
                    self.connected = false;
                    self.down_since.get_or_insert_with(Instant::now);
                }
                RTCPeerConnectionState::Closed => return Some("closed".into()),
                _ => {}
            },
            Internal::Dc(i, DataChannelEvent::OnOpen) => {
                self.open[i] = true;
                if i == CTRL {
                    self.start_handshake().await;
                }
            }
            Internal::Dc(CTRL, DataChannelEvent::OnClose) => return Some("channel closed".into()),
            Internal::Dc(i, DataChannelEvent::OnMessage(msg)) => {
                self.last_heard = Instant::now();
                if msg.is_string {
                    if i == CTRL && self.secure.is_none() {
                        if let Ok(v) = serde_json::from_slice::<Value>(&msg.data) {
                            if let Err(e) = self.finish_handshake(&v).await {
                                return Some(format!("handshake failed: {e}"));
                            }
                        }
                    }
                } else if self.secure.is_none() {
                    self.pending.push((i, msg.data.to_vec()));
                } else if let Some(reason) = self.on_secure_message(i, &msg.data).await {
                    return Some(reason);
                }
            }
            Internal::Dc(..) => {}
        }
        None
    }

    async fn start_handshake(&mut self) {
        if self.hs.is_some() || self.secure.is_some() {
            return;
        }
        if let Some(d) = self.pc.local_description().await {
            self.local_fp = sdp_fingerprint(&d.sdp);
        }
        if let Some(d) = self.pc.remote_description().await {
            self.remote_fp = sdp_fingerprint(&d.sdp);
        }
        let secret = EphemeralSecret::random_from_rng(rand::rngs::OsRng);
        let x_pub = PublicKey::from(&secret).to_bytes();
        let t = transcript(&self.opts.bind_key, &x_pub, &self.local_fp, &self.remote_fp);
        let commit = sas_commit(&self.sas_nonce);
        let sig = self.opts.identity.sign(&t);
        let csig = self.opts.identity.sign(&commit_transcript(&t, &commit));
        let hello = json!({
            "t": "hs", "v": 1, "edPub": b64u(&self.opts.identity.ed_pub), "xPub": b64u(&x_pub), "sig": b64u(&sig),
            "commit": b64u(&commit), "csig": b64u(&csig),
        });
        self.hs = Some((secret, x_pub));
        if let Some(dc) = self.dcs.get(CTRL) {
            let _ = dc.send_text(&hello.to_string()).await;
        }
    }

    async fn finish_handshake(&mut self, v: &Value) -> Result<()> {
        if v["t"] != "hs" {
            return Ok(());
        }
        if self.hs.is_none() {
            self.start_handshake().await;
        }
        let ed_pub = from_b64u(v["edPub"].as_str().unwrap_or_default())?;
        let their_x: [u8; 32] =
            from_b64u(v["xPub"].as_str().unwrap_or_default())?.try_into().map_err(|_| anyhow!("bad key"))?;
        let sig: [u8; 64] =
            from_b64u(v["sig"].as_str().unwrap_or_default())?.try_into().map_err(|_| anyhow!("bad signature"))?;
        if peer_id_of(&ed_pub) != self.opts.remote_id {
            bail!("identity mismatch");
        }
        let t = transcript(&self.opts.bind_key, &their_x, &self.remote_fp, &self.local_fp);
        if !verify(&ed_pub, &sig, &t) {
            bail!("bad signature");
        }
        // The SAS commitment and its signature come together, or not at all (older peers).
        let remote_commit = match (v["commit"].as_str(), v["csig"].as_str()) {
            (None, None) => None,
            (Some(commit), Some(csig)) => {
                let commit: [u8; 32] = from_b64u(commit)?.try_into().map_err(|_| anyhow!("bad commit"))?;
                if !verify(&ed_pub, &from_b64u(csig)?, &commit_transcript(&t, &commit)) {
                    bail!("bad signature");
                }
                Some(commit)
            }
            _ => bail!("bad commit"),
        };
        let (secret, my_x) = self.hs.take().ok_or_else(|| anyhow!("no handshake"))?;
        let shared = secret.diffie_hellman(&PublicKey::from(their_x));
        if shared.as_bytes().iter().all(|b| *b == 0) {
            bail!("bad key");
        }
        let me = self.opts.identity.peer_id.clone();
        self.secure = Some(session_channels(&SessionInputs {
            shared: shared.as_bytes(),
            bind_key: &self.opts.bind_key,
            me: &me,
            them: &self.opts.remote_id,
            my_x: &my_x,
            their_x: &their_x,
            local_fp: &self.local_fp,
            remote_fp: &self.remote_fp,
        }));
        self.remote_ed_pub = ed_pub;
        self.remote_commit = remote_commit;
        let _ = self.events.send((self.key, PeerEvent::Connected { outdated: remote_commit.is_none() }));
        // The peer has committed to its SAS nonce (in its hello): ours can be revealed now.
        if remote_commit.is_some() {
            let nonce = b64u(&self.sas_nonce);
            self.send(CTRL, &Frame::Json(json!({"t": "sas", "nonce": nonce}))).await;
        }
        for (i, data) in std::mem::take(&mut self.pending) {
            if self.on_secure_message(i, &data).await.is_some() {
                break;
            }
        }
        Ok(())
    }

    async fn on_secure_message(&mut self, i: usize, data: &[u8]) -> Option<String> {
        let chans = self.secure.as_mut()?;
        let Ok(pt) = chans[i].decrypt(data) else { return Some("decryption failed".into()) };
        let frame = Frame::decode(&pt)?;
        match (i, frame) {
            (FILE, f) => {
                let _ = self.events.send((self.key, PeerEvent::File(f)));
            }
            (CHAT, Frame::Json(v)) => {
                let _ = self.events.send((self.key, PeerEvent::Gossip(v)));
            }
            (CTRL, Frame::Json(v)) => match v["t"].as_str() {
                Some("ping") => {
                    let ts = v["ts"].clone();
                    self.send(CTRL, &Frame::Json(json!({"t": "pong", "ts": ts}))).await;
                }
                Some("pong") => {}
                Some("bye") => return Some("left".into()),
                Some("sas") => {
                    // A nonce that does not open the peer's commitment: it changed its mind after seeing ours.
                    // Malformed: ignored, as the web app's decoder does.
                    let nonce = from_b64u(v["nonce"].as_str().unwrap_or_default()).ok()?;
                    let nonce: [u8; 32] = nonce.try_into().ok()?;
                    if self.remote_commit != Some(sas_commit(&nonce)) {
                        return Some("sas commit mismatch".into());
                    }
                    if !std::mem::replace(&mut self.sas_revealed, true) {
                        let _ = self.events.send((
                            self.key,
                            PeerEvent::Sas {
                                remote_ed_pub: self.remote_ed_pub.clone(),
                                local_fp: self.local_fp.clone(),
                                remote_fp: self.remote_fp.clone(),
                                local_nonce: self.sas_nonce,
                                remote_nonce: nonce,
                            },
                        ));
                    }
                }
                Some("sdp") => {
                    let kind = v["type"].as_str().unwrap_or_default().to_string();
                    let sdp = v["sdp"].as_str().unwrap_or_default().to_string();
                    // Renegotiation (e.g. the other side adding media) travels over ctrl.
                    if self.accept_remote_inline(&kind, sdp).await.is_err() {
                        return Some("fingerprint changed".into());
                    }
                }
                _ => {
                    let _ = self.events.send((self.key, PeerEvent::Ctrl(v)));
                }
            },
            _ => {}
        }
        None
    }

    /// Renegotiation received on ctrl: same as `accept_remote`, without waiting on gathering
    /// (no ICE restart over a working ctrl channel, so candidates are already known).
    async fn accept_remote_inline(&mut self, kind: &str, sdp: String) -> Result<()> {
        let fp = sdp_fingerprint(&sdp);
        if !self.remote_fp.is_empty() && !fp.is_empty() && fp != self.remote_fp {
            bail!("fingerprint changed");
        }
        if kind == "offer" {
            let polite = self.opts.identity.peer_id < self.opts.remote_id;
            if self.have_local_offer {
                if !polite {
                    return Ok(());
                }
                self.pc.set_local_description(RTCSessionDescription::rollback(None)?).await?;
                self.have_local_offer = false;
            }
            self.pc.set_remote_description(RTCSessionDescription::offer(sdp)?).await?;
            let answer = self.pc.create_answer(None).await?;
            self.pc.set_local_description(answer).await?;
            self.emit_description().await?;
        } else if kind == "answer" && self.have_local_offer {
            self.pc.set_remote_description(RTCSessionDescription::answer(sdp)?).await?;
            self.have_local_offer = false;
        }
        Ok(())
    }

    async fn send(&mut self, channel: usize, frame: &Frame) {
        let Some(chans) = self.secure.as_mut() else { return };
        if !self.open[channel] {
            return;
        }
        let sealed = chans[channel].encrypt(&frame.encode());
        if let Some(dc) = self.dcs.get(channel) {
            let _ = dc.send(BytesMut::from(&sealed[..])).await;
        }
    }

    async fn close(&mut self, reason: &str) {
        if reason == "leaving" && self.secure.is_some() {
            self.send(CTRL, &Frame::Json(json!({"t": "bye"}))).await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let _ = self.pc.close().await;
        let _ = self.events.send((self.key, PeerEvent::Closed(reason.to_string())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_channel_round_trip_and_replay() {
        let k1 = [1u8; 32];
        let k2 = [2u8; 32];
        let mut a = SecureChannel::new(&k1, &k2);
        let mut b = SecureChannel::new(&k2, &k1);
        let m0 = a.encrypt(b"zero");
        let m1 = a.encrypt(b"one");
        assert_eq!(b.decrypt(&m1).unwrap(), b"one");
        assert!(b.decrypt(&m0).is_err(), "reordered");
        assert!(b.decrypt(&m1).is_err(), "replayed");
    }

    #[test]
    fn frames() {
        let f = Frame::Json(json!({"t": "ping", "ts": 1}));
        assert!(matches!(Frame::decode(&f.encode()), Some(Frame::Json(v)) if v["t"] == "ping"));
        assert!(matches!(Frame::decode(&Frame::Binary(vec![9]).encode()), Some(Frame::Binary(b)) if b == vec![9]));
    }
}
