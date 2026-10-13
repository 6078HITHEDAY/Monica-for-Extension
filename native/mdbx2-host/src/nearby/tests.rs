use super::*;
use tempfile::TempDir;

static SERIAL: Mutex<()> = Mutex::new(());
struct Host {
    nearby: Nearby,
    root: TempDir,
}
impl Host {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let nearby = Nearby::new(root.path()).unwrap();
        Self { nearby, root }
    }
    fn call(&mut self, operation: &str, params: Value) -> Value {
        self.nearby
            .call(json!({"operation":operation,"params":params}))
            .unwrap()
    }
    fn open(&mut self, node: &str) -> String {
        self.call(
            "replica_open",
            json!({"storage_id":id(),"device_id":node,"key":URL_SAFE_NO_PAD.encode([17;32])}),
        )["handle"]
            .as_str()
            .unwrap()
            .into()
    }
    fn scan(&mut self, replica: &str, entries: Value) {
        self.call(
            "replica_scan_begin",
            json!({"handle":replica,"scopes":["local"]}),
        );
        self.call(
            "replica_scan_batch",
            json!({"handle":replica,"entries":entries}),
        );
        self.call("replica_scan_end", json!({"handle":replica}));
    }
    fn snapshot(&mut self, replica: &str) -> String {
        self.call("replica_export", json!({"handle":replica}))["handle"]
            .as_str()
            .unwrap()
            .into()
    }
    fn state(&mut self, session: &str) -> Value {
        self.call("progress", json!({"handle":session}))
    }
    fn await_phase(&mut self, session: &str, expected: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let state = self.state(session);
            if state["phase"] == expected {
                return state;
            }
            assert!(
                !matches!(state["phase"].as_str(), Some("failed" | "cancelled")),
                "unexpected terminal phase: {}",
                state["error"]
            );
            assert!(Instant::now() < deadline, "transport phase timeout");
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}
impl Drop for Host {
    fn drop(&mut self) {
        let handles: Vec<_> = self.nearby.transfers.keys().cloned().collect();
        for handle in &handles {
            let _ = self
                .nearby
                .call(json!({"operation":"cancel","params":{"handle":handle}}));
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.nearby.transfers.is_empty() && Instant::now() < deadline {
            for handle in &handles {
                let _ = self
                    .nearby
                    .call(json!({"operation":"release","params":{"handle":handle}}));
            }
            std::thread::sleep(Duration::from_millis(15));
        }
    }
}
fn local(local_id: &str, data: Value) -> Value {
    json!({"local_id":local_id,"scope":"local","guard":"version-1","deleted":false,"data":data})
}
fn device(node: &str, mode: &str) -> Value {
    json!({"device_id":node,"name":node,"sync_mode":mode})
}

#[test]
fn nearby_literal_json_fields_survive_scan_and_reopen() {
    let _serial = SERIAL.lock().unwrap();
    let mut failures = Vec::new();
    for (name, literal) in [
        ("integer", "9007199254740993"),
        ("decimal", "1.00000000000000001"),
        ("exponent", "1e999"),
        ("negative_zero", "-0"),
        ("proto", r#"{"__proto__":{"literal":true}}"#),
        (
            "number_marker",
            r#"{"$serde_json::private::Number":"literal"}"#,
        ),
        ("raw_marker", r#"{"$serde_json::private::RawValue":"null"}"#),
    ] {
        let mut a = Host::new();
        let storage = id();
        let params = json!({"storage_id":storage,"device_id":"precision","key":URL_SAFE_NO_PAD.encode([17;32])});
        let replica = handle(&a.call("replica_open", params.clone()));
        a.call(
            "replica_scan_begin",
            json!({"handle":replica,"scopes":["local"]}),
        );
        let data = monica_lan_sync::json::from_str(&format!(
            r#"{{"entry_type":"note","payload":{{"value":{literal}}}}}"#
        ))
        .unwrap();
        let mut entry = local("precision", json!({}));
        entry["data"] = data;
        let mut request = json!({"operation":"replica_scan_batch","params":{"handle":replica}});
        request["params"]["entries"] = Value::Array(vec![entry]);
        let result = a.nearby.call(request);
        if let Err(error) = result {
            failures.push(format!("{name}: {}", error.message));
            continue;
        }
        a.call("replica_scan_end", json!({"handle":replica}));
        a.call("replica_close", json!({"handle":replica}));
        let replica = handle(&a.call("replica_open", params));
        let saved = a.call(
            "replica_local",
            json!({"handle":replica,"local_ids":["precision"],"include_data":true}),
        );
        let text = serde_json::to_string(&saved).unwrap();
        if !text.contains(&format!("\"value\":{literal}")) {
            failures.push(format!("{name}: literal changed"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("; "));
}
fn link(start: &Value) -> String {
    start["invitations"][0].as_str().unwrap().into()
}
fn handle(value: &Value) -> String {
    value["handle"].as_str().unwrap().into()
}
fn applied(host: &mut Host, replica: &str) {
    let pending = host.call("replica_pending", json!({"handle":replica}));
    let items:Vec<_>=pending["items"].as_array().unwrap().iter().map(|item| json!({"record_id":item["record"]["id"],"clock":item["record"]["clock"],"local_id":format!("saved-{}",item["record"]["id"].as_str().unwrap()),"scope":"local","guard":"saved-v1","data":item["record"]["data"]})).collect();
    host.call(
        "replica_applied_batch",
        json!({"handle":replica,"items":items}),
    );
}

#[test]
fn opaque_boundary_rejects_paths_foreign_handles_and_unknown_operations() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let mut b = Host::new();
    let replica = a.open("a");
    for (op, p) in [
        (
            "replica_open",
            json!({"storage_id":"../outside","device_id":"a","key":URL_SAFE_NO_PAD.encode([1;32])}),
        ),
        ("replica_open", json!({"path":"C:/outside"})),
        (
            "replica_export",
            json!({"handle":replica,"path":"C:/outside"}),
        ),
        (
            "replica_pending",
            json!({"handle":replica,"dependency_order":true}),
        ),
        ("start", json!({"incoming_directory":"C:/outside"})),
        ("replica_applied", json!({"handle":replica})),
    ] {
        assert!(a.nearby.call(json!({"operation":op,"params":p})).is_err());
    }
    assert!(b
        .nearby
        .call(json!({"operation":"replica_revision","params":{"handle":replica}}))
        .is_err());
}

#[test]
fn persistent_replicas_authenticate_and_lease_across_host_instances() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let storage = id();
    let request =
        json!({"storage_id":storage,"device_id":"a","key":URL_SAFE_NO_PAD.encode([17;32])});
    let replica = handle(&a.call("replica_open", request.clone()));
    a.scan(
        &replica,
        json!([local(
            "one",
            json!({"entry_type":"password","payload":{"password":"synthetic-secret"}})
        )]),
    );
    let revision = a.call("replica_revision", json!({"handle":replica}));
    let mut other = Nearby::new(a.root.path()).unwrap();
    assert_eq!(
        other
            .call(json!({"operation":"replica_open","params":request}))
            .unwrap_err()
            .code,
        "nearby-replica-busy"
    );
    a.call("replica_close", json!({"handle":replica}));
    let mut wrong = request.clone();
    wrong["key"] = json!(URL_SAFE_NO_PAD.encode([18; 32]));
    assert!(other
        .call(json!({"operation":"replica_open","params":wrong}))
        .is_err());
    let reopened = handle(
        &other
            .call(json!({"operation":"replica_open","params":request}))
            .unwrap(),
    );
    assert_eq!(
        other
            .call(json!({"operation":"replica_revision","params":{"handle":reopened}}))
            .unwrap(),
        revision
    );
    let disk = fs::read(
        a.root
            .path()
            .join("nearby-v1/replicas")
            .join(storage)
            .join("state.enc"),
    )
    .unwrap();
    assert!(!disk
        .windows(b"synthetic-secret".len())
        .any(|w| w == b"synthetic-secret"));
}

#[test]
fn incomplete_failed_scan_never_deletes_omitted_records_or_exports_partial_data() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let replica = a.open("a");
    a.scan(
        &replica,
        json!([
            local("one", json!({"value":1})),
            local("two", json!({"value":2}))
        ]),
    );
    let before = a.call("replica_revision", json!({"handle":replica}));
    a.call(
        "replica_scan_begin",
        json!({"handle":replica,"scopes":["local"]}),
    );
    a.call(
        "replica_scan_batch",
        json!({"handle":replica,"entries":[local("one",json!({"value":3}))]}),
    );
    assert!(a.nearby.call(json!({"operation":"replica_scan_batch","params":{"handle":replica,"entries":[local("one",json!({"value":4}))]}})).is_err());
    for op in ["replica_scan_end", "replica_export"] {
        assert!(a
            .nearby
            .call(json!({"operation":op,"params":{"handle":replica}}))
            .is_err());
    }
    assert_eq!(
        a.call("replica_revision", json!({"handle":replica})),
        before
    );
    a.scan(
        &replica,
        json!([
            local("one", json!({"value":1})),
            local("two", json!({"value":2}))
        ]),
    );
    a.snapshot(&replica);
}

#[test]
fn framed_buffers_bound_verify_and_zero_lifetime() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let input = serde_json::to_vec(&json!({"operation":"close_all","params":{}})).unwrap();
    let upload = a
        .nearby
        .handle(
            "nearby.input.begin",
            json!({"size":input.len(),"sha256":digest(&input)}),
        )
        .unwrap();
    let h = handle(&upload);
    assert!(a
        .nearby
        .handle(
            "nearby.input.chunk",
            json!({"handle":h,"offset":1,"data":STANDARD.encode(&input)})
        )
        .is_err());
    a.nearby
        .handle(
            "nearby.input.chunk",
            json!({"handle":h,"offset":0,"data":STANDARD.encode(&input)}),
        )
        .unwrap();
    assert_eq!(
        a.nearby
            .handle("nearby.input.finish", json!({"handle":h}))
            .unwrap(),
        json!({"json":"{}"})
    );
    assert!(a
        .nearby
        .handle("nearby.input.finish", json!({"handle":h}))
        .is_err());
    let result = a
        .nearby
        .pack(json!({"synthetic":"x".repeat(INLINE+17)}))
        .unwrap();
    let out = handle(&result);
    let mut bytes = Vec::new();
    while bytes.len() < result["size"].as_u64().unwrap() as usize {
        let part = a
            .nearby
            .handle(
                "nearby.output.read",
                json!({"handle":out,"offset":bytes.len()}),
            )
            .unwrap();
        bytes.extend(STANDARD.decode(part["data"].as_str().unwrap()).unwrap());
    }
    assert_eq!(digest(&bytes), result["sha256"]);
    a.nearby.output.get_mut(&out).unwrap().touched = Instant::now() - TTL;
    assert!(a
        .nearby
        .handle("nearby.output.read", json!({"handle":out,"offset":0}))
        .is_err());
    let bad = a
        .nearby
        .handle(
            "nearby.input.begin",
            json!({"size":input.len(),"sha256":"0".repeat(64)}),
        )
        .unwrap();
    a.nearby
        .handle(
            "nearby.input.chunk",
            json!({"handle":bad["handle"],"offset":0,"data":STANDARD.encode(&input)}),
        )
        .unwrap();
    assert_eq!(
        a.nearby
            .handle("nearby.input.finish", json!({"handle":bad["handle"]}))
            .unwrap_err()
            .code,
        "nearby-buffer-integrity"
    );
}

#[test]
fn real_noise_duplex_requires_merge_and_adoption_then_reconnects_with_trust() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let mut b = Host::new();
    let ar = a.open("browser");
    let br = b.open("android-protocol-peer");
    let zero = json!({"entry_type":"passkey","payload":{"credential_id":"AQIDBA","rp_id":"example.test","sign_count":0,"private_key_alias":"unchanged-synthetic-private"}});
    let positive = json!({"entry_type":"passkey","payload":{"credential_id":"BQYHCA","rp_id":"example.test","sign_count":19,"private_key_alias":"local-only-positive"}});
    a.scan(
        &ar,
        json!([
            local("zero", zero.clone()),
            local("positive", positive.clone())
        ]),
    );
    b.scan(
        &br,
        json!([local(
            "password",
            json!({"entry_type":"password","payload":{"password":"unchanged-peer-password"}})
        )]),
    );
    let ax = a.snapshot(&ar);
    let bx = b.snapshot(&br);
    let started=a.call("start",json!({"snapshot":ax,"device":device("browser","bidirectional"),"listen_address":"127.0.0.1"}));
    let sa = handle(&started);
    let sb=handle(&b.call("connect",json!({"snapshot":bx,"device":device("android-protocol-peer","bidirectional"),"invitation":link(&started)})));
    let pa = a.await_phase(&sa, "received");
    let pb = b.await_phase(&sb, "received");
    assert!(pa.get("received_directory").is_none());
    assert!(pa["peer"]["pairing"].get("content_key").is_none());
    assert_eq!(pa["peer"]["pairing"], pb["peer"]["pairing"]);
    assert_eq!(
        a.nearby
            .call(json!({"operation":"acknowledge","params":{"handle":sa,"success":true}}))
            .unwrap_err()
            .code,
        "nearby-merge-required"
    );
    a.call("replica_merge", json!({"handle":ar,"session":sa}));
    b.call("replica_merge", json!({"handle":br,"session":sb}));
    let pending = b.call("replica_pending", json!({"handle":br}));
    assert_eq!(pending["items"].as_array().unwrap().len(), 1);
    assert_eq!(pending["items"][0]["record"]["data"], zero);
    assert_eq!(
        a.nearby
            .call(json!({"operation":"acknowledge","params":{"handle":sa,"success":true}}))
            .unwrap_err()
            .code,
        "nearby-apply-required"
    );
    applied(&mut a, &ar);
    applied(&mut b, &br);
    a.call("acknowledge", json!({"handle":sa,"success":true}));
    b.call("acknowledge", json!({"handle":sb,"success":true}));
    a.await_phase(&sa, "completed");
    b.await_phase(&sb, "completed");
    a.call("release", json!({"handle":sa}));
    b.call("release", json!({"handle":sb}));
    let local = a.call(
        "replica_local",
        json!({"handle":ar,"local_ids":["positive","zero"],"include_data":true}),
    );
    assert!(local["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["data"] == positive));
    let trust = &pa["peer"]["pairing"];
    let mut ad = device("browser", "send_only");
    ad["pair_id"] = trust["pair_id"].clone();
    let mut bd = device("android-protocol-peer", "receive_only");
    bd["pair_id"] = trust["pair_id"].clone();
    let started=a.call("start",json!({"snapshot":ax,"device":ad,"expected_device_id":"android-protocol-peer","trusted_key":trust["trusted_key"],"listen_address":"127.0.0.1"}));
    let sa = handle(&started);
    let sb=handle(&b.call("connect",json!({"snapshot":bx,"device":bd,"expected_device_id":"browser","invitation":link(&started)})));
    assert_eq!(
        a.await_phase(&sa, "received")["peer"]["receive_content"],
        false
    );
    assert_eq!(
        b.await_phase(&sb, "received")["peer"]["receive_content"],
        true
    );
    b.call("replica_merge", json!({"handle":br,"session":sb}));
    applied(&mut b, &br);
    a.call("acknowledge", json!({"handle":sa,"success":true}));
    b.call("acknowledge", json!({"handle":sb,"success":true}));
    a.await_phase(&sa, "completed");
    b.await_phase(&sb, "completed");
}

#[test]
fn assets_require_all_hashes_before_sending_and_authenticated_chunks_after_receiving() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let mut b = Host::new();
    let ar = a.open("a");
    let br = b.open("b");
    let bytes = vec![69u8; 600_000];
    let asset = digest(&bytes);
    a.scan(
        &ar,
        json!([local(
            "file",
            json!({"entry_type":"password","assets":[{"id":asset,"size":bytes.len()}]})
        )]),
    );
    let ax = a.snapshot(&ar);
    let bx = b.snapshot(&br);
    let start =
        json!({"snapshot":ax,"device":device("a","bidirectional"),"listen_address":"127.0.0.1"});
    assert_eq!(
        a.nearby
            .call(json!({"operation":"start","params":start}))
            .unwrap_err()
            .code,
        "nearby-assets-incomplete"
    );
    for (i, chunk) in bytes.chunks(512 * 1024).enumerate() {
        a.call(
            "asset_append",
            json!({"handle":ax,"id":asset,"index":i,"final":i==1,"data":STANDARD.encode(chunk)}),
        );
    }
    let started = a.call("start", start);
    let sa = handle(&started);
    let sb = handle(&b.call(
        "connect",
        json!({"snapshot":bx,"device":device("b","bidirectional"),"invitation":link(&started)}),
    ));
    a.await_phase(&sa, "received");
    b.await_phase(&sb, "received");
    let list = b.call("asset_list", json!({"session":sb}));
    let mut offset = list["items"][0]["offset"].as_u64().unwrap();
    let mut received = Vec::new();
    for index in 0..2 {
        let chunk = b.call("asset_read", json!({"session":sb,"offset":offset}));
        assert_eq!(chunk["id"], asset);
        assert_eq!(chunk["index"], index);
        assert_eq!(chunk["final"], index == 1);
        received.extend(STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap());
        offset = chunk["next"].as_u64().unwrap();
    }
    assert_eq!(received, bytes);
    let path = b.nearby.transfers[&sb]
        .incoming
        .path()
        .join("received/assets.monica");
    let mut damaged = fs::read(&path).unwrap();
    damaged[120] ^= 1;
    fs::write(path, damaged).unwrap();
    assert!(b.nearby.call(json!({"operation":"asset_read","params":{"session":sb,"offset":list["items"][0]["offset"]}})).is_err());
}

#[test]
fn invalid_asset_and_nonlocal_invitation_cannot_start_transport() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let ar = a.open("a");
    a.scan(
        &ar,
        json!([local(
            "file",
            json!({"assets":[{"id":"0".repeat(64),"size":3}]})
        )]),
    );
    let ax = a.snapshot(&ar);
    assert_eq!(a.nearby.call(json!({"operation":"asset_append","params":{"handle":ax,"id":"0".repeat(64),"index":0,"final":true,"data":STANDARD.encode(b"abc")}})).unwrap_err().code,"nearby-asset-integrity");
    assert!(a.nearby.call(json!({"operation":"start","params":{"snapshot":ax,"device":device("a","bidirectional")}})).is_err());
    a.scan(&ar, json!([]));
    let empty = a.snapshot(&ar);
    for address in ["8.8.8.8", "192.168.001.2", "127.0.0.1,127.0.0.1"] {
        assert!(a.nearby.call(json!({"operation":"connect","params":{"snapshot":empty,"device":device("a","bidirectional"),"invitation":format!("monica-lan:2:{address}:32123:{}",URL_SAFE_NO_PAD.encode([1;32]))}})).is_err());
    }
}

#[test]
fn locking_cancels_listener_and_keeps_live_owned_scratch_until_release() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let ar = a.open("a");
    let ax = a.snapshot(&ar);
    let started = a.call(
        "start",
        json!({"snapshot":ax,"device":device("a","bidirectional"),"listen_address":"127.0.0.1"}),
    );
    let native = a.nearby.transfers[&handle(&started)].handle;
    let path = a.nearby.transfers[&handle(&started)]
        .incoming
        .path()
        .to_owned();
    a.call("snapshot_release", json!({"handle":ax}));
    assert!(path.exists());
    a.call("close_all", json!({}));
    assert!(a.nearby.replicas.is_empty());
    assert!(a.nearby.transfers.is_empty());
    let deadline = Instant::now() + Duration::from_secs(10);
    while path.exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!path.exists());
    assert!(engine(json!({"operation":"progress","handle":native})).is_err());
    a.open("new-session");
}

#[test]
fn discovery_does_not_block_native_message_processing() {
    let _serial = SERIAL.lock().unwrap();
    let mut a = Host::new();
    let before = Instant::now();
    let discovery = a.call(
        "discover",
        json!({"targets":["127.0.0.1"],"multicast":false}),
    );
    assert!(before.elapsed() < Duration::from_secs(1));
    let ar = a.open("a");
    a.call("replica_revision", json!({"handle":ar}));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let result = a.call("discovery_result", json!({"handle":discovery["handle"]}));
        if result["ready"] == true {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(25));
    }
}
