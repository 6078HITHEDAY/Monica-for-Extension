//! Bounded, memory-only content/attachment adoption. The native transaction is
//! revision guarded; a committed operation ID is replayable with identical input.
use super::{
    fresh_uuid, reject_unknown, take_object, take_optional_string, take_optional_uuid, take_string,
    take_u64, take_uuid, unix_seconds, valid_sha256, HostRuntime, RpcFailure,
    MAX_BINARY_CHUNK_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use mdbx_ffi::{MdbxAttachmentBatchCommand, MdbxWriteCommand, MdbxWriteRevision};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use zeroize::Zeroizing;

const MAX_PLAN: usize = 8 * 1024 * 1024;
const MAX_ASSETS: usize = 64 * 1024 * 1024;
const MAX_MEMORY: usize = 128 * 1024 * 1024;
const MAX_COMMANDS: usize = 128;
const MAX_ASSET_COUNT: usize = 64;
const LIFETIME: u64 = 300;
const OPERATION: &str = "monica-content-adoption-v1";
type Result<T> = std::result::Result<T, RpcFailure>;
fn invalid() -> RpcFailure {
    RpcFailure::new(
        "content-write-invalid",
        "Native content write is incomplete or invalid.",
        false,
    )
}
fn failed() -> RpcFailure {
    RpcFailure::new("content-write-failed", "Native content write could not be confirmed. Retry the identical operation to recover its receipt before starting another write.", false)
}

struct Part {
    size: usize,
    hash: String,
    bytes: Zeroizing<Vec<u8>>,
}
pub(super) struct Session {
    vault_handle: String,
    operation_id: String,
    revision: MdbxWriteRevision,
    parts: HashMap<String, Part>,
    reserved: usize,
    touched: u64,
}
impl Session {
    pub(super) fn belongs_to(&self, handle: &str) -> bool {
        self.vault_handle == handle
    }
}
fn descriptor(value: Value, maximum: usize) -> Result<Part> {
    let mut row = take_object(value, "Content descriptor must be an object.")?;
    let size = take_u64(&mut row, "sizeBytes")?;
    let hash = take_string(&mut row, "sha256", 64, false)?;
    reject_unknown(row)?;
    if size > maximum as u64 || !valid_sha256(&hash) {
        return Err(invalid());
    }
    Ok(Part {
        size: size as usize,
        hash,
        bytes: Zeroizing::new(Vec::new()),
    })
}
fn revision(value: Value) -> Result<MdbxWriteRevision> {
    let mut row = take_object(value, "Content revision is required.")?;
    let vault_id = take_uuid(&mut row, "vaultId")?;
    let revision_sha256 = take_string(&mut row, "revisionSha256", 64, false)?;
    reject_unknown(row)?;
    if !valid_sha256(&revision_sha256) {
        return Err(invalid());
    }
    Ok(MdbxWriteRevision {
        vault_id,
        revision_sha256,
    })
}

pub(super) fn handle(runtime: &mut HostRuntime, method: &str, value: Value) -> Result<Value> {
    let now = unix_seconds()?;
    runtime
        .content_writes
        .retain(|_, session| now.saturating_sub(session.touched) <= LIFETIME);
    let mut params = take_object(value, "Content write params must be an object.")?;
    let vault_handle = take_uuid(&mut params, "vaultHandle")?;
    if method == "content.write.abort" {
        let handle = take_uuid(&mut params, "writeHandle")?;
        reject_unknown(params)?;
        let owned = runtime
            .content_writes
            .get(&handle)
            .is_some_and(|s| s.belongs_to(&vault_handle));
        if owned {
            runtime.content_writes.remove(&handle);
        }
        return Ok(json!({"released":owned}));
    }
    let vault = runtime.require_open_vault(&vault_handle)?;
    match method {
        "content.write.anchor" => {
            reject_unknown(params)?;
            let unreadable = || {
                RpcFailure::new(
                    "content-write-anchor-unavailable",
                    "The native write anchor could not be read.",
                    true,
                )
            };
            // Retain the actual branch inputs to the native revision hash.
            // A caller can then predict the revision after its own main-branch
            // commit, including after a lost reply, without accepting unrelated
            // edits as a new baseline. This endpoint never performs a write.
            let before = vault.read_write_revision().map_err(|_| unreadable())?;
            let mut branches = vault.list_branches().map_err(|_| unreadable())?;
            if branches.is_empty() || branches.len() > 1024 {
                return Err(invalid());
            }
            branches.sort_by(|a, b| a.branch_id.cmp(&b.branch_id));
            let mut ids = HashSet::new();
            let mut main_count = 0;
            let mut hash = Sha256::new();
            let mut part = |bytes: &[u8]| {
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(bytes);
            };
            part(b"monica-extension-write-revision-v1");
            part(before.vault_id.as_bytes());
            let mut rows = Vec::with_capacity(branches.len());
            for branch in branches {
                if branch.branch_id.len() != 36
                    || branch.head_commit_id.len() != 36
                    || branch.branch_name.is_empty()
                    || branch.branch_name.len() > 4096
                    || !ids.insert(branch.branch_id.clone())
                {
                    return Err(invalid());
                }
                part(branch.branch_id.as_bytes());
                part(branch.branch_name.as_bytes());
                part(branch.head_commit_id.as_bytes());
                if branch.branch_name == "main" {
                    main_count += 1;
                }
                rows.push(json!({"branchId":branch.branch_id,"branchName":branch.branch_name,"headCommitId":branch.head_commit_id}));
            }
            let after = vault.read_write_revision().map_err(|_| unreadable())?;
            if before != after || format!("{:x}", hash.finalize()) != before.revision_sha256 {
                return Err(RpcFailure::new(
                    "content-write-stale",
                    "The vault changed while reading its write anchor.",
                    true,
                ));
            }
            if main_count != 1 {
                return Err(invalid());
            }
            let result = json!({"writeRevision":{"vaultId":before.vault_id,"revisionSha256":before.revision_sha256},"branches":rows});
            if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > 512 * 1024 {
                return Err(invalid());
            }
            Ok(result)
        }
        "content.write.begin" => {
            let operation_id = take_uuid(&mut params, "operationId")?;
            let revision = revision(params.remove("writeRevision").ok_or_else(invalid)?)?;
            let plan = descriptor(params.remove("plan").ok_or_else(invalid)?, MAX_PLAN)?;
            if plan.size == 0 {
                return Err(invalid());
            }
            let assets = params.remove("assets").ok_or_else(invalid)?;
            reject_unknown(params)?;
            let assets = assets.as_array().ok_or_else(invalid)?;
            if assets.len() > MAX_ASSET_COUNT {
                return Err(invalid());
            }
            let mut total = 0;
            let mut parts = HashMap::new();
            let reserved = plan.size;
            parts.insert("plan".to_string(), plan);
            for raw in assets {
                let mut item = take_object(raw.clone(), "Content asset must be an object.")?;
                let id = take_uuid(&mut item, "id")?;
                let part = descriptor(Value::Object(item), MAX_ASSETS)?;
                total += part.size;
                if total > MAX_ASSETS || parts.insert(id, part).is_some() {
                    return Err(invalid());
                }
            }
            let reserved = reserved + total;
            if runtime.content_writes.len() >= 2
                || runtime
                    .content_writes
                    .values()
                    .map(|s| s.reserved)
                    .sum::<usize>()
                    + reserved
                    > MAX_MEMORY
            {
                return Err(RpcFailure::new(
                    "content-write-busy",
                    "Native content staging limit reached.",
                    true,
                ));
            }
            // Revision validation belongs inside the eventual transaction. Do
            // not reject identical committed retries simply because it advanced.
            for part in parts.values_mut() {
                part.bytes
                    .try_reserve_exact(part.size)
                    .map_err(|_| invalid())?;
            }
            let handle = fresh_uuid();
            runtime.content_writes.insert(
                handle.clone(),
                Session {
                    vault_handle,
                    operation_id,
                    revision,
                    parts,
                    reserved,
                    touched: now,
                },
            );
            Ok(json!({"writeHandle":handle,"maxChunkBytes":MAX_BINARY_CHUNK_BYTES}))
        }
        "content.write.chunk" => {
            let handle = take_uuid(&mut params, "writeHandle")?;
            let part_id = take_string(&mut params, "partId", 64, false)?;
            let offset = take_u64(&mut params, "offset")?;
            let encoded = Zeroizing::new(take_string(
                &mut params,
                "dataBase64",
                4 * MAX_BINARY_CHUNK_BYTES.div_ceil(3),
                false,
            )?);
            reject_unknown(params)?;
            let session = runtime
                .content_writes
                .get_mut(&handle)
                .filter(|s| s.belongs_to(&vault_handle))
                .ok_or_else(invalid)?;
            let part = session.parts.get_mut(&part_id).ok_or_else(invalid)?;
            let bytes = Zeroizing::new(STANDARD.decode(encoded.as_bytes()).map_err(|_| invalid())?);
            if bytes.is_empty()
                || bytes.len() > MAX_BINARY_CHUNK_BYTES
                || STANDARD.encode(bytes.as_slice()) != *encoded
                || offset > part.size as u64
            {
                return Err(invalid());
            }
            let offset = offset as usize;
            let end = offset.checked_add(bytes.len()).ok_or_else(invalid)?;
            if end > part.size {
                return Err(invalid());
            }
            let repeated = offset < part.bytes.len();
            if repeated {
                if end > part.bytes.len() || part.bytes[offset..end] != **bytes {
                    return Err(invalid());
                }
            } else {
                if offset != part.bytes.len() {
                    return Err(invalid());
                }
                part.bytes.extend_from_slice(&bytes);
            }
            session.touched = now;
            Ok(
                json!({"writeHandle":handle,"partId":part_id,"nextOffset":part.bytes.len(),"repeated":repeated}),
            )
        }
        "content.write.finish" => {
            let handle = take_uuid(&mut params, "writeHandle")?;
            reject_unknown(params)?;
            if !runtime
                .content_writes
                .get(&handle)
                .is_some_and(|s| s.belongs_to(&vault_handle))
            {
                return Err(invalid());
            }
            let session = runtime.content_writes.remove(&handle).ok_or_else(invalid)?;
            for part in session.parts.values() {
                if part.bytes.len() != part.size
                    || format!("{:x}", Sha256::digest(part.bytes.as_slice())) != part.hash
                {
                    return Err(invalid());
                }
            }
            let raw = serde_json::from_slice::<Value>(&session.parts["plan"].bytes)
                .map_err(|_| invalid())?;
            let mut plan = take_object(raw, "Content plan must be an object.")?;
            let commands = plan.remove("commands").ok_or_else(invalid)?;
            let attachments = plan.remove("attachments").ok_or_else(invalid)?;
            reject_unknown(plan)?;
            let commands = commands.as_array().ok_or_else(invalid)?;
            let attachments = attachments.as_array().ok_or_else(invalid)?;
            if (commands.is_empty() && attachments.is_empty())
                || commands.len() > MAX_COMMANDS
                || attachments.len() > MAX_ASSET_COUNT
            {
                return Err(invalid());
            }
            let mut used = HashSet::new();
            let mut plaintext = 0;
            let commands = commands
                .iter()
                .cloned()
                .map(|value| command(value, &session, &mut used, &mut plaintext))
                .collect::<Result<Vec<_>>>()?;
            let attachments = attachments
                .iter()
                .cloned()
                .map(|value| attachment(value, &session, &mut used, &mut plaintext))
                .collect::<Result<Vec<_>>>()?;
            if used.len() + 1 != session.parts.len() {
                return Err(invalid());
            }
            let mut limits = mdbx_ffi::default_composite_write_operation_limits();
            limits.attachment_limits.max_plaintext_bytes_per_command = MAX_ASSETS as u64;
            limits.attachment_limits.max_plaintext_bytes = MAX_ASSETS as u64;
            let result = vault
                .execute_content_write_operation_at_revision(
                    session.operation_id.clone(),
                    OPERATION.into(),
                    commands,
                    attachments,
                    session.revision.clone(),
                    limits,
                )
                .map_err(|error| match error {
                    mdbx_ffi::MdbxFfiError::Storage { message }
                        if message == "validation error: write revision changed" =>
                    {
                        RpcFailure::new("content-write-stale", "The vault changed before this operation could write. Read the latest content before planning another operation.", true)
                    }
                    _ => failed(),
                })?;
            Ok(
                json!({"operationId":session.operation_id,"commitId":result.commit_id,"alreadyCommitted":result.already_committed}),
            )
        }
        _ => Err(invalid()),
    }
}

fn payload(row: &mut Map<String, Value>) -> Result<String> {
    take_string(row, "payloadJson", 1024 * 1024, false)
}
fn schema(row: &mut Map<String, Value>) -> Result<u32> {
    u32::try_from(take_u64(row, "payloadSchemaVersion")?).map_err(|_| invalid())
}
fn declarations(row: &mut Map<String, Value>, key: &str, maximum: usize) -> Result<Vec<String>> {
    let value = row.remove(key).ok_or_else(invalid)?;
    let values = value.as_array().ok_or_else(invalid)?;
    if values.len() > maximum {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    values
        .iter()
        .map(|value| {
            let text = value.as_str().ok_or_else(invalid)?;
            if text.is_empty() || text.len() > 512 || !seen.insert(text) {
                return Err(invalid());
            }
            Ok(text.to_string())
        })
        .collect()
}
fn command(
    value: Value,
    session: &Session,
    used: &mut HashSet<String>,
    total: &mut usize,
) -> Result<MdbxWriteCommand> {
    let mut row = take_object(value, "Content command must be an object.")?;
    let kind = take_string(&mut row, "kind", 32, false)?;
    let result = match kind.as_str() {
        "collection-profile-set" => {
            let project_id = take_uuid(&mut row, "collectionId")?;
            let collection_type_id = take_string(&mut row, "collectionTypeId", 512, false)?;
            let payload_schema_version = schema(&mut row)?;
            let allowed_object_type_ids = declarations(&mut row, "allowedObjectTypeIds", 256)?;
            let required_capability_ids = declarations(&mut row, "requiredCapabilityIds", 128)?;
            let id = take_uuid(&mut row, "assetId")?;
            if payload_schema_version == 0 || !row.is_empty() {
                return Err(invalid());
            }
            let part = session.parts.get(&id).ok_or_else(invalid)?;
            *total += part.size;
            // Also bound repeated references before making plaintext copies.
            if part.size > 1024 * 1024 || *total > 8 * 1024 * 1024 {
                return Err(invalid());
            }
            used.insert(id);
            MdbxWriteCommand::SetCollectionProfile {
                project_id,
                collection_type_id,
                payload: part.bytes.to_vec(),
                payload_schema_version,
                allowed_object_type_ids,
                required_capability_ids,
            }
        }
        "collection-presentation" => MdbxWriteCommand::UpdateProjectPresentation {
            project_id: take_uuid(&mut row, "collectionId")?,
            favorite: row
                .remove("favorite")
                .and_then(|v| v.as_bool())
                .ok_or_else(invalid)?,
            archived: row
                .remove("archived")
                .and_then(|v| v.as_bool())
                .ok_or_else(invalid)?,
            icon_ref: match row.remove("iconRef").ok_or_else(invalid)? {
                Value::Null => None,
                Value::String(text) if !text.is_empty() && text.len() <= 4096 => Some(text),
                _ => return Err(invalid()),
            },
        },
        "collection-create" => MdbxWriteCommand::CreateProjectWithParent {
            project_id: take_uuid(&mut row, "collectionId")?,
            title: take_string(&mut row, "title", 4096, true)?,
            parent_project_id: take_optional_uuid(&mut row, "parentId")?,
        },
        "collection-rename" => MdbxWriteCommand::RenameProject {
            project_id: take_uuid(&mut row, "collectionId")?,
            title: take_string(&mut row, "title", 4096, true)?,
        },
        "collection-move" => MdbxWriteCommand::MoveProject {
            project_id: take_uuid(&mut row, "collectionId")?,
            parent_project_id: take_optional_uuid(&mut row, "parentId")?,
        },
        "collection-delete" => MdbxWriteCommand::DeleteProject {
            project_id: take_uuid(&mut row, "collectionId")?,
        },
        "collection-trash" => MdbxWriteCommand::TrashProjectWithAttachments {
            project_id: take_uuid(&mut row, "collectionId")?,
        },
        "collection-restore" => MdbxWriteCommand::RestoreProject {
            project_id: take_uuid(&mut row, "collectionId")?,
            parent_project_id: take_optional_uuid(&mut row, "parentId")?,
        },
        "object-create" | "object-update" => {
            let entry_id = take_uuid(&mut row, "objectId")?;
            let project_id = take_uuid(&mut row, "collectionId")?;
            let entry_type = take_string(&mut row, "objectTypeId", 128, false)?;
            let title = take_string(&mut row, "title", 4096, true)?;
            let payload_json = payload(&mut row)?;
            if kind == "object-create" {
                MdbxWriteCommand::CreateEntry {
                    entry_id,
                    project_id,
                    entry_type,
                    title,
                    payload_json,
                }
            } else {
                MdbxWriteCommand::UpdateEntry {
                    entry_id,
                    project_id,
                    entry_type,
                    title,
                    payload_json,
                }
            }
        }
        "object-delete" => MdbxWriteCommand::DeleteEntry {
            entry_id: take_uuid(&mut row, "objectId")?,
            project_id: take_uuid(&mut row, "collectionId")?,
        },
        "object-restore" => MdbxWriteCommand::RestoreEntry {
            entry_id: take_uuid(&mut row, "objectId")?,
            project_id: take_uuid(&mut row, "collectionId")?,
        },
        "object-move" => MdbxWriteCommand::MoveEntry {
            entry_id: take_uuid(&mut row, "objectId")?,
            project_id: take_uuid(&mut row, "collectionId")?,
            target_project_id: take_uuid(&mut row, "targetCollectionId")?,
        },
        "label-create" => MdbxWriteCommand::CreateObjectLabel {
            label_id: take_uuid(&mut row, "labelId")?,
            collection_id: take_uuid(&mut row, "collectionId")?,
            name: take_string(&mut row, "name", 4096, true)?,
            payload_json: payload(&mut row)?,
            payload_schema_version: schema(&mut row)?,
        },
        "label-update" => MdbxWriteCommand::UpdateObjectLabel {
            label_id: take_uuid(&mut row, "labelId")?,
            name: take_string(&mut row, "name", 4096, true)?,
            payload_json: payload(&mut row)?,
            payload_schema_version: schema(&mut row)?,
        },
        "label-delete" => MdbxWriteCommand::DeleteObjectLabel {
            label_id: take_uuid(&mut row, "labelId")?,
        },
        "label-assign" => MdbxWriteCommand::AssignObjectLabel {
            assignment_id: take_uuid(&mut row, "assignmentId")?,
            object_id: take_uuid(&mut row, "objectId")?,
            label_id: take_uuid(&mut row, "labelId")?,
        },
        "label-unassign" => MdbxWriteCommand::RemoveObjectLabelAssignment {
            assignment_id: take_uuid(&mut row, "assignmentId")?,
        },
        "relation-create" => MdbxWriteCommand::CreateObjectRelation {
            relation_id: take_uuid(&mut row, "relationId")?,
            source_object_id: take_uuid(&mut row, "sourceObjectId")?,
            target_object_id: take_uuid(&mut row, "targetObjectId")?,
            relation_kind: take_string(&mut row, "relationKind", 128, false)?,
            payload_json: payload(&mut row)?,
            payload_schema_version: schema(&mut row)?,
        },
        "relation-update" => MdbxWriteCommand::UpdateObjectRelation {
            relation_id: take_uuid(&mut row, "relationId")?,
            relation_kind: take_string(&mut row, "relationKind", 128, false)?,
            payload_json: payload(&mut row)?,
            payload_schema_version: schema(&mut row)?,
        },
        "relation-delete" => MdbxWriteCommand::DeleteObjectRelation {
            relation_id: take_uuid(&mut row, "relationId")?,
        },
        _ => return Err(invalid()),
    };
    reject_unknown(row)?;
    Ok(result)
}
fn attachment(
    value: Value,
    session: &Session,
    used: &mut HashSet<String>,
    total: &mut usize,
) -> Result<MdbxAttachmentBatchCommand> {
    let mut row = take_object(value, "Content attachment must be an object.")?;
    let kind = take_string(&mut row, "kind", 16, false)?;
    let attachment_id = take_uuid(&mut row, "attachmentId")?;
    let content = if kind == "create" || kind == "replace" {
        let id = take_uuid(&mut row, "assetId")?;
        let part = session.parts.get(&id).ok_or_else(invalid)?;
        *total += part.size;
        if *total > MAX_ASSETS {
            return Err(invalid());
        }
        used.insert(id);
        part.bytes.to_vec()
    } else {
        Vec::new()
    };
    let result = match kind.as_str() {
        "create" => MdbxAttachmentBatchCommand::Create {
            attachment_id,
            project_id: take_uuid(&mut row, "collectionId")?,
            entry_id: take_optional_uuid(&mut row, "objectId")?,
            file_name: take_string(&mut row, "fileName", 512, false)?,
            media_type: take_optional_string(&mut row, "mediaType", 512)?,
            content,
        },
        "replace" => MdbxAttachmentBatchCommand::Replace {
            attachment_id,
            content,
        },
        "rename" => MdbxAttachmentBatchCommand::Rename {
            attachment_id,
            file_name: take_string(&mut row, "fileName", 512, false)?,
            media_type: take_optional_string(&mut row, "mediaType", 512)?,
        },
        "delete" => MdbxAttachmentBatchCommand::Delete { attachment_id },
        _ => return Err(invalid()),
    };
    reject_unknown(row)?;
    Ok(result)
}
