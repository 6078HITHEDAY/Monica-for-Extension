//! Synchronous, bounded JSON ABI for one exclusively owned browser Worker.
//! Durability and sender authorization belong to the enclosing Worker controller.
#![recursion_limit = "256"]
#![allow(dead_code)] // The shared native runtime also contains native-only entry points.
#[cfg(not(target_os = "emscripten"))]
compile_error!("Build this engine for wasm32-unknown-emscripten with the pinned browser toolchain.");
#[cfg(target_feature = "atomics")]
compile_error!("The browser engine requires a private single-threaded MEMFS.");

mod backup_scratch;
mod nearby;
#[path = "../../mdbx2-host/src/runtime.rs"]
mod runtime;
#[path = "../../mdbx2-host/src/cloud_sync.rs"]
mod cloud_sync;
#[path = "../../mdbx2-host/src/local_export.rs"]
mod local_export;
#[path = "../../mdbx2-host/src/windows_hello.rs"]
mod windows_hello;

use runtime::{HostRuntime, RpcFailure};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use zeroize::{Zeroize, Zeroizing};

const MAX_INPUT: usize = 1024 * 1024;
const MAX_OUTPUT: usize = 900 * 1024;
const ROOT: &str = "/monica";

#[derive(Default)]
struct Engine {
    runtime: Option<HostRuntime>,
    input: Vec<u8>,
    output: Vec<u8>,
}
thread_local! { static ENGINE: RefCell<Engine> = RefCell::new(Engine::default()); }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol: u32,
    request_id: String,
    method: String,
    #[serde(deserialize_with = "lossless_params")]
    params: Value,
}
fn lossless_params<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Value, D::Error> {
    let raw = Box::<serde_json::value::RawValue>::deserialize(d)?;
    mdbx_core::json::from_str(raw.get()).map_err(serde::de::Error::custom)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    protocol: u32,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorResponse>,
}
#[derive(Serialize)]
struct ErrorResponse { code: &'static str, message: String, retryable: bool }
impl Response {
    fn from_result(request_id: String, result: Result<Value, RpcFailure>) -> Self {
        let (value, error) = match result {
            Ok(value) => (Some(value), None),
            Err(e) => (None, Some(ErrorResponse { code: e.code, message: e.message, retryable: e.retryable })),
        };
        Self { protocol: 2, request_id, ok: error.is_none(), result: value, error }
    }
}
fn invalid() -> RpcFailure { RpcFailure::new("browser-request-invalid", "Browser database request is invalid.", false) }
fn valid_id(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':')) }
fn wipe_json(v: &mut Value) {
    match v {
        Value::String(s) => s.zeroize(),
        Value::Array(a) => a.iter_mut().for_each(wipe_json),
        Value::Object(o) => o.values_mut().for_each(wipe_json),
        _ => {}
    }
}

fn create_vault(runtime: &mut HostRuntime, mut params: Value) -> Result<Value, RpcFailure> {
    let Some(object) = params.as_object_mut() else { wipe_json(&mut params); return Err(invalid()); };
    let mut password = object.remove("password").unwrap_or(Value::Null);
    let password = match password.as_str() {
        Some(value) if !value.is_empty() && value.len() <= 64 * 1024 => {
            let result = Zeroizing::new(value.to_owned());
            wipe_json(&mut password);
            result
        }
        _ => { wipe_json(&mut password); wipe_json(&mut params); return Err(invalid()); }
    };
    let mode = object.remove("mode");
    let mode = match mode.as_ref().and_then(Value::as_str) {
        Some("sky") => mdbx_ffi::MdbxTigaMode::Sky,
        Some("multi") => mdbx_ffi::MdbxTigaMode::Multi,
        Some("power") => mdbx_ffi::MdbxTigaMode::Power,
        _ => { wipe_json(&mut params); return Err(invalid()); }
    };
    if !object.is_empty() { wipe_json(&mut params); return Err(invalid()); }
    let fail = |code| RpcFailure::new(code, "The browser database could not be created.", false);
    let temp = tempfile::tempdir_in("/tmp").map_err(|_| fail("browser-create-scratch-failed"))?;
    let source = temp.path().join("vault.mdbx");
    let vault = mdbx_ffi::create_vault_with_tiga_mode(source.to_string_lossy().into(), password.to_string(), "monica-browser".into(), mode).map_err(|_| fail("browser-create-engine-failed"))?;
    let handle = uuid::Uuid::new_v4().to_string();
    let imported = runtime.root.join("imports").join(format!("{handle}.mdbx"));
    vault.create_backup(imported.to_string_lossy().into()).map_err(|_| fail("browser-create-backup-failed"))?;
    drop(vault);
    let result = runtime.handle("vault.open", json!({"source":{"kind":"file","handle":handle},"credential":{"method":"password","password":*password}}));
    // The imported seed is not needed once the runtime's working copy exists.
    let _ = std::fs::remove_file(imported);
    result
}

