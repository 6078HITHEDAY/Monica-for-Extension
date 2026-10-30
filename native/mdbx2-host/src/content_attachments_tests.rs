fn attachment_catalog_fixture(runtime: &mut HostRuntime, handle: &str) -> Value {
    let owner = fresh_uuid();
    let object = fresh_uuid();
    let ids = [fresh_uuid(), fresh_uuid(), fresh_uuid()];
    let asset = fresh_uuid();
    let small_asset = fresh_uuid();
    let plan = json!({"commands":[
        {"kind":"collection-create","collectionId":owner,"title":"Synthetic asset folder"},
        {"kind":"object-create","objectId":object,"collectionId":owner,"objectTypeId":"note","title":"Synthetic asset owner","payloadJson":"{}"}
    ],"attachments":[
        {"kind":"create","attachmentId":ids[0],"collectionId":owner,"objectId":null,"fileName":"folder.bin","assetId":asset},
        {"kind":"create","attachmentId":ids[1],"collectionId":owner,"objectId":object,"fileName":"object.bin","mediaType":"application/octet-stream","assetId":small_asset},
        {"kind":"create","attachmentId":ids[2],"collectionId":owner,"objectId":null,"fileName":"deleted.bin","assetId":small_asset}
    ]});
    let before = call(
        runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let bytes = (0..600000).map(|n| (n % 251) as u8).collect::<Vec<_>>();
    let staged = stage_content_write(
        runtime,
        handle,
        &fresh_uuid(),
        &before,
        &plan,
        &[(asset, bytes), (small_asset, vec![1, 2, 3, 4])],
    );
    let receipt = finish_content_write(runtime, handle, &staged).unwrap();
    runtime
        .require_open_vault(handle)
        .unwrap()
        .delete_attachment(ids[2].clone())
        .unwrap();
    json!({"owner":owner,"object":object,"ids":ids,"receipt":receipt})
}

#[test]
fn content_attachments_catalog_preserves_owners_hashes_and_tombstones() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic attachment catalog password");
    let f = attachment_catalog_fixture(&mut runtime, &handle);
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let params = json!({"vaultHandle":handle,"collectionId":f["owner"],"writeRevision":revision,"pageSize":1});
    let first = call(&mut runtime, "content.attachments.list", params.clone());
    assert!(first["nextCursor"].is_string());
    let mut second_params = params.clone();
    second_params["cursor"] = first["nextCursor"].clone();
    let second = call(&mut runtime, "content.attachments.list", second_params);
    assert!(second["nextCursor"].is_null());
    let rows = [&first["items"][0], &second["items"][0]];
    assert_eq!(rows.iter().filter(|r| r["objectId"].is_null()).count(), 1);
    assert_eq!(
        rows.iter().filter(|r| r["objectId"] == f["object"]).count(),
        1
    );
    for row in rows {
        assert_eq!(row["collectionId"], f["owner"]);
        assert_eq!(row["headCommitId"], f["receipt"]["commitId"]);
        let expected = if row["objectId"].is_null() {
            (0..600000).map(|n| (n % 251) as u8).collect::<Vec<_>>()
        } else {
            vec![1, 2, 3, 4]
        };
        assert_eq!(row["storedSize"], expected.len());
        assert_eq!(row["originalSize"], expected.len());
        assert_eq!(
            row["contentHash"],
            format!("{:x}", Sha256::digest(&expected))
        );
    }
    let deleted = call(
        &mut runtime,
        "content.attachments.list",
        json!({"vaultHandle":handle,"collectionId":null,"writeRevision":revision,"pageSize":50}),
    );
    assert_eq!(deleted["items"].as_array().unwrap().len(), 1);
    assert_eq!(deleted["items"][0]["attachmentId"], f["ids"][2]);
    assert_eq!(deleted["items"][0]["deleted"], true);
    assert_eq!(deleted["writeRevision"], revision);
    let error = runtime
        .handle(
            "content.attachments.begin",
            json!({"vaultHandle":handle,"attachmentId":f["ids"][2],"writeRevision":revision}),
        )
        .unwrap_err();
    assert_eq!(error.code, "attachment-deleted");
    assert!(runtime.attachment_reads.is_empty());
    // Existing object-only navigation stays unchanged.
    let ordinary = call(
        &mut runtime,
        "attachment.list",
        json!({"vaultHandle":handle,"collectionId":f["owner"],"objectId":f["object"],"pageSize":50}),
    );
    assert_eq!(ordinary["items"].as_array().unwrap().len(), 1);
}

