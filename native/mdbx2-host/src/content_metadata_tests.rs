#[test]
fn content_metadata_preserves_full_payload_and_revision() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic metadata password");
    let object = upsert_test_login(
        &mut runtime,
        &handle,
        "password:metadata",
        "Synthetic metadata",
    );
    let collection = object["collectionId"].as_str().unwrap();
    let object_id = object["objectId"].as_str().unwrap();
    let label = fresh_uuid();
    let payload = "{ \"large\":9007199254740993,\"decimal\":1.00000000000000001,\"secret\":\"synthetic metadata\" }";
    runtime
        .require_open_vault(&handle)
        .unwrap()
        .execute_write_operation(
            fresh_uuid(),
            "synthetic-metadata".into(),
            vec![
                MdbxWriteCommand::CreateObjectLabel {
                    label_id: label.clone(),
                    collection_id: collection.into(),
                    name: "Synthetic tag".into(),
                    payload_json: payload.into(),
                    payload_schema_version: 7,
                },
                MdbxWriteCommand::AssignObjectLabel {
                    assignment_id: fresh_uuid(),
                    object_id: object_id.into(),
                    label_id: label.clone(),
                },
            ],
        )
        .unwrap();
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let page = call(
        &mut runtime,
        "content.metadata.list",
        json!({"vaultHandle":handle,"kind":"labels","ownerId":collection,"writeRevision":revision,"pageSize":1}),
    );
    assert_eq!(page["items"][0]["labelId"], label);
    assert_eq!(page["items"][0]["payloadSchemaVersion"], 7);
    let read = call(
        &mut runtime,
        "content.metadata.read",
        json!({"vaultHandle":handle,"kind":"label","id":label,"writeRevision":revision,"offset":0,"limit":262144}),
    );
    let stored = runtime
        .require_open_vault(&handle)
        .unwrap()
        .reveal_object_label(label.clone())
        .unwrap()
        .label
        .unwrap()
        .payload_json;
    assert!(stored.contains("9007199254740993"));
    assert!(stored.contains("1.00000000000000001"));
    assert_eq!(
        BASE64.decode(read["dataBase64"].as_str().unwrap()).unwrap(),
        stored.as_bytes()
    );
    assert_eq!(read["writeRevision"], revision);
    assert_eq!(
        call(
            &mut runtime,
            "vault.writeRevision",
            json!({"vaultHandle":handle})
        ),
        revision
    );
}

#[test]
fn retained_sync_disclosure_preserves_trash_without_restoring_or_bypassing_power() {
    for mode in [mdbx_ffi::MdbxTigaMode::Multi, mdbx_ffi::MdbxTigaMode::Power] {
        let (_root, mut runtime) = runtime();
        let power = matches!(mode, mdbx_ffi::MdbxTigaMode::Power);
        let handle =
            open_test_vault_with_tiga_mode(&mut runtime, "synthetic retained password", mode);
        let row = upsert_test_login(&mut runtime, &handle, "retained-sync", "Retained secret");
        let vault = runtime.require_open_vault(&handle).unwrap();
        vault
            .execute_write_operation(
                fresh_uuid(),
                "synthetic-delete".into(),
                vec![MdbxWriteCommand::DeleteEntry {
                    entry_id: row["objectId"].as_str().unwrap().into(),
                    project_id: row["collectionId"].as_str().unwrap().into(),
                }],
            )
            .unwrap();
        let revision = vault.read_write_revision().unwrap();
        assert!(runtime
            .handle(
                "object.reveal",
                json!({"vaultHandle":handle,"objectId":row["objectId"]})
            )
            .is_err());
        let disclosed = runtime.handle(
            "object.reveal",
            json!({"vaultHandle":handle,"objectId":row["objectId"],"syncRetained":true}),
        );
        if power {
            assert_eq!(disclosed.unwrap_err().code, "object-disclosure-denied");
        } else {
            let disclosed = disclosed.unwrap();
            assert_eq!(disclosed["deleted"], true);
            assert!(disclosed["payloadJson"]
                .as_str()
                .unwrap()
                .contains("snapshot-test-secret"));
        }
        assert_eq!(vault.read_write_revision().unwrap(), revision);
    }
}

