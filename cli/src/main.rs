//! `veil`: send and receive files, or chat, in a Veil room from the terminal.
//! Same protocol as the web app: a browser and the CLI can share a room.

mod crypto;
mod envelope;
mod files;
mod identity;
mod peer;
mod room;
mod signal;

use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use files::{IncomingFile, OutgoingFile, ReceiveUpdate, SenderUpdate};
use peer::Frame;
use room::{RoomEvent, RoomHandle, RoomOptions};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::AsyncBufReadExt;
use webrtc::peer_connection::RTCIceServer;

const DEFAULT_BASE: &str = "https://maxgfr.github.io/veil/";
const DEFAULT_STUN: [&str; 2] = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"];

#[derive(Parser)]
#[command(name = "veil", version, about = "Peer-to-peer, end-to-end encrypted file transfer and chat in Veil rooms")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Send files: opens a room (or joins --room) and serves them to whoever accepts.
    Send {
        #[arg(required = true)]
        files: Vec<PathBuf>,
        /// Join this room link instead of creating a new room.
        #[arg(long)]
        room: Option<String>,
        /// Exit once one member has received every file.
        #[arg(long)]
        once: bool,
        #[command(flatten)]
        net: NetArgs,
    },
    /// Receive files sent to a room.
    Receive {
        /// Room link (or bare key).
        link: String,
        /// Directory to save into.
        #[arg(short, long, default_value = ".")]
        out: PathBuf,
        /// Accept every file without asking.
        #[arg(short, long)]
        yes: bool,
        /// Exit after the first file is received.
        #[arg(long)]
        once: bool,
        #[command(flatten)]
        net: NetArgs,
    },
    /// Chat in a room (lines from stdin are sent; messages are printed).
    Chat {
        /// Room link (or bare key). Omit to create a new room.
        link: Option<String>,
        #[command(flatten)]
        net: NetArgs,
    },
    /// Print a new room link.
    New {
        #[arg(long, default_value = DEFAULT_BASE)]
        base: String,
        /// A files room: the web app opens without camera or microphone.
        #[arg(long)]
        files: bool,
    },
}

#[derive(Args, Clone)]
struct NetArgs {
    /// Your name in the room.
    #[arg(long, default_value = "Terminal")]
    nick: String,
    /// Room passphrase, if the room uses one.
    #[arg(long, env = "VEIL_PASSPHRASE")]
    passphrase: Option<String>,
    /// Nostr relay (repeatable). Defaults to the web app's relays.
    #[arg(long = "relay")]
    relays: Vec<String>,
    /// WebTorrent tracker (repeatable). Defaults to the web app's trackers.
    #[arg(long = "tracker")]
    trackers: Vec<String>,
    /// Do not use Nostr relays.
    #[arg(long)]
    no_nostr: bool,
    /// Do not use WebTorrent trackers.
    #[arg(long)]
    no_torrent: bool,
    /// STUN server (repeatable). Defaults to Cloudflare and Google.
    #[arg(long = "stun")]
    stun: Vec<String>,
    /// Use no STUN server (local network only).
    #[arg(long)]
    no_stun: bool,
    /// TURN server URL, e.g. turns:turn.example.com:443.
    #[arg(long)]
    turn: Option<String>,
    #[arg(long, default_value = "")]
    turn_user: String,
    #[arg(long, default_value = "", env = "VEIL_TURN_CREDENTIAL")]
    turn_credential: String,
    /// Base URL used when printing room links.
    #[arg(long, default_value = DEFAULT_BASE)]
    base: String,
}

