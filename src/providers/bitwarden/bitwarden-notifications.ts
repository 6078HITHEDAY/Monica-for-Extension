import { HubConnectionBuilder, HttpTransportType, LogLevel, type HubConnection } from "@microsoft/signalr";
import { MessagePackHubProtocol } from "@microsoft/signalr-protocol-msgpack";
import { inferBitwardenServerUrls, type BitwardenClient, type BitwardenSessionConfig } from "./bitwarden-client";
import type { BitwardenSyncHint } from "./bitwarden-sync-cache";
import { ProviderTransportError } from "../provider-transport";

export type BitwardenNotification = BitwardenSyncHint | { type: "logout" };

/** Validate the bearer over HTTP before putting it in a browser WebSocket URL.
 * The client refreshes expiring/rejected tokens once. Older self-hosted servers
 * without revision-date still have an authenticated sync endpoint. */
export async function bitwardenNotificationSession(client: BitwardenClient, session: BitwardenSessionConfig, signal: AbortSignal): Promise<BitwardenSessionConfig> {
  try { return (await client.accountRevision(session, signal)).session; }
  catch (error) {
    if (error instanceof ProviderTransportError && (error.status === 404 || error.status === 405)) {
      return (await client.sync(session, signal)).session;
    }
    throw error;
  }
}

/** Same hub, WebSocket transport and MessagePack protocol as the official extension. */
export function bitwardenNotificationUrl(vaultUrl: string): string {
  const { vault } = inferBitwardenServerUrls(vaultUrl);
  if (vault === "https://vault.bitwarden.com") return "https://notifications.bitwarden.com/hub";
  if (vault === "https://vault.bitwarden.eu") return "https://notifications.bitwarden.eu/hub";
  return `${vault}/notifications/hub`;
}

export function parseBitwardenNotification(input: unknown, userId: string, deviceId: string): BitwardenNotification | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const raw = input as Record<string, unknown>;
  const contextId = raw.ContextId ?? raw.contextId;
  if (contextId === deviceId) return;
  const payload = (raw.Payload ?? raw.payload ?? {}) as Record<string, unknown>;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const owner = payload.UserId ?? payload.userId;
  if (owner !== undefined && owner !== null && owner !== userId) return;
  const type = raw.Type ?? raw.type;
  if ([0, 1, 2, 9].includes(type as number)) {
    const id = payload.Id ?? payload.id;
    if (typeof id !== "string" || !id || id.length > 256 || /[\x00-\x20\x7f]/.test(id)) return;
    // Even deletes are confirmed by the authenticated Cipher endpoint (404), so
    // an old/reordered delete notification cannot erase a subsequently restored item.
    return { type: "ciphers", ids: [id] };
  }
  if ([3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 17, 18, 19, 25].includes(type as number)) return { type: "full" };
  if (type === 11) return { type: "logout" };
}

export class BitwardenNotifications {
  private readonly connection: HubConnection;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private starting = false;
  private failures = 0;
  private readonly abort = new AbortController();
  private disconnectedReported = false;
  connected = false;

  constructor(input: {
    vaultUrl: string;
    userId: string;
    deviceId: string;
    accessToken: (signal: AbortSignal) => Promise<string>;
    receive: (hint: BitwardenNotification) => void;
    connected: () => void;
    disconnected: () => void;
  }) {
    this.connection = new HubConnectionBuilder()
      .withUrl(bitwardenNotificationUrl(input.vaultUrl), { accessTokenFactory: async () => {
        this.abort.signal.throwIfAborted();
        const token = await input.accessToken(this.abort.signal);
        // Lock/disable can happen while the authenticated preflight is pending.
        this.abort.signal.throwIfAborted();
        return token;
      }, skipNegotiation: true, transport: HttpTransportType.WebSockets })
      .withHubProtocol(new MessagePackHubProtocol())
      // SignalR URLs contain access_token. Never emit its transport messages.
      .configureLogging(LogLevel.None)
      .withKeepAliveInterval(20_000)
      .withServerTimeout(60_000)
      .build();
    this.connection.on("ReceiveMessage", value => {
      if (this.stopped) return;
      const hint = parseBitwardenNotification(value, input.userId, input.deviceId);
      if (hint) input.receive(hint);
    });
    this.connection.onclose(() => {
      this.connected = false;
      if (this.stopped) return;
      this.reportDisconnected();
      this.retry();
    });
    this.onConnected = input.connected;
    this.onDisconnected = input.disconnected;
  }

  private readonly onConnected: () => void;
  private readonly onDisconnected: () => void;

  private reportDisconnected(): void {
    if (this.stopped || this.disconnectedReported) return;
    this.disconnectedReported = true;
    this.onDisconnected();
  }

  start(): void {
    if (this.stopped || this.starting || this.connected) return;
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.starting = true;
    this.disconnectedReported = false;
    void this.connection.start().then(() => {
      if (this.stopped) return this.connection.stop();
      this.connected = true;
      this.failures = 0;
      this.onConnected(); // Always reconcile changes made while disconnected.
    }).catch(() => { this.reportDisconnected(); this.retry(); }).finally(() => { this.starting = false; });
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.abort.abort();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.connection.stop().catch(() => undefined);
  }

  private retry(): void {
    if (this.stopped || this.retryTimer !== undefined) return;
    this.failures = Math.min(7, this.failures + 1);
    const delay = Math.min(5 * 60_000, 1000 * 2 ** (this.failures - 1));
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.start(); }, delay + Math.random() * delay * 0.2);
  }
}
