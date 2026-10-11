export type KeePassRemoteSourceMode = "webdav" | "onedrive";
export type KeePassSourceMode = "local-file" | KeePassRemoteSourceMode;

export function isRemoteKeePassSource(value: unknown): value is KeePassRemoteSourceMode {
  return value === "webdav" || value === "onedrive";
}

export function hasLocalKeePassWorkingCopy(config: Record<string, unknown>): boolean {
  return config.sourceMode === 'local-file' && typeof config.localFileSourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(config.localFileSourceSha256);
}
