fn profile_write_command(owner: &str, asset: &str) -> Value {
    json!({"kind":"collection-profile-set","collectionId":owner,"collectionTypeId":"com.monica.passwords",
        "payloadSchemaVersion":1,"allowedObjectTypeIds":["login","passkey"],"requiredCapabilityIds":[],"assetId":asset})
}
fn profile_presentation_command(owner: &str) -> Value {
    json!({"kind":"collection-presentation","collectionId":owner,"favorite":true,"archived":true,"iconRef":"key"})
}
fn profile_write_revision(runtime: &mut HostRuntime, handle: &str) -> Value {
    call(
        runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    )
}

#[test]
fn content_profile_write_atomic_binary_preserves_passkeys_and_replays_after_restart() {
    let (_root, mut runtime) = runtime();
    let password = "synthetic profile write password";
    let handle = open_test_vault(&mut runtime, password);
    let owner = fresh_uuid();
    let ids = [fresh_uuid(), fresh_uuid()];
    let payloads = [
        r#"{"credential_id":"synthetic-zero","sign_count":0,"private_key":"synthetic-original-zero"}"#,
        r#"{"credential_id":"synthetic-positive","sign_count":19,"private_key":"synthetic-original-positive"}"#,
    ];
    let vault = runtime.require_open_vault(&handle).unwrap();
    vault
        .execute_write_operation(
            fresh_uuid(),
            "profile-seed".into(),
            vec![
                MdbxWriteCommand::CreateProject {
                    project_id: owner.clone(),
                    title: "Original folder".into(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: ids[0].clone(),
                    project_id: owner.clone(),
                    entry_type: "passkey".into(),
                    title: "Zero".into(),
                    payload_json: payloads[0].into(),
                },
                MdbxWriteCommand::CreateEntry {
                    entry_id: ids[1].clone(),
                    project_id: owner.clone(),
                    entry_type: "passkey".into(),
                    title: "Positive".into(),
                    payload_json: payloads[1].into(),
                },
            ],
        )
        .unwrap();
    let originals = ids
        .iter()
        .map(|id| {
            vault
                .get_object(owner.clone(), id.clone())
                .unwrap()
                .unwrap()
                .payload_json
        })
        .collect::<Vec<_>>();
    let asset = fresh_uuid();
    let file = fresh_uuid();
    let bytes = (0..1024 * 1024)
        .map(|n| (n % 256) as u8)
        .collect::<Vec<_>>();
    let file_asset = fresh_uuid();
    let assets = vec![
        (asset.clone(), bytes.clone()),
        (file_asset.clone(), vec![3, 2, 1]),
    ];
    let plan = json!({"commands":[profile_write_command(&owner,&asset),profile_presentation_command(&owner)],
        "attachments":[{"kind":"create","attachmentId":file,"collectionId":owner,"fileName":"synthetic-profile-copy.bin","assetId":file_asset}]});
    let before = profile_write_revision(&mut runtime, &handle);
    let op = fresh_uuid();
    // Profile and snapshot serialization share the existing 16MiB native sync
    // delta limit with attachments. An oversized combination must fully roll
    // back, never disable that boundary to make the larger batch succeed.
    let mut large_plan = plan.clone();
    large_plan["attachments"][0]["assetId"] = json!(asset);
    let staged = stage_content_write(
        &mut runtime,
        &handle,
        &op,
        &before,
        &large_plan,
        &assets[..1],
    );
    assert_eq!(
        finish_content_write(&mut runtime, &handle, &staged)
            .unwrap_err()
            .code,
        "content-write-failed"
    );
    assert_eq!(profile_write_revision(&mut runtime, &handle), before);
    assert!(vault
        .get_collection_profile(owner.clone())
        .unwrap()
        .is_none());
    assert!(vault
        .get_attachment_summary(file.clone())
        .unwrap()
        .is_none());
    assert!(
        !vault
            .get_collection_summary(owner.clone())
            .unwrap()
            .unwrap()
            .favorite
    );
    let staged = stage_content_write(&mut runtime, &handle, &op, &before, &plan, &assets);
    let receipt = finish_content_write(&mut runtime, &handle, &staged).unwrap();
    let profile = vault
        .get_collection_profile(owner.clone())
        .unwrap()
        .unwrap();
    assert_eq!(profile.payload, bytes);
    assert_eq!(profile.allowed_object_type_ids, vec!["login", "passkey"]);
    let collection = vault
        .get_collection_summary(owner.clone())
        .unwrap()
        .unwrap();
    assert!(collection.favorite && collection.archived);
    assert_eq!(collection.icon_ref.as_deref(), Some("key"));
    assert_eq!(collection.title, "Original folder");
    assert_eq!(
        collection.head_commit_id,
        receipt["commitId"].as_str().unwrap()
    );
    assert_eq!(
        vault
            .get_attachment_summary(file)
            .unwrap()
            .unwrap()
            .head_commit_id,
        collection.head_commit_id
    );
    for (id, original) in ids.iter().zip(&originals) {
        assert_eq!(
            &vault
                .get_object(owner.clone(), id.clone())
                .unwrap()
                .unwrap()
                .payload_json,
            original
        );
    }
    let after = profile_write_revision(&mut runtime, &handle);
    let mut changed = assets.clone();
    changed[0].1[17] ^= 1;
    let staged = stage_content_write(&mut runtime, &handle, &op, &before, &plan, &changed);
    assert_eq!(
        finish_content_write(&mut runtime, &handle, &staged)
            .unwrap_err()
            .code,
        "content-write-failed"
    );
    let staged = stage_content_write(
        &mut runtime,
        &handle,
        &fresh_uuid(),
        &before,
        &plan,
        &assets,
    );
    assert_eq!(
        finish_content_write(&mut runtime, &handle, &staged)
            .unwrap_err()
            .code,
        "content-write-stale"
    );
    assert_eq!(profile_write_revision(&mut runtime, &handle), after);
    drop(vault);
    call(&mut runtime, "vault.lock", json!({"vaultHandle":handle}));
    reopen_test_vault(&mut runtime, &handle, password);
    let staged = stage_content_write(&mut runtime, &handle, &op, &before, &plan, &assets);
    let replay = finish_content_write(&mut runtime, &handle, &staged).unwrap();
    assert_eq!(replay["alreadyCommitted"], true);
    assert_eq!(replay["commitId"], receipt["commitId"]);
    assert_eq!(profile_write_revision(&mut runtime, &handle), after);
    let saved = runtime
        .require_open_vault(&handle)
        .unwrap()
        .get_collection_profile(owner)
        .unwrap()
        .unwrap();
    assert_eq!(saved.payload, bytes);
    assert_eq!(saved.created_at, profile.created_at);
    assert_eq!(saved.updated_at, profile.updated_at);
}

#[test]
fn content_profile_write_rejects_type_capability_and_object_conflicts_atomically() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic profile rejection");
    let object = upsert_test_login(&mut runtime, &handle, "profile-reject", "Original");
    let owner = object["collectionId"].as_str().unwrap();
    let asset = fresh_uuid();
    let vault = runtime.require_open_vault(&handle).unwrap();
    vault
        .set_collection_profile(
            owner.into(),
            "com.monica.passwords".into(),
            vec![255, 0, 128],
            1,
            vec!["login".into()],
            vec![],
        )
        .unwrap();
    let original = vault.get_collection_summary(owner.into()).unwrap().unwrap();
    let before = profile_write_revision(&mut runtime, &handle);
    for failure in [
        "type",
        "missing-capability",
        "existing-object",
        "late-attachment",
    ] {
        let mut command = profile_write_command(owner, &asset);
        if failure == "type" {
            command["collectionTypeId"] = json!("com.monica.other");
        }
        if failure == "missing-capability" {
            command["requiredCapabilityIds"] = json!(["com.monica.unavailable"]);
        }
        if failure == "existing-object" {
            command["allowedObjectTypeIds"] = json!(["passkey"]);
        }
        let files = if failure == "late-attachment" {
            json!([{"kind":"create","attachmentId":fresh_uuid(),"collectionId":owner,"objectId":fresh_uuid(),"fileName":"must-roll-back.bin","assetId":asset}])
        } else {
            json!([])
        };
        let plan =
            json!({"commands":[profile_presentation_command(owner),command],"attachments":files});
        let staged = stage_content_write(
            &mut runtime,
            &handle,
            &fresh_uuid(),
            &before,
            &plan,
            &[(asset.clone(), vec![1, 2, 3])],
        );
        let error = finish_content_write(&mut runtime, &handle, &staged).unwrap_err();
        assert_eq!(error.code, "content-write-failed", "{failure}");
        assert!(!error.message.contains("com.monica"));
        assert_eq!(
            profile_write_revision(&mut runtime, &handle),
            before,
            "{failure}"
        );
        assert_eq!(
            vault.get_collection_summary(owner.into()).unwrap().unwrap(),
            original
        );
        assert_eq!(
            vault
                .get_collection_profile(owner.into())
                .unwrap()
                .unwrap()
                .payload,
            vec![255, 0, 128]
        );
    }
    assert!(vault.list_extension_profiles().unwrap().is_empty());
}

