fn predicted_content_revision(anchor: &Value, commit: &Value) -> Value {
    let mut hash = Sha256::new();
    let mut part = |value: &str| {
        hash.update((value.len() as u64).to_le_bytes());
        hash.update(value.as_bytes());
    };
    part("monica-extension-write-revision-v1");
    part(anchor["writeRevision"]["vaultId"].as_str().unwrap());
    let mut branches = anchor["branches"].as_array().unwrap().clone();
    branches.sort_by(|a, b| a["branchId"].as_str().cmp(&b["branchId"].as_str()));
    for branch in branches {
        part(branch["branchId"].as_str().unwrap());
        part(branch["branchName"].as_str().unwrap());
        part(
            if branch["branchName"] == "main" {
                commit
            } else {
                &branch["headCommitId"]
            }
            .as_str()
            .unwrap(),
        );
    }
    json!({"vaultId":anchor["writeRevision"]["vaultId"],"revisionSha256":format!("{:x}",hash.finalize())})
}

#[test]
fn content_write_anchor_predicts_profile_sequence_and_rejects_intervening_edits() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic write anchor password");
    let anchor = call(
        &mut runtime,
        "content.write.anchor",
        json!({"vaultHandle":handle}),
    );
    let before = profile_write_revision(&mut runtime, &handle);
    assert_eq!(before, anchor["writeRevision"]);
    let owner = fresh_uuid();
    let first = json!({"commands":[{"kind":"collection-create","collectionId":owner,"title":"Synthetic sequence"}],"attachments":[]});
    let operation = fresh_uuid();
    let staged = stage_content_write(&mut runtime, &handle, &operation, &before, &first, &[]);
    let receipt = finish_content_write(&mut runtime, &handle, &staged).unwrap();
    let predicted = predicted_content_revision(&anchor, &receipt["commitId"]);
    assert_eq!(predicted, profile_write_revision(&mut runtime, &handle));

    // A third-party edit after reply loss must not become the next step's guard.
    let vault = runtime.require_open_vault(&handle).unwrap();
    vault
        .execute_write_operation(
            fresh_uuid(),
            "unrelated-change".into(),
            vec![MdbxWriteCommand::RenameProject {
                project_id: owner.clone(),
                title: "User edit after interruption".into(),
            }],
        )
        .unwrap();
    let replay = stage_content_write(&mut runtime, &handle, &operation, &before, &first, &[]);
    let replay = finish_content_write(&mut runtime, &handle, &replay).unwrap();
    assert_eq!(replay["alreadyCommitted"], true);
    assert_eq!(
        predicted,
        predicted_content_revision(&anchor, &replay["commitId"])
    );
    let next = json!({"commands":[{"kind":"collection-rename","collectionId":owner,"title":"Pending next step"}],"attachments":[]});
    let next = stage_content_write(&mut runtime, &handle, &fresh_uuid(), &predicted, &next, &[]);
    assert_eq!(
        finish_content_write(&mut runtime, &handle, &next)
            .unwrap_err()
            .code,
        "content-write-stale"
    );
    assert_eq!(
        vault.get_collection_summary(owner).unwrap().unwrap().title,
        "User edit after interruption"
    );
}

#[test]
fn content_write_anchor_is_read_only_bounded_to_open_vault_and_strict_parameters() {
    let (_root, mut runtime) = runtime();
    let handle = open_test_vault(&mut runtime, "synthetic read-only anchor");
    let before = profile_write_revision(&mut runtime, &handle);
    let anchor = call(
        &mut runtime,
        "content.write.anchor",
        json!({"vaultHandle":handle}),
    );
    assert_eq!(anchor["writeRevision"], before);
    assert_eq!(profile_write_revision(&mut runtime, &handle), before);
    assert!(runtime.content_writes.is_empty());
    assert!(runtime
        .handle(
            "content.write.anchor",
            json!({"vaultHandle":handle,"acceptLatest":true})
        )
        .is_err());
    call(&mut runtime, "vault.lock", json!({"vaultHandle":handle}));
    assert!(runtime
        .handle("content.write.anchor", json!({"vaultHandle":handle}))
        .is_err());
}