impl NetArgs {
    fn room_options(&self, key: [u8; 32]) -> RoomOptions {
        let relays = if self.no_nostr {
            vec![]
        } else if self.relays.is_empty() {
            signal::DEFAULT_RELAYS.iter().map(|s| s.to_string()).collect()
        } else {
            self.relays.clone()
        };
        let trackers = if self.no_torrent {
            vec![]
        } else if self.trackers.is_empty() {
            signal::DEFAULT_TRACKERS.iter().map(|s| s.to_string()).collect()
        } else {
            self.trackers.clone()
        };
        let mut ice = Vec::new();
        let stun: Vec<String> = if self.no_stun {
            vec![]
        } else if self.stun.is_empty() {
            DEFAULT_STUN.iter().map(|s| s.to_string()).collect()
        } else {
            self.stun.clone()
        };
        if !stun.is_empty() {
            ice.push(RTCIceServer { urls: stun, ..Default::default() });
        }
        if let Some(turn) = &self.turn {
            ice.push(RTCIceServer {
                urls: vec![turn.clone()],
                username: self.turn_user.clone(),
                credential: self.turn_credential.clone(),
            });
        }
        RoomOptions {
            key,
            passphrase: self.passphrase.clone().filter(|p| !p.is_empty()),
            nick: self.nick.chars().take(40).collect(),
            signal: signal::SignalConfig { relays, trackers },
            ice_servers: ice,
        }
    }
}

fn print_qr(text: &str) {
    if let Ok(code) = qrcode::QrCode::new(text.as_bytes()) {
        let s = code
            .render::<qrcode::render::unicode::Dense1x2>()
            .dark_color(qrcode::render::unicode::Dense1x2::Light)
            .light_color(qrcode::render::unicode::Dense1x2::Dark)
            .quiet_zone(true)
            .build();
        eprintln!("{s}");
    }
}

fn human(n: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < units.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", units[i])
    }
}

fn parse_link(link: &str) -> Result<[u8; 32]> {
    crypto::parse_room_link(link).context("not a Veil room link (expected …/veil/#<key>)")
}

fn announce_room(base: &str, key: &[u8; 32], has_passphrase: bool, files: bool) {
    let link = crypto::room_link(base, key, files);
    eprintln!("\nRoom link (share it; the key after # never reaches any server):\n\n  {link}\n");
    print_qr(&link);
    if has_passphrase {
        eprintln!("This room uses a passphrase: share it through a different channel.\n");
    }
    // The link alone on stdout, for scripts.
    println!("{link}");
    let _ = std::io::stdout().flush();
}

struct Names(HashMap<String, String>);

impl Names {
    fn of(&self, id: &str) -> String {
        self.0.get(id).cloned().unwrap_or_else(|| id[..6.min(id.len())].to_string())
    }

    /// Common bookkeeping for room events; returns true when the event was fully handled.
    fn on_event(&mut self, ev: &RoomEvent) -> bool {
        match ev {
            RoomEvent::MemberJoined { peer_id, nick } => {
                self.0.insert(peer_id.clone(), nick.clone());
                eprintln!("+ {nick} joined");
                false
            }
            RoomEvent::MemberLeft { nick, .. } => {
                eprintln!("- {nick} left");
                false
            }
            RoomEvent::LinkUp { peer_id, sas } => {
                eprintln!("  direct encrypted link with {} · verify together: {sas}", self.of(peer_id));
                false
            }
            _ => false,
        }
    }
}

async fn ctrl_c() {
    let _ = tokio::signal::ctrl_c().await;
}

fn main() {
    let cli = Cli::parse();
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let result = runtime.block_on(run(cli));
    // Exit explicitly: a pending stdin read lives on a blocking thread that would
    // otherwise keep the process alive after Ctrl-C.
    let code = match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error: {e:#}");
            1
        }
    };
    std::process::exit(code);
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::New { base, files } => {
            println!("{}", crypto::room_link(&base, &crypto::new_room_key(), files));
            Ok(())
        }
        Command::Send { files, room, once, net } => send(files, room, once, net).await,
        Command::Receive { link, out, yes, once, net } => receive(link, out, yes, once, net).await,
        Command::Chat { link, net } => chat(link, net).await,
    }
}

