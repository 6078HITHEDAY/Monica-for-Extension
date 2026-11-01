import { createProviderSyncRuntime } from './provider-sync-runtime';
import { type ProviderAccount, type VaultItem } from "../core/model";
import { KeePassProjectRemovalWorkflow } from './keepass-project-removal';
import { KeePassProjectResolutionWorkflow } from './keepass-project-resolution';
import { KeePassRecoveryDownloads } from './keepass-recovery-download';
import { IndexedDbKeePassConflictRecoveryStorage } from '../providers/keepass/keepass-conflict-recovery-store';
import { sameProviderBinding, type ProviderSyncResult } from "../core/provider";
import { KeePassProvider, type KeePassSessionSummary } from "../providers/keepass/keepass-provider";
import { KeePassDurableSyncCoordinator } from "../providers/keepass/keepass-durable-sync";
import { KeePassGroupError, type KeePassGroupMutationResult } from "../providers/keepass/keepass-groups";
import { KeePassHistoryError, type KeePassHistoryRestoreResult } from "../providers/keepass/keepass-history";
import { keePassMutationIntentSha256, KeePassRemoteSessionError, KeePassRemoteSessionService, type KeePassRemoteFailureInfo } from "../providers/keepass/keepass-remote-session";
import { isRemoteKeePassSource, hasLocalKeePassWorkingCopy } from "../providers/keepass/keepass-source";
import { KeePassLocalWorkingCopyService } from '../providers/keepass/keepass-local-working-copy';
import { OneDriveSessionService } from "../providers/onedrive/onedrive-session";
import { OneDriveKeePassConnections } from "./onedrive-keepass-connection";
import { IndexedDbKeePassWorkingCopyStorage, type KeePassDurableMutationKind, type KeePassDurableMutationReceipt, type KeePassDurableMutationResult } from "../providers/keepass/keepass-working-copy-store";
import type { LiveViews } from './live-views';
interface Dependencies {
    providerOperations: import("./provider-operation-queue").ProviderOperationQueue;
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "paused">;
    publishVaultChanged: LiveViews["publishVaultChanged"];
    service: import("../security/secure-vault-service").SecureVaultService;
}
export function createKeePassRuntime(deps: Dependencies) {
    const keePassProvider = new KeePassProvider();
    const keePassWorkingCopies = new IndexedDbKeePassWorkingCopyStorage();
    const oneDriveSessions = new OneDriveSessionService({
        sessionId: () => deps.service.passkeySessionId(),
        getProvider: id => deps.service.getProvider(id),
        rotateOneDriveTokens: (...args) => deps.service.rotateOneDriveTokens(...args)
    });
    const keePassRemoteSessions = new KeePassRemoteSessionService(keePassProvider, keePassWorkingCopies, undefined, (account, identity) => oneDriveSessions.fileClient(account, identity));
    const keePassLocalCopies = new KeePassLocalWorkingCopyService(keePassProvider, keePassWorkingCopies);
    const keePassPersistenceFor = (account: ProviderAccount) => hasLocalKeePassWorkingCopy(account.config) ? keePassLocalCopies : keePassRemoteSessions;
    const keePassProjectRemovals = new KeePassProjectRemovalWorkflow(deps.service, {
        reconcileAccountConfig: account => keePassPersistenceFor(account).reconcileAccountConfig(account),
        readDurableReceipt: (account, ...args) => keePassPersistenceFor(account).readDurableReceipt(account, ...args),
        persistProjectRemoval: (account, input) => keePassPersistenceFor(account).persistProjectRemoval(account, input)
    }, deps.providerOperations, () => deps.publishVaultChanged(), {
        runMutationExclusive: runKeePassMutationExclusive,
        beforeCapture: async (account) => {
            await ensureKeePassSession(account, true);
            await flushKeePassPendingMutations(account);
            const persisted = await keePassPersistenceFor(account).persistWorkingCopy(account);
            if (persisted)
                await applyKeePassRemoteAccountConfig(account, persisted.accountConfig);
        },
        invalidateSession: async (providerId) => {
            const account = await deps.service.getProvider(providerId);
            if (account && hasLocalKeePassWorkingCopy(account.config) && keePassProvider.isUnlocked(providerId))
                await keePassLocalCopies.reload(account);
            else
                keePassProvider.lockAccount(providerId);
            clearKeePassPendingPersistence(providerId);
        }
    });
    const keePassProjectResolutions = new KeePassProjectResolutionWorkflow(deps.service, keePassRemoteSessions, keePassWorkingCopies, new IndexedDbKeePassConflictRecoveryStorage(), deps.providerOperations, {
        runMutationExclusive: runKeePassMutationExclusive,
        beforeCapture: async (account) => {
            await keePassProjectRemovals.assertProviderReady(account.id);
            await ensureKeePassSession(account, true);
            await flushKeePassPendingMutations(account);
            const persisted = await keePassRemoteSessions.persistWorkingCopy(account);
            if (persisted)
                await applyKeePassRemoteAccountConfig(account, persisted.accountConfig);
        },
        beforeResolve: async (account) => {
            await keePassProjectRemovals.assertProviderReady(account.id);
            await ensureKeePassSession(account, true);
            await flushKeePassPendingMutations(account);
        },
        invalidateSession: providerId => keePassProvider.lockAccount(providerId)
    }, () => deps.publishVaultChanged());
    const keePassRecoveryDownloads = new KeePassRecoveryDownloads(providerId => keePassProjectRemovals.sourceToken(providerId));
    const oneDriveConnections = new OneDriveKeePassConnections(deps.service, keePassProvider, keePassRemoteSessions, keePassWorkingCopies, oneDriveSessions, flushKeePassPendingMutations);
    const keePassDurableSync = new KeePassDurableSyncCoordinator(keePassProvider, {
        publishWorkingCopy: (account, signal) => keePassPersistenceFor(account).publishWorkingCopy(account, signal),
        persistWorkingCopy: (account, receipt) => keePassPersistenceFor(account).persistWorkingCopy(account, receipt),
        readAnyDurableReceipt: (account, operationId) => keePassPersistenceFor(account).readAnyDurableReceipt(account, operationId),
        deleteDurableReceipt: (account, operationId) => keePassPersistenceFor(account).deleteDurableReceipt(account, operationId)
    }, deps.service, (account, config) => applyKeePassRemoteAccountConfig(account, config));
    const keePassMutationQueues = new Map<string, Promise<void>>();
    const keePassPendingPersistence = new Map<string, {
        providerId: string;
        kind: KeePassDurableMutationKind;
        intentSha256: string;
        completedAt: string;
        result: unknown;
        durableResult: KeePassDurableMutationResult;
    }>();
    async function requireKeePassAccount(providerId: string): Promise<ProviderAccount> {
        const account = await requireKeePassAccountRecord(providerId);
        await ensureKeePassSession(account, true);
        return account;
    }
    async function executeKeePassDurableMutation<T>(input: {
        account: ProviderAccount;
        operationId: string;
        kind: KeePassDurableMutationKind;
        intent: unknown;
        replay: (result: KeePassDurableMutationResult) => T | Promise<T>;
        mutate: () => {
            result: T;
            durableResult: KeePassDurableMutationResult;
        } | Promise<{
            result: T;
            durableResult: KeePassDurableMutationResult;
        }>;
    }): Promise<T> {
        if (input.account.kind !== "keepass" || !(isRemoteKeePassSource(input.account.config.sourceMode) || hasLocalKeePassWorkingCopy(input.account.config))) {
            return (await input.mutate()).result;
        }
        return runKeePassMutationExclusive(input.account.id, async () => {
            await keePassProjectRemovals.assertProviderReady(input.account.id);
            await keePassProjectResolutions.assertProviderReady(input.account.id);
            const account = await reconcileKeePassRemoteAccount(input.account);
            const intentSha256 = await keePassMutationIntentSha256(input.intent);
            const durable = await keePassPersistenceFor(account).readDurableReceipt(account, input.operationId, input.kind, intentSha256);
            if (durable)
                return input.replay(durable.result);
            const key = `${account.id}\u0000${input.operationId}`;
            let pending = keePassPendingPersistence.get(key);
            if (pending && (pending.providerId !== account.id || pending.kind !== input.kind || pending.intentSha256 !== intentSha256)) {
                throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 操作标识已经用于其他持久操作。");
            }
            if (!pending) {
                const mutation = await input.mutate();
                if (keePassPendingPersistence.size >= 256)
                    keePassPendingPersistence.delete(keePassPendingPersistence.keys().next().value!);
                pending = {
                    providerId: account.id,
                    kind: input.kind,
                    intentSha256,
                    completedAt: new Date().toISOString(),
                    result: structuredClone(mutation.result),
                    durableResult: structuredClone(mutation.durableResult)
                };
                keePassPendingPersistence.set(key, pending);
            }
            const receipt: KeePassDurableMutationReceipt = {
                providerId: account.id,
                operationId: input.operationId,
                kind: input.kind,
                intentSha256,
                completedAt: pending.completedAt,
                result: pending.durableResult
            };
            const persisted = await keePassPersistenceFor(account).persistWorkingCopy(account, receipt);
            if (persisted)
                await applyKeePassRemoteAccountConfig(account, persisted.accountConfig);
            keePassPendingPersistence.delete(key);
            return structuredClone(pending.result) as T;
        });
    }
    async function runKeePassMutationExclusive<T>(providerId: string, task: () => Promise<T>, bitwardenMove = false): Promise<T> {
        const previous = keePassMutationQueues.get(providerId) || Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => { release = resolve; });
        const queued = previous.then(() => current);
        keePassMutationQueues.set(providerId, queued);
        await previous;
        try {
            if (!bitwardenMove)
                await deps.service.assertNoBitwardenKeePassMove(providerId);
            return await task();
        }
        finally {
            release();
            if (keePassMutationQueues.get(providerId) === queued)
                keePassMutationQueues.delete(providerId);
        }
    }
    async function flushKeePassPendingMutations(account: ProviderAccount): Promise<void> {
        for (const [key, pending] of keePassPendingPersistence) {
            if (pending.providerId !== account.id)
                continue;
            const operationId = key.slice(account.id.length + 1);
            const persisted = await keePassPersistenceFor(account).persistWorkingCopy(account, {
                providerId: account.id, operationId, kind: pending.kind, intentSha256: pending.intentSha256,
                completedAt: pending.completedAt, result: pending.durableResult
            });
            if (persisted)
                await applyKeePassRemoteAccountConfig(account, persisted.accountConfig);
            keePassPendingPersistence.delete(key);
        }
    }
    function clearKeePassPendingPersistence(providerId?: string): void {
        if (!providerId) {
            keePassPendingPersistence.clear();
            keePassMutationQueues.clear();
            return;
        }
        for (const [key, pending] of keePassPendingPersistence)
            if (pending.providerId === providerId)
                keePassPendingPersistence.delete(key);
        keePassMutationQueues.delete(providerId);
    }
    function durableKeePassGroupResult(account: ProviderAccount, result: KeePassGroupMutationResult): KeePassDurableMutationResult {
        return {
            type: "group",
            changed: result.changed,
            groupUuid: keePassProvider.groupUuidForHandle(account.id, result.group.groupId)
        };
    }
    function replayKeePassGroupResult(account: ProviderAccount, result: KeePassDurableMutationResult): KeePassGroupMutationResult {
        if (result.type !== "group")
            throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久分组回执类型无效。");
        return keePassProvider.groupResultFromUuid(account, result.groupUuid, result.changed);
    }
    function durableKeePassHistoryResult(result: KeePassHistoryRestoreResult): KeePassDurableMutationResult {
        return { type: "history", changed: result.changed, historyCount: result.historyCount, modifiedAt: result.modifiedAt };
    }
    function replayKeePassHistoryResult(result: KeePassDurableMutationResult): KeePassHistoryRestoreResult {
        if (result.type !== "history" || result.changed !== true) {
            throw new KeePassRemoteSessionError("remote-operation-reused", "KeePass 持久历史回执类型无效。");
        }
        return { changed: true, historyCount: result.historyCount, modifiedAt: result.modifiedAt };
    }
    async function synchronizeKeePassProvider(account: ProviderAccount, signal: AbortSignal, checkOnly = false): Promise<ProviderSyncResult> {
        return runKeePassMutationExclusive(account.id, async () => {
            signal.throwIfAborted();
            await ensureKeePassSession(account, true);
            signal.throwIfAborted();
            if (isRemoteKeePassSource(account.config.sourceMode) || hasLocalKeePassWorkingCopy(account.config)) {
                return keePassDurableSync.synchronize(await reconcileKeePassRemoteAccount(account), signal, { checkOnly });
            }
            signal.throwIfAborted();
            const snapshot = (await deps.service.readState()).items;
            const result = await keePassProvider.sync(account, {
                signal,
                now: new Date().toISOString(),
                localItems: structuredClone(snapshot)
            });
            signal.throwIfAborted();
            await deps.service.applyProviderSync(account.id, result.items, result.accountPatch, result.conflicts, result.sourceRecords, snapshot, [], [], false, [], { expectedAccount: account });
            return result;
        });
    }
    async function requireKeePassAccountRecord(providerId: string): Promise<ProviderAccount> {
        const account = await deps.service.getProvider(providerId);
        if (!account || account.kind !== "keepass") {
            throw new KeePassGroupError("keepass-group-provider-not-found", "KeePass 密码源不存在。");
        }
        return account;
    }
    async function ensureKeePassSession(account: ProviderAccount, required: true): Promise<KeePassSessionSummary>;
    async function ensureKeePassSession(account: ProviderAccount, required: false): Promise<KeePassSessionSummary | undefined>;
    async function ensureKeePassSession(account: ProviderAccount, required: boolean): Promise<KeePassSessionSummary | undefined> {
        await keePassProjectResolutions.assertProviderReady(account.id);
        if ((await deps.providerSync.paused()).has(account.id)) {
            if (required)
                throw new KeePassRemoteSessionError("remote-working-copy-missing", "此 KeePass 数据库已锁定，请先重新解锁。");
            return undefined;
        }
        if (keePassProvider.isUnlocked(account.id)) {
            if (isRemoteKeePassSource(account.config.sourceMode))
                await reconcileKeePassRemoteAccount(account);
            return keePassProvider.summarize(account.id);
        }
        if (isRemoteKeePassSource(account.config.sourceMode)) {
            const restored = await keePassRemoteSessions.restore(account);
            try {
                const current = await deps.service.getProvider(account.id);
                if (!current || !sameProviderBinding(account, current) || (await deps.providerSync.paused()).has(account.id)) {
                    throw new KeePassRemoteSessionError("remote-working-copy-missing", "此 KeePass 数据库已锁定或配置已变化，请重新打开。");
                }
                await applyKeePassRemoteAccountConfig(account, restored.accountConfig);
                return restored.session;
            }
            catch (error) {
                keePassProvider.lockAccount(account.id);
                throw error;
            }
        }
        if (required)
            throw new KeePassRemoteSessionError("remote-working-copy-missing", "此 KeePass 本地文件会话尚未解锁，请重新选择 .kdbx 文件。");
        return undefined;
    }
    async function reconcileKeePassRemoteAccount(account: ProviderAccount): Promise<ProviderAccount> {
        if (account.kind !== "keepass" || !isRemoteKeePassSource(account.config.sourceMode))
            return account;
        return applyKeePassRemoteAccountConfig(account, await keePassRemoteSessions.reconcileAccountConfig(account));
    }
    async function applyKeePassRemoteAccountConfig(account: ProviderAccount, config: Record<string, unknown>): Promise<ProviderAccount> {
        if (sameKeePassAccountConfig(account.config, config))
            return account;
        const updated = { ...account, config };
        await deps.service.upsertProvider(updated, false, account);
        account.config = config;
        return updated;
    }
    function sameKeePassAccountConfig(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
        const normalize = (value: Record<string, unknown>) => JSON.stringify(Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)));
        return normalize(left) === normalize(right);
    }
    async function persistKeePassRemoteFailure(providerId: string, failure?: KeePassRemoteFailureInfo, message?: string): Promise<void> {
        const latest = await deps.service.getProvider(providerId);
        if (!latest || latest.kind !== "keepass" || !isRemoteKeePassSource(latest.config.sourceMode))
            return;
        if (!failure && !latest.config.remoteLastErrorCode && !latest.lastError)
            return;
        const config = { ...latest.config };
        delete config.remoteLastErrorCode;
        delete config.remoteLastErrorRetryable;
        delete config.remoteLastErrorAt;
        if (failure) {
            config.remoteLastErrorCode = failure.code;
            config.remoteLastErrorRetryable = failure.retryable;
            config.remoteLastErrorAt = new Date().toISOString();
        }
        await deps.service.upsertProvider({ ...latest, config, lastError: message }, false);
    }
    async function requireKeePassHistoryTarget(providerId: string, itemId: string): Promise<{
        account: ProviderAccount;
        item: VaultItem;
    }> {
        const [account, item] = await Promise.all([requireKeePassAccount(providerId), deps.service.getItem(itemId)]);
        if (!item || !item.providerRefs.some((reference) => reference.providerId === providerId)) {
            throw new KeePassHistoryError("keepass-history-target-not-found", "KeePass 历史项目不存在或不属于所选密码源。");
        }
        return { account, item };
    }
    async function waitForKeePassIdle(ids: string[]): Promise<void> { await Promise.allSettled(ids.map(id => keePassMutationQueues.get(id))); }
    return { applyKeePassRemoteAccountConfig, clearKeePassPendingPersistence, durableKeePassGroupResult, durableKeePassHistoryResult, ensureKeePassSession, executeKeePassDurableMutation, flushKeePassPendingMutations, keePassDurableSync, keePassLocalCopies, keePassPersistenceFor, keePassProjectRemovals, keePassProjectResolutions, keePassProvider, keePassRecoveryDownloads, keePassRemoteSessions, keePassWorkingCopies, oneDriveConnections, oneDriveSessions, persistKeePassRemoteFailure, replayKeePassGroupResult, replayKeePassHistoryResult, requireKeePassAccount, requireKeePassAccountRecord, requireKeePassHistoryTarget, runKeePassMutationExclusive, synchronizeKeePassProvider, waitForKeePassIdle };
}
export type KeePassRuntime = ReturnType<typeof createKeePassRuntime>;
