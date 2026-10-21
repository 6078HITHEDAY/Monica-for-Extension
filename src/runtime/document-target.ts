/** Callers must obtain the CURRENT frame by tabId + frameId, not query an old
 * documentId (which could refer to a cached document). Firefox exposes native
 * documentId but no documentLifecycle; require its current ID and reject any
 * explicitly inactive/error state. Chromium keeps the lifecycle requirement. */
export function currentFrameDocument(frame: { documentId?: string; documentLifecycle?: string; errorOccurred?: boolean } | null | undefined,
  expectedDocumentId: string | undefined, firefox: boolean): frame is { documentId: string; documentLifecycle?: string; errorOccurred?: boolean } {
  return Boolean(frame && typeof frame.documentId === 'string' && /^[0-9a-f-]{16,64}$/i.test(frame.documentId)
    && (!expectedDocumentId || frame.documentId === expectedDocumentId) && frame.errorOccurred !== true
    && (frame.documentLifecycle === 'active' || firefox && frame.documentLifecycle === undefined));
}