fn metadata_fixture(runtime: &mut HostRuntime, handle: &str, payload: &str) -> Value {
    let object = upsert_test_login(
        runtime,
        handle,
        "password:metadata-source",
        "Synthetic source",
    );
    let target = upsert_test_login(
        runtime,
        handle,
        "password:metadata-target",
        "Synthetic target",
    );
    let owner = object["collectionId"].as_str().unwrap();
    let source = object["objectId"].as_str().unwrap();
    let destination = target["objectId"].as_str().unwrap();
    let labels = [fresh_uuid(), fresh_uuid(), fresh_uuid()];
    let assignments = [fresh_uuid(), fresh_uuid()];
    let relations = [fresh_uuid(), fresh_uuid()];
    let mut commands = Vec::new();
    for label in &labels {
        commands.push(MdbxWriteCommand::CreateObjectLabel {
            label_id: label.clone(),
            collection_id: owner.into(),
            name: "Synthetic root metadata".into(),
            payload_json: payload.into(),
            payload_schema_version: 3,
        });
    }
    for index in 0..2 {
        commands.push(MdbxWriteCommand::AssignObjectLabel {
            assignment_id: assignments[index].clone(),
            object_id: source.into(),
            label_id: labels[index].clone(),
        });
        commands.push(MdbxWriteCommand::CreateObjectRelation {
            relation_id: relations[index].clone(),
            source_object_id: source.into(),
            target_object_id: destination.into(),
            relation_kind: format!("com.monica.synthetic{index}"),
            payload_json: payload.into(),
            payload_schema_version: 4,
        });
    }
    for command in commands {
        runtime
            .require_open_vault(handle)
            .unwrap()
            .execute_write_operation(fresh_uuid(), "synthetic-metadata".into(), vec![command])
            .unwrap();
    }
    runtime
        .require_open_vault(handle)
        .unwrap()
        .execute_write_operation(
            fresh_uuid(),
            "synthetic-tombstones".into(),
            vec![
                MdbxWriteCommand::RemoveObjectLabelAssignment {
                    assignment_id: assignments[0].clone(),
                },
                MdbxWriteCommand::DeleteObjectLabel {
                    label_id: labels[0].clone(),
                },
                MdbxWriteCommand::DeleteObjectRelation {
                    relation_id: relations[0].clone(),
                },
            ],
        )
        .unwrap();
    json!({"owner":owner,"source":source,"target":destination,"labels":labels,"assignments":assignments,"relations":relations})
}

#[test]
fn content_metadata_pages_include_tombstones_and_unassigned_labels() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic metadata password");
    let fixture = metadata_fixture(&mut runtime, &handle, "{\"unknown\":\"synthetic secret\"}");
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    for (kind, owner, key, count) in [
        ("labels", "owner", "labelId", 3),
        ("assignments", "source", "assignmentId", 2),
        ("relations", "source", "relationId", 2),
    ] {
        let mut cursor = Value::Null;
        let mut rows = Vec::new();
        loop {
            let page = call(
                &mut runtime,
                "content.metadata.list",
                json!({"vaultHandle":handle,"kind":kind,"ownerId":fixture[owner],"writeRevision":revision,"pageSize":1,"cursor":cursor}),
            );
            assert_eq!(page["writeRevision"], revision);
            assert_eq!(page["items"].as_array().unwrap().len(), 1);
            rows.push(page["items"][0].clone());
            cursor = page["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
            assert!(rows.len() <= count);
        }
        assert_eq!(rows.len(), count);
        assert_eq!(rows.iter().filter(|row| row["deleted"] == true).count(), 1);
        for id in fixture[kind].as_array().unwrap() {
            assert!(rows.iter().any(|row| &row[key] == id));
        }
    }
    // Preserve the existing policy: deletion markers are enumerable, but their
    // old secret payloads are not disclosed or synthesized as empty content.
    for (kind, ids) in [("label", "labels"), ("relation", "relations")] {
        let error = runtime.handle("content.metadata.read", json!({"vaultHandle":handle,"kind":kind,"id":fixture[ids][0],"writeRevision":revision,"offset":0,"limit":262144})).unwrap_err();
        assert_eq!(error.code, "content-metadata-unavailable");
    }
    let vault = runtime.require_open_vault(&handle).unwrap();
    assert_eq!(
        vault
            .list_object_label_summaries(fixture["owner"].as_str().unwrap().into(), 200, None)
            .unwrap()
            .items
            .len(),
        2
    );
    assert_eq!(
        vault
            .list_object_label_assignment_summaries_by_object(
                fixture["source"].as_str().unwrap().into(),
                200,
                None
            )
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        vault
            .list_object_relation_summaries_from(
                fixture["source"].as_str().unwrap().into(),
                None,
                200,
                None
            )
            .unwrap()
            .items
            .len(),
        1
    );
    let inclusive = vault
        .list_object_label_summaries_including_deleted(
            fixture["owner"].as_str().unwrap().into(),
            1,
            None,
        )
        .unwrap();
    assert!(vault
        .list_object_label_summaries(
            fixture["owner"].as_str().unwrap().into(),
            1,
            inclusive.next_cursor
        )
        .is_err());
    assert_eq!(
        call(
            &mut runtime,
            "vault.writeRevision",
            json!({"vaultHandle":handle})
        ),
        revision
    );
}

