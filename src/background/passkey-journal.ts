import { normalizeCredentialId } from "../passkey/source-policy";
import { VaultLockedError } from "../security/secure-vault-service";
import type { PasskeyRuntime } from './passkey-runtime';
import { PendingPasskeyRequest } from './passkey-state-types';
import { PasskeyCompletionReceipt } from './passkey-state-types';
import { PASSKEY_PENDING_PREFIX } from './passkey-state-types';
import { PASSKEY_COMPLETION_PREFIX } from './passkey-state-types';
import { PASSKEY_COMPLETION_TTL_MS } from './passkey-state-types';
interface Dependencies {
    cancelPendingPasskeyRequest: PasskeyRuntime["cancelPendingPasskeyRequest"];
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "getItem">;
}
export function createPasskeyJournal(deps: Dependencies) {
    const pendingPasskeyRequests = new Map<string, PendingPasskeyRequest>();
    const passkeyCompletionReceipts = new Map<string, PasskeyCompletionReceipt>();
    function pendingPasskeyStorageKey(candidateId: string): string {
        return `${PASSKEY_PENDING_PREFIX}${candidateId}`;
    }
    function passkeyCompletionStorageKey(candidateId: string): string {
        return `${PASSKEY_COMPLETION_PREFIX}${candidateId}`;
    }
    async function persistPendingPasskeyRequest(pending: PendingPasskeyRequest): Promise<void> {
        pendingPasskeyRequests.set(pending.id, pending);
        await chrome.storage.session.set({ [pendingPasskeyStorageKey(pending.id)]: pending });
    }
    async function loadPendingPasskeyRequest(candidateId: string): Promise<PendingPasskeyRequest | undefined> {
        const cached = pendingPasskeyRequests.get(candidateId);
        if (cached) {
            if (cached.expiresAt <= Date.now()) {
                await deletePendingPasskeyRequest(candidateId);
                return undefined;
            }
            return cached;
        }
        const key = pendingPasskeyStorageKey(candidateId);
        const stored = (await chrome.storage.session.get(key))[key] as PendingPasskeyRequest | undefined;
        if (!stored || stored.id !== candidateId || stored.expiresAt <= Date.now()) {
            if (stored)
                await chrome.storage.session.remove(key);
            return undefined;
        }
        pendingPasskeyRequests.set(candidateId, stored);
        return stored;
    }
    async function deletePendingPasskeyRequest(candidateId: string): Promise<void> {
        pendingPasskeyRequests.delete(candidateId);
        await chrome.storage.session.remove(pendingPasskeyStorageKey(candidateId));
    }
    async function persistPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<void> {
        passkeyCompletionReceipts.set(receipt.id, receipt);
        await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: receipt });
    }
    async function refreshPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt, status = receipt.status): Promise<PasskeyCompletionReceipt> {
        const refreshed = { ...receipt, status, expiresAt: Date.now() + PASSKEY_COMPLETION_TTL_MS };
        passkeyCompletionReceipts.set(receipt.id, refreshed);
        try {
            await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: refreshed });
        }
        catch {
            // Keep the recoverable receipt in memory; a later query can retry persistence.
        }
        return refreshed;
    }
    async function resolveExpiredPasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<PasskeyCompletionReceipt | undefined> {
        if (receipt.status !== "prepared") {
            await deletePasskeyCompletionReceipt(receipt.id);
            return undefined;
        }
        const commitState = await passkeyReceiptCommitState(receipt);
        if (commitState === "not-committed") {
            await deletePasskeyCompletionReceipt(receipt.id);
            return undefined;
        }
        return refreshPasskeyCompletionReceipt(receipt, commitState === "committed" ? "committed" : "prepared");
    }
    async function loadPasskeyCompletionReceipt(candidateId: string): Promise<PasskeyCompletionReceipt | undefined> {
        const cached = passkeyCompletionReceipts.get(candidateId);
        if (cached) {
            if (cached.expiresAt <= Date.now())
                return resolveExpiredPasskeyCompletionReceipt(cached);
            return cached;
        }
        const key = passkeyCompletionStorageKey(candidateId);
        const stored = (await chrome.storage.session.get(key))[key] as PasskeyCompletionReceipt | undefined;
        if (!stored || stored.id !== candidateId) {
            if (stored)
                await chrome.storage.session.remove(key);
            return undefined;
        }
        if (stored.expiresAt <= Date.now())
            return resolveExpiredPasskeyCompletionReceipt(stored);
        passkeyCompletionReceipts.set(candidateId, stored);
        return stored;
    }
    async function deletePasskeyCompletionReceipt(candidateId: string): Promise<void> {
        passkeyCompletionReceipts.delete(candidateId);
        await chrome.storage.session.remove(passkeyCompletionStorageKey(candidateId));
    }
    function passkeyReceiptMatchesSource(receipt: Pick<PasskeyCompletionReceipt, "tabId" | "frameId" | "documentId" | "origin">, source: {
        tabId: number;
        frameId: number;
        documentId: string;
        origin: string;
    }): boolean {
        return receipt.tabId === source.tabId
            && receipt.frameId === source.frameId
            && receipt.documentId === source.documentId
            && receipt.origin === source.origin;
    }
    async function promotePasskeyCompletionReceipt(receipt: PasskeyCompletionReceipt): Promise<void> {
        if (receipt.status === "committed")
            return;
        const committed = { ...receipt, status: "committed" as const };
        passkeyCompletionReceipts.set(receipt.id, committed);
        try {
            await chrome.storage.session.set({ [passkeyCompletionStorageKey(receipt.id)]: committed });
        }
        catch {
            // The in-memory committed receipt still closes the response/cancellation race.
            // A persisted prepared receipt is reconciled against the stable item id after a worker restart.
        }
    }
    async function passkeyReceiptCommitState(receipt: PasskeyCompletionReceipt): Promise<"committed" | "not-committed" | "unknown"> {
        if (receipt.status === "committed")
            return "committed";
        // A prepared assertion is not deliverable until the post-signing identity check and
        // usage commit finish. After an interrupted worker, retry rather than releasing it.
        if (receipt.operation === "get")
            return "not-committed";
        try {
            const item = await deps.service.getItem(receipt.itemId);
            return item && item.kind === "passkey" && !item.deletedAt && normalizeCredentialId(item.credentialId) === normalizeCredentialId(receipt.result.id)
                ? "committed"
                : "not-committed";
        }
        catch (error) {
            if (error instanceof VaultLockedError)
                return "unknown";
            throw error;
        }
    }
    async function purgeExpiredPasskeySessionState(): Promise<void> {
        const now = Date.now();
        const stored = await chrome.storage.session.get(null);
        const expiredKeys: string[] = [];
        for (const [key, value] of Object.entries(stored)) {
            if (!key.startsWith(PASSKEY_PENDING_PREFIX) && !key.startsWith(PASSKEY_COMPLETION_PREFIX))
                continue;
            const expiresAt = Number((value as {
                expiresAt?: unknown;
            } | undefined)?.expiresAt);
            if (Number.isFinite(expiresAt) && expiresAt > now)
                continue;
            if (key.startsWith(PASSKEY_COMPLETION_PREFIX)) {
                const receipt = value as PasskeyCompletionReceipt | undefined;
                if (receipt?.id && receipt.status === "prepared") {
                    await resolveExpiredPasskeyCompletionReceipt(receipt);
                    continue;
                }
            }
            expiredKeys.push(key);
            const candidateId = key.slice(key.lastIndexOf(".") + 1);
            pendingPasskeyRequests.delete(candidateId);
            passkeyCompletionReceipts.delete(candidateId);
        }
        if (expiredKeys.length)
            await chrome.storage.session.remove(expiredKeys);
    }
    function schedulePasskeyCompletionExpiry(candidateId: string, expiresAt: number): void {
        setTimeout(() => void (async () => {
            const receipt = await loadPasskeyCompletionReceipt(candidateId);
            if (receipt && receipt.expiresAt <= Date.now())
                await deletePasskeyCompletionReceipt(candidateId);
        })(), Math.max(0, expiresAt - Date.now()) + 100);
    }
    function schedulePasskeyExpiry(candidateId: string, expiresAt: number): void {
        setTimeout(() => void (async () => {
            const cached = pendingPasskeyRequests.get(candidateId);
            const key = pendingPasskeyStorageKey(candidateId);
            const pending = cached || (await chrome.storage.session.get(key))[key] as PendingPasskeyRequest | undefined;
            if (pending && pending.expiresAt <= Date.now())
                await deps.cancelPendingPasskeyRequest(candidateId);
        })(), Math.max(0, expiresAt - Date.now()) + 100);
    }
    function cachedPendingPasskeyRequests(): PendingPasskeyRequest[] { return [...pendingPasskeyRequests.values()]; }
    function forgetCachedPendingPasskeyRequest(id: string): void { pendingPasskeyRequests.delete(id); }
    return { cachedPendingPasskeyRequests, deletePasskeyCompletionReceipt, deletePendingPasskeyRequest, forgetCachedPendingPasskeyRequest, loadPasskeyCompletionReceipt, loadPendingPasskeyRequest, passkeyReceiptCommitState, passkeyReceiptMatchesSource, persistPasskeyCompletionReceipt, persistPendingPasskeyRequest, promotePasskeyCompletionReceipt, purgeExpiredPasskeySessionState, schedulePasskeyCompletionExpiry, schedulePasskeyExpiry };
}
export type PasskeyJournal = ReturnType<typeof createPasskeyJournal>;