async fn send(paths: Vec<PathBuf>, room_link: Option<String>, once: bool, net: NetArgs) -> Result<()> {
    let mut files = Vec::new();
    for p in &paths {
        let f = OutgoingFile::open(p).with_context(|| format!("cannot read {}", p.display()))?;
        eprintln!("ready: {} ({}, sha256 {}…)", f.name, human(f.size), &f.sha256[..16]);
        files.push(f);
    }
    let key = match &room_link {
        Some(l) => parse_link(l)?,
        None => crypto::new_room_key(),
    };
    let (room, mut events) = room::spawn(net.room_options(key));
    // A files room: recipients' browsers open the files interface directly.
    announce_room(&net.base, &key, net.passphrase.is_some(), true);
    eprintln!("Waiting for someone to join… (Ctrl-C to stop)");
    // One listener for the whole session: a Ctrl-C between two iterations must not be lost.
    let stop = ctrl_c();
    tokio::pin!(stop);
    let mut names = Names(HashMap::new());
    let mut last_progress = Instant::now();
    loop {
        tokio::select! {
            _ = &mut stop => break,
            ev = events.recv() => {
                let Some(ev) = ev else { break };
                names.on_event(&ev);
                match ev {
                    RoomEvent::MemberJoined { .. } => {
                        // (Re-)announce every file so latecomers see them; receivers de-duplicate.
                        for f in &files { room.send_app(f.offer()); }
                    }
                    RoomEvent::File { peer_id, frame: Frame::Json(msg) } => match files::on_sender_ctrl(&room, &mut files, &peer_id, &msg) {
                        Some(SenderUpdate::Progress { peer_id, file, bytes, size }) if last_progress.elapsed() > Duration::from_millis(500) => {
                            last_progress = Instant::now();
                            eprintln!("  → {} {file}: {} / {}", names.of(&peer_id), human(bytes), human(size));
                        }
                        Some(SenderUpdate::Delivered { peer_id, file }) => {
                            eprintln!("✓ {file} delivered to {} (verified by SHA-256)", names.of(&peer_id));
                            if once && files.iter().all(|f| f.done.iter().any(|d| d == &peer_id)) { break; }
                        }
                        _ => {}
                    },
                    _ => {}
                }
            }
        }
    }
    room.leave().await;
    Ok(())
}

