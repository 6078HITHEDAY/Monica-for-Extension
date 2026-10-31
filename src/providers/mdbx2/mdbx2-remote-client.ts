import type { WebDavCredentials } from "../webdav/webdav-client";
import type { Mdbx2WebDavClient } from "./mdbx2-webdav-client";

/**
 * Transport contract used by Mdbx2SyncCoordinator. Mdbx2WebDavClient satisfies
 * it structurally; Mdbx2OneDriveClient implements it over Microsoft Graph path
 * addressing. All paths are mdbx2 remote paths (see mdbx2-sync-paths.ts).
 */
export interface Mdbx2RemoteObject {
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  etag?: string;
  lastModified?: string;
}

export interface Mdbx2RemoteDownloadResult {
  path: string;
  sizeBytes: number;
  sha256: string;
  etag?: string;
  lastModified?: string;
}

export interface Mdbx2RemoteClient {
  testConnection(signal?: AbortSignal): Promise<void>;
  stat(path: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject | undefined>;
  list(path: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject[]>;
  ensureDirectory(path: string, signal?: AbortSignal): Promise<void>;
  download(
    path: string,
    maximumBytes: number,
    onChunk: (chunk: Uint8Array, offset: number) => Promise<void> | void,
    signal?: AbortSignal
  ): Promise<Mdbx2RemoteDownloadResult>;
  putImmutable(path: string, body: Blob, expectedSha256: string, signal?: AbortSignal): Promise<Mdbx2RemoteObject>;
}

export interface Mdbx2WebDavSyncConfig extends WebDavCredentials {
  transport?: "webdav";
  remotePath: string;
  syncStateHandle?: string;
}

/** providerId wires saved-account token rotation; loginId covers draft bootstrap before save. */
export interface Mdbx2OneDriveSyncConfig {
  transport: "onedrive";
  driveId: string;
  remotePath: string;
  syncStateHandle?: string;
  providerId?: string;
  loginId?: string;
}

export type Mdbx2RemoteSyncConfig = Mdbx2WebDavSyncConfig | Mdbx2OneDriveSyncConfig;

export type Mdbx2RemoteClientFactory = (input: Mdbx2RemoteSyncConfig) => Mdbx2RemoteClient;

export function mdbx2SyncConfigTransport(input: Mdbx2RemoteSyncConfig): "webdav" | "onedrive" {
  return input.transport === "onedrive" ? "onedrive" : "webdav";
}

/** Default factory. OneDrive clients need token plumbing and must be injected. */
export function defaultMdbx2RemoteClient(
  input: Mdbx2RemoteSyncConfig,
  fetcher: typeof fetch,
  webdav: (config: Mdbx2WebDavSyncConfig) => Mdbx2WebDavClient
): Mdbx2RemoteClient {
  if (input.transport === "onedrive") throw new Error("MDBX2 OneDrive 同步客户端未注入。");
  return webdav(input);
}
