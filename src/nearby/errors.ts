import { Mdbx2NativeHostError } from '../providers/mdbx2/native-contract';

const code = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Normalize a native engine code such as `connection_failed` to `connection-failed`. */
export function nearbyEngineCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(value)) return undefined;
  return value.replace(/_/g, '-');
}

/** Reduce any nearby failure to a fixed, redacted code the manager can explain.
 * Only constant identifiers pass; native messages, paths and secrets never do. */
export function nearbyErrorCode(error: unknown): string {
  if (error instanceof Mdbx2NativeHostError) {
    if (error.code === 'nearby-engine-error') {
      const engine = /^Nearby: ([a-z_]{1,64})\.$/.exec(error.message)?.[1];
      return nearbyEngineCode(engine) ?? 'operation-failed';
    }
    return code.test(error.code) ? error.code : 'operation-failed';
  }
  if (error instanceof Error && typeof (error as { code?: unknown }).code === 'string') {
    const value = (error as unknown as { code: string }).code;
    if (/^(?:Nearby(?:Coordinator|Transport|Data|Preferences)Error)$/.test(error.name) && code.test(value)) return value;
  }
  return 'operation-failed';
}
