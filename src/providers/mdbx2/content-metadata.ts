import { base64ToBytes, bytesToBase64 } from "../../security/encoding";
import { Mdbx2NativeHostError, type Mdbx2WriteRevision } from "./native-contract";
import type { Mdbx2NativeClient } from "./native-client";

const MAX_ITEMS = 10_000;
const MAX_PAYLOAD = 1024 * 1024;
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const CHUNK = 256 * 1024;
const PAGE = 200;

interface Summary { headCommitId: string; deleted: boolean; updatedAt: string }
export interface Mdbx2ContentLabel extends Summary {
  labelId: string; collectionId: string; name: string; payloadSchemaVersion: number; payloadJson: string | null;
}
export interface Mdbx2ContentAssignment extends Summary { assignmentId: string; objectId: string; labelId: string }
export interface Mdbx2ContentRelation extends Summary {
  relationId: string; sourceObjectId: string; targetObjectId: string; relationKind: string; payloadSchemaVersion: number; payloadJson: string | null;
}
export interface Mdbx2ContentMetadataInput {
  writeRevision: Mdbx2WriteRevision;
  collectionIds: readonly string[];
  objectIds: readonly string[];
}
export interface Mdbx2ContentMetadata {
  writeRevision: Mdbx2WriteRevision;
  labels: Mdbx2ContentLabel[];
  assignments: Mdbx2ContentAssignment[];
  relations: Mdbx2ContentRelation[];
}

function invalid(): never {
  throw new Mdbx2NativeHostError("content-metadata-invalid", "MDBX 元数据不完整或不一致，请重新读取。", false);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function shape(value: unknown, fields: string): Record<string, unknown> {
  const row = object(value), keys = fields.split(",");
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) invalid();
  return value;
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) invalid();
  return value;
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
  return value as number;
}
function revision(value: unknown): Mdbx2WriteRevision {
  const row = shape(value, "vaultId,revisionSha256");
  const hash = bounded(row.revisionSha256, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) invalid();
  return { vaultId: uuid(row.vaultId), revisionSha256: hash };
}
function sameRevision(value: unknown, expected: Mdbx2WriteRevision): void {
  const actual = revision(value);
  if (actual.vaultId !== expected.vaultId || actual.revisionSha256 !== expected.revisionSha256) invalid();
}
function ids(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > MAX_ITEMS) invalid();
  const result = values.map(uuid);
  if (new Set(result).size !== result.length) invalid();
  return result;
}
function summary(row: Record<string, unknown>): Summary {
  if (typeof row.deleted !== "boolean") invalid();
  return { headCommitId: uuid(row.headCommitId), deleted: row.deleted, updatedAt: bounded(row.updatedAt, 128) };
}
const LABEL_FIELDS = "labelId,collectionId,name,payloadSchemaVersion,deleted";
const RELATION_FIELDS = "relationId,sourceObjectId,targetObjectId,relationKind,payloadSchemaVersion,deleted";

/** Bounded read of a caller-selected catalog at one revision. Payload JSON stays
 * opaque: parsing and reserializing it would round native integers/decimals. */
