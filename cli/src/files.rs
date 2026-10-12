//! File transfer, wire-compatible with `src/features/files.ts`: 63 KiB chunks
//! over the encrypted `file` channel, SHA-256 per chunk and for the whole
//! file, a window of unacknowledged chunks, and resume from the last chunk
//! written.

use crate::crypto::{b64u, random, sha256};
use crate::peer::Frame;
use crate::room::RoomHandle;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tokio::sync::watch;

pub const CHUNK_SIZE: u64 = 63 * 1024;
pub const WINDOW: u64 = 64;
const ACK_EVERY: u64 = 8;

pub fn chunk_count(size: u64) -> u64 {
    size.div_ceil(CHUNK_SIZE)
}

pub fn encode_chunk(id: &str, index: u32, data: &[u8]) -> Vec<u8> {
    let mut out = vec![id.len() as u8];
    out.extend_from_slice(id.as_bytes());
    out.extend_from_slice(&index.to_be_bytes());
    out.extend_from_slice(&sha256(data));
    out.extend_from_slice(data);
    out
}

pub fn decode_chunk(b: &[u8]) -> Option<(String, u32, [u8; 32], &[u8])> {
    let n = *b.first()? as usize;
    if b.len() < 1 + n + 4 + 32 {
        return None;
    }
    let id = std::str::from_utf8(&b[1..1 + n]).ok()?.to_string();
    let index = u32::from_be_bytes(b[1 + n..5 + n].try_into().ok()?);
    let hash: [u8; 32] = b[5 + n..37 + n].try_into().ok()?;
    Some((id, index, hash, &b[37 + n..]))
}

/// A safe file name: no directories, no control characters, never empty or hidden.
pub fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String =
        base.chars().filter(|c| !c.is_control()).collect::<String>().trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "file".to_string()
    } else {
        cleaned.chars().take(200).collect()
    }
}

/// `dir/name`, or `dir/name (1).ext` etc. when it already exists.
pub fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..).map(|i| dir.join(format!("{stem} ({i}){ext}"))).find(|p| !p.exists()).expect("a free name")
}

fn mime_of(name: &str) -> &'static str {
    match name.rsplit('.').next().map(str::to_lowercase).as_deref() {
        Some("txt" | "md") => "text/plain",
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("zip") => "application/zip",
        Some("json") => "application/json",
        Some("mp4") => "video/mp4",
        _ => "application/octet-stream",
    }
}

// ── sending ─────────────────────────────────────────────────────────────────

pub struct OutgoingFile {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
    /// Per recipient: highest chunk acknowledged, watched by the streaming task.
    acks: HashMap<String, watch::Sender<u64>>,
    pub done: Vec<String>,
}

impl OutgoingFile {
    pub fn open(path: &Path) -> Result<Self> {
        let meta = std::fs::metadata(path)?;
        if !meta.is_file() {
            bail!("{} is not a file", path.display());
        }
        let mut f = File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = f.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "file".into());
        Ok(Self {
            id: b64u(&random::<12>()),
            name: sanitize_name(&name),
            path: path.to_path_buf(),
            size: meta.len(),
            sha256: hex::encode(hasher.finalize()),
            acks: HashMap::new(),
            done: Vec::new(),
        })
    }

    pub fn offer(&self) -> Value {
        json!({"type": "file-offer", "id": self.id, "name": self.name, "size": self.size, "mime": mime_of(&self.name)})
    }

    pub fn total(&self) -> u64 {
        chunk_count(self.size)
    }
}

/// Streams chunks `from..` to one recipient, never more than WINDOW ahead of its acks.
fn stream(room: RoomHandle, peer_id: String, file: &OutgoingFile, from: u64, mut acks: watch::Receiver<u64>) {
    let (id, path, size, digest) = (file.id.clone(), file.path.clone(), file.size, file.sha256.clone());
    tokio::spawn(async move {
        let total = chunk_count(size);
        let Ok(mut f) = File::open(&path) else { return };
        for i in from..total {
            // A newer request (or a cancel) dropped our sender: stop.
            if acks.has_changed().is_err() {
                return;
            }
            while i >= *acks.borrow() + WINDOW {
                if acks.changed().await.is_err() {
                    return; // replaced by a newer stream or cancelled
                }
            }
            let len = (size - i * CHUNK_SIZE).min(CHUNK_SIZE) as usize;
            let mut data = vec![0u8; len];
            if f.seek(SeekFrom::Start(i * CHUNK_SIZE)).and_then(|_| f.read_exact(&mut data)).is_err() {
                return;
            }
            room.send_file(&peer_id, Frame::Binary(encode_chunk(&id, i as u32, &data)));
        }
        room.send_file(&peer_id, Frame::Json(json!({"t": "end", "id": id, "chunks": total, "sha256": digest})));
    });
}

