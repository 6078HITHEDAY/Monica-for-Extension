//! Revision-bound metadata disclosure shared by Native Messaging and the browser
//! worker. No arbitrary writes, unbounded payload responses or caller paths.
use super::{
    reject_unknown, take_object, take_optional_string, take_page_size, take_string, take_u64,
    take_uuid, valid_sha256, HostRuntime, RpcFailure, MAX_BINARY_CHUNK_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use mdbx_ffi::{
    MdbxAuthorizationOutcome, MdbxDeviceAssurance, MdbxDeviceContext,
    MdbxObjectMetadataDisclosureLimits, MdbxTigaOperation, MdbxTigaScope, MdbxTigaScopeType,
    MdbxVault, MdbxWriteRevision,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

const MAX_PAYLOAD: usize = 1024 * 1024;
const MAX_RESULT: usize = 850 * 1024;
type Result<T> = std::result::Result<T, RpcFailure>;
fn error() -> RpcFailure {
    RpcFailure::new(
        "content-metadata-unavailable",
        "Native metadata could not be disclosed safely.",
        false,
    )
}
fn stale() -> RpcFailure {
    RpcFailure::new(
        "content-metadata-stale",
        "Native metadata changed; restart the catalog read.",
        true,
    )
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    vault_handle: String,
    owner_id: String,
    kind: String,
    revision: String,
    inner: String,
}

fn revision(params: &mut Map<String, Value>) -> Result<MdbxWriteRevision> {
    let mut raw = take_object(
        params.remove("writeRevision").ok_or_else(error)?,
        "Metadata writeRevision is required.",
    )?;
    let vault_id = take_uuid(&mut raw, "vaultId")?;
    let revision_sha256 = take_string(&mut raw, "revisionSha256", 64, false)?;
    if !valid_sha256(&revision_sha256) {
        return Err(error());
    }
    reject_unknown(raw)?;
    Ok(MdbxWriteRevision {
        vault_id,
        revision_sha256,
    })
}
fn check(vault: &MdbxVault, expected: &MdbxWriteRevision) -> Result<()> {
    if vault.read_write_revision().map_err(|_| error())? != *expected {
        return Err(stale());
    }
    Ok(())
}
fn revision_json(value: &MdbxWriteRevision) -> Value {
    json!({"vaultId":value.vault_id,"revisionSha256":value.revision_sha256})
}

pub(super) fn list(runtime: &HostRuntime, params: Value) -> Result<Value> {
    let mut params = take_object(params, "Metadata list params must be an object.")?;
    let handle = take_uuid(&mut params, "vaultHandle")?;
    let owner = take_uuid(&mut params, "ownerId")?;
    let kind = take_string(&mut params, "kind", 32, false)?;
    let expected = revision(&mut params)?;
    let page_size = take_page_size(&mut params)?;
    let cursor = take_optional_string(&mut params, "cursor", 8192)?;
    reject_unknown(params)?;
    let cursor = cursor
        .map(|encoded| -> Result<String> {
            let bytes = STANDARD.decode(&encoded).map_err(|_| error())?;
            if STANDARD.encode(&bytes) != encoded {
                return Err(error());
            }
            let value: Cursor = serde_json::from_slice(&bytes).map_err(|_| error())?;
            if value.vault_handle != handle
                || value.owner_id != owner
                || value.kind != kind
                || value.revision != expected.revision_sha256
            {
                return Err(stale());
            }
            Ok(value.inner)
        })
        .transpose()?;
    let vault = runtime.require_open_vault(&handle)?;
    check(&vault, &expected)?;
    let (items, next) = match kind.as_str() {
        "labels" => {
            let page = vault
                .list_object_label_summaries_including_deleted(owner.clone(), page_size, cursor)
                .map_err(|_| error())?;
            (page.items.into_iter().map(|r| json!({"labelId":r.label_id,"collectionId":r.collection_id,"name":r.name,
                "payloadSchemaVersion":r.payload_schema_version,"headCommitId":r.head_commit_id,"deleted":r.deleted,"updatedAt":r.updated_at})).collect::<Vec<_>>(), page.next_cursor)
        }
        "assignments" => {
            let page = vault
                .list_object_label_assignment_summaries_by_object_including_deleted(
                    owner.clone(),
                    page_size,
                    cursor,
                )
                .map_err(|_| error())?;
            (page.items.into_iter().map(|r| json!({"assignmentId":r.assignment_id,"objectId":r.object_id,"labelId":r.label_id,
                "headCommitId":r.head_commit_id,"deleted":r.deleted,"updatedAt":r.updated_at})).collect::<Vec<_>>(), page.next_cursor)
        }
        "relations" => {
            let page = vault
                .list_object_relation_summaries_from_including_deleted(
                    owner.clone(),
                    None,
                    page_size,
                    cursor,
                )
                .map_err(|_| error())?;
            (page.items.into_iter().map(|r| json!({"relationId":r.relation_id,"sourceObjectId":r.source_object_id,"targetObjectId":r.target_object_id,
                "relationKind":r.relation_kind,"payloadSchemaVersion":r.payload_schema_version,"headCommitId":r.head_commit_id,"deleted":r.deleted,"updatedAt":r.updated_at})).collect::<Vec<_>>(), page.next_cursor)
        }
        _ => return Err(error()),
    };
    check(&vault, &expected)?;
    let next = next
        .map(|inner| {
            serde_json::to_vec(&Cursor {
                vault_handle: handle,
                owner_id: owner.clone(),
                kind: kind.clone(),
                revision: expected.revision_sha256.clone(),
                inner,
            })
            .map(|bytes| STANDARD.encode(bytes))
            .map_err(|_| error())
        })
        .transpose()?;
    let value = json!({"kind":kind,"ownerId":owner,"items":items,"nextCursor":next,"writeRevision":revision_json(&expected)});
    if serde_json::to_vec(&value).map_err(|_| error())?.len() > MAX_RESULT {
        return Err(error());
    }
    Ok(value)
}

pub(super) fn read(runtime: &HostRuntime, params: Value) -> Result<Value> {
    let mut params = take_object(params, "Metadata read params must be an object.")?;
    let handle = take_uuid(&mut params, "vaultHandle")?;
    let id = take_uuid(&mut params, "id")?;
    let kind = take_string(&mut params, "kind", 32, false)?;
    let expected = revision(&mut params)?;
    let offset = take_u64(&mut params, "offset")?;
    let limit = take_u64(&mut params, "limit")?;
    if offset > MAX_PAYLOAD as u64 || limit == 0 || limit > MAX_BINARY_CHUNK_BYTES as u64 {
        return Err(error());
    }
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&handle)?;
    check(&vault, &expected)?;
    let limits = MdbxObjectMetadataDisclosureLimits {
        max_payload_bytes: MAX_PAYLOAD as u64,
    };
    // Each chunk repeats policy authorization, including BOTH relation ends.
    let (metadata, payload) = match kind.as_str() {
        "label" => {
            let r = vault
                .reveal_object_label_with_limits(id.clone(), limits)
                .map_err(|_| error())?
                .label
                .ok_or_else(error)?;
            (
                json!({"labelId":r.label_id,"collectionId":r.collection_id,"name":r.name,"payloadSchemaVersion":r.payload_schema_version,"deleted":r.deleted}),
                Zeroizing::new(r.payload_json.into_bytes()),
            )
        }
        "relation" => {
            let r = vault
                .reveal_object_relation_with_limits(id.clone(), limits)
                .map_err(|_| error())?
                .relation
                .ok_or_else(error)?;
            (
                json!({"relationId":r.relation_id,"sourceObjectId":r.source_object_id,"targetObjectId":r.target_object_id,
                "relationKind":r.relation_kind,"payloadSchemaVersion":r.payload_schema_version,"deleted":r.deleted}),
                Zeroizing::new(r.payload_json.into_bytes()),
            )
        }
        "collection-profile" => {
            // This raw repository API has no policy boundary of its own. Check
            // the owning project before every chunk, using conservative browser
            // posture, and recheck the content revision after disclosure.
            let decision = vault
                .authorize_tiga_operation(
                    MdbxTigaScope {
                        scope_type: MdbxTigaScopeType::Project,
                        scope_id: Some(id.clone()),
                    },
                    MdbxTigaOperation::RevealSecret,
                    MdbxDeviceContext {
                        assurance: MdbxDeviceAssurance::Standard,
                        secure_clipboard_available: false,
                        screen_capture_protection_available: false,
                        secure_temp_files_available: false,
                    },
                )
                .map_err(|_| error())?;
            if !matches!(
                decision.outcome,
                MdbxAuthorizationOutcome::Allow | MdbxAuthorizationOutcome::AllowWithConstraints
            ) {
                return Err(error());
            }
            check(&vault, &expected)?;
            let r = vault
                .get_collection_profile(id.clone())
                .map_err(|_| error())?
                .ok_or_else(error)?;
            let payload = Zeroizing::new(r.payload);
            let summary = vault
                .get_collection_summary(id.clone())
                .map_err(|_| error())?
                .ok_or_else(error)?;
            if r.collection_id != id
                || summary.collection_type_id.as_deref() != Some(r.collection_type_id.as_str())
                || summary.profile_schema_version != Some(r.payload_schema_version)
            {
                return Err(error());
            }
            (
                json!({"collectionId":r.collection_id,"collectionTypeId":r.collection_type_id,
                "payloadSchemaVersion":r.payload_schema_version,"allowedObjectTypeIds":r.allowed_object_type_ids,
                "requiredCapabilityIds":r.required_capability_ids,"createdAt":r.created_at,"updatedAt":r.updated_at,
                "createdByDeviceId":r.created_by_device_id,"updatedByDeviceId":r.updated_by_device_id,
                "headCommitId":summary.head_commit_id,"deleted":summary.deleted}),
                payload,
            )
        }
        _ => return Err(error()),
    };
    if payload.len() > MAX_PAYLOAD || offset as usize > payload.len() {
        return Err(error());
    }
    let end = (offset as usize + limit as usize).min(payload.len());
    let value = json!({"kind":kind,"id":id,"metadata":metadata,"sizeBytes":payload.len(),"sha256":format!("{:x}",Sha256::digest(payload.as_slice())),
        "offset":offset,"nextOffset":end,"done":end == payload.len(),"dataBase64":STANDARD.encode(&payload[offset as usize..end]),"writeRevision":revision_json(&expected)});
    check(&vault, &expected)?;
    if serde_json::to_vec(&value).map_err(|_| error())?.len() > MAX_RESULT {
        return Err(error());
    }
    Ok(value)
}