#[test]
fn content_metadata_rejects_cross_owner_cursor_stale_revision_and_locked_vault() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic metadata password");
    let fixture = metadata_fixture(&mut runtime, &handle, "{}");
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let request = json!({"vaultHandle":handle,"kind":"labels","ownerId":fixture["owner"],"writeRevision":revision,"pageSize":1});
    let page = call(&mut runtime, "content.metadata.list", request.clone());
    for (field, value) in [
        ("ownerId", json!(fresh_uuid())),
        ("kind", json!("relations")),
        ("vaultHandle", json!(fresh_uuid())),
    ] {
        let mut bad = request.clone();
        bad["cursor"] = page["nextCursor"].clone();
        bad[field] = value;
        assert_eq!(
            runtime
                .handle("content.metadata.list", bad)
                .unwrap_err()
                .code,
            "content-metadata-stale"
        );
    }
    let read = json!({"vaultHandle":handle,"kind":"label","id":fixture["labels"][1],"writeRevision":revision,"offset":0,"limit":10});
    upsert_test_login(
        &mut runtime,
        &handle,
        "password:metadata-source",
        "Changed source",
    );
    assert_eq!(
        runtime
            .handle("content.metadata.list", request.clone())
            .unwrap_err()
            .code,
        "content-metadata-stale"
    );
    assert_eq!(
        runtime
            .handle("content.metadata.read", read.clone())
            .unwrap_err()
            .code,
        "content-metadata-stale"
    );
    call(&mut runtime, "vault.lock", json!({"vaultHandle":handle}));
    assert_eq!(
        runtime
            .handle("content.metadata.list", request)
            .unwrap_err()
            .code,
        "vault-locked"
    );
    assert_eq!(
        runtime
            .handle("content.metadata.read", read)
            .unwrap_err()
            .code,
        "vault-locked"
    );
}

#[test]
fn content_metadata_chunks_reconstruct_utf8_and_enforce_bounds() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic metadata password");
    let fixture = metadata_fixture(
        &mut runtime,
        &handle,
        &json!({"secret":"密🔑".repeat(45000)}).to_string(),
    );
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    for (kind, ids) in [("label", "labels"), ("relation", "relations")] {
        let mut result = Vec::new();
        let mut offset = 0;
        let mut digest = Value::Null;
        loop {
            let read = call(
                &mut runtime,
                "content.metadata.read",
                json!({"vaultHandle":handle,"kind":kind,"id":fixture[ids][1],"writeRevision":revision,"offset":offset,"limit":262144}),
            );
            result.extend(BASE64.decode(read["dataBase64"].as_str().unwrap()).unwrap());
            if !digest.is_null() {
                assert_eq!(read["sha256"], digest);
            }
            digest = read["sha256"].clone();
            offset = read["nextOffset"].as_u64().unwrap();
            if read["done"] == true {
                assert_eq!(result.len() as u64, read["sizeBytes"].as_u64().unwrap());
                break;
            }
        }
        assert_eq!(
            format!("{:x}", Sha256::digest(&result)),
            digest.as_str().unwrap()
        );
        assert!(String::from_utf8(result)
            .unwrap()
            .contains(&"密🔑".repeat(45000)));
    }
    let read = json!({"vaultHandle":handle,"kind":"label","id":fixture["labels"][1],"writeRevision":revision,"offset":0,"limit":10});
    for (field, value) in [
        ("offset", json!(1048577)),
        ("limit", json!(0)),
        ("limit", json!(262145)),
        ("kind", json!("synthetic secret")),
        ("path", json!("synthetic secret")),
    ] {
        let mut bad = read.clone();
        bad[field] = value;
        let failure = runtime.handle("content.metadata.read", bad).unwrap_err();
        assert!(!failure.message.contains("synthetic secret"));
    }
}

#[test]
fn content_metadata_power_denies_payload_disclosure() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault_with_tiga_mode(
        &mut runtime,
        "synthetic metadata password",
        mdbx_ffi::MdbxTigaMode::Power,
    );
    let fixture = metadata_fixture(
        &mut runtime,
        &handle,
        "{\"secret\":\"synthetic private metadata\"}",
    );
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    for (kind, ids) in [("label", "labels"), ("relation", "relations")] {
        let failure = runtime.handle("content.metadata.read", json!({"vaultHandle":handle,"kind":kind,"id":fixture[ids][1],"writeRevision":revision,"offset":0,"limit":262144})).unwrap_err();
        assert_eq!(failure.code, "content-metadata-unavailable");
        assert!(!failure.message.contains("synthetic private metadata"));
    }
}

#[test]
fn content_metadata_rejects_oversized_payload_before_disclosure() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic metadata password");
    let obj = upsert_test_login(
        &mut runtime,
        &handle,
        "password:large-label",
        "Synthetic large label",
    );
    let label = runtime
        .require_open_vault(&handle)
        .unwrap()
        .create_object_label(
            obj["collectionId"].as_str().unwrap().into(),
            "Synthetic large".into(),
            json!({"secret":"x".repeat(1024 * 1024)}).to_string(),
            1,
        )
        .unwrap();
    let revision = call(
        &mut runtime,
        "vault.writeRevision",
        json!({"vaultHandle":handle}),
    );
    let denied = runtime.handle("content.metadata.read", json!({"vaultHandle":handle,"kind":"label","id":label.label_id,"writeRevision":revision,"offset":0,"limit":262144})).unwrap_err();
    assert_eq!(denied.code, "content-metadata-unavailable");
}
