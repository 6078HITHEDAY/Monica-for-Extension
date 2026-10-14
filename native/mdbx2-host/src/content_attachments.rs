//! Revision-bound, payload-free catalog including collection-owned attachments.
//! Content still passes the existing integrity, Tiga and in-memory read boundary.
use super::{
    reject_unknown, require_active_attachment_summary, take_bounded_page_size, take_object,
    take_optional_string, take_optional_uuid, take_string, take_uuid, valid_sha256, HostRuntime,
    RpcFailure, MAX_ATTACHMENT_PAGE_SIZE,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use mdbx_ffi::{MdbxAttachmentSummary, MdbxVault, MdbxWriteRevision};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

type Result<T> = std::result::Result<T, RpcFailure>;
const MAX_RESULT: usize = 850 * 1024;
fn invalid() -> RpcFailure {
    RpcFailure::new(
        "content-attachments-unavailable",
        "Native attachment catalog could not be read safely.",
        false,
    )
}
fn stale() -> RpcFailure {
    RpcFailure::new(
        "content-attachments-stale",
        "Native content changed; restart the attachment catalog read.",
        true,
    )
}
fn revision(params: &mut Map<String, Value>) -> Result<MdbxWriteRevision> {
    let mut raw = take_object(
        params.remove("writeRevision").ok_or_else(invalid)?,
        "Attachment writeRevision is required.",
    )?;
    let vault_id = take_uuid(&mut raw, "vaultId")?;
    let revision_sha256 = take_string(&mut raw, "revisionSha256", 64, false)?;
    if !valid_sha256(&revision_sha256) {
        return Err(invalid());
    }
    reject_unknown(raw)?;
    Ok(MdbxWriteRevision {
        vault_id,
        revision_sha256,
    })
}
fn check(vault: &MdbxVault, expected: &MdbxWriteRevision) -> Result<()> {
    if vault.read_write_revision().map_err(|_| invalid())? != *expected {
        return Err(stale());
    }
    Ok(())
}
fn revision_json(r: &MdbxWriteRevision) -> Value {
    json!({"vaultId":r.vault_id,"revisionSha256":r.revision_sha256})
}
fn summary(r: MdbxAttachmentSummary) -> Value {
    json!({"attachmentId":r.attachment_id,"collectionId":r.collection_id,"objectId":r.object_id,
        "fileName":r.file_name,"mediaType":r.media_type,"storageMode":r.storage_mode,"contentHash":r.content_hash,
        "originalSize":r.original_size,"storedSize":r.stored_size,"chunkCount":r.chunk_count,
        "headCommitId":r.head_commit_id,"deleted":r.deleted,"updatedAt":r.updated_at})
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Cursor {
    vault_handle: String,
    vault_id: String,
    revision: String,
    collection_id: Option<String>,
    inner: String,
}

pub(super) fn list(runtime: &HostRuntime, params: Value) -> Result<Value> {
    let mut params = take_object(params, "Attachment catalog params must be an object.")?;
    let handle = take_uuid(&mut params, "vaultHandle")?;
    // A UUID selects all active attachments in that collection; null selects
    // global tombstones. The two queries and their cursors never interchange.
    let collection = take_optional_uuid(&mut params, "collectionId")?;
    let expected = revision(&mut params)?;
    let page_size = take_bounded_page_size(
        &mut params,
        MAX_ATTACHMENT_PAGE_SIZE,
        "Attachment catalog pageSize exceeds the limit.",
    )?;
    let cursor = take_optional_string(&mut params, "cursor", 8192)?;
    reject_unknown(params)?;
    let cursor = cursor
        .map(|encoded| -> Result<String> {
            let bytes = STANDARD.decode(&encoded).map_err(|_| invalid())?;
            if STANDARD.encode(&bytes) != encoded {
                return Err(invalid());
            }
            let value: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if value.vault_handle != handle
                || value.vault_id != expected.vault_id
                || value.revision != expected.revision_sha256
                || value.collection_id != collection
            {
                return Err(stale());
            }
            Ok(value.inner)
        })
        .transpose()?;
    let vault = runtime.require_open_vault(&handle)?;
    check(&vault, &expected)?;
    let page = match &collection {
        Some(owner) => vault.list_attachment_summaries(owner.clone(), None, page_size, cursor),
        None => vault.list_deleted_attachment_summaries(page_size, cursor),
    }
    .map_err(|_| invalid())?;
    let next = page
        .next_cursor
        .map(|inner| {
            serde_json::to_vec(&Cursor {
                vault_handle: handle,
                vault_id: expected.vault_id.clone(),
                revision: expected.revision_sha256.clone(),
                collection_id: collection.clone(),
                inner,
            })
            .map(|bytes| STANDARD.encode(bytes))
        })
        .transpose()
        .map_err(|_| invalid())?;
    let result = json!({"collectionId":collection,"items":page.items.into_iter().map(summary).collect::<Vec<_>>(),"nextCursor":next,"writeRevision":revision_json(&expected)});
    check(&vault, &expected)?;
    if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > MAX_RESULT {
        return Err(invalid());
    }
    Ok(result)
}

pub(super) fn begin(runtime: &mut HostRuntime, params: Value) -> Result<Value> {
    let mut params = take_object(params, "Attachment catalog read params must be an object.")?;
    let handle = take_uuid(&mut params, "vaultHandle")?;
    let id = take_uuid(&mut params, "attachmentId")?;
    let expected = revision(&mut params)?;
    reject_unknown(params)?;
    let vault = runtime.require_open_vault(&handle)?;
    check(&vault, &expected)?;
    let metadata = summary(require_active_attachment_summary(&vault, &id)?);
    let mut result =
        runtime.attachment_read_begin(json!({"vaultHandle":handle,"attachmentId":id}))?;
    // Do not retain an inaccessible staged plaintext buffer when concurrent
    // native mutation invalidated the read. Ordinary release/lock/TTL also apply.
    if let Err(error) = check(&vault, &expected) {
        if let Some(read) = result["readHandle"].as_str() {
            runtime.attachment_reads.remove(read);
        }
        return Err(error);
    }
    result["metadata"] = metadata;
    result["writeRevision"] = revision_json(&expected);
    if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > MAX_RESULT {
        if let Some(read) = result["readHandle"].as_str() {
            runtime.attachment_reads.remove(read);
        }
        return Err(invalid());
    }
    Ok(result)
}