pub enum SenderUpdate {
    Progress { peer_id: String, file: String, bytes: u64, size: u64 },
    Delivered { peer_id: String, file: String },
}

/// Handles a recipient's control message for one of our files.
pub fn on_sender_ctrl(
    room: &RoomHandle,
    files: &mut [OutgoingFile],
    peer_id: &str,
    msg: &Value,
) -> Option<SenderUpdate> {
    let id = msg["id"].as_str()?;
    let Some(file) = files.iter_mut().find(|f| f.id == id) else {
        if msg["t"] == "req" {
            room.send_file(peer_id, Frame::Json(json!({"t": "cancel", "id": id})));
        }
        return None;
    };
    match msg["t"].as_str()? {
        "req" => {
            let from = msg["from"].as_u64()?.min(file.total());
            let (tx, rx) = watch::channel(from);
            // A new request replaces any stream still running for that member.
            file.acks.insert(peer_id.to_string(), tx);
            stream(room.clone(), peer_id.to_string(), file, from, rx);
            None
        }
        "ack" => {
            let upto = msg["upto"].as_u64()?;
            if let Some(tx) = file.acks.get(peer_id) {
                let _ = tx.send(upto);
            }
            if upto >= file.total() && !file.done.iter().any(|d| d == peer_id) {
                file.done.push(peer_id.to_string());
                file.acks.remove(peer_id);
                return Some(SenderUpdate::Delivered { peer_id: peer_id.to_string(), file: file.name.clone() });
            }
            Some(SenderUpdate::Progress {
                peer_id: peer_id.to_string(),
                file: file.name.clone(),
                bytes: (upto * CHUNK_SIZE).min(file.size),
                size: file.size,
            })
        }
        "cancel" => {
            file.acks.remove(peer_id);
            None
        }
        _ => None,
    }
}

// ── receiving ───────────────────────────────────────────────────────────────

pub struct IncomingFile {
    pub id: String,
    pub from: String,
    pub name: String,
    pub size: u64,
    pub path: PathBuf,
    out: Option<File>,
    hasher: Sha256,
    pub next: u64,
    pub received: u64,
}

pub enum ReceiveUpdate {
    Progress { bytes: u64, size: u64 },
    Done { path: PathBuf, sha256: String },
    Failed(String),
}

impl IncomingFile {
    pub fn create(dir: &Path, offer: &Value, from: &str) -> Result<Self> {
        let (Some(id), Some(name), Some(size)) = (offer["id"].as_str(), offer["name"].as_str(), offer["size"].as_u64())
        else {
            bail!("malformed offer");
        };
        let path = unique_path(dir, &sanitize_name(name));
        let out = File::create(&path)?;
        Ok(Self {
            id: id.to_string(),
            from: from.to_string(),
            name: sanitize_name(name),
            size,
            path,
            out: Some(out),
            hasher: Sha256::new(),
            next: 0,
            received: 0,
        })
    }

    /// Asks the sender for the file, from the first chunk we do not have (start or resume).
    pub fn request(&self, room: &RoomHandle) {
        room.send_file(&self.from, Frame::Json(json!({"t": "req", "id": self.id, "from": self.next})));
    }

    pub fn total(&self) -> u64 {
        chunk_count(self.size)
    }

