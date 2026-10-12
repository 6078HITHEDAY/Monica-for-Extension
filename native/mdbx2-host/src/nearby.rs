//! Browser boundary for the pinned Android LAN engine. No caller-controlled paths or
//! engine handles cross Native Messaging. This is transport, not vault adoption.
use crate::{backup_scratch::BackupScratch, runtime::RpcFailure};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use fs2::FileExt;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const MAX_BUFFERS: usize = 4;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;
const INLINE: usize = 600 * 1024;
const TTL: Duration = Duration::from_secs(120);
const MAX_SNAPSHOTS: usize = 8;

type Result<T> = std::result::Result<T, RpcFailure>;
type Args = Map<String, Value>;

pub(crate) fn supports(method: &str) -> bool {
    matches!(
        method,
        "nearby.call"
            | "nearby.input.begin"
            | "nearby.input.chunk"
            | "nearby.input.finish"
            | "nearby.input.release"
            | "nearby.output.read"
            | "nearby.output.release"
    )
}

fn failure(code: &'static str) -> RpcFailure {
    // Only fixed codes; never stringify secret-bearing requests or OS errors.
    RpcFailure::new(code, "Nearby operation could not complete.", false)
}

fn wipe(value: &mut Value) {
    match value {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe),
        Value::Object(o) => o.values_mut().for_each(wipe),
        _ => {}
    }
}

struct Secret(Value);
impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

fn engine(value: Value) -> Result<Value> {
    let value = Secret(value);
    let input = Zeroizing::new(
        serde_json::to_string(&value.0).map_err(|_| failure("nearby-invalid-request"))?,
    );
    let output = Zeroizing::new(monica_lan_sync::request_json(&input));
    let mut parsed =
        Secret(serde_json::from_str(&output).map_err(|_| failure("nearby-engine-invalid"))?);
    if parsed.0["ok"] != true {
        let code = parsed.0["error"].as_str().unwrap_or("unavailable");
        // The pinned engine returns constant codes; bound and sanitize defensively.
        let safe = code.len() <= 64 && code.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        return Err(RpcFailure::new(
            "nearby-engine-error",
            if safe {
                format!("Nearby: {code}.")
            } else {
                "Nearby: unavailable.".into()
            },
            false,
        ));
    }
    Ok(parsed.0["data"].take())
}

fn args(value: Value, allowed: &[&str]) -> Result<Args> {
    let mut value = Secret(value);
    let Some(map) = value.0.as_object_mut() else {
        return Err(failure("nearby-invalid-request"));
    };
    if map.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(failure("nearby-invalid-request"));
    }
    Ok(std::mem::take(map))
}
fn text(a: &mut Args, name: &str) -> Result<String> {
    match a.remove(name) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s),
        _ => Err(failure("nearby-invalid-request")),
    }
}
fn number(a: &mut Args, name: &str) -> Result<u64> {
    a.remove(name)
        .and_then(|v| v.as_u64())
        .ok_or_else(|| failure("nearby-invalid-request"))
}
fn token(a: &mut Args, name: &str) -> Result<String> {
    let value = text(a, name)?;
    if Uuid::parse_str(&value)
        .ok()
        .is_none_or(|u| u.to_string() != value)
    {
        return Err(failure("nearby-invalid-handle"));
    }
    Ok(value)
}
fn key(a: &mut Args, name: &str) -> Result<Zeroizing<String>> {
    let value = Zeroizing::new(text(a, name)?);
    let bytes = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value.as_bytes())
            .map_err(|_| failure("nearby-invalid-key"))?,
    );
    if bytes.len() != 32 || URL_SAFE_NO_PAD.encode(&*bytes) != *value {
        return Err(failure("nearby-invalid-key"));
    }
    Ok(value)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn id() -> String {
    Uuid::new_v4().to_string()
}

