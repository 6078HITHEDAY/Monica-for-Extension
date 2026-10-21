/** Only imported by the human manager page. Never routed through content scripts. */
export const CLI_HOST = 'app.monica.cli';
export const CLI_PROTOCOL = 2;
export const REQUIRED_CAPABILITIES = ['snapshots', 'mutation_receipts'] as const;
export interface CliHello { protocol:number;version:string;integration_revision:number;capabilities:string[];databases:CliDatabase[] }
export interface CliReceipt { operation_id:string; operation?:string;state:'succeeded'|'unconfirmed'|'not_recorded';error?:string }
export interface CliKey {entry_id:string;title:string;kind:string;algorithm:string;fingerprint:string}
export interface CliDatabase { id: string; name: string; path: string; current: boolean }
export interface CliCategory { id: string; title: string; parent: string | null }
export interface CliEntry { id: string; title: string; category: string; kind: string; connection: string | null }
export interface CliSnapshot {
  vault_id: string;
  databases: CliDatabase[]; categories: CliCategory[]; entries: CliEntry[];
  connections: { name: string; provider: string; api_base: string; note: string }[];
  grants: { name: string; connection: string; repositories: string[]; operations: string[]; expires_at_unix: number; refresh_required: boolean; calls_used: number; max_calls: number;approval:string }[];
  sync?: {configured:boolean;path:string;last_sync:number}|null;
}
export class CliError extends Error { constructor(readonly code: string, readonly sent=false) { super(code); } }
export function validateHello(value: unknown): CliHello {
  const hello=value as Partial<CliHello>|undefined;
  const version=typeof hello?.version==='string' && /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(hello.version);
  const numbers=version && version.slice(1).map(Number);
  const supported=numbers && (numbers[0]>1 || numbers[0]===1 && (numbers[1]>0 || numbers[2]>=101));
  if (!hello || hello.protocol!==CLI_PROTOCOL || !supported || !Number.isInteger(hello.integration_revision) || (hello.integration_revision ?? 0)<2 || !Array.isArray(hello.capabilities) || !REQUIRED_CAPABILITIES.every(c=>hello.capabilities!.includes(c)) || !Array.isArray(hello.databases)) throw new CliError('host_incompatible');
  return hello as CliHello;
}
type Port = Pick<chrome.runtime.Port, 'postMessage' | 'disconnect' | 'onMessage' | 'onDisconnect'>;
export class CliNativeClient {
  private port?: Port;
  private next = 0;
  private negotiated=false;
  get ready() {return this.negotiated;}
  private pending?: { id: number; op:unknown;sent:boolean;resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
  constructor(private readonly connect = () => chrome.runtime.connectNative(CLI_HOST), private readonly closed = () => {}) {}
  async request<T>(command: Record<string, unknown>): Promise<T> {
    if (this.pending) throw new CliError('busy');
    if (command.op!=='hello' && !this.negotiated) throw new CliError('host_not_negotiated');
    const id = ++this.next;
    const message={...command,id,...(command.op==='hello'?{}:{protocol:CLI_PROTOCOL})};
    if (new TextEncoder().encode(JSON.stringify(message)).byteLength > 64 * 1024) throw new CliError('input_too_large');
    if (!this.port) {
      try { this.port = this.connect(); }
      catch { throw new CliError('host_unavailable'); }
      this.port.onMessage.addListener(this.message);
      this.port.onDisconnect.addListener(this.disconnected);
    }
    return new Promise<T>((resolve, reject) => {
      this.pending = { id,op:command.op,sent:false,resolve: value => resolve(value as T), reject, timer: setTimeout(() => this.close('timeout'), 70000) };
      try { this.pending.sent=true;this.port!.postMessage(message); }
      catch { this.close('host_unavailable'); }
    });
  }
  private message = (reply: unknown) => {
    if (!reply || typeof reply !== 'object') { this.close('invalid_reply'); return; }
    const value = reply as {id?:number;ok?:boolean;data?:unknown;error?:unknown};
    const pending = this.pending;
    if (!pending || value.id !== pending.id || typeof value.ok !== 'boolean') { this.close('invalid_reply'); return; }
    clearTimeout(pending.timer); this.pending = undefined;
    if (value.ok) {
      if (pending.op==='hello') {
        try {validateHello(value.data);this.negotiated=true;}
        catch {pending.reject(new CliError('host_incompatible'));this.close('host_incompatible');return;}
      }
      pending.resolve(value.data);
    } else pending.reject(new CliError(typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : 'operation_failed',pending.sent));
  };
  private disconnected = () => {
    // Access lastError to acknowledge Chromium's native-host connection error.
    const message=chrome.runtime.lastError?.message || '';
    this.close(/not found/i.test(message)?'host_not_registered':/forbidden|access.*denied/i.test(message)?'origin_not_allowed':/exited/i.test(message)?'host_exited':'host_unavailable');
  };
  close(code = 'closed') {
    const port = this.port; this.port = undefined;this.negotiated=false;
    port?.onMessage.removeListener(this.message); port?.onDisconnect.removeListener(this.disconnected);
    port?.disconnect();
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(new CliError(code,this.pending.sent)); this.pending = undefined; }
    this.closed();
  }
}
