//! Extension-only outgoing policy. Inspect the engine's encrypted wire copy;
//! never edit replica storage, clocks, bindings, or the shared Android engine.
use super::*;
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};

const MAGIC: &[u8] = b"MONICA-DEVICE-REPLICA-1\0";
const MAX_WIRE: usize = 64 * 1024 * 1024;

pub(super) fn apply(path: &Path, content_key: &str, omit: bool, result: &mut Value) -> Result<()> {
    let bytes = fs::read(path).map_err(|_| failure("nearby-export-read"))?;
    if bytes.len() < MAGIC.len() + 28 || bytes.len() > MAX_WIRE + 1024 || !bytes.starts_with(MAGIC)
    {
        return Err(failure("nearby-engine-invalid"));
    }
    let key = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(content_key)
            .map_err(|_| failure("nearby-engine-invalid"))?,
    );
    let cipher =
        ChaCha20Poly1305::new_from_slice(&key).map_err(|_| failure("nearby-engine-invalid"))?;
    let n = MAGIC.len();
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&bytes[n..n + 12]),
                Payload {
                    msg: &bytes[n + 12..],
                    aad: MAGIC,
                },
            )
            .map_err(|_| failure("nearby-export-authentication"))?,
    );
    let mut wire = Secret(
        monica_lan_sync::json::from_slice(&plain).map_err(|_| failure("nearby-engine-invalid"))?,
    );
    if wire.0["version"] != 1 {
        return Err(failure("nearby-engine-invalid"));
    }
    let records = wire.0["records"]
        .as_object_mut()
        .ok_or_else(|| failure("nearby-engine-invalid"))?;
    let mut deleted = HashSet::new();
    for (id, row) in records.iter() {
        match row["deleted"].as_bool() {
            Some(true) => {
                deleted.insert(id.clone());
            }
            Some(false) => {}
            None => return Err(failure("nearby-engine-invalid")),
        }
    }
    result["deletion_count"] = json!(deleted.len());
    result["deletion_policy"] = json!(if omit { "omit" } else { "include" });
    if !omit || deleted.is_empty() {
        return Ok(());
    }
    records.retain(|id, record| {
        if deleted.contains(id) {
            wipe(record);
            false
        } else {
            true
        }
    });
    let live: HashSet<_> = records.keys().cloned().collect();
    // Keep only aliases resolving to included records. Resolve chains with a
    // cache so long histories stay linear, and reject malformed/cyclic aliases.
    let aliases = wire.0["aliases"]
        .as_object_mut()
        .ok_or_else(|| failure("nearby-engine-invalid"))?;
    let mut included: HashMap<String, bool> = HashMap::new();
    for id in aliases.keys() {
        let mut current = id.as_str();
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let keep = loop {
            if let Some(keep) = included.get(current) {
                break *keep;
            }
            match aliases.get(current) {
                None => break live.contains(current),
                Some(value) => {
                    if !seen.insert(current) {
                        return Err(failure("nearby-engine-invalid"));
                    }
                    chain.push(current.to_owned());
                    current = value
                        .as_str()
                        .ok_or_else(|| failure("nearby-engine-invalid"))?;
                }
            }
        };
        for id in chain {
            included.insert(id, keep);
        }
    }
    aliases.retain(|id, _| included.get(id) == Some(&true));
    let assets: HashSet<String> = wire.0["records"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|row| row["data"]["assets"].as_array().into_iter().flatten())
        .map(|asset| {
            asset["id"]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| failure("nearby-engine-invalid"))
        })
        .collect::<Result<_>>()?;
    let plain =
        Zeroizing::new(serde_json::to_vec(&wire.0).map_err(|_| failure("nearby-engine-invalid"))?);
    let mut nonce = [0; 12];
    getrandom::getrandom(&mut nonce).map_err(|_| failure("nearby-random-unavailable"))?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plain,
                aad: MAGIC,
            },
        )
        .map_err(|_| failure("nearby-export-encryption"))?;
    let mut bytes = Vec::with_capacity(n + 12 + encrypted.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&encrypted);
    fs::write(path, bytes).map_err(|_| failure("nearby-export-write"))?;
    result["revision"] = json!(format!("incremental-{}", digest(&plain)));
    result["asset_ids"] = json!(assets);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_deleted_assets_and_alias_chains_preserving_literal_user_data() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("outgoing");
        let key = [31; 32];
        let cipher = ChaCha20Poly1305::new((&key).into());
        let plain = br#"{"version":1,"records":{"gone":{"deleted":true,"data":{"assets":[{"id":"deleted-asset"}]}},"live":{"deleted":false,"data":{"assets":[{"id":"live-asset"}],"payload":{"integer":18446744073709551615,"fraction":1.234567890123456789,"$serde_json::private::Number":"literal"}}}},"aliases":{"old-gone":"gone","chain-gone":"old-gone","old-live":"live","chain-live":"old-live"}}"#;
        let nonce = [7; 12];
        let mut sealed = MAGIC.to_vec();
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(
            &cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: plain,
                        aad: MAGIC,
                    },
                )
                .unwrap(),
        );
        fs::write(&file, sealed).unwrap();
        let mut result = json!({});
        apply(&file, &URL_SAFE_NO_PAD.encode(key), true, &mut result).unwrap();
        assert_eq!(result["deletion_count"], 1);
        assert_eq!(result["asset_ids"], json!(["live-asset"]));
        let bytes = fs::read(&file).unwrap();
        let n = MAGIC.len();
        let output = cipher
            .decrypt(
                Nonce::from_slice(&bytes[n..n + 12]),
                Payload {
                    msg: &bytes[n + 12..],
                    aad: MAGIC,
                },
            )
            .unwrap();
        let output = monica_lan_sync::json::from_slice(&output).unwrap();
        assert_eq!(output["records"].as_object().unwrap().len(), 1);
        assert_eq!(
            output["aliases"],
            json!({"old-live":"live","chain-live":"old-live"})
        );
        assert_eq!(
            output["records"]["live"]["data"],
            monica_lan_sync::json::from_slice(plain).unwrap()["records"]["live"]["data"]
        );
        assert!(apply(&file, &URL_SAFE_NO_PAD.encode([32; 32]), true, &mut result).is_err());
    }
}