#[test]
fn content_attachments_cursor_revision_and_lock_guards() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic attachment catalog password");
    let f = attachment_catalog_fixture(&mut runtime, &handle);
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let params = json!({"vaultHandle":handle,"collectionId":f["owner"],"writeRevision":revision,"pageSize":1});
    let page = call(&mut runtime, "content.attachments.list", params.clone());
    for (field, value) in [
        ("collectionId", Value::Null),
        ("collectionId", json!(fresh_uuid())),
        ("vaultHandle", json!(fresh_uuid())),
    ] {
        let mut changed = params.clone();
        changed[field] = value;
        changed["cursor"] = page["nextCursor"].clone();
        assert_eq!(
            runtime
                .handle("content.attachments.list", changed)
                .unwrap_err()
                .code,
            "content-attachments-stale"
        );
    }
    for (field, value) in [
        ("pageSize", json!(0)),
        ("pageSize", json!(51)),
        ("cursor", json!("invalid")),
        ("path", json!("synthetic secret")),
    ] {
        let mut changed = params.clone();
        changed[field] = value;
        assert!(!runtime
            .handle("content.attachments.list", changed)
            .unwrap_err()
            .message
            .contains("synthetic secret"));
    }
    upsert_test_login(
        &mut runtime,
        &handle,
        "password:changed-catalog",
        "Synthetic change",
    );
    assert_eq!(
        runtime
            .handle("content.attachments.list", params.clone())
            .unwrap_err()
            .code,
        "content-attachments-stale"
    );
    assert_eq!(
        runtime
            .handle(
                "content.attachments.begin",
                json!({"vaultHandle":handle,"attachmentId":f["ids"][0],"writeRevision":revision})
            )
            .unwrap_err()
            .code,
        "content-attachments-stale"
    );
    assert!(runtime.attachment_reads.is_empty());
    call(&mut runtime, "vault.lock", json!({"vaultHandle":handle}));
    assert_eq!(
        runtime
            .handle("content.attachments.list", params)
            .unwrap_err()
            .code,
        "vault-locked"
    );
}

#[test]
fn content_attachments_folder_download_preserves_hash_and_releases_on_lock() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic attachment catalog password");
    let f = attachment_catalog_fixture(&mut runtime, &handle);
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let begun = call(
        &mut runtime,
        "content.attachments.begin",
        json!({"vaultHandle":handle,"attachmentId":f["ids"][0],"writeRevision":revision}),
    );
    assert!(begun["metadata"]["objectId"].is_null());
    assert_eq!(begun["writeRevision"], revision);
    let mut bytes = Vec::new();
    while bytes.len() < 600000 {
        let chunk = call(
            &mut runtime,
            "attachment.read.chunk",
            json!({"readHandle":begun["readHandle"],"offset":bytes.len(),"maxBytes":262144}),
        );
        bytes.extend(
            BASE64
                .decode(chunk["dataBase64"].as_str().unwrap())
                .unwrap(),
        );
    }
    assert_eq!(
        begun["metadata"]["contentHash"],
        format!("{:x}", Sha256::digest(&bytes))
    );
    assert_eq!(
        call(
            &mut runtime,
            "vault.writeRevision",
            json!({"vaultHandle":handle})
        ),
        revision
    );
    call(&mut runtime, "vault.lock", json!({"vaultHandle":handle}));
    assert!(runtime.attachment_reads.is_empty());
    assert!(runtime
        .handle(
            "attachment.read.chunk",
            json!({"readHandle":begun["readHandle"],"offset":0,"maxBytes":1})
        )
        .is_err());
}

#[test]
fn content_attachments_power_denies_folder_and_object_plaintext() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault_with_tiga_mode(
        &mut runtime,
        "synthetic power attachment password",
        mdbx_ffi::MdbxTigaMode::Power,
    );
    let f = attachment_catalog_fixture(&mut runtime, &handle);
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let catalog = call(
        &mut runtime,
        "content.attachments.list",
        json!({"vaultHandle":handle,"collectionId":f["owner"],"writeRevision":revision,"pageSize":50}),
    );
    assert_eq!(catalog["items"].as_array().unwrap().len(), 2);
    for index in 0..2 {
        let error = runtime.handle("content.attachments.begin", json!({"vaultHandle":handle,"attachmentId":f["ids"][index],"writeRevision":revision})).unwrap_err();
        assert_eq!(error.code, "attachment-read-failed");
        assert!(runtime.attachment_reads.is_empty());
    }
}