#[test]
fn content_profile_write_cannot_drop_unavailable_existing_capability_or_change_tiga() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault_with_tiga_mode(
        &mut runtime,
        "synthetic profile capability",
        mdbx_ffi::MdbxTigaMode::Power,
    );
    let object = upsert_test_login(&mut runtime, &handle, "capability-owner", "Original");
    let owner = object["collectionId"].as_str().unwrap();
    let asset = fresh_uuid();
    let vault = runtime.require_open_vault(&handle).unwrap();
    vault
        .set_extension_capabilities(vec!["com.monica.test.store".into()])
        .unwrap();
    vault
        .set_collection_profile(
            owner.into(),
            "com.monica.passwords".into(),
            vec![7],
            1,
            vec!["login".into()],
            vec!["com.monica.test.store".into()],
        )
        .unwrap();
    vault.set_extension_capabilities(vec![]).unwrap();
    let before = profile_write_revision(&mut runtime, &handle);
    for command in [
        profile_write_command(owner, &asset),
        profile_presentation_command(owner),
    ] {
        let assets = if command["kind"] == "collection-profile-set" {
            vec![(asset.clone(), vec![8])]
        } else {
            vec![]
        };
        let plan = json!({"commands":[command],"attachments":[]});
        let staged = stage_content_write(
            &mut runtime,
            &handle,
            &fresh_uuid(),
            &before,
            &plan,
            &assets,
        );
        assert!(finish_content_write(&mut runtime, &handle, &staged).is_err());
        assert_eq!(profile_write_revision(&mut runtime, &handle), before);
    }
    assert_eq!(
        vault
            .get_collection_profile(owner.into())
            .unwrap()
            .unwrap()
            .required_capability_ids,
        vec!["com.monica.test.store"]
    );
    // A real installed capability can perform a presentation-only update. It
    // must not make Power data disclosable under this Standard device context.
    vault
        .set_extension_capabilities(vec!["com.monica.test.store".into()])
        .unwrap();
    let plan = json!({"commands":[profile_presentation_command(owner)],"attachments":[]});
    let staged = stage_content_write(&mut runtime, &handle, &fresh_uuid(), &before, &plan, &[]);
    finish_content_write(&mut runtime, &handle, &staged).unwrap();
    assert!(runtime
        .handle(
            "object.reveal",
            json!({"vaultHandle":handle,"objectId":object["objectId"]})
        )
        .is_err());
    let rev = profile_write_revision(&mut runtime, &handle);
    assert!(runtime.handle("content.metadata.read",json!({"vaultHandle":handle,"kind":"collection-profile","id":owner,"writeRevision":rev,"offset":0,"limit":262144})).is_err());
}

