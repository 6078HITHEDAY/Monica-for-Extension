import { isAutofillBlocked, isSaveBlocked, type AutofillSitePolicy } from "../autofill/site-policy";
interface Dependencies {
    service: Pick<import("../security/secure-vault-service").SecureVaultService, "getAutofillSitePolicy" | "isAutofillFieldSignatureBlocked" | "readAutofillContext">;
}
export function createAutofillPolicyRuntime(deps: Dependencies) {
    async function currentAutofillSitePolicy(): Promise<AutofillSitePolicy> {
        const context = await deps.service.readAutofillContext();
        return { blockedHosts: context.blockedHosts, saveBlockedHosts: [] };
    }
    async function autofillBlocked(pageUrl: string): Promise<boolean> {
        return isAutofillBlocked(pageUrl, await currentAutofillSitePolicy());
    }
    async function savePromptBlocked(pageUrl: string): Promise<boolean> {
        return isSaveBlocked(pageUrl, await deps.service.getAutofillSitePolicy());
    }
    async function anyAutofillFieldSignatureBlocked(signatures: unknown): Promise<boolean> {
        if (!Array.isArray(signatures))
            return false;
        for (const signature of signatures.slice(0, 128)) {
            if (typeof signature === "string" && await deps.service.isAutofillFieldSignatureBlocked(signature))
                return true;
        }
        return false;
    }
    return { anyAutofillFieldSignatureBlocked, autofillBlocked, savePromptBlocked };
}
export type AutofillPolicyRuntime = ReturnType<typeof createAutofillPolicyRuntime>;