impl Engine {
    fn dispatch(&mut self) {
        let input = Zeroizing::new(std::mem::take(&mut self.input));
        let mut response = match serde_json::from_slice::<Request>(&input) {
            Ok(mut request) => {
                let result = if request.protocol != 2 || !valid_id(&request.request_id) || !valid_id(&request.method) {
                    wipe_json(&mut request.params);
                    Err(invalid())
                } else if request.method.starts_with("nearby.") || request.method.starts_with("hello.") {
                    wipe_json(&mut request.params);
                    Err(RpcFailure::new("browser-native-capability-unavailable", "This operation requires native device support.", false))
                } else {
                    if self.runtime.is_none() { self.runtime = HostRuntime::new(ROOT.into()).ok(); }
                    match self.runtime.as_mut() {
                        None => { wipe_json(&mut request.params); Err(RpcFailure::new("browser-engine-start-failed", "Browser database storage could not be initialized.", false)) }
                        Some(runtime) if request.method == "vault.create" => create_vault(runtime, request.params),
                        Some(runtime) => runtime.handle(&request.method, request.params).map(|mut value| {
                            if request.method == "host.hello" {
                                value["runtimeKind"] = json!("browser");
                                value["nearbyTransportVersion"] = json!(0);
                                value["supportsWindowsHello"] = json!(false);
                                value["supportsVaultCreation"] = json!(true);
                            }
                            value
                        }),
                    }
                };
                Response::from_result(if valid_id(&request.request_id) { request.request_id } else { String::new() }, result)
            }
            Err(_) => Response::from_result(String::new(), Err(invalid())),
        };
        self.output.zeroize();
        self.output = serde_json::to_vec(&response).unwrap_or_default();
        if let Some(result) = response.result.as_mut() { wipe_json(result); }
        if self.output.len() > MAX_OUTPUT {
            self.output.zeroize();
            self.output = serde_json::to_vec(&Response::from_result(response.request_id, Err(RpcFailure::new("browser-response-limit", "Browser database response exceeds the supported size.", false)))).unwrap_or_default();
        }
    }
}

#[no_mangle]
pub extern "C" fn mdbx_input(size: u32) -> u32 {
    ENGINE.with_borrow_mut(|engine| {
        engine.input.zeroize();
        engine.input.clear();
        if size == 0 || size as usize > MAX_INPUT || engine.input.try_reserve_exact(size as usize).is_err() { return 0; }
        engine.input.resize(size as usize, 0);
        engine.input.as_mut_ptr() as u32
    })
}
#[no_mangle]
pub extern "C" fn mdbx_dispatch() { ENGINE.with_borrow_mut(Engine::dispatch); }
#[no_mangle]
pub extern "C" fn mdbx_output_ptr() -> u32 { ENGINE.with_borrow(|engine| engine.output.as_ptr() as u32) }
#[no_mangle]
pub extern "C" fn mdbx_output_len() -> u32 { ENGINE.with_borrow(|engine| engine.output.len() as u32) }
#[no_mangle]
pub extern "C" fn mdbx_clear_output() { ENGINE.with_borrow_mut(|engine| { engine.output.zeroize(); engine.output.clear(); }); }
#[no_mangle]
pub extern "C" fn mdbx_close() {
    ENGINE.with_borrow_mut(|engine| { engine.runtime = None; engine.input.zeroize(); engine.output.zeroize(); engine.input.clear(); engine.output.clear(); });
}
fn main() { std::panic::set_hook(Box::new(|_| {})); }
