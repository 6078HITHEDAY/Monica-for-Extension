//! Synthetic acceptance fixture only; never shipped in the helper or extension.
use mdbx_ffi::{create_vault_with_tiga_mode, MdbxTigaMode, MdbxWriteCommand};
use serde_json::json;
use std::path::PathBuf;
use uuid::Uuid;

fn id() -> String {
    Uuid::new_v4().to_string()
}
fn main() {
    let directory = PathBuf::from(std::env::args().nth(1).expect("synthetic output directory"));
    std::fs::create_dir_all(&directory).unwrap();
    let mut fixtures = Vec::new();
    for (mode, name) in [
        (MdbxTigaMode::Multi, "multi"),
        (MdbxTigaMode::Power, "power"),
    ] {
        let path = directory.join(format!("synthetic-{name}.mdbx"));
        assert!(!path.exists(), "refuse to overwrite an existing fixture");
        let vault = create_vault_with_tiga_mode(
            path.to_str().unwrap().into(),
            "synthetic-metadata-acceptance-password".into(),
            "synthetic-metadata-test".into(),
            mode,
        )
        .unwrap();
        let owner = id();
        let source = id();
        let target = id();
        vault
            .execute_write_operation(
                id(),
                "synthetic-fixture".into(),
                vec![
                    MdbxWriteCommand::CreateProject {
                        project_id: owner.clone(),
                        title: "Synthetic metadata".into(),
                    },
                    MdbxWriteCommand::CreateEntry {
                        entry_id: source.clone(),
                        project_id: owner.clone(),
                        entry_type: "login".into(),
                        title: "Synthetic source".into(),
                        payload_json: "{}".into(),
                    },
                    MdbxWriteCommand::CreateEntry {
                        entry_id: target.clone(),
                        project_id: owner.clone(),
                        entry_type: "login".into(),
                        title: "Synthetic target".into(),
                        payload_json: "{}".into(),
                    },
                ],
            )
            .unwrap();
        let payload = format!(
            "{{\"large\":9007199254740993,\"decimal\":1.00000000000000001,\"opaque\":\"{}\"}}",
            "密🔑".repeat(40000)
        );
        let label = vault
            .create_object_label(
                owner.clone(),
                "Synthetic root metadata".into(),
                payload.clone(),
                3,
            )
            .unwrap();
        let tombstone = vault
            .create_object_label(
                owner.clone(),
                "Synthetic deleted metadata".into(),
                "{}".into(),
                2,
            )
            .unwrap();
        let assignment = id();
        vault
            .execute_write_operation(
                id(),
                "synthetic-assignment".into(),
                vec![MdbxWriteCommand::AssignObjectLabel {
                    assignment_id: assignment.clone(),
                    object_id: source.clone(),
                    label_id: label.label_id.clone(),
                }],
            )
            .unwrap();
        let relation = vault
            .create_object_relation(
                source.clone(),
                target.clone(),
                "com.monica.synthetic".into(),
                payload,
                4,
            )
            .unwrap();
        vault
            .delete_object_label(tombstone.label_id.clone())
            .unwrap();
        let backup = directory.join(format!("export-{name}.mdbx"));
        vault
            .create_backup(backup.to_str().unwrap().into())
            .unwrap();
        fixtures.push(json!({"mode":name,"file":backup.file_name().unwrap().to_str().unwrap(),"owner":owner,"source":source,"target":target,"label":label.label_id,"tombstone":tombstone.label_id,"assignment":assignment,"relation":relation.relation_id,"payloadJson":label.payload_json}));
    }
    std::fs::write(
        directory.join("fixtures.json"),
        serde_json::to_vec(&fixtures).unwrap(),
    )
    .unwrap();
    println!("Synthetic metadata fixtures generated.");
}
