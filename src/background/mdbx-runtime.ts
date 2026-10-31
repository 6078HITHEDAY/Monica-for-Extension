import { type ProviderAccount } from "../core/model";
import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from "../providers/mdbx2/native-client";
import { Mdbx2BackendRouter } from '../providers/mdbx2/backend-router';
import { createBrowserMdbx2Runtime } from '../providers/mdbx2/browser/runtime';
import { Mdbx2LocalFileExports } from "../providers/mdbx2/local-file-export";
import { Mdbx2RestoreCoordinator } from '../providers/mdbx2/mdbx2-restore';
import { Mdbx2RestoreBatchCoordinator } from '../providers/mdbx2/mdbx2-restore-batch';
import { MDBX2_MAX_BINARY_CHUNK_BYTES, type Mdbx2SyncStateStatus } from "../providers/mdbx2/native-contract";
import { chromeMdbxImportStore } from "../providers/mdbx2/mdbx-import-coordinator";
import { Mdbx2Provider } from "../providers/mdbx2/mdbx2-provider";
import { Mdbx2SyncCoordinator, type Mdbx2CloudSyncDraft, type Mdbx2CloudSyncInput, type Mdbx2RemoteClientFactory, type Mdbx2RemoteSyncConfig, type Mdbx2WebDavSyncConfig } from "../providers/mdbx2/mdbx2-sync-coordinator";
import { Mdbx2WebDavClient } from "../providers/mdbx2/mdbx2-webdav-client";
import { normalizeMdbx2RemotePath } from "../providers/mdbx2/mdbx2-sync-paths";
import { parseOneDriveConnection } from "../providers/onedrive/onedrive-token-manager";
import { normalizeServerUrl } from "../providers/webdav/webdav-client";
import type { Mdbx2ManagerSyncStatus, Mdbx2WebDavSettingsInput } from "../runtime/messages";
import type { KeePassRuntime } from './keepass-runtime';
interface Dependencies {
    oneDriveSessions: Pick<KeePassRuntime["oneDriveSessions"], "mdbx2OneDriveClient">;
    service: import("../security/secure-vault-service").SecureVaultService;
}
export function createMdbxRuntime(deps: Dependencies) {
    const mdbx2NativeClient = new Mdbx2BackendRouter(createChromeMdbx2NativeRuntime(), createBrowserMdbx2Runtime(), undefined, (handle, role) => deps.service.cachedMdbx2HandleBackend(handle, role));
    const mdbx2Restores = new Mdbx2RestoreCoordinator(mdbx2NativeClient, deps.service);
    const mdbx2RestoreBatches = new Mdbx2RestoreBatchCoordinator(mdbx2NativeClient, deps.service);
    const mdbx2LocalFileExports = new Mdbx2LocalFileExports(mdbx2NativeClient, async (providerId) => {
        const state = await deps.service.readState(false);
        const account = state.providers.find(provider => provider.id === providerId);
        if (!account || account.kind !== "mdbx2" || !account.enabled || typeof account.config.vaultHandle !== "string" || !account.config.vaultHandle)
            throw new Error("MDBX2 密码源不存在或尚未连接。");
        if (state.mutationQueue.some(mutation => mutation.providerId === providerId) || state.providerConflicts.some(conflict => conflict.providerId === providerId))
            throw new Error("请先同步所有待写入修改并处理冲突，再导出 MDBX 数据库。");
        return { vaultHandle: account.config.vaultHandle, fileName: `${(account.name || "Monica").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100)}.mdbx` };
    });
    const windowsHelloNativeClient = new Mdbx2NativeClient(createChromeMdbx2NativeRuntime(), undefined, "com.monica_pass.windows_hello", "Monica Windows Hello");
    const mdbx2ImportStore = chromeMdbxImportStore();
    const mdbx2RemoteFactory: Mdbx2RemoteClientFactory = input => {
        if (input.transport === "onedrive")
            return deps.oneDriveSessions.mdbx2OneDriveClient(input);
        return new Mdbx2WebDavClient({ baseUrl: normalizeServerUrl(input.baseUrl), username: input.username, password: input.password });
    };
    const mdbx2SyncCoordinator = new Mdbx2SyncCoordinator(mdbx2NativeClient, undefined, mdbx2RemoteFactory);
    const mdbx2Provider = new Mdbx2Provider(mdbx2NativeClient, mdbx2SyncCoordinator);
    const MDBX2_MAX_BASE64_CHUNK_LENGTH = Math.ceil(MDBX2_MAX_BINARY_CHUNK_BYTES / 3) * 4;
    function effectiveMdbx2WebDavSettings(config: Mdbx2WebDavSettingsInput, previous: Record<string, unknown> = {}): Mdbx2WebDavSyncConfig {
        return {
            baseUrl: normalizeServerUrl(config.baseUrl),
            username: config.username.trim(),
            password: config.password || (typeof previous.webDavPassword === "string" ? previous.webDavPassword : ""),
            remotePath: normalizeMdbx2RemotePath(config.remotePath),
            syncStateHandle: typeof previous.syncStateHandle === "string" ? previous.syncStateHandle : undefined
        };
    }
    async function requireMdbx2Account(providerId: string): Promise<ProviderAccount> {
        const account = await deps.service.getProvider(providerId);
        if (!account || account.kind !== "mdbx2")
            throw new Error("MDBX2 密码源不存在。");
        return account;
    }
    function mdbx2ExportOwner(sender: chrome.runtime.MessageSender): string {
        if (!sender.documentId)
            throw new Error("此浏览器页面缺少安全下载会话标识，请重新打开拓展页面。");
        return sender.documentId;
    }
    function mdbx2RemoteSyncConfig(account: ProviderAccount): Mdbx2RemoteSyncConfig {
        const remotePath = stringAccountConfig(account, "remotePath");
        if (!remotePath)
            throw new Error("MDBX2 远端文件位置未配置。");
        const syncStateHandle = stringAccountConfig(account, "syncStateHandle") || undefined;
        if (account.config.syncTransport === "onedrive") {
            const driveId = stringAccountConfig(account, "oneDriveDriveId");
            if (!driveId)
                throw new Error("MDBX2 OneDrive 云盘未配置。");
            if (!parseOneDriveConnection(account.config.oneDriveConnection))
                throw new Error("MDBX2 OneDrive 登录已失效，请重新连接。");
            return { transport: "onedrive", driveId, remotePath, syncStateHandle, providerId: account.id };
        }
        const baseUrl = stringAccountConfig(account, "webDavBaseUrl");
        if (!baseUrl)
            throw new Error("MDBX2 WebDAV 地址未配置。");
        return {
            baseUrl,
            username: stringAccountConfig(account, "webDavUsername"),
            password: stringAccountConfig(account, "webDavPassword"),
            remotePath,
            syncStateHandle
        };
    }
    function mdbx2CloudSyncInput(account: ProviderAccount, requireState: true): Mdbx2CloudSyncInput;
    function mdbx2CloudSyncInput(account: ProviderAccount, requireState: false): Mdbx2CloudSyncDraft;
    function mdbx2CloudSyncInput(account: ProviderAccount, requireState: boolean): Mdbx2CloudSyncInput | Mdbx2CloudSyncDraft {
        const config = mdbx2RemoteSyncConfig(account);
        const vaultHandle = stringAccountConfig(account, "vaultHandle");
        if (!vaultHandle)
            throw new Error("MDBX2 密码源缺少本机工作副本。");
        if (requireState && !config.syncStateHandle)
            throw new Error("MDBX2 云同步尚未完成 bootstrap 注册。");
        return { ...config, vaultHandle, syncStateHandle: config.syncStateHandle };
    }
    function managerSyncStatus(status: Mdbx2SyncStateStatus | undefined, configured: boolean, registered: boolean): Mdbx2ManagerSyncStatus {
        return {
            configured,
            registered,
            initialized: status?.initialized || false,
            hasLocalChanges: status?.hasLocalChanges || false,
            pendingBootstrap: status?.pendingBootstrap || false,
            pendingSegment: status?.pendingSegment || false,
            pendingRemoteAcknowledgement: status?.pendingRemoteAcknowledgement || false,
            remoteStreamCount: status?.remoteStreamCount || 0,
            blockedStreamCount: status?.blockedStreamCount || 0,
            blobTransferCount: status?.blobTransferCount || 0,
            verifiedRemoteBlobCount: status?.verifiedRemoteBlobCount || 0
        };
    }
    function stringAccountConfig(account: ProviderAccount, key: string): string {
        return typeof account.config[key] === "string" ? account.config[key] as string : "";
    }
    async function requireMdbx2VaultHandle(providerId: string): Promise<string> {
        const account = await deps.service.getProvider(providerId);
        const vaultHandle = account?.kind === "mdbx2" && typeof account.config.vaultHandle === "string"
            ? account.config.vaultHandle
            : "";
        if (!vaultHandle)
            throw new Error("MDBX2 密码源不存在或缺少本机工作副本。");
        return vaultHandle;
    }
    return { MDBX2_MAX_BASE64_CHUNK_LENGTH, effectiveMdbx2WebDavSettings, managerSyncStatus, mdbx2CloudSyncInput, mdbx2ExportOwner, mdbx2ImportStore, mdbx2LocalFileExports, mdbx2NativeClient, mdbx2Provider, mdbx2RemoteSyncConfig, mdbx2RestoreBatches, mdbx2Restores, mdbx2SyncCoordinator, requireMdbx2Account, requireMdbx2VaultHandle, stringAccountConfig, windowsHelloNativeClient };
}
export type MdbxRuntime = ReturnType<typeof createMdbxRuntime>;