async fn ask(question: &str) -> bool {
    eprint!("{question} [y/N] ");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    let mut stdin = tokio::io::BufReader::new(tokio::io::stdin());
    if stdin.read_line(&mut line).await.is_err() {
        return false;
    }
    matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

async fn receive(link: String, out: PathBuf, yes: bool, once: bool, net: NetArgs) -> Result<()> {
    if !out.is_dir() {
        bail!("{} is not a directory", out.display());
    }
    let key = parse_link(&link)?;
    let (room, mut events) = room::spawn(net.room_options(key));
    eprintln!("Joining the room… (Ctrl-C to stop)");
    let mut names = Names(HashMap::new());
    let mut incoming: HashMap<String, IncomingFile> = HashMap::new();
    let mut offered: Vec<String> = Vec::new();
    let mut linked: Vec<String> = Vec::new();
    let mut last_progress = Instant::now();
    let mut failed = false;
    // One listener for the whole session: a Ctrl-C between two iterations must not be lost.
    let stop = ctrl_c();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            ev = events.recv() => {
                let Some(ev) = ev else { break };
                names.on_event(&ev);
                match ev {
                    RoomEvent::LinkUp { peer_id, .. } => {
                        linked.push(peer_id.clone());
                        // Start, or resume, what this member is sending us.
                        for f in incoming.values().filter(|f| f.from == peer_id) { f.request(&room); }
                    }
                    RoomEvent::LinkDown { peer_id } => linked.retain(|p| p != &peer_id),
                    RoomEvent::App { author, msg } if msg["type"] == "file-offer" => {
                        let Some(id) = msg["id"].as_str() else { continue };
                        if offered.iter().any(|o| o == id) { continue; }
                        offered.push(id.to_string());
                        let name = msg["name"].as_str().unwrap_or("file");
                        let size = msg["size"].as_u64().unwrap_or(0);
                        let q = format!("{} wants to send you {} ({}). Accept?", names.of(&author), files::sanitize_name(name), human(size));
                        if !yes && !ask(&q).await { eprintln!("  declined"); continue; }
                        if yes { eprintln!("{q} yes"); }
                        match IncomingFile::create(&out, &msg, &author) {
                            Ok(f) => {
                                room.require(&author);
                                if linked.contains(&author) { f.request(&room); }
                                incoming.insert(f.id.clone(), f);
                            }
                            Err(e) => eprintln!("  cannot save: {e}"),
                        }
                    }
                    RoomEvent::App { author, msg } if msg["type"] == "file-cancel" => {
                        if let Some(mut f) = msg["id"].as_str().and_then(|id| files::take_cancelled(&mut incoming, &author, id)) {
                            f.abort();
                            eprintln!("✗ {} cancelled by the sender", f.name);
                        }
                    }
                    RoomEvent::File { peer_id, frame } => {
                        let update = match &frame {
                            Frame::Binary(b) => files::decode_chunk(b).and_then(|(id, index, hash, data)| {
                                incoming.get_mut(&id).filter(|f| f.from == peer_id).and_then(|f| f.on_chunk(&room, index, &hash, data).map(|u| (id, u)))
                            }),
                            Frame::Json(msg) if msg["t"] == "end" => msg["id"].as_str().and_then(|id| {
                                incoming.get_mut(id).filter(|f| f.from == peer_id).and_then(|f| f.on_end(&room, msg).map(|u| (id.to_string(), u)))
                            }),
                            _ => None,
                        };
                        match update {
                            Some((id, ReceiveUpdate::Progress { bytes, size })) => {
                                if last_progress.elapsed() > Duration::from_millis(500) {
                                    last_progress = Instant::now();
                                    let name = incoming.get(&id).map(|f| f.name.clone()).unwrap_or_default();
                                    eprintln!("  ← {name}: {} / {}", human(bytes), human(size));
                                }
                            }
                            Some((id, ReceiveUpdate::Done { path, sha256 })) => {
                                incoming.remove(&id);
                                eprintln!("✓ saved {} (SHA-256 {sha256} verified)", path.display());
                                println!("{}", path.display());
                                if once { break; }
                            }
                            Some((id, ReceiveUpdate::Failed(why))) => {
                                incoming.remove(&id);
                                eprintln!("✗ transfer failed: {why}");
                                failed = true;
                                if once { break; }
                            }
                            None => {}
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    for f in incoming.values_mut() {
        f.abort();
    }
    room.leave().await;
    if failed {
        bail!("a transfer failed");
    }
    Ok(())
}

async fn chat(link: Option<String>, net: NetArgs) -> Result<()> {
    let key = match &link {
        Some(l) => parse_link(l)?,
        None => crypto::new_room_key(),
    };
    let (room, mut events) = room::spawn(net.room_options(key));
    if link.is_none() {
        announce_room(&net.base, &key, net.passphrase.is_some(), false);
    }
    eprintln!("Type a message and press Enter. Ctrl-C to leave.");
    let mut names = Names(HashMap::new());
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    let mut receipts: Vec<String> = Vec::new();
    let mut flush = tokio::time::interval(Duration::from_millis(800));
    // One listener for the whole session: a Ctrl-C between two iterations must not be lost.
    let stop = ctrl_c();
    tokio::pin!(stop);
    loop {
        tokio::select! {
            _ = &mut stop => break,
            _ = flush.tick() => if !receipts.is_empty() {
                room.send_app(json!({"type": "receipt", "ids": std::mem::take(&mut receipts)}));
            },
            line = lines.next_line() => match line {
                Ok(Some(text)) if !text.trim().is_empty() => send_chat(&room, &text),
                Ok(Some(_)) => {}
                _ => break,
            },
            ev = events.recv() => {
                let Some(ev) = ev else { break };
                names.on_event(&ev);
                if let RoomEvent::App { author, msg } = ev {
                    if msg["type"] == "chat" {
                        let text = msg["text"].as_str().unwrap_or_default();
                        // Strip terminal control sequences: remote text is untrusted.
                        let clean: String = text.chars().filter(|c| !c.is_control() || *c == '\n').collect();
                        println!("[{}] {clean}", names.of(&author));
                        if let Some(id) = msg["id"].as_str() { receipts.push(id.to_string()); }
                    } else if msg["type"] == "file-offer" {
                        eprintln!("  {} offered a file ({}); use `veil receive` to get files", names.of(&author), msg["name"].as_str().unwrap_or("file"));
                    }
                }
            }
        }
    }
    room.leave().await;
    Ok(())
}

fn send_chat(room: &RoomHandle, text: &str) {
    let msg: Value = json!({"type": "chat", "id": crypto::b64u(&crypto::random::<12>()), "text": text.chars().take(8000).collect::<String>(), "ts": crypto::now_ms()});
    room.send_app(msg);
}
