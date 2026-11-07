import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { PeerClient, PeerConnection } from "./daemon-relay";

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Same encrypted relay connection the app uses to reach a host. */
export async function connectPeer(peer: PeerConnection, selfId: string): Promise<PeerClient> {
  const client = new DaemonClient({
    url: buildRelayWebSocketUrl({
      endpoint: peer.relayEndpoint,
      useTls: peer.useTls,
      serverId: peer.serverId,
      role: "client",
    }),
    // Stable, so a reconnect replaces the earlier session on the peer instead of adding one.
    clientId: `settings-sync-relay-${selfId}`,
    clientType: "cli",
    appVersion: "0.12.0",
    password: peer.password,
    e2ee: { enabled: true, daemonPublicKeyB64: peer.daemonPublicKeyB64 },
    connectTimeoutMs: 20_000,
    reconnect: { enabled: false },
    suppressSendErrors: true,
    logger: quiet,
  });
  try {
    await client.connect();
    if (client.getLastServerInfoMessage()?.serverId !== peer.serverId) throw new Error("Server identity mismatch");
    return client;
  } catch (error) {
    void Promise.resolve(client.close()).catch(() => {});
    throw error;
  }
}