    pub fn on_chunk(&mut self, room: &RoomHandle, index: u32, hash: &[u8; 32], data: &[u8]) -> Option<ReceiveUpdate> {
        self.out.as_ref()?;
        if index as u64 != self.next {
            return None; // duplicate after a resume
        }
        if &sha256(data) != hash {
            return Some(self.fail("a chunk was corrupted"));
        }
        let expected = if self.next == self.total() - 1 { self.size - self.next * CHUNK_SIZE } else { CHUNK_SIZE };
        if data.len() as u64 != expected {
            return Some(self.fail("unexpected chunk size"));
        }
        if let Err(e) = self.out.as_mut().expect("checked above").write_all(data) {
            return Some(self.fail(&e.to_string()));
        }
        self.hasher.update(data);
        self.next += 1;
        self.received += data.len() as u64;
        if self.next % ACK_EVERY == 0 || self.next == self.total() {
            room.send_file(&self.from, Frame::Json(json!({"t": "ack", "id": self.id, "upto": self.next})));
        }
        Some(ReceiveUpdate::Progress { bytes: self.received, size: self.size })
    }

    pub fn on_end(&mut self, room: &RoomHandle, msg: &Value) -> Option<ReceiveUpdate> {
        let mut out = self.out.take()?;
        let (Some(chunks), Some(digest)) = (msg["chunks"].as_u64(), msg["sha256"].as_str()) else {
            self.out = Some(out);
            return None;
        };
        if chunks != self.total() || self.next != chunks {
            self.out = Some(out);
            return None;
        }
        if chunks == 0 {
            room.send_file(&self.from, Frame::Json(json!({"t": "ack", "id": self.id, "upto": 0})));
        }
        let actual = hex::encode(std::mem::take(&mut self.hasher).finalize());
        if actual != digest {
            drop(out);
            let _ = std::fs::remove_file(&self.path);
            return Some(ReceiveUpdate::Failed("integrity check failed (SHA-256 mismatch)".into()));
        }
        if let Err(e) = out.flush() {
            return Some(ReceiveUpdate::Failed(e.to_string()));
        }
        Some(ReceiveUpdate::Done { path: self.path.clone(), sha256: actual })
    }

    fn fail(&mut self, why: &str) -> ReceiveUpdate {
        self.out = None;
        let _ = std::fs::remove_file(&self.path);
        ReceiveUpdate::Failed(why.to_string())
    }

    pub fn abort(&mut self) {
        if self.out.take().is_some() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// A cancel only counts when it comes from the member who is sending the file.
pub fn take_cancelled(incoming: &mut HashMap<String, IncomingFile>, author: &str, id: &str) -> Option<IncomingFile> {
    if incoming.get(id)?.from != author {
        return None;
    }
    incoming.remove(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_sender_can_cancel() {
        let dir = std::env::temp_dir().join(format!("veil-cancel-{}", b64u(&random::<6>())));
        std::fs::create_dir_all(&dir).unwrap();
        let offer = json!({"id": "abcdefghijklmnop", "name": "a.bin", "size": 10});
        let mut incoming = HashMap::new();
        let f = IncomingFile::create(&dir, &offer, "aaaaaaaaaaaaaaaaaaaa").unwrap();
        incoming.insert(f.id.clone(), f);
        assert!(take_cancelled(&mut incoming, "mmmmmmmmmmmmmmmmmmmm", "abcdefghijklmnop").is_none());
        assert!(incoming.contains_key("abcdefghijklmnop"));
        let mut f = take_cancelled(&mut incoming, "aaaaaaaaaaaaaaaaaaaa", "abcdefghijklmnop").unwrap();
        f.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunk_round_trip() {
        let enc = encode_chunk("abcdefghijklmnop", 7, b"hello");
        let (id, i, h, d) = decode_chunk(&enc).unwrap();
        assert_eq!((id.as_str(), i, d), ("abcdefghijklmnop", 7, &b"hello"[..]));
        assert_eq!(h, sha256(b"hello"));
    }

    #[test]
    fn names_are_sanitized() {
        assert_eq!(sanitize_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_name("..\\..\\win.ini"), "win.ini");
        assert_eq!(sanitize_name(".bashrc"), "bashrc");
        assert_eq!(sanitize_name("a\u{0}b\nc.txt"), "abc.txt");
        assert_eq!(sanitize_name("///"), "file");
    }

    #[test]
    fn counts() {
        assert_eq!(chunk_count(0), 0);
        assert_eq!(chunk_count(1), 1);
        assert_eq!(chunk_count(CHUNK_SIZE), 1);
        assert_eq!(chunk_count(CHUNK_SIZE + 1), 2);
    }
}
