//! Raw LAN sockets are not a browser database capability.
use crate::runtime::RpcFailure;
use serde_json::Value;
use std::{io, path::Path};

pub(crate) fn supports(_: &str) -> bool { false }
pub(crate) struct Nearby;
impl Nearby {
    pub(crate) fn new(_: &Path) -> io::Result<Self> { Ok(Self) }
    pub(crate) fn handle(&mut self, _: &str, _: Value) -> Result<Value, RpcFailure> {
        Err(RpcFailure::new("browser-native-capability-unavailable", "This operation requires native device support.", false))
    }
}