fn linked(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}
fn directory(path: &Path) -> std::io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() || linked(&meta) {
        return Err(std::io::ErrorKind::InvalidInput.into());
    }
    Ok(())
}
fn safe_file(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !linked(&meta) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(failure("nearby-storage-invalid")),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum ScanState {
    Ready,
    Scanning,
    Failed,
}
struct Replica {
    handle: u64,
    _lease: File,
    scan: ScanState,
}
impl Drop for Replica {
    fn drop(&mut self) {
        let _ = engine(json!({"operation":"replica_close", "handle":self.handle}));
    }
}
struct AssetWrite {
    index: u32,
    size: usize,
    hash: Sha256,
}
struct Snapshot {
    directory: BackupScratch,
    key: Zeroizing<String>,
    revision: String,
    assets: HashSet<String>,
    finished: HashSet<String>,
    writing: Option<(String, AssetWrite)>,
    failed: bool,
    frozen: bool,
}
struct Transfer {
    handle: u64,
    incoming: BackupScratch,
    // Keeps all encrypted output alive until the native worker has stopped.
    _snapshot: Arc<Snapshot>,
    replica: Option<String>,
}
struct Buffer {
    bytes: Zeroizing<Vec<u8>>,
    size: usize,
    hash: String,
    touched: Instant,
}
struct Discovery {
    result: Arc<Mutex<Option<Result<Value>>>>,
    touched: Instant,
}

pub(crate) struct Nearby {
    root: PathBuf,
    replicas: HashMap<String, Replica>,
    snapshots: HashMap<String, Arc<Snapshot>>,
    transfers: HashMap<String, Transfer>,
    input: HashMap<String, Buffer>,
    output: HashMap<String, Buffer>,
    discoveries: HashMap<String, Discovery>,
}

impl Nearby {
    pub(crate) fn new(host_root: &Path) -> std::io::Result<Self> {
        let root = host_root.join("nearby-v1");
        directory(&root)?;
        directory(&root.join("replicas"))?;
        directory(&root.join("scratch"))?;
        crate::backup_scratch::scavenge(&root.join("scratch"))?;
        Ok(Self {
            root,
            replicas: HashMap::new(),
            snapshots: HashMap::new(),
            transfers: HashMap::new(),
            input: HashMap::new(),
            output: HashMap::new(),
            discoveries: HashMap::new(),
        })
    }

    fn scratch(&self) -> Result<BackupScratch> {
        BackupScratch::new(&self.root.join("scratch"))
            .map_err(|_| failure("nearby-storage-invalid"))
    }
    fn replica(&self, handle: &str) -> Result<u64> {
        self.replicas
            .get(handle)
            .map(|r| r.handle)
            .ok_or_else(|| failure("nearby-replica-closed"))
    }
    fn transfer(&self, handle: &str) -> Result<&Transfer> {
        self.transfers
            .get(handle)
            .ok_or_else(|| failure("nearby-session-closed"))
    }

    pub(crate) fn handle(&mut self, method: &str, params: Value) -> Result<Value> {
        self.input.retain(|_, b| b.touched.elapsed() < TTL);
        self.output.retain(|_, b| b.touched.elapsed() < TTL);
        self.discoveries.retain(|_, b| b.touched.elapsed() < TTL);
        match method {
            "nearby.call" => {
                if self.output.len() >= MAX_BUFFERS {
                    return Err(failure("nearby-buffer-limit"));
                }
                let value = self.call(params)?;
                self.pack(value)
            }
            "nearby.input.begin" => {
                let mut p = args(params, &["size", "sha256"])?;
                let size = number(&mut p, "size")?;
                let hash = text(&mut p, "sha256")?;
                if size == 0
                    || size > monica_lan_sync::MAX_REQUEST_BYTES as u64
                    || hash.len() != 64
                    || !hash.bytes().all(|b| b.is_ascii_hexdigit())
                    || self.input.len() >= MAX_BUFFERS
                {
                    return Err(failure("nearby-buffer-limit"));
                }
                let handle = id();
                self.input.insert(
                    handle.clone(),
                    Buffer {
                        bytes: Zeroizing::new(Vec::new()),
                        size: size as usize,
                        hash,
                        touched: Instant::now(),
                    },
                );
                Ok(json!({"handle":handle, "chunk_bytes":CHUNK}))
            }
            "nearby.input.chunk" => {
                let mut p = args(params, &["handle", "offset", "data"])?;
                let handle = token(&mut p, "handle")?;
                let offset = number(&mut p, "offset")?;
                let encoded = Zeroizing::new(text(&mut p, "data")?);
                if encoded.len() > CHUNK * 2 {
                    return Err(failure("nearby-buffer-limit"));
                }
                let bytes = Zeroizing::new(
                    STANDARD
                        .decode(encoded.as_bytes())
                        .map_err(|_| failure("nearby-invalid-request"))?,
                );
                let b = self
                    .input
                    .get_mut(&handle)
                    .ok_or_else(|| failure("nearby-buffer-closed"))?;
                if offset != b.bytes.len() as u64
                    || bytes.is_empty()
                    || bytes.len() > CHUNK
                    || bytes.len() + b.bytes.len() > b.size
                {
                    return Err(failure("nearby-invalid-offset"));
                }
                b.bytes.extend_from_slice(&bytes);
                b.touched = Instant::now();
                Ok(json!({"next_offset":b.bytes.len()}))
            }
            "nearby.input.finish" => {
                let mut p = args(params, &["handle"])?;
                let handle = token(&mut p, "handle")?;
                if self.output.len() >= MAX_BUFFERS {
                    return Err(failure("nearby-buffer-limit"));
                }
                let b = self
                    .input
                    .remove(&handle)
                    .ok_or_else(|| failure("nearby-buffer-closed"))?;
                if b.bytes.len() != b.size || digest(&b.bytes) != b.hash {
                    return Err(failure("nearby-buffer-integrity"));
                }
                let p = serde_json::from_slice(&b.bytes)
                    .map_err(|_| failure("nearby-invalid-request"))?;
                let result = self.call(p)?;
                self.pack(result)
            }
            "nearby.input.release" | "nearby.output.release" => {
                let mut p = args(params, &["handle"])?;
                let handle = token(&mut p, "handle")?;
                if method == "nearby.input.release" {
                    self.input.remove(&handle);
                } else {
                    self.output.remove(&handle);
                }
                Ok(json!({}))
            }
            "nearby.output.read" => {
                let mut p = args(params, &["handle", "offset"])?;
                let handle = token(&mut p, "handle")?;
                let offset = number(&mut p, "offset")?;
                let b = self
                    .output
                    .get_mut(&handle)
                    .ok_or_else(|| failure("nearby-buffer-closed"))?;
                if offset >= b.bytes.len() as u64 {
                    return Err(failure("nearby-invalid-offset"));
                }
                let end = (offset as usize + CHUNK).min(b.bytes.len());
                b.touched = Instant::now();
                Ok(
                    json!({"data":STANDARD.encode(&b.bytes[offset as usize..end]),"next_offset":end,"size":b.size}),
                )
            }
            _ => Err(failure("nearby-invalid-request")),
        }
    }

    fn pack(&mut self, value: Value) -> Result<Value> {
        let mut value = Secret(value);
        let bytes = Zeroizing::new(
            serde_json::to_vec(&value.0).map_err(|_| failure("nearby-engine-invalid"))?,
        );
        if bytes.len() <= INLINE {
            return Ok(json!({"value":value.0.take()}));
        }
        if bytes.len() > MAX_BYTES {
            return Err(failure("nearby-buffer-limit"));
        }
        let handle = id();
        let size = bytes.len();
        let hash = digest(&bytes);
        self.output.insert(
            handle.clone(),
            Buffer {
                bytes,
                size,
                hash: hash.clone(),
                touched: Instant::now(),
            },
        );
        Ok(json!({"handle":handle,"size":size,"sha256":hash}))
    }

    fn call(&mut self, params: Value) -> Result<Value> {
        let mut p = args(params, &["operation", "params"])?;
        let operation = text(&mut p, "operation")?;
        let params = p.remove("params").unwrap_or(json!({}));
        match operation.as_str() {
            "close_all" => {
                args(params, &[])?;
                self.close_all();
                Ok(json!({}))
            }
            "replica_open" => {
                let mut p = args(params, &["storage_id", "device_id", "key"])?;
                let storage_id = token(&mut p, "storage_id")?;
                let node = text(&mut p, "device_id")?;
                let secret = key(&mut p, "key")?;
                if self.replicas.len() >= 4 {
                    return Err(failure("nearby-replica-limit"));
                }
                let dir = self.root.join("replicas").join(storage_id);
                directory(&dir).map_err(|_| failure("nearby-storage-invalid"))?;
                safe_file(&dir.join("lease"))?;
                let lease = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .open(dir.join("lease"))
                    .map_err(|_| failure("nearby-storage-invalid"))?;
                lease
                    .try_lock_exclusive()
                    .map_err(|_| failure("nearby-replica-busy"))?;
                safe_file(&dir.join("state.enc"))?;
                let opened = engine(
                    json!({"operation":"replica_open","device_id":node,"key":*secret,"path":dir.join("state.enc")}),
                )?;
                let handle = opened["handle"]
                    .as_u64()
                    .ok_or_else(|| failure("nearby-engine-invalid"))?;
                let opaque = id();
                self.replicas.insert(
                    opaque.clone(),
                    Replica {
                        handle,
                        _lease: lease,
                        scan: ScanState::Ready,
                    },
                );
                Ok(json!({"handle":opaque}))
            }
            "replica_close" => {
                let mut p = args(params, &["handle"])?;
                let handle = token(&mut p, "handle")?;
                if self
                    .transfers
                    .values()
                    .any(|t| t.replica.as_ref() == Some(&handle))
                {
                    return Err(failure("nearby-session-busy"));
                }
                self.replicas.remove(&handle);
                Ok(json!({}))
            }
            "replica_export" => self.export(params),
            "snapshot_release" => {
                let mut p = args(params, &["handle"])?;
                self.snapshots.remove(&token(&mut p, "handle")?);
                Ok(json!({}))
            }
            "asset_append" => self.append_asset(params),
            "start" | "connect" => self.start(&operation, params),
            "progress" | "cancel" | "release" | "acknowledge" => self.session(&operation, params),
            "replica_merge" => self.merge(params),
            "asset_list" | "asset_read" => self.read_asset(&operation, params),
            "discover" => {
                let p = args(params, &["targets", "multicast"])?;
                if self.discoveries.len() >= 2 {
                    return Err(failure("nearby-discovery-busy"));
                }
                let mut request = Value::Object(p);
                request["operation"] = json!("discover");
                let result = Arc::new(Mutex::new(None));
                let worker = result.clone();
                std::thread::spawn(move || {
                    let value = engine(request);
                    if let Ok(mut slot) = worker.lock() {
                        *slot = Some(value);
                    }
                });
                let handle = id();
                self.discoveries.insert(
                    handle.clone(),
                    Discovery {
                        result,
                        touched: Instant::now(),
                    },
                );
                Ok(json!({"handle":handle}))
            }
            "discovery_result" => {
                let mut p = args(params, &["handle"])?;
                let handle = token(&mut p, "handle")?;
                let discovery = self
                    .discoveries
                    .get(&handle)
                    .ok_or_else(|| failure("nearby-discovery-closed"))?;
                let result = discovery
                    .result
                    .lock()
                    .map_err(|_| failure("nearby-discovery-closed"))?
                    .take();
                match result {
                    None => Ok(json!({"ready":false})),
                    Some(value) => {
                        self.discoveries.remove(&handle);
                        Ok(json!({"ready":true,"result":value?}))
                    }
                }
            }
            _ => self.replica_operation(&operation, params),
        }
    }

    fn replica_operation(&mut self, operation: &str, params: Value) -> Result<Value> {
        let allowed: &[&str] = match operation {
            "replica_scan_begin" => &["handle", "scopes"],
            "replica_scan_batch" => &["handle", "entries"],
            "replica_scan_end" | "replica_revision" => &["handle"],
            "replica_local" => &["handle", "local_ids", "include_data"],
            "replica_resolve" => &["handle", "ids", "scope", "include_data"],
            "replica_rebind" | "replica_applied_batch" => &["handle", "items"],
            // IDs remain lexicographically ordered so cursors cannot skip records.
            "replica_pending" => &["handle", "after"],
            _ => return Err(failure("nearby-operation-unsupported")),
        };
        let mut p = args(params, allowed)?;
        let handle = token(&mut p, "handle")?;
        let replica = self
            .replicas
            .get_mut(&handle)
            .ok_or_else(|| failure("nearby-replica-closed"))?;
        match operation {
            "replica_scan_begin" => {}
            "replica_scan_batch" | "replica_scan_end" if replica.scan != ScanState::Scanning => {
                return Err(failure("nearby-scan-required"))
            }
            "replica_rebind" | "replica_applied_batch" if replica.scan != ScanState::Ready => {
                return Err(failure("nearby-scan-active"))
            }
            _ => {}
        }
        p.insert("handle".into(), json!(replica.handle));
        p.insert("operation".into(), json!(operation));
        let result = engine(Value::Object(p));
        match operation {
            "replica_scan_begin" => {
                replica.scan = if result.is_ok() {
                    ScanState::Scanning
                } else {
                    ScanState::Failed
                }
            }
            "replica_scan_batch" if result.is_err() => replica.scan = ScanState::Failed,
            "replica_scan_end" => {
                replica.scan = if result.is_ok() {
                    ScanState::Ready
                } else {
                    ScanState::Failed
                }
            }
            _ => {}
        }
        result
    }

    fn export(&mut self, params: Value) -> Result<Value> {
        let mut p = args(params, &["handle"])?;
        let opaque = token(&mut p, "handle")?;
        let handle = self.replica(&opaque)?;
        if self.replicas[&opaque].scan != ScanState::Ready {
            return Err(failure("nearby-scan-active"));
        }
        if self.snapshots.len() >= MAX_SNAPSHOTS {
            return Err(failure("nearby-snapshot-limit"));
        }
        let directory = self.scratch()?;
        // Always omit positive-counter credentials, including older aliases. Never
        // reset counters or delete a local record to make it appear portable.
        let mut result = Secret(engine(
            json!({"operation":"replica_export","handle":handle,"path":directory.path().join("changes.mdbxsync"),"skip_nonzero_passkeys":true}),
        )?);
        let content_key = result.0["content_key"]
            .as_str()
            .ok_or_else(|| failure("nearby-engine-invalid"))?
            .to_owned();
        let revision = result.0["revision"]
            .as_str()
            .ok_or_else(|| failure("nearby-engine-invalid"))?
            .to_owned();
        let assets: HashSet<String> = serde_json::from_value(result.0["asset_ids"].clone())
            .map_err(|_| failure("nearby-engine-invalid"))?;
        if assets.iter().any(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }) {
            return Err(failure("nearby-invalid-asset"));
        }
        let handle = id();
        self.snapshots.insert(
            handle.clone(),
            Arc::new(Snapshot {
                directory,
                key: Zeroizing::new(content_key),
                revision: revision.clone(),
                assets,
                finished: HashSet::new(),
                writing: None,
                failed: false,
                frozen: false,
            }),
        );
        Ok(
            json!({"handle":handle,"revision":revision,"asset_ids":result.0["asset_ids"].take(),"pending":result.0["pending"].take()}),
        )
    }

    fn append_asset(&mut self, params: Value) -> Result<Value> {
        let mut p = args(params, &["handle", "id", "index", "final", "data"])?;
        let handle = token(&mut p, "handle")?;
        let asset_id = text(&mut p, "id")?;
        let index = number(&mut p, "index")?;
        let final_chunk = p
            .remove("final")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| failure("nearby-invalid-asset"))?;
        let encoded = Zeroizing::new(
            p.remove("data")
                .and_then(|v| v.as_str().map(str::to_owned))
                .ok_or_else(|| failure("nearby-invalid-asset"))?,
        );
        let plain = Zeroizing::new(
            STANDARD
                .decode(encoded.as_bytes())
                .map_err(|_| failure("nearby-invalid-asset"))?,
        );
        if plain.len() > 512 * 1024 || (!final_chunk && plain.len() != 512 * 1024) {
            return Err(failure("nearby-invalid-asset"));
        }
        let snapshot = self
            .snapshots
            .get_mut(&handle)
            .and_then(Arc::get_mut)
            .ok_or_else(|| failure("nearby-snapshot-busy"))?;
        if snapshot.failed
            || snapshot.frozen
            || !snapshot.assets.contains(&asset_id)
            || snapshot.finished.contains(&asset_id)
        {
            return Err(failure("nearby-invalid-asset"));
        }
        if snapshot.writing.is_none() {
            snapshot.writing = Some((
                asset_id.clone(),
                AssetWrite {
                    index: 0,
                    size: 0,
                    hash: Sha256::new(),
                },
            ));
        }
        let (current, write) = snapshot.writing.as_mut().unwrap();
        if *current != asset_id
            || u64::from(write.index) != index
            || write.size + plain.len() > 64 * 1024 * 1024
        {
            return Err(failure("nearby-invalid-asset"));
        }
        write.hash.update(&*plain);
        write.size += plain.len();
        if final_chunk && format!("{:x}", write.hash.clone().finalize()) != asset_id {
            snapshot.failed = true;
            return Err(failure("nearby-asset-integrity"));
        }
        if let Err(e) = engine(
            json!({"operation":"asset_append","path":snapshot.directory.path().join("assets.monica"),"key":*snapshot.key,"id":asset_id,"index":index,"final":final_chunk,"data":*encoded}),
        ) {
            snapshot.failed = true;
            return Err(e);
        }
        write.index += 1;
        if final_chunk {
            snapshot.writing = None;
            snapshot.finished.insert(asset_id);
        }
        Ok(json!({}))
    }

    fn start(&mut self, operation: &str, params: Value) -> Result<Value> {
        let mut p = args(
            params,
            &[
                "snapshot",
                "device",
                "invitation",
                "expected_device_id",
                "trusted_key",
                "listen_address",
            ],
        )?;
        let snapshot_id = token(&mut p, "snapshot")?;
        if self.transfers.len() >= 8 {
            return Err(failure("nearby-session-limit"));
        }
        let snapshot = self
            .snapshots
            .get_mut(&snapshot_id)
            .ok_or_else(|| failure("nearby-snapshot-closed"))?;
        if snapshot.failed || snapshot.writing.is_some() || snapshot.assets != snapshot.finished {
            return Err(failure("nearby-assets-incomplete"));
        }
        if let Some(snapshot) = Arc::get_mut(snapshot) {
            snapshot.frozen = true;
        }
        let snapshot = snapshot.clone();
        let mut device = args(
            p.remove("device")
                .ok_or_else(|| failure("nearby-invalid-request"))?,
            &[
                "device_id",
                "name",
                "pair_id",
                "interval_seconds",
                "settings_version",
                "settings_writer",
                "sync_request",
                "sync_mode",
            ],
        )?;
        device.insert("revision".into(), json!(snapshot.revision));
        device.insert("content_type".into(), json!("vault"));
        device.insert("vault_content_version".into(), json!(2));
        let name = device
            .get("name")
            .cloned()
            .unwrap_or(json!("Monica Browser"));
        // Snapshot and incoming root are host-owned. The engine expects an empty
        // leaf, separate from our lease file.
        let incoming = self.scratch()?;
        let leaf = incoming.path().join("received");
        let mut request = Value::Object(p);
        request["operation"] = json!(operation);
        request["protocol"] = json!(2);
        request["device"] = Value::Object(device);
        request["name"] = name;
        request["revision"] = json!(snapshot.revision);
        request["vault_id"] = json!("monica-passwords-v1");
        request["content_key"] = json!(*snapshot.key);
        request["incoming_directory"] = json!(leaf);
        request["outgoing_directory"] = json!(snapshot.directory.path());
        let mut started = engine(request)?;
        let native_handle = started["handle"]
            .as_u64()
            .ok_or_else(|| failure("nearby-engine-invalid"))?;
        let handle = id();
        self.transfers.insert(
            handle.clone(),
            Transfer {
                handle: native_handle,
                incoming,
                _snapshot: snapshot,
                replica: None,
            },
        );
        started["handle"] = json!(handle);
        Ok(started)
    }

    fn session(&mut self, operation: &str, params: Value) -> Result<Value> {
        let allowed = if operation == "acknowledge" {
            &["handle", "success"][..]
        } else {
            &["handle"][..]
        };
        let mut p = args(params, allowed)?;
        let handle = token(&mut p, "handle")?;
        let Some(transfer) = self.transfers.get(&handle) else {
            return if operation == "release" || operation == "cancel" {
                Ok(json!({}))
            } else {
                Err(failure("nearby-session-closed"))
            };
        };
        if operation == "acknowledge" && p.get("success") == Some(&json!(true)) {
            let progress = Secret(engine(
                json!({"operation":"progress","handle":transfer.handle}),
            )?);
            if progress.0["peer"]["receive_content"] == true {
                let replica = transfer
                    .replica
                    .as_ref()
                    .ok_or_else(|| failure("nearby-merge-required"))?;
                let revision = engine(
                    json!({"operation":"replica_revision","handle":self.replica(replica)?}),
                )?;
                if revision["pending"] != false {
                    return Err(failure("nearby-apply-required"));
                }
            }
        }
        p.insert("operation".into(), json!(operation));
        p.insert("handle".into(), json!(transfer.handle));
        let mut result = engine(Value::Object(p))?;
        if operation == "release" {
            self.transfers.remove(&handle);
        }
        if operation == "progress" {
            if let Some(map) = result.as_object_mut() {
                map.remove("received_directory");
            }
            // Content keys stay inside the Host; pairing secrets are returned only
            // after the complete authenticated transport, for encrypted persistence.
            if !matches!(
                result["phase"].as_str(),
                Some("received" | "confirming" | "completed")
            ) {
                wipe(&mut result["peer"]);
                result["peer"] = Value::Null;
            }
            if let Some(pairing) = result["peer"]["pairing"].as_object_mut() {
                if let Some(mut value) = pairing.remove("content_key") {
                    wipe(&mut value);
                }
                if let Some(mut value) = pairing.remove("vault_password") {
                    wipe(&mut value);
                }
            }
        }
        Ok(result)
    }

    fn received(&self, handle: &str) -> Result<(u64, PathBuf, Zeroizing<String>)> {
        let transfer = self.transfer(handle)?;
        let progress = Secret(engine(
            json!({"operation":"progress","handle":transfer.handle}),
        )?);
        if progress.0["phase"] != "received" || progress.0["peer"]["receive_content"] != true {
            return Err(failure("nearby-not-received"));
        }
        let key = progress.0["peer"]["pairing"]["content_key"]
            .as_str()
            .ok_or_else(|| failure("nearby-engine-invalid"))?;
        Ok((
            transfer.handle,
            transfer.incoming.path().join("received"),
            Zeroizing::new(key.into()),
        ))
    }

    fn merge(&mut self, params: Value) -> Result<Value> {
        let mut p = args(params, &["handle", "session"])?;
        let handle = token(&mut p, "handle")?;
        let session = token(&mut p, "session")?;
        let native = self.replica(&handle)?;
        if self.replicas[&handle].scan != ScanState::Ready {
            return Err(failure("nearby-scan-active"));
        }
        let (_, directory, key) = self.received(&session)?;
        if self
            .transfer(&session)?
            .replica
            .as_ref()
            .is_some_and(|r| r != &handle)
        {
            return Err(failure("nearby-different-replica"));
        }
        let result = engine(
            json!({"operation":"replica_merge","handle":native,"path":directory.join("changes.mdbxsync"),"content_key":*key}),
        )?;
        self.transfers.get_mut(&session).unwrap().replica = Some(handle);
        Ok(result)
    }

    fn read_asset(&self, operation: &str, params: Value) -> Result<Value> {
        let mut p = args(
            params,
            if operation == "asset_read" {
                &["session", "offset"]
            } else {
                &["session"]
            },
        )?;
        let (_, directory, key) = self.received(&token(&mut p, "session")?)?;
        let path = directory.join("assets.monica");
        if operation == "asset_list" && !path.exists() {
            return Ok(json!({"items":[]}));
        }
        p.insert("path".into(), json!(path));
        p.insert("operation".into(), json!(operation));
        if operation == "asset_read" {
            p.insert("key".into(), json!(*key));
        }
        engine(Value::Object(p))
    }

    fn close_all(&mut self) {
        self.input.clear();
        self.output.clear();
        self.discoveries.clear();
        // Closing a browser port/locking must not delete files still used by a
        // native worker. Cancel immediately and retire ownership asynchronously.
        let transfers = std::mem::take(&mut self.transfers);
        for transfer in transfers.values() {
            let _ = engine(json!({"operation":"cancel","handle":transfer.handle}));
        }
        if !transfers.is_empty() {
            std::thread::spawn(move || {
                let mut transfers = transfers;
                while !transfers.is_empty() {
                    transfers.retain(|_, transfer| {
                        engine(json!({"operation":"release","handle":transfer.handle})).is_err()
                    });
                    if !transfers.is_empty() {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            });
        }
        self.snapshots.clear();
        self.replicas.clear();
    }
}
impl Drop for Nearby {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests;
