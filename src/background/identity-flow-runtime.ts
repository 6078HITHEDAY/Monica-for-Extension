import { OneDriveAuthorizationError } from "../providers/onedrive/onedrive-auth";
import type { ExtensionRequest } from "../runtime/messages";
import { bytesToBase64 } from "../security/encoding";
import type { BitwardenRuntime } from './bitwarden-runtime';
interface Dependencies {
    bitwardenClient: Pick<BitwardenRuntime["bitwardenClient"], "loginSso" | "prevalidateSso">;
    bitwardenDeviceIdentity: Pick<BitwardenRuntime["bitwardenDeviceIdentity"], "get">;
}
export function createIdentityFlowRuntime(deps: Dependencies) {
    function launchOneDriveIdentityFlow(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            chrome.identity.launchWebAuthFlow({ url, interactive: true }, redirect => {
                // Chrome's raw error can contain callback details; expose no OAuth material.
                if (chrome.runtime.lastError || !redirect)
                    reject(new OneDriveAuthorizationError("OneDrive 登录未完成，请重试。"));
                else
                    resolve(redirect);
            });
        });
    }
    async function loginBitwardenWithSso(request: Extract<ExtensionRequest, {
        type: "BITWARDEN_LOGIN";
    }>, existingDeviceId: unknown) {
        if (!chrome.identity?.launchWebAuthFlow || !chrome.identity.getRedirectURL) {
            throw new Error("当前浏览器不支持 Bitwarden SSO 登录流程。");
        }
        const organizationIdentifier = request.ssoOrganizationIdentifier?.trim();
        if (!organizationIdentifier)
            throw new Error("请输入组织 SSO 标识。");
        const deviceId = await deps.bitwardenDeviceIdentity.get(existingDeviceId);
        const prevalidated = await deps.bitwardenClient.prevalidateSso(request.vaultUrl, organizationIdentifier);
        const verifier = base64UrlBytes(crypto.getRandomValues(new Uint8Array(32)));
        const challenge = base64UrlBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
        const state = base64UrlBytes(crypto.getRandomValues(new Uint8Array(24)));
        const redirectUri = chrome.identity.getRedirectURL("sso-callback");
        const authorize = new URL(`${prevalidated.urls.identity}/connect/authorize`);
        authorize.searchParams.set("client_id", "browser");
        authorize.searchParams.set("redirect_uri", redirectUri);
        authorize.searchParams.set("response_type", "code");
        authorize.searchParams.set("scope", "api offline_access");
        authorize.searchParams.set("state", state);
        authorize.searchParams.set("code_challenge", challenge);
        authorize.searchParams.set("code_challenge_method", "S256");
        authorize.searchParams.set("response_mode", "query");
        authorize.searchParams.set("domain_hint", organizationIdentifier);
        authorize.searchParams.set("ssoToken", prevalidated.token);
        const callbackUrl = await launchWebAuthFlow(authorize.toString());
        const callback = new URL(callbackUrl);
        if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== new URL(redirectUri).pathname) {
            throw new Error("Bitwarden SSO 回调地址无效。");
        }
        if (callback.searchParams.get("state") !== state)
            throw new Error("Bitwarden SSO 状态校验失败。");
        const code = callback.searchParams.get("code");
        if (!code)
            throw new Error("Bitwarden SSO 未返回授权码。");
        return deps.bitwardenClient.loginSso({
            vaultUrl: request.vaultUrl,
            email: request.email,
            masterPassword: request.masterPassword,
            deviceId,
            code,
            codeVerifier: verifier,
            redirectUri,
            organizationIdentifier
        });
    }
    async function completeBitwardenWebAuthn(vaultUrl: string, providerData: Record<string, unknown>): Promise<string> {
        if (!chrome.identity?.launchWebAuthFlow || !chrome.identity.getRedirectURL) {
            throw new Error("当前浏览器不支持 Bitwarden WebAuthn 两步验证。");
        }
        const selected = providerData["5"] && typeof providerData["5"] === "object" && !Array.isArray(providerData["5"])
            ? providerData["5"] as Record<string, unknown>
            : providerData;
        const redirectUri = chrome.identity.getRedirectURL("webauthn-callback");
        const parent = encodeURIComponent(redirectUri);
        const base = new URL(vaultUrl);
        base.pathname = "/";
        base.search = "";
        base.hash = "";
        const connectorData = {
            data: JSON.stringify(selected),
            headerText: "Bitwarden WebAuthn",
            btnText: "验证 WebAuthn",
            btnReturnText: "返回",
            mobile: true
        };
        const encodedData = bytesToBase64(new TextEncoder().encode(JSON.stringify(connectorData)));
        const connector = new URL("/webauthn-mobile-connector.html", base);
        connector.searchParams.set("data", encodedData);
        connector.searchParams.set("parent", parent);
        connector.searchParams.set("client", "browser");
        connector.searchParams.set("v", "2");
        connector.searchParams.set("deeplinkScheme", "https");
        const callbackUrl = await launchWebAuthFlow(connector.toString());
        const callback = new URL(callbackUrl);
        const expected = new URL(redirectUri);
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname)
            throw new Error("Bitwarden WebAuthn 回调地址无效。");
        const token = callback.searchParams.get("data")?.trim();
        if (!token || token.length > 256 * 1024)
            throw new Error("Bitwarden WebAuthn 未返回有效验证结果。");
        return token;
    }
    async function completeBitwardenDuo(providerData: Record<string, unknown>, provider: number): Promise<string> {
        if (!chrome.identity?.launchWebAuthFlow || !chrome.identity.getRedirectURL)
            throw new Error("当前浏览器不支持 Bitwarden Duo 两步验证。");
        const selectedValue = providerData[String(provider)];
        const selected = selectedValue && typeof selectedValue === "object" && !Array.isArray(selectedValue) ? selectedValue as Record<string, unknown> : undefined;
        const duo = selected || providerData;
        const authUrl = typeof duo.AuthUrl === "string" ? duo.AuthUrl : typeof duo.authUrl === "string" ? duo.authUrl : "";
        if (!authUrl)
            throw new Error("Bitwarden Duo 响应缺少验证地址。");
        const redirectUri = chrome.identity.getRedirectURL("duo-callback");
        const target = new URL(authUrl);
        target.searchParams.set("redirect_uri", redirectUri);
        const callbackUrl = await launchWebAuthFlow(target.toString());
        const callback = new URL(callbackUrl);
        const expected = new URL(redirectUri);
        if (callback.origin !== expected.origin || callback.pathname !== expected.pathname)
            throw new Error("Bitwarden Duo 回调地址无效。");
        const code = callback.searchParams.get("code")?.trim();
        const state = callback.searchParams.get("state")?.trim();
        if (!code || !state || code.length > 4096 || state.length > 4096)
            throw new Error("Bitwarden Duo 未返回有效验证结果。");
        return `${code}|${state}`;
    }
    function launchWebAuthFlow(url: string): Promise<string> {
        return new Promise((resolve, reject) => {
            chrome.identity.launchWebAuthFlow({ url, interactive: true }, (redirectUrl) => {
                const runtimeError = chrome.runtime.lastError;
                if (runtimeError)
                    return reject(new Error("Bitwarden SSO 登录窗口未完成。"));
                if (!redirectUrl)
                    return reject(new Error("Bitwarden SSO 未返回回调地址。"));
                resolve(redirectUrl);
            });
        });
    }
    function base64UrlBytes(bytes: Uint8Array): string {
        return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }
    return { completeBitwardenDuo, completeBitwardenWebAuthn, launchOneDriveIdentityFlow, loginBitwardenWithSso };
}
export type IdentityFlowRuntime = ReturnType<typeof createIdentityFlowRuntime>;
