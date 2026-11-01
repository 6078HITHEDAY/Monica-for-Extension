import { assertExtensionPage } from './request-access';
import { createProviderSyncRuntime } from './provider-sync-runtime';
interface Dependencies {
    providerSync: Pick<ReturnType<typeof createProviderSyncRuntime>, "reconcile" | "reconnected" | "wake">;
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "recordUserActivity">;
}
export function createLiveViews(deps: Dependencies) {
    const liveVaultPorts = new Map<chrome.runtime.Port, boolean>();
    chrome.runtime.onConnect.addListener(port => {
        if (port.name !== "monica-vault-live-v1")
            return;
        try {
            assertExtensionPage(port.sender || {});
            if (!["/index.html", "/popup.html"].includes(new URL(port.sender!.url!).pathname))
                throw new Error("Unsupported live view");
        }
        catch {
            port.disconnect();
            return;
        }
        liveVaultPorts.set(port, false);
        let lastActivity = 0;
        port.onMessage.addListener((message: {
            type?: string;
            visible?: boolean;
        }) => {
            if (message?.type === "activity") {
                if (Date.now() - lastActivity < 10000)
                    return;
                lastActivity = Date.now();
                void deps.service.recordUserActivity().catch(() => undefined);
            }
            else if (message?.type === "visibility" && typeof message.visible === "boolean") {
                const becameVisible = message.visible && !liveVaultPorts.get(port);
                liveVaultPorts.set(port, message.visible);
                void deps.providerSync.reconcile().then(() => {
                    if (becameVisible)
                        deps.providerSync.wake();
                }).catch(() => undefined);
            }
            else if (message?.type === "online") {
                void deps.providerSync.reconcile().then(() => deps.providerSync.reconnected()).catch(() => undefined);
            }
            else if (message?.type === "focus") {
                void deps.providerSync.reconcile().then(() => deps.providerSync.wake()).catch(() => undefined);
            }
        });
        port.onDisconnect.addListener(() => {
            liveVaultPorts.delete(port);
            void deps.providerSync.reconcile().catch(() => undefined);
        });
    });
    function publishVaultChanged(): void {
        for (const port of liveVaultPorts.keys()) {
            try {
                port.postMessage({ type: "vault-changed" });
            }
            catch {
                liveVaultPorts.delete(port);
            }
        }
    }
    function liveViewsVisible(): boolean { return [...liveVaultPorts.values()].some(Boolean); }
    return { liveViewsVisible, publishVaultChanged };
}
export type LiveViews = ReturnType<typeof createLiveViews>;