export async function readMdbx2ContentMetadata(
  client: Pick<Mdbx2NativeClient, "hello" | "request">,
  vaultHandle: string,
  input: Mdbx2ContentMetadataInput,
  signal?: AbortSignal
): Promise<Mdbx2ContentMetadata> {
  // Snapshot mutable caller input before the first await, including the revision.
  const handle = uuid(vaultHandle), expected = revision(input.writeRevision);
  const collections = ids(input.collectionIds), objects = ids(input.objectIds);
  const active = () => { if (signal?.aborted) throw new DOMException("MDBX metadata read cancelled", "AbortError"); };
  active();
  const capabilities = await client.hello(5_000, handle); active();
  if (!capabilities.supportsContentMetadata || !capabilities.supportsVaultWriteRevision) {
    throw new Mdbx2NativeHostError("content-metadata-host-update-required", "当前 MDBX 引擎不支持完整元数据读取，请更新插件或本机助手。", false);
  }
  let bytes = 0, count = 0;
  const charge = (value: unknown) => {
    bytes += new TextEncoder().encode(JSON.stringify(value)).length;
    if (bytes > MAX_CATALOG_BYTES) invalid();
  };
  const request = async (method: "content.metadata.list" | "content.metadata.read", params: Record<string, unknown>) => {
    active();
    const result = await client.request(method, { ...params, vaultHandle: handle, writeRevision: { ...expected } }, 30_000);
    active();
    if (new TextEncoder().encode(JSON.stringify(result)).length > 850 * 1024) invalid();
    return result;
  };
  const pages = async (kind: "labels" | "assignments" | "relations", ownerId: string): Promise<Record<string, unknown>[]> => {
    const rows: Record<string, unknown>[] = [], cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = shape(await request("content.metadata.list", { kind, ownerId, pageSize: PAGE, cursor }), "kind,ownerId,items,nextCursor,writeRevision");
      sameRevision(page.writeRevision, expected);
      if (page.kind !== kind || page.ownerId !== ownerId || !Array.isArray(page.items) || page.items.length > PAGE) invalid();
      count += page.items.length; if (count > MAX_ITEMS) invalid();
      charge(page.items);
      for (const row of page.items) rows.push(object(row));
      if (page.nextCursor === null) cursor = null;
      else {
        cursor = bounded(page.nextCursor, 8192);
        if (!cursor || !page.items.length || cursors.has(cursor)) invalid();
        cursors.add(cursor);
      }
    } while (cursor !== null);
    return rows;
  };
  const payload = async (kind: "label" | "relation", id: string, row: Record<string, unknown>): Promise<string> => {
    const fields = kind === "label" ? LABEL_FIELDS : RELATION_FIELDS;
    let buffer: Uint8Array<ArrayBuffer> | undefined, hash: string | undefined, offset = 0;
    try {
      for (;;) {
        const chunk = shape(await request("content.metadata.read", { kind, id, offset, limit: CHUNK }), "kind,id,metadata,sizeBytes,sha256,offset,nextOffset,done,dataBase64,writeRevision");
        sameRevision(chunk.writeRevision, expected);
        const metadata = shape(chunk.metadata, fields);
        if (chunk.kind !== kind || chunk.id !== id || fields.split(",").some(key => metadata[key] !== row[key])) invalid();
        const size = integer(chunk.sizeBytes, MAX_PAYLOAD), next = integer(chunk.nextOffset, size);
        const digest = bounded(chunk.sha256, 64);
        if (!/^[a-f0-9]{64}$/.test(digest) || chunk.offset !== offset || next !== Math.min(size, offset + CHUNK) || chunk.done !== (next === size)) invalid();
        if (!buffer) {
          bytes += size; if (bytes > MAX_CATALOG_BYTES) invalid();
          buffer = new Uint8Array(size); hash = digest;
        }
        if (buffer.length !== size || hash !== digest) invalid();
        let part: Uint8Array | undefined;
        try {
          part = base64ToBytes(bounded(chunk.dataBase64, 4 * Math.ceil(CHUNK / 3)));
          if (part.length !== next - offset || bytesToBase64(part) !== chunk.dataBase64) invalid();
          buffer.set(part, offset);
        } catch { invalid(); } finally { part?.fill(0); }
        offset = next;
        if (chunk.done) break;
        if (!part?.length) invalid();
      }
      const actualHash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(byte => byte.toString(16).padStart(2, "0")).join("");
      active(); if (actualHash !== hash) invalid();
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer); } catch { invalid(); }
    } finally { buffer?.fill(0); }
  };
  const result: Mdbx2ContentMetadata = { writeRevision: { ...expected }, labels: [], assignments: [], relations: [] };
  const unique = new Set<string>();
  const once = (id: string) => { if (unique.has(id)) invalid(); unique.add(id); };
  for (const owner of collections) {
    for (const raw of await pages("labels", owner)) {
      const row = shape(raw, LABEL_FIELDS + ",headCommitId,updatedAt");
      const base = summary(row), labelId = uuid(row.labelId), collectionId = uuid(row.collectionId);
      if (collectionId !== owner) invalid(); once(`label:${labelId}`);
      const name = bounded(row.name, 64 * 1024), payloadSchemaVersion = integer(row.payloadSchemaVersion, 0xffff_ffff);
      result.labels.push({ ...base, labelId, collectionId, name, payloadSchemaVersion, payloadJson: base.deleted ? null : await payload("label", labelId, row) });
    }
  }
  for (const owner of objects) {
    for (const raw of await pages("assignments", owner)) {
      const row = shape(raw, "assignmentId,objectId,labelId,headCommitId,deleted,updatedAt");
      const base = summary(row), assignmentId = uuid(row.assignmentId), objectId = uuid(row.objectId), labelId = uuid(row.labelId);
      if (objectId !== owner) invalid(); once(`assignment:${assignmentId}`);
      result.assignments.push({ ...base, assignmentId, objectId, labelId });
    }
    for (const raw of await pages("relations", owner)) {
      const row = shape(raw, RELATION_FIELDS + ",headCommitId,updatedAt");
      const base = summary(row), relationId = uuid(row.relationId), sourceObjectId = uuid(row.sourceObjectId), targetObjectId = uuid(row.targetObjectId);
      if (sourceObjectId !== owner) invalid(); once(`relation:${relationId}`);
      const relationKind = bounded(row.relationKind, 1024), payloadSchemaVersion = integer(row.payloadSchemaVersion, 0xffff_ffff);
      result.relations.push({ ...base, relationId, sourceObjectId, targetObjectId, relationKind, payloadSchemaVersion, payloadJson: base.deleted ? null : await payload("relation", relationId, row) });
    }
  }
  active();
  sameRevision(await client.request("vault.writeRevision", { vaultHandle: handle }, 15_000), expected);
  active(); return result;
}
