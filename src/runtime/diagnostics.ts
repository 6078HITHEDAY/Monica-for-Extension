import { runtimeInfo, type RuntimeInfo } from './version';
import type { Mdbx2HostStatus, VaultWindowsHelloStatus } from './messages';
const safeVersion = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9.+_-]{1,64}$/.test(value) ? value : 'unknown';
/** Construct a whitelist report. Never spread runtime/native objects or errors. */
export function diagnosticReport(background?: RuntimeInfo, engine?: Mdbx2HostStatus, hello?: VaultWindowsHelloStatus) {
  return {schema:1, ui:{version:runtimeInfo.version,protocol:runtimeInfo.protocolVersion,build:runtimeInfo.buildId},
    background: background ? {version:safeVersion(background.version),protocol:Number.isSafeInteger(background.protocolVersion)?background.protocolVersion:0,build:safeVersion(background.buildId),compatible:background.version===runtimeInfo.version&&background.protocolVersion===runtimeInfo.protocolVersion&&background.buildId===runtimeInfo.buildId}:null,
    engine:engine?{availability:['ready','not-installed','incompatible','unavailable'].includes(engine.availability)?engine.availability:'unavailable',backend:engine.runtimeBackend==='native'?'native':'browser',version:safeVersion(engine.capabilities?.hostVersion)}:null,
    systemVerifier:hello?{available:hello.native.available===true,supported:hello.native.supported===true,enrolled:hello.vaultEnrolled===true,consistent:hello.bindingConsistent===true}:null};
}
