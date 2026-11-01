import type { ExtensionRequest } from '../runtime/messages';
import { createAttachmentRuntime } from './attachment-runtime';
import { createBitwardenSendRuntime } from './bitwarden-send-runtime';
import { createCommandExecutor } from './command-router';
import { createProviderSyncRuntime } from './provider-sync-runtime';
import { ProviderSyncActivity } from './provider-sync-activity';
import { localNearbySource } from '../nearby/source-adapter';
import { nativeNearbySource } from '../nearby/native-adapter';
import { ProviderRegistry } from "../core/provider";
import { LocalAttachmentService } from '../providers/attachments/local-attachments';
import { BitwardenProvider } from "../providers/bitwarden/bitwarden-provider";
import { BitwardenDurableSyncCoordinator } from "../providers/bitwarden/bitwarden-durable-sync";
import { Mdbx2NativeClient, createChromeMdbx2NativeRuntime } from "../providers/mdbx2/native-client";
import { ProviderOperationQueue } from './provider-operation-queue';
import { ClipboardLifecycle } from './clipboard';
import { MonicaWebDavProvider } from "../providers/webdav/monica-webdav-provider";
import { ChromeVaultSessionStore } from "../security/vault-session";
import { SecureVaultService } from "../security/secure-vault-service";
import { IndexedDbVaultStorage } from "../security/vault-storage";
import { ChromeVaultDeviceKeyStore } from "../security/vault-device-key";
import { IndexedDbLockedAutofillStorage, LockedAutofillCache } from "../security/locked-autofill";
import { NearbyManagerOwner } from './nearby-owner';
import { NearbyLocalCoordinator } from '../nearby/local-coordinator';
import { NearbyNativeTransport } from '../nearby/native-transport';
import { createAutofillPolicyRuntime } from './autofill-policy-runtime';
import { createCredentialRuntime } from './credential-runtime';
import { createPasskeyRuntime } from './passkey-runtime';
import { createPasskeyJournal } from './passkey-journal';
import { createPasskeyVerificationRuntime } from './passkey-verification-runtime';
import { createAutofillRuntime } from './autofill-runtime';
import { createKeePassRuntime } from './keepass-runtime';
import { createBitwardenRuntime } from './bitwarden-runtime';
import { createIdentityFlowRuntime } from './identity-flow-runtime';
import { createMdbxRuntime } from './mdbx-runtime';
import { createTransferRuntime } from './transfer-runtime';
import { createProjectRuntime } from './project-runtime';
import { createVaultRuntime } from './vault-runtime';
import { createVaultItemRuntime } from './vault-item-runtime';
import { createProviderCommandRuntime } from './provider-command-runtime';
import { createSteamRuntime } from './steam-runtime';
import { createKeePassCommandRuntime } from './keepass-command-runtime';
import { createMdbxFileRuntime } from './mdbx-file-runtime';
import { createMdbxSyncRuntime } from './mdbx-sync-runtime';
import { createMdbxObjectRuntime } from './mdbx-object-runtime';
import { createCommandEffects } from './command-effects';
import { createLiveViews } from './live-views';
import { installBackgroundEvents } from './events';
import { createCommandDispatcher, type CommandHandlers } from './command-router';
export function startBackground() {
    const clipboardLifecycle = new ClipboardLifecycle();
    const AUTO_LOCK_ALARM = "monica-vault-auto-lock";
    const AUTO_SYNC_ALARM = "monica-provider-auto-sync";
    const vaultSessions = new ChromeVaultSessionStore();
    const service = new SecureVaultService(new IndexedDbVaultStorage(), vaultSessions, () => Date.now(), new ChromeVaultDeviceKeyStore(), new LockedAutofillCache(new IndexedDbLockedAutofillStorage()));
    const providers = new ProviderRegistry();
    const monicaWebDavProvider = new MonicaWebDavProvider();
    const bitwardenProvider = new BitwardenProvider();
    const bitwardenDurableSync = new BitwardenDurableSyncCoordinator(bitwardenProvider, service);
    const providerOperations = new ProviderOperationQueue();
    const executeCommand = createCommandExecutor(service, providerOperations);
    const localAttachments = new LocalAttachmentService(service);
    const syncActivity = new ProviderSyncActivity();
    const autofillPolicyRuntime = createAutofillPolicyRuntime({
        service: service,
    });
    const credentialRuntime = createCredentialRuntime({
        anyAutofillFieldSignatureBlocked: autofillPolicyRuntime.anyAutofillFieldSignatureBlocked,
        savePromptBlocked: autofillPolicyRuntime.savePromptBlocked,
        service: service,
    });
    const passkeyRuntime = createPasskeyRuntime({
        get verification() { return passkeyVerificationRuntime; },
        get journal() { return passkeyJournal; },
        autofillBlocked: autofillPolicyRuntime.autofillBlocked,
        bitwardenDurableSync: bitwardenDurableSync,
        providerOperations: providerOperations,
        get providerSync() { return providerSync; },
        get publishVaultChanged() { return liveViews.publishVaultChanged; },
        service: service,
        get windowsHelloNativeClient() { return mdbxRuntime.windowsHelloNativeClient; },
    });
    const passkeyJournal = createPasskeyJournal({
        cancelPendingPasskeyRequest: passkeyRuntime.cancelPendingPasskeyRequest,
        service: service,
    });
    const passkeyVerificationRuntime = createPasskeyVerificationRuntime({
        service: service,
        get windowsHelloNativeClient() { return mdbxRuntime.windowsHelloNativeClient; },
    });
    const autofillRuntime = createAutofillRuntime({
        get afterRuntimeRequest() { return commandEffects.afterRuntimeRequest; },
        autofillBlocked: autofillPolicyRuntime.autofillBlocked,
        get dismissInlineMenus() { return commandEffects.dismissInlineMenus; },
        service: service,
    });
    const keePassRuntime = createKeePassRuntime({
        providerOperations: providerOperations,
        get providerSync() { return providerSync; },
        get publishVaultChanged() { return liveViews.publishVaultChanged; },
        service: service,
    });
    const bitwardenRuntime = createBitwardenRuntime({
        get attachmentRuntime() { return attachmentRuntime; },
        bitwardenProvider: bitwardenProvider,
        get completeBitwardenDuo() { return identityFlowRuntime.completeBitwardenDuo; },
        get completeBitwardenWebAuthn() { return identityFlowRuntime.completeBitwardenWebAuthn; },
        get loginBitwardenWithSso() { return identityFlowRuntime.loginBitwardenWithSso; },
        get providerSync() { return providerSync; },
        service: service,
    });
    const identityFlowRuntime = createIdentityFlowRuntime({
        bitwardenClient: bitwardenRuntime.bitwardenClient,
        bitwardenDeviceIdentity: bitwardenRuntime.bitwardenDeviceIdentity,
    });
    const mdbxRuntime = createMdbxRuntime({
        oneDriveSessions: keePassRuntime.oneDriveSessions,
        service: service,
    });
    const transferRuntime = createTransferRuntime({
        MDBX2_MAX_BASE64_CHUNK_LENGTH: mdbxRuntime.MDBX2_MAX_BASE64_CHUNK_LENGTH,
        bitwardenAttachmentDownloads: bitwardenRuntime.bitwardenAttachmentDownloads,
        bitwardenAttachmentMutations: bitwardenRuntime.bitwardenAttachmentMutations,
        bitwardenClient: bitwardenRuntime.bitwardenClient,
        bitwardenProvider: bitwardenProvider,
        bitwardenTransferAttachmentSource: bitwardenRuntime.bitwardenTransferAttachmentSource,
        clearBitwardenOrganizationKeys: bitwardenRuntime.clearBitwardenOrganizationKeys,
        ensureKeePassSession: keePassRuntime.ensureKeePassSession,
        keePassLocalCopies: keePassRuntime.keePassLocalCopies,
        keePassPersistenceFor: keePassRuntime.keePassPersistenceFor,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassRemoteSessions: keePassRuntime.keePassRemoteSessions,
        keePassWorkingCopies: keePassRuntime.keePassWorkingCopies,
        loadBitwardenTransferAttachmentContext: bitwardenRuntime.loadBitwardenTransferAttachmentContext,
        localAttachments: localAttachments,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2Provider: mdbxRuntime.mdbx2Provider,
        monicaWebDavProvider: monicaWebDavProvider,
        providerOperations: providerOperations,
        providers: providers,
        runKeePassMutationExclusive: keePassRuntime.runKeePassMutationExclusive,
        service: service,
        stringAccountConfig: mdbxRuntime.stringAccountConfig,
    });
    const projectRuntime = createProjectRuntime({
        bitwardenAttachmentDownloads: bitwardenRuntime.bitwardenAttachmentDownloads,
        bitwardenAttachmentMutations: bitwardenRuntime.bitwardenAttachmentMutations,
        bitwardenClient: bitwardenRuntime.bitwardenClient,
        bitwardenProvider: bitwardenProvider,
        keePassProjectRemovals: keePassRuntime.keePassProjectRemovals,
        keePassProjectResolutions: keePassRuntime.keePassProjectResolutions,
        keePassRecoveryDownloads: keePassRuntime.keePassRecoveryDownloads,
        mdbx2ExportOwner: mdbxRuntime.mdbx2ExportOwner,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2RestoreBatches: mdbxRuntime.mdbx2RestoreBatches,
        mdbx2Restores: mdbxRuntime.mdbx2Restores,
        providerOperations: providerOperations,
        get publishVaultChanged() { return liveViews.publishVaultChanged; },
        service: service,
        syncActivity: syncActivity,
    });
    const vaultRuntime = createVaultRuntime({
        get attachmentRuntime() { return attachmentRuntime; },
        get bitwardenSendRuntime() { return bitwardenSendRuntime; },
        clearCredentialCaptures: credentialRuntime.clearCredentialCaptures,
        clearKeePassPendingPersistence: keePassRuntime.clearKeePassPendingPersistence,
        clearPendingPasskeyRequests: passkeyRuntime.clearPendingPasskeyRequests,
        clearPendingUsernameContexts: credentialRuntime.clearPendingUsernameContexts,
        clearTransferSessions: transferRuntime.clearTransferSessions,
        clearTransferStatuses: transferRuntime.clearTransferStatuses,
        clipboardLifecycle: clipboardLifecycle,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassRecoveryDownloads: keePassRuntime.keePassRecoveryDownloads,
        mdbx2LocalFileExports: mdbxRuntime.mdbx2LocalFileExports,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2Provider: mdbxRuntime.mdbx2Provider,
        get nearbyOwner() { return nearbyOwner; },
        get providerSync() { return providerSync; },
        service: service,
        windowsHelloNativeClient: mdbxRuntime.windowsHelloNativeClient,
    });
    const vaultItemRuntime = createVaultItemRuntime({
        monicaWebDavProvider: monicaWebDavProvider,
        restoreVaultItem: projectRuntime.restoreVaultItem,
        service: service,
    });
    const providerCommandRuntime = createProviderCommandRuntime({
        get attachmentRuntime() { return attachmentRuntime; },
        get bitwardenSendRuntime() { return bitwardenSendRuntime; },
        clearKeePassPendingPersistence: keePassRuntime.clearKeePassPendingPersistence,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassWorkingCopies: keePassRuntime.keePassWorkingCopies,
        mdbx2LocalFileExports: mdbxRuntime.mdbx2LocalFileExports,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2Provider: mdbxRuntime.mdbx2Provider,
        get nearbyOwner() { return nearbyOwner; },
        providerOperations: providerOperations,
        get providerSync() { return providerSync; },
        providers: providers,
        runKeePassMutationExclusive: keePassRuntime.runKeePassMutationExclusive,
        service: service,
    });
    const steamRuntime = createSteamRuntime({
        service: service,
    });
    const keePassCommandRuntime = createKeePassCommandRuntime({
        applyKeePassRemoteAccountConfig: keePassRuntime.applyKeePassRemoteAccountConfig,
        clearKeePassPendingPersistence: keePassRuntime.clearKeePassPendingPersistence,
        durableKeePassGroupResult: keePassRuntime.durableKeePassGroupResult,
        durableKeePassHistoryResult: keePassRuntime.durableKeePassHistoryResult,
        ensureKeePassSession: keePassRuntime.ensureKeePassSession,
        executeKeePassDurableMutation: keePassRuntime.executeKeePassDurableMutation,
        flushKeePassPendingMutations: keePassRuntime.flushKeePassPendingMutations,
        keePassDurableSync: keePassRuntime.keePassDurableSync,
        keePassLocalCopies: keePassRuntime.keePassLocalCopies,
        keePassProjectRemovals: keePassRuntime.keePassProjectRemovals,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassRecoveryDownloads: keePassRuntime.keePassRecoveryDownloads,
        keePassRemoteSessions: keePassRuntime.keePassRemoteSessions,
        keePassWorkingCopies: keePassRuntime.keePassWorkingCopies,
        launchOneDriveIdentityFlow: identityFlowRuntime.launchOneDriveIdentityFlow,
        oneDriveConnections: keePassRuntime.oneDriveConnections,
        oneDriveSessions: keePassRuntime.oneDriveSessions,
        providerOperations: providerOperations,
        get providerSync() { return providerSync; },
        get publishVaultChanged() { return liveViews.publishVaultChanged; },
        replayKeePassGroupResult: keePassRuntime.replayKeePassGroupResult,
        replayKeePassHistoryResult: keePassRuntime.replayKeePassHistoryResult,
        requireKeePassAccount: keePassRuntime.requireKeePassAccount,
        requireKeePassAccountRecord: keePassRuntime.requireKeePassAccountRecord,
        requireKeePassHistoryTarget: keePassRuntime.requireKeePassHistoryTarget,
        runKeePassMutationExclusive: keePassRuntime.runKeePassMutationExclusive,
        service: service,
        waitForKeePassIdle: keePassRuntime.waitForKeePassIdle,
    });
    const mdbxFileRuntime = createMdbxFileRuntime({
        mdbx2ExportOwner: mdbxRuntime.mdbx2ExportOwner,
        mdbx2ImportStore: mdbxRuntime.mdbx2ImportStore,
        mdbx2LocalFileExports: mdbxRuntime.mdbx2LocalFileExports,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2Provider: mdbxRuntime.mdbx2Provider,
        get providerSync() { return providerSync; },
        requireMdbx2VaultHandle: mdbxRuntime.requireMdbx2VaultHandle,
        service: service,
    });
    const mdbxSyncRuntime = createMdbxSyncRuntime({
        effectiveMdbx2WebDavSettings: mdbxRuntime.effectiveMdbx2WebDavSettings,
        managerSyncStatus: mdbxRuntime.managerSyncStatus,
        mdbx2CloudSyncInput: mdbxRuntime.mdbx2CloudSyncInput,
        mdbx2RemoteSyncConfig: mdbxRuntime.mdbx2RemoteSyncConfig,
        mdbx2SyncCoordinator: mdbxRuntime.mdbx2SyncCoordinator,
        oneDriveSessions: keePassRuntime.oneDriveSessions,
        requireMdbx2Account: mdbxRuntime.requireMdbx2Account,
        service: service,
        stringAccountConfig: mdbxRuntime.stringAccountConfig,
    });
    const mdbxObjectRuntime = createMdbxObjectRuntime({
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        requireMdbx2VaultHandle: mdbxRuntime.requireMdbx2VaultHandle,
    });
    const commandEffects = createCommandEffects({
        bitwardenProvider: bitwardenProvider,
        get providerSync() { return providerSync; },
        get publishVaultChanged() { return liveViews.publishVaultChanged; },
        service: service,
    });
    const liveViews = createLiveViews({
        get providerSync() { return providerSync; },
        service: service,
    });
    const nearbyOwner = new NearbyManagerOwner({
        runtimeId: chrome.runtime.id, extensionRoot: chrome.runtime.getURL(''), store: service,
        readSession: async () => { const session = await vaultSessions.read(); return session ? { id: session.id, expiresAt: session.expiresAt } : null; },
        createCoordinator: assertActive => new NearbyLocalCoordinator(service, () => new NearbyNativeTransport(new Mdbx2NativeClient(createChromeMdbx2NativeRuntime())), undefined, assertActive, async (p, sessionId, signal, active, epoch) => {
            const provider = await service.getProvider(p.localProviderId);
            active();
            if (provider?.kind === 'local')
                return localNearbySource(service, sessionId, active);
            if (provider?.kind !== 'mdbx2')
                throw new Error('Nearby source unavailable');
            return nativeNearbySource({ store: service, client: mdbxRuntime.mdbx2NativeClient, providerId: provider.id, replicaStorageId: p.replicaStorageId,
                sessionId, signal, assertActive: active, epoch, exclusive: work => providerOperations.run(provider.id, work) });
        }),
        changed: () => liveViews.publishVaultChanged()
    });
    providers.register(monicaWebDavProvider);
    providers.register(bitwardenProvider);
    providers.register(mdbxRuntime.mdbx2Provider);
    providers.register(keePassRuntime.keePassProvider);
    const attachmentRuntime = createAttachmentRuntime({
        service,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        keePassProvider: keePassRuntime.keePassProvider,
        monicaWebDavProvider,
        bitwardenAttachmentDownloads: bitwardenRuntime.bitwardenAttachmentDownloads,
        bitwardenAttachmentMutations: bitwardenRuntime.bitwardenAttachmentMutations,
        ensureKeePassSession: keePassRuntime.ensureKeePassSession,
        loadBitwardenAttachmentContext: bitwardenRuntime.loadBitwardenAttachmentContext,
        persistBitwardenSession: bitwardenRuntime.persistBitwardenSession,
        acknowledgeBitwardenAttachmentMutation: bitwardenRuntime.acknowledgeBitwardenAttachmentMutation,
        clearBitwardenOrganizationKeys: bitwardenRuntime.clearBitwardenOrganizationKeys,
        executeKeePassDurableMutation: keePassRuntime.executeKeePassDurableMutation,
        executeCommand, localAttachments
    });
    const bitwardenSendRuntime = createBitwardenSendRuntime({ bitwardenClient: bitwardenRuntime.bitwardenClient, requireBitwardenAccountRecord: bitwardenRuntime.requireBitwardenAccountRecord, persistBitwardenSession: bitwardenRuntime.persistBitwardenSession });
    const providerSync = createProviderSyncRuntime({
        service, providers, providerOperations, bitwardenProvider,
        bitwardenClient: bitwardenRuntime.bitwardenClient,
        executeCommand,
        bitwardenDurableSync,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassDurableSync: keePassRuntime.keePassDurableSync,
        vaultSessions,
        oneDriveSessions: keePassRuntime.oneDriveSessions,
        synchronizeKeePassProvider: keePassRuntime.synchronizeKeePassProvider,
        persistKeePassRemoteFailure: keePassRuntime.persistKeePassRemoteFailure,
        clearKeePassPendingPersistence: keePassRuntime.clearKeePassPendingPersistence,
        recordProviderDiagnosticIfUnlocked: providerCommandRuntime.recordProviderDiagnosticIfUnlocked,
        publishVaultChanged: liveViews.publishVaultChanged,
        isVisible: () => liveViews.liveViewsVisible(),
        recoverProvider: projectRuntime.recoverProviderBeforeSync
    }, syncActivity);
    const handlers: CommandHandlers<ExtensionRequest> = {
        ...attachmentRuntime.handlers,
        ...bitwardenSendRuntime.handlers,
        ...providerSync.handlers,
        ...credentialRuntime.handlers,
        ...passkeyRuntime.handlers,
        ...passkeyVerificationRuntime.handlers,
        ...autofillRuntime.handlers,
        ...bitwardenRuntime.handlers,
        ...transferRuntime.handlers,
        ...projectRuntime.handlers,
        ...vaultRuntime.handlers,
        ...vaultItemRuntime.handlers,
        ...providerCommandRuntime.handlers,
        ...steamRuntime.handlers,
        ...keePassCommandRuntime.handlers,
        ...mdbxFileRuntime.handlers,
        ...mdbxSyncRuntime.handlers,
        ...mdbxObjectRuntime.handlers,
    };
    const routeRequest = createCommandDispatcher(handlers);
    async function handleRequest(request: ExtensionRequest, sender: chrome.runtime.MessageSender): Promise<unknown> { return executeCommand(request, sender, routeRequest); }
    chrome.webNavigation.onCommitted.addListener(passkeyRuntime.navigationCommitted);
    chrome.tabs.onRemoved.addListener(passkeyRuntime.tabRemoved);
    installBackgroundEvents({
        AUTO_LOCK_ALARM,
        AUTO_SYNC_ALARM,
        afterRuntimeRequest: commandEffects.afterRuntimeRequest,
        attachmentRuntime,
        bitwardenSendRuntime,
        clearCredentialCaptures: credentialRuntime.clearCredentialCaptures,
        clearKeePassPendingPersistence: keePassRuntime.clearKeePassPendingPersistence,
        clearPendingPasskeyRequests: passkeyRuntime.clearPendingPasskeyRequests,
        clearPendingUsernameContexts: credentialRuntime.clearPendingUsernameContexts,
        clearTransferSessions: transferRuntime.clearTransferSessions,
        clearTransferStatuses: transferRuntime.clearTransferStatuses,
        clipboardLifecycle,
        dismissInlineMenus: commandEffects.dismissInlineMenus,
        handleRequest,
        keePassProvider: keePassRuntime.keePassProvider,
        keePassRecoveryDownloads: keePassRuntime.keePassRecoveryDownloads,
        mdbx2ImportStore: mdbxRuntime.mdbx2ImportStore,
        mdbx2LocalFileExports: mdbxRuntime.mdbx2LocalFileExports,
        mdbx2NativeClient: mdbxRuntime.mdbx2NativeClient,
        mdbx2Provider: mdbxRuntime.mdbx2Provider,
        nearbyOwner,
        oneDriveSessions: keePassRuntime.oneDriveSessions,
        providerSync,
        purgeExpiredPasskeySessionState: passkeyJournal.purgeExpiredPasskeySessionState,
        service,
    });
}