#[test]
fn content_profile_write_rejects_invalid_shapes_and_counts_binary_resource_usage() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic profile bounds");
    let owner = fresh_uuid();
    let asset = fresh_uuid();
    let before = profile_write_revision(&mut runtime, &handle);
    for failure in [
        "oversized",
        "duplicate-types",
        "duplicate-capabilities",
        "invalid-schema",
        "policy-field",
        "missing-asset",
        "repeated-budget",
    ] {
        let mut command = profile_write_command(&owner, &asset);
        let mut assets = vec![(asset.clone(), vec![0; 16])];
        if failure == "oversized" {
            assets[0].1 = vec![0; 1024 * 1024 + 1];
        }
        if failure == "duplicate-types" {
            command["allowedObjectTypeIds"] = json!(["login", "login"]);
        }
        if failure == "duplicate-capabilities" {
            command["requiredCapabilityIds"] = json!(["com.monica.test", "com.monica.test"]);
        }
        if failure == "invalid-schema" {
            command["payloadSchemaVersion"] = json!(0);
        }
        if failure == "policy-field" {
            command["tigaModeOverride"] = json!("sky");
        }
        if failure == "missing-asset" {
            assets.clear();
        }
        let commands = if failure == "repeated-budget" {
            assets[0].1 = vec![0; 1024 * 1024];
            vec![command; 9]
        } else {
            vec![command]
        };
        let plan = json!({"commands":commands,"attachments":[]});
        let staged = stage_content_write(
            &mut runtime,
            &handle,
            &fresh_uuid(),
            &before,
            &plan,
            &assets,
        );
        assert_eq!(
            finish_content_write(&mut runtime, &handle, &staged)
                .unwrap_err()
                .code,
            "content-write-invalid",
            "{failure}"
        );
        assert!(runtime.content_writes.is_empty());
        assert_eq!(profile_write_revision(&mut runtime, &handle), before);
    }
    use mdbx_storage::repo::{
        OperationCoordinator, WriteCommand, WriteOperationLimits, WriteOperationRequest,
    };
    let command = WriteCommand::SetCollectionProfile {
        project_id: owner,
        collection_type_id: "com.monica.passwords".into(),
        payload: vec![0; 16],
        payload_schema_version: 1,
        allowed_object_type_ids: vec!["login".into()],
        required_capability_ids: vec![],
    };
    let request = |commands, limits| {
        WriteOperationRequest::new(fresh_uuid(), "synthetic-resource", commands).with_limits(limits)
    };
    assert!(OperationCoordinator::prepare(request(
        vec![command.clone()],
        WriteOperationLimits {
            max_payload_bytes_per_command: 15,
            ..Default::default()
        }
    ))
    .is_err());
    assert!(OperationCoordinator::prepare(request(
        vec![command.clone(), command.clone()],
        WriteOperationLimits {
            max_payload_bytes_per_command: 16,
            max_payload_bytes: 31,
            ..Default::default()
        }
    ))
    .is_err());
    assert!(OperationCoordinator::prepare(request(
        vec![command],
        WriteOperationLimits {
            max_intent_bytes: 20,
            ..Default::default()
        }
    ))
    .is_err());
}
