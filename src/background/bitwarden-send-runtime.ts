import { readBitwardenSession } from './bitwarden-session-config';
import { type ProviderAccount } from "../core/model";
import { BITWARDEN_ATTACHMENT_MAX_BYTES, PROVIDER_ATTACHMENT_CHUNK_BYTES, ProviderAttachmentError } from "../providers/attachments/attachment-contract";
import { ProviderAttachmentUploadStore } from "../providers/attachments/attachment-upload-store";
import { BitwardenClient } from "../providers/bitwarden/bitwarden-client";
import type { BitwardenSessionConfig } from "../providers/bitwarden/bitwarden-client";
import { BitwardenSendError, BitwardenSendService, type BitwardenSendFileInput } from "../providers/bitwarden/bitwarden-sends";
import type { ExtensionRequest } from "../runtime/messages";
import { base64ToBytes } from "../security/encoding";
import type { CommandHandlers } from './command-router';
import { assertManagerPage } from './request-access';

export type BitwardenSendRequest = Extract<ExtensionRequest, { type: "BITWARDEN_SEND_LIST" | "BITWARDEN_SEND_GET" | "BITWARDEN_SEND_CREATE_TEXT" | "BITWARDEN_SEND_UPDATE" | "BITWARDEN_SEND_DELETE" | "BITWARDEN_SEND_REMOVE_PASSWORD" | "BITWARDEN_SEND_FILE_UPLOAD_BEGIN" | "BITWARDEN_SEND_FILE_UPLOAD_CHUNK" | "BITWARDEN_SEND_FILE_UPLOAD_FINISH" | "BITWARDEN_SEND_FILE_UPLOAD_ABORT" }>;
export function createBitwardenSendRuntime(dependencies: {
  bitwardenClient: BitwardenClient;
  requireBitwardenAccountRecord(providerId: string): Promise<ProviderAccount>;
  persistBitwardenSession(account: ProviderAccount, session: BitwardenSessionConfig): Promise<void>;
}) {
  const { bitwardenClient, requireBitwardenAccountRecord, persistBitwardenSession } = dependencies;
  const bitwardenSends = new BitwardenSendService(bitwardenClient);

  const bitwardenSendUploads = new ProviderAttachmentUploadStore();

  const bitwardenSendUploadInputs = new Map<string, { providerId: string; input: Omit<BitwardenSendFileInput, "bytes"> }>();

  function clearBitwardenSendUploads(providerId?: string): void {
    bitwardenSendUploads.clear(providerId);
    for (const [transferId, metadata] of bitwardenSendUploadInputs) {
      if (providerId === undefined || metadata.providerId === providerId) bitwardenSendUploadInputs.delete(transferId);
    }
  }

  const PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH = Math.ceil(PROVIDER_ATTACHMENT_CHUNK_BYTES / 3) * 4;
  const handlers: CommandHandlers<BitwardenSendRequest> = {
    "BITWARDEN_SEND_LIST": async (request, sender) => {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.list(readBitwardenSession(account), account.id, request);
      await persistBitwardenSession(account, result.session);
      return result.page;
    },
    "BITWARDEN_SEND_GET": async (request, sender) => {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.get(readBitwardenSession(account), account.id, request.sendId);
      await persistBitwardenSession(account, result.session);
      return result.send;
    },
    "BITWARDEN_SEND_CREATE_TEXT": async (request, sender) => {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.createText(readBitwardenSession(account), account.id, request.input);
      await persistBitwardenSession(account, result.session);
      return result.send;
    },
    "BITWARDEN_SEND_UPDATE": async (request, sender) => {
      assertManagerPage(sender);
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.update(readBitwardenSession(account), account.id, request.input);
      await persistBitwardenSession(account, result.session);
      return result.send;
    },
    "BITWARDEN_SEND_DELETE": async (request, sender) => {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new BitwardenSendError("send-delete-confirmation-required", "删除 Bitwarden Send 需要明确确认。");
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.remove(readBitwardenSession(account), account.id, request.sendId, request.expectedRevision);
      await persistBitwardenSession(account, result.session);
      return { deleted: result.deleted };
    },
    "BITWARDEN_SEND_REMOVE_PASSWORD": async (request, sender) => {
      assertManagerPage(sender);
      if (request.confirmed !== true) throw new BitwardenSendError("send-password-removal-confirmation-required", "移除 Bitwarden Send 密码需要明确确认。");
      const account = await requireBitwardenAccountRecord(request.providerId);
      const result = await bitwardenSends.removePassword(readBitwardenSession(account), account.id, request.sendId, request.expectedRevision);
      await persistBitwardenSession(account, result.session);
      return result.send;
    },
    "BITWARDEN_SEND_FILE_UPLOAD_BEGIN": async (request, sender) => {
      assertManagerPage(sender);
      await requireBitwardenAccountRecord(request.providerId);
      const { sizeBytes, sha256, ...input } = request.input;
      const begun = bitwardenSendUploads.begin({
        providerId: request.providerId,
        itemId: "bitwarden-send",
        providerKind: "bitwarden",
        fileName: input.fileName,
        sizeBytes,
        sha256,
        replaceExisting: false
      }, BITWARDEN_ATTACHMENT_MAX_BYTES);
      bitwardenSendUploadInputs.set(begun.transferId, { providerId: request.providerId, input });
      return begun;
    },
    "BITWARDEN_SEND_FILE_UPLOAD_CHUNK": async (request, sender) => {
      assertManagerPage(sender);
      if (typeof request.dataBase64 !== "string" || request.dataBase64.length > PROVIDER_ATTACHMENT_MAX_BASE64_CHUNK_LENGTH) {
        throw new ProviderAttachmentError("attachment-upload-chunk-invalid", "Send 文件上传分块编码超过安全上限。");
      }
      const metadata = bitwardenSendUploadInputs.get(request.transferId);
      if (!metadata || metadata.providerId !== request.providerId) throw new ProviderAttachmentError("attachment-upload-not-found", "Send 文件上传已过期或 Service Worker 已重启，请重新选择文件。");
      return bitwardenSendUploads.write(request.transferId, request.offset, base64ToBytes(request.dataBase64));
    },
    "BITWARDEN_SEND_FILE_UPLOAD_FINISH": async (request, sender) => {
      assertManagerPage(sender);
      const metadata = bitwardenSendUploadInputs.get(request.transferId);
      if (!metadata || metadata.providerId !== request.providerId) throw new ProviderAttachmentError("attachment-upload-not-found", "Send 文件上传已过期或 Service Worker 已重启，请重新选择文件。");
      const account = await requireBitwardenAccountRecord(request.providerId);
      try {
        const completed = await bitwardenSendUploads.complete(request.transferId);
        const result = await bitwardenSends.createFile(readBitwardenSession(account), account.id, { ...metadata.input, bytes: completed.bytes });
        await persistBitwardenSession(account, result.session);
        return result.send;
      } finally {
        bitwardenSendUploads.release(request.transferId);
        bitwardenSendUploadInputs.delete(request.transferId);
      }
    },
    "BITWARDEN_SEND_FILE_UPLOAD_ABORT": async (request, sender) => {
      assertManagerPage(sender);
      const metadata = bitwardenSendUploadInputs.get(request.transferId);
      if (metadata && metadata.providerId !== request.providerId) throw new ProviderAttachmentError("attachment-upload-not-found", "Send 文件上传不属于所选密码源。");
      bitwardenSendUploadInputs.delete(request.transferId);
      return bitwardenSendUploads.abort(request.transferId);
    }
  };

  return { handlers, clear: clearBitwardenSendUploads };
}
