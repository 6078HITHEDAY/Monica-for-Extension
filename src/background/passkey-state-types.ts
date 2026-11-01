import type { PasskeyRequest, PasskeyResult } from "../runtime/messages";
export const PASSKEY_COMPLETION_TTL_MS = 2 * 60000;
export interface PendingPasskeyRequest {
    id: string;
    request: PasskeyRequest;
    tabId: number;
    frameId: number;
    documentId: string;
    origin: string;
    rpId: string;
    expiresAt: number;
    matches: string[];
    saveTargets: Array<{
        providerId: string;
        name: string;
        kind: "local" | "bitwarden" | "mdbx2" | "keepass";
    }>;
    defaultSaveTargetId?: string;
    unlockRequired?: boolean;
    unlockSessionId?: string;
}
export const PASSKEY_PENDING_PREFIX = "monica.passkey.pending.v1.";
export interface PasskeyCompletionReceipt {
    id: string;
    tabId: number;
    frameId: number;
    documentId: string;
    origin: string;
    operation: PasskeyRequest["operation"];
    itemId: string;
    result: PasskeyResult;
    status: "prepared" | "committed";
    expiresAt: number;
}
export const PASSKEY_COMPLETION_PREFIX = "monica.passkey.completion.v1.";
