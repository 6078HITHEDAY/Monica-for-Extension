import { createProviderSyncRuntime } from './provider-sync-runtime';
import type { ExtensionRequest } from "../runtime/messages";
import type { LiveViews } from './live-views';
interface Dependencies {
    bitwardenProvider: Pick<import("../providers/bitwarden/bitwarden-provider").BitwardenProvider, "lockAccount">;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "pause" | "reconcile" | "request" | "wake">;
    publishVaultChanged: LiveViews["publishVaultChanged"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "readState" | "recordUserActivity">;
}
export function createCommandEffects(deps: Dependencies) {
    async function dismissInlineMenus(): Promise<void> {
        try {
            const tabs = await chrome.tabs.query({});
            await Promise.allSettled(tabs.filter(tab => tab.id !== undefined).map(tab => chrome.tabs.sendMessage(tab.id!, { type: "MONICA_INLINE_INVALIDATE" })));
        }
        catch { /* A closed or restricted tab has no menu to dismiss. */ }
    }
    async function afterRuntimeRequest(request: ExtensionRequest, data?: unknown): Promise<void> {
        const type = request.type;
        if (type === 'VAULT_KEEPASS_PROJECT_RESOLVE' || type === 'VAULT_KEEPASS_PROJECT_RESOLUTION_RESUME') {
            const result = data as import('./keepass-project-resolution').KeePassProjectResolutionStatus | undefined;
            if (result?.localAdoptionCompleted) {
                deps.publishVaultChanged();
                await deps.providerSync.reconcile();
                deps.providerSync.request(result.providerId, { type: 'full' }, 700);
            }
        }
        if (["VAULT_FILL_LOGIN", "VAULT_FILL_WALLET", "AUTOFILL_INLINE_FILL", "PASSKEY_ACCEPT", "CREDENTIAL_ACCEPT"].includes(type))
            void deps.service.recordUserActivity().catch(() => undefined);
        const itemMutation = ["VAULT_BATCH_MUTATE", "VAULT_CONSUME_HOTP", "VAULT_UNARCHIVE_ITEM", "VAULT_DELETE_PASSWORD_HISTORY", "VAULT_UPSERT_ITEM", "VAULT_SAVE_PASSWORD_GROUP", "VAULT_SET_PASSWORD_COVER", "VAULT_SET_PASSWORD_STACK", "VAULT_PASSWORD_PROJECT_REMOVE", "VAULT_PASSWORD_PROJECT_REMOVAL_RESUME", "VAULT_PASSWORD_PROJECT_REMOVAL_CANCEL", "VAULT_KEEPASS_PROJECT_REMOVE", "VAULT_KEEPASS_PROJECT_REMOVAL_RESUME", "VAULT_KEEPASS_PROJECT_REMOVAL_CANCEL", "VAULT_PASSWORD_PROJECT_RESTORE", "VAULT_PASSWORD_PROJECT_RESTORE_RESUME", "VAULT_DELETE_ITEM", "VAULT_DELETE_PASSWORD_GROUP", "VAULT_RESTORE_ITEM", "VAULT_IMPORT_ITEMS", "PROVIDER_CONFLICT_RESOLVE", "CREDENTIAL_ACCEPT", "PASSKEY_ACCEPT"].includes(type);
        const providerMutation = ["BITWARDEN_CIPHER_MOVE_FOLDER", "BITWARDEN_CIPHER_MOVE_COLLECTIONS", "PROVIDER_ATTACHMENT_UPLOAD_FINISH", "PROVIDER_ATTACHMENT_DELETE"].includes(type)
            || /^(?:BITWARDEN_(?:FOLDER|CIPHER)_|KEEPASS_(?:GROUP|HISTORY)_|MDBX2_(?:OBJECT|COLLECTION|HISTORY|CONFLICT|SNAPSHOT)_)/.test(type)
                && /(?:CREATE|RENAME|MOVE|DELETE|RESTORE|UPSERT|REVERT|RESOLVE)$/.test(type);
        const connectionChange = ["BITWARDEN_LOGIN", "BITWARDEN_LOGOUT", "WEBDAV_SAVE", "PROVIDER_REMOVE", "MDBX2_VAULT_OPEN", "MDBX2_IMPORT_COMMIT", "MDBX2_WEBDAV_SAVE", "MDBX2_ONEDRIVE_SAVE", "MDBX2_BOOTSTRAP_PUBLISH", "MDBX2_BOOTSTRAP_REGISTER", "KEEPASS_WEBDAV_OPEN", "KEEPASS_ONEDRIVE_OPEN", "KEEPASS_OPEN", "KEEPASS_REMOTE_RESTORE"].includes(type);
        const unlocked = ["VAULT_SETUP", "VAULT_UNLOCK", "VAULT_UNLOCK_HELLO", "VAULT_RESTORE_ENCRYPTED", "MDBX2_IMPORT_COMMIT"].includes(type);
        if (type === "KEEPASS_LOCK" || type === "MDBX2_VAULT_LOCK") {
            deps.publishVaultChanged();
            return;
        }
        if (!(itemMutation || providerMutation || connectionChange || unlocked || type === "PROVIDER_SYNC" || type === "MDBX2_BATCH_TRANSFER_EXECUTE"))
            return;
        deps.publishVaultChanged();
        const connectionResult = data as {
            providerId?: string;
            account?: {
                id?: string;
            };
        } | undefined;
        const connectedId = "providerId" in request && request.providerId || connectionResult?.providerId || connectionResult?.account?.id;
        if (connectionChange && connectedId) {
            deps.bitwardenProvider.lockAccount(connectedId);
            await deps.providerSync.pause([connectedId], false);
        }
        await deps.providerSync.reconcile();
        if (unlocked)
            deps.providerSync.wake();
        if (itemMutation || type === "MDBX2_BATCH_TRANSFER_EXECUTE") {
            const state = await deps.service.readState(false);
            for (const id of new Set(state.mutationQueue.filter(mutation => !mutation.lastError).map(mutation => mutation.providerId)))
                deps.providerSync.request(id, { type: "full" }, 700);
        }
        if (providerMutation && "providerId" in request && request.providerId) {
            deps.bitwardenProvider.lockAccount(request.providerId);
            deps.providerSync.request(request.providerId, { type: "full" }, 700);
        }
        if (type === 'VAULT_KEEPASS_PROJECT_REMOVE' || type === 'VAULT_KEEPASS_PROJECT_REMOVAL_RESUME') {
            const result = data as import('./keepass-project-removal').KeePassProjectRemovalStatus | undefined;
            if (result?.localAdoptionCompleted && result.providerId)
                deps.providerSync.request(result.providerId, { type: 'full' }, 700);
        }
    }
    return { afterRuntimeRequest, dismissInlineMenus };
}
export type CommandEffects = ReturnType<typeof createCommandEffects>;
