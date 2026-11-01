import { createAttachmentRuntime } from './attachment-runtime';
import { createBitwardenSendRuntime } from './bitwarden-send-runtime';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { ProviderAttachmentError } from "../providers/attachments/attachment-contract";
import { BitwardenFolderError } from "../providers/bitwarden/bitwarden-folders";
import { BitwardenCollectionError } from "../providers/bitwarden/bitwarden-collections";
import { BitwardenSendError } from "../providers/bitwarden/bitwarden-sends";
import { isBrowserMdbxControlMessage } from '../providers/mdbx2/browser/runtime';
import { PasswordProjectRestoreNotStagedError } from './password-project-restore';
import { PasswordProjectRemovalNotStagedError } from './password-project-removal';
import { Mdbx2NativeHostError } from "../providers/mdbx2/native-contract";
import { recoverMdbxImports } from "../providers/mdbx2/mdbx-import-coordinator";
import { CLIPBOARD_ALARM, CLIPBOARD_CLEAR_MESSAGE, CLIPBOARD_PREFERENCES_KEY } from '../security/clipboard-lifecycle';
import { KeePassGroupError } from "../providers/keepass/keepass-groups";
import { KeePassHistoryError } from "../providers/keepass/keepass-history";
import { KeePassRemoteSessionError } from "../providers/keepass/keepass-remote-session";
import { KeePassWebDavError } from "../providers/keepass/keepass-webdav-client";
import { KeePassWorkingCopyStoreError } from "../providers/keepass/keepass-working-copy-store";
import { ProviderTransportError } from "../providers/provider-transport";
import type { ExtensionRequest, ExtensionResponse } from "../runtime/messages";
import { VaultHelloRequiredError, VaultLockedError } from "../security/secure-vault-service";
import { configureSessionStorageAccess } from "./startup";
import { AUTO_SYNC_PREFERENCES_KEY } from "../providers/sync-preferences";
import type { CommandEffects } from './command-effects';
import type { CredentialRuntime } from './credential-runtime';
import type { KeePassRuntime } from './keepass-runtime';
import type { PasskeyRuntime } from './passkey-runtime';
import type { TransferRuntime } from './transfer-runtime';
import type { MdbxRuntime } from './mdbx-runtime';
import type { PasskeyJournal } from './passkey-journal';
import { PasskeyUnavailableError } from './passkey-errors';
import { PasskeyExcludedError } from './passkey-errors';
import { PasskeyCancelledError } from './passkey-errors';
import { PasskeyCommitUnknownError } from './passkey-errors';
interface Dependencies {
    AUTO_LOCK_ALARM: "monica-vault-auto-lock";
    AUTO_SYNC_ALARM: "monica-provider-auto-sync";
    afterRuntimeRequest: CommandEffects["afterRuntimeRequest"];
    attachmentRuntime: Pick<ReturnType<typeof createAttachmentRuntime>, "clear">;
    bitwardenSendRuntime: Pick<ReturnType<typeof createBitwardenSendRuntime>, "clear">;
    clearCredentialCaptures: CredentialRuntime["clearCredentialCaptures"];
    clearKeePassPendingPersistence: KeePassRuntime["clearKeePassPendingPersistence"];
    clearPendingPasskeyRequests: PasskeyRuntime["clearPendingPasskeyRequests"];
    clearPendingUsernameContexts: CredentialRuntime["clearPendingUsernameContexts"];
    clearTransferSessions: TransferRuntime["clearTransferSessions"];
    clearTransferStatuses: TransferRuntime["clearTransferStatuses"];
    clipboardLifecycle: Pick<import("./clipboard").ClipboardLifecycle, "cancel" | "expire">;
    dismissInlineMenus: CommandEffects["dismissInlineMenus"];
    handleRequest: (request: import("../runtime/messages").ExtensionRequest, sender: chrome.runtime.MessageSender) => Promise<unknown>;
    keePassProvider: Pick<KeePassRuntime["keePassProvider"], "lock">;
    keePassRecoveryDownloads: Pick<KeePassRuntime["keePassRecoveryDownloads"], "clear">;
    mdbx2ImportStore: MdbxRuntime["mdbx2ImportStore"];
    mdbx2LocalFileExports: Pick<MdbxRuntime["mdbx2LocalFileExports"], "clear">;
    mdbx2NativeClient: MdbxRuntime["mdbx2NativeClient"];
    mdbx2Provider: Pick<MdbxRuntime["mdbx2Provider"], "lock">;
    nearbyOwner: Pick<import("./nearby-owner").NearbyManagerOwner, "attach" | "close" | "sessionChanged">;
    oneDriveSessions: Pick<KeePassRuntime["oneDriveSessions"], "clear">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "abortAll" | "reconcile" | "stop">;
    purgeExpiredPasskeySessionState: PasskeyJournal["purgeExpiredPasskeySessionState"];
    service: import("../security/secure-vault-service").SecureVaultService;
}
export function installBackgroundEvents(deps: Dependencies) {
    chrome.runtime.onConnect.addListener(port => deps.nearbyOwner.attach(port));
    chrome.runtime.onSuspend.addListener(() => deps.nearbyOwner.close('background-suspended'));
    void configureSessionStorageAccess(chrome.storage.session.setAccessLevel?.bind(chrome.storage.session));
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[CLIPBOARD_PREFERENCES_KEY])
            void deps.clipboardLifecycle.cancel().catch(() => undefined);
        const change = changes["monica.secureVault.session.v1"];
        const previous = change?.oldValue as {
            id?: unknown;
            rawKey?: unknown;
        } | undefined;
        const next = change?.newValue as {
            id?: string;
            rawKey?: unknown;
            expiresAt: number;
        } | undefined;
        if (area === "session" && change && (!next || previous?.rawKey !== next.rawKey || previous?.id !== next.id)) {
            deps.nearbyOwner.close('session-changed');
            deps.service.clearDecryptedState();
            deps.keePassRecoveryDownloads.clear();
            deps.oneDriveSessions.clear();
            void deps.dismissInlineMenus();
            if (!next?.rawKey) {
                deps.providerSync.stop();
                void deps.clipboardLifecycle.expire(true).catch(() => undefined);
            }
            else
                void deps.providerSync.reconcile().catch(() => undefined);
        }
        if (area === "local" && changes[AUTO_SYNC_PREFERENCES_KEY]) {
            deps.providerSync.stop();
            void deps.providerSync.reconcile().catch(() => undefined);
        }
        if (area === 'session' && change)
            deps.nearbyOwner.sessionChanged(next ? { id: next.id, expiresAt: next.expiresAt } : null);
    });
    chrome.runtime.onInstalled.addListener(() => {
        void chrome.alarms.create(deps.AUTO_LOCK_ALARM, { periodInMinutes: 1 });
        void chrome.alarms.create(deps.AUTO_SYNC_ALARM, { periodInMinutes: 1 });
        void deps.purgeExpiredPasskeySessionState().catch(() => undefined);
    });
    chrome.runtime.onStartup.addListener(() => {
        void chrome.alarms.create(deps.AUTO_LOCK_ALARM, { periodInMinutes: 1 });
        void chrome.alarms.create(deps.AUTO_SYNC_ALARM, { periodInMinutes: 1 });
        void deps.purgeExpiredPasskeySessionState().catch(() => undefined);
        void recoverMdbxImports(deps.mdbx2ImportStore, deps.mdbx2NativeClient, deps.service).catch(() => undefined);
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === CLIPBOARD_ALARM)
            void deps.clipboardLifecycle.expire().catch(() => undefined);
        if (alarm.name === deps.AUTO_SYNC_ALARM)
            void deps.providerSync.reconcile().catch(() => undefined);
        if (alarm.name === deps.AUTO_LOCK_ALARM) {
            void deps.purgeExpiredPasskeySessionState().catch(() => undefined);
            void deps.service.status().then((status) => {
                if (status !== 'unlocked')
                    deps.nearbyOwner.close('vault-locked');
                if (status !== "unlocked")
                    deps.clearCredentialCaptures();
                if (status !== "unlocked")
                    void deps.clearPendingUsernameContexts();
                if (status !== "unlocked")
                    void deps.clearPendingPasskeyRequests(true);
                if (status !== "unlocked")
                    deps.providerSync.abortAll();
                if (status !== "unlocked")
                    void deps.mdbx2LocalFileExports.clear();
                if (status !== "unlocked")
                    deps.mdbx2NativeClient.close();
                if (status !== "unlocked")
                    deps.mdbx2Provider.lock();
                if (status !== "unlocked")
                    deps.keePassProvider.lock();
                if (status !== "unlocked")
                    deps.clearKeePassPendingPersistence();
                if (status !== "unlocked")
                    deps.attachmentRuntime.clear();
                if (status !== "unlocked")
                    deps.bitwardenSendRuntime.clear();
                if (status !== "unlocked") {
                    deps.clearTransferStatuses();
                    deps.clearTransferSessions();
                }
            });
        }
    });
    chrome.runtime.onMessage.addListener((message: ExtensionRequest, sender, sendResponse: (response: ExtensionResponse) => void) => {
        if (isBrowserMdbxControlMessage(message))
            return false;
        if ((message as {
            type?: string;
        })?.type === CLIPBOARD_CLEAR_MESSAGE)
            return false;
        deps.handleRequest(message, sender)
            .then((data) => {
            if (["VAULT_BATCH_MUTATE", "VAULT_DELETE_ITEM", "VAULT_DELETE_PASSWORD_GROUP", "VAULT_CONSUME_HOTP", "VAULT_UNARCHIVE_ITEM", "VAULT_DELETE_PASSWORD_HISTORY", "VAULT_UPSERT_ITEM", "VAULT_SAVE_PASSWORD_GROUP", "VAULT_SET_PASSWORD_COVER", "VAULT_SET_PASSWORD_STACK", "VAULT_PASSWORD_PROJECT_REMOVE", "VAULT_PASSWORD_PROJECT_REMOVAL_RESUME", "VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL", "VAULT_KEEPASS_PROJECT_REMOVE", "VAULT_KEEPASS_PROJECT_REMOVAL_RESUME", "VAULT_KEEPASS_PROJECT_REMOVAL_CANCEL", "VAULT_PASSWORD_PROJECT_RESTORE", "VAULT_PASSWORD_PROJECT_RESTORE_RESUME", "VAULT_SET_LOCKED_AUTOFILL", "VAULT_RESTORE_ENCRYPTED", "AUTOFILL_SITE_POLICY_SET", "AUTOFILL_FIELD_POLICY_SET_CURRENT", "AUTOFILL_FIELD_POLICY_REMOVE"].includes(message.type))
                void deps.dismissInlineMenus();
            sendResponse({ ok: true, data });
            void deps.afterRuntimeRequest(message, data).catch(() => undefined);
        })
            .catch((error: unknown) => {
            const code = error instanceof PasswordProjectRemovalNotStagedError || error instanceof PasswordProjectRestoreNotStagedError ? error.code : error instanceof VaultLockedError
                ? "VAULT_LOCKED"
                : error instanceof VaultHelloRequiredError
                    ? "VAULT_HELLO_REQUIRED"
                    : error instanceof PasskeyUnavailableError
                        ? "PASSKEY_UNAVAILABLE"
                        : error instanceof PasskeyExcludedError
                            ? "PASSKEY_EXCLUDED"
                            : error instanceof PasskeyCancelledError
                                ? "PASSKEY_CANCELLED"
                                : error instanceof PasskeyCommitUnknownError
                                    ? "PASSKEY_COMMIT_UNKNOWN"
                                    : error instanceof Mdbx2NativeHostError || error instanceof ProviderAttachmentError || error instanceof BitwardenFolderError || error instanceof BitwardenCollectionError || error instanceof BitwardenSendError || error instanceof KeePassGroupError || error instanceof KeePassHistoryError || error instanceof KeePassRemoteSessionError || error instanceof KeePassWebDavError || error instanceof KeePassWorkingCopyStoreError || error instanceof ProviderTransportError
                                        ? error.code
                                        : undefined;
            sendResponse({ ok: false, error: error instanceof Error ? error.message : "未知后台错误", code });
        });
        return true;
    });
    // Alarms survive worker suspension and work with the manifest's Chrome 109 floor.
    // WebSocket heartbeats additionally keep notification delivery live on Chrome 116+.
    void chrome.alarms.create(deps.AUTO_SYNC_ALARM, { periodInMinutes: 1 });
    void deps.providerSync.reconcile().catch(() => undefined);
}
