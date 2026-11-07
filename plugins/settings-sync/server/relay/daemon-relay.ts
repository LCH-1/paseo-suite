import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { relayCredentials, type RelayClient, type RelayPeer } from "../../client/credential-relay";
import { atomicWrite } from "../files";

// Holds what it takes to reach every other host, so it is only ever written with owner-only
// access, never logged, never returned over RPC, and lives outside the settings backup.
const peerConnection = z
  .object({
    serverId: z.string().min(1).max(200),
    relayEndpoint: z.string().min(1).max(500),
    useTls: z.boolean(),
    daemonPublicKeyB64: z.string().min(1).max(512),
    password: z.string().max(1024).optional(),
    platform: z.string().max(32).optional(),
  })
  .strict();
export const peerConnections = z.array(peerConnection).max(64);
export type PeerConnection = z.infer<typeof peerConnection>;

const peersFile = (home: string) => path.join(home, "settings-sync", "relay-peers.json");

export async function readPeers(home: string): Promise<PeerConnection[]> {
  let raw: string;
  try {
    raw = await readFile(peersFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = peerConnections.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : [];
}

/** Windows can hold different host lists, so one list never removes what another one added. */
export function mergePeers(current: readonly PeerConnection[], incoming: readonly PeerConnection[]) {
  const merged = new Map(current.map((peer) => [peer.serverId, peer]));
  for (const peer of incoming) {
    const platform = peer.platform ?? merged.get(peer.serverId)?.platform;
    merged.set(peer.serverId, { ...peer, ...(platform ? { platform } : {}) });
  }
  return [...merged.values()].sort((a, b) => a.serverId.localeCompare(b.serverId));
}

export async function savePeers(home: string, incoming: readonly PeerConnection[]) {
  const current = await readPeers(home);
  const next = mergePeers(current, incoming);
  if (JSON.stringify(next) !== JSON.stringify(current)) await atomicWrite(peersFile(home), JSON.stringify(next));
  return next.length;
}

/** Every daemon computes the same order, and servers come first because they stay on. */
export function rankPeers(peers: readonly PeerConnection[]) {
  const rank = (peer: PeerConnection) => (peer.platform === "linux" ? 0 : peer.platform ? 2 : 1);
  return [...peers].sort((a, b) => rank(a) - rank(b) || a.serverId.localeCompare(b.serverId));
}

export interface PeerClient extends RelayClient {
  readonly isConnected: boolean;
  close(): unknown;
}
export interface DaemonRelayState {
  capable: boolean;
  role: "idle" | "leader" | "standby";
  activeAt: number | null;
  reachable: number;
  changed: number;
}
const statusMethod = "sync.credentials.status.request";
const probeTimeoutMs = 15_000;
const offlineRetryMs = 5 * 60_000;
const tickMs = 60_000;
const firstTickMs = 20_000;

function within<T>(work: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Peer did not answer")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Delivers logins between hosts without an app window. One live daemon does the work and the
 * others watch it, so a daemon that stops is replaced on the next tick. Two daemons briefly
 * believing they lead is harmless: delivery and refresh token release already tolerate it.
 */
export class DaemonRelay {
  private readonly clients = new Map<string, { peer: PeerConnection; client: PeerClient }>();
  private readonly retryAt = new Map<string, number>();
  private state: Omit<DaemonRelayState, "capable"> = { role: "idle", activeAt: null, reachable: 0, changed: 0 };
  private running: Promise<void> | null = null;
  private stopped = false;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly options: {
      home: string;
      enabled: () => Promise<boolean>;
      connect: (peer: PeerConnection, selfId: string) => Promise<PeerClient>;
      relay?: typeof relayCredentials;
      now?: () => number;
      log?: (message: string) => void;
    },
  ) {}

  private get now() {
    return (this.options.now ?? Date.now)();
  }
  private log(message: string) {
    (this.options.log ?? console.log)(`[settings-sync] ${message}`);
  }
  async snapshot(): Promise<DaemonRelayState> {
    return { ...this.state, capable: (await readPeers(this.options.home).catch(() => [])).length > 0 };
  }
  start() {
    const tick = () => void this.tick();
    const first = setTimeout(tick, firstTickMs),
      every = setInterval(tick, tickMs);
    first.unref?.();
    every.unref?.();
    this.timers = [first, every];
  }
  dispose() {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.closeAll();
  }
  private close(serverId: string) {
    const open = this.clients.get(serverId);
    this.clients.delete(serverId);
    try {
      void Promise.resolve(open?.client.close()).catch(() => {});
    } catch {
      /* Already gone. */
    }
  }
  private closeAll(except?: string) {
    for (const serverId of [...this.clients.keys()]) if (serverId !== except) this.close(serverId);
  }
  private async open(peer: PeerConnection, selfId: string) {
    const open = this.clients.get(peer.serverId);
    if (open?.client.isConnected && JSON.stringify(open.peer) === JSON.stringify(peer)) return open.client;
    if (open) this.close(peer.serverId);
    if (this.now < (this.retryAt.get(peer.serverId) ?? 0)) return null;
    try {
      const client = await this.options.connect(peer, selfId);
      if (this.stopped) {
        void Promise.resolve(client.close()).catch(() => {});
        return null;
      }
      this.clients.set(peer.serverId, { peer, client });
      this.retryAt.delete(peer.serverId);
      return client;
    } catch {
      // A host that is off must not cost a connection attempt every minute.
      this.retryAt.set(peer.serverId, this.now + offlineRetryMs);
      return null;
    }
  }
  private setRole(role: DaemonRelayState["role"], leader?: string) {
    if (this.state.role !== role) this.log(`인증 전달 역할: ${role}${leader ? ` (${leader.slice(0, 12)})` : ""}`);
    this.state.role = role;
  }
  private idle() {
    this.closeAll();
    this.setRole("idle");
    this.state.activeAt = null;
  }
  private async pass() {
    if (!(await this.options.enabled().catch(() => false))) return this.idle();
    const peers = rankPeers(await readPeers(this.options.home));
    if (!peers.length) return this.idle();
    const selfId = (await readFile(path.join(this.options.home, "server-id"), "utf8")).trim();
    const position = peers.findIndex((peer) => peer.serverId === selfId);
    for (const peer of position < 0 ? peers : peers.slice(0, position)) {
      if (this.stopped) return;
      const client = await this.open(peer, selfId);
      if (!client) continue;
      const answer = await within(client.invokePluginRpc("settings-sync", statusMethod, {}), probeTimeoutMs).catch(
        () => null,
      );
      if ((answer as { daemonRelay?: { capable?: boolean } } | null)?.daemonRelay?.capable) {
        this.closeAll(peer.serverId);
        this.setRole("standby", peer.serverId);
        this.state.activeAt = null;
        return;
      }
      // Reachable but not relaying: an older version or a host with the relay switched off.
    }
    const ready: RelayPeer[] = [];
    await Promise.all(
      peers.map(async (peer) => {
        const client = await this.open(peer, selfId);
        if (client) ready.push({ serverId: peer.serverId, client });
      }),
    );
    if (this.stopped) return;
    const result = await (this.options.relay ?? relayCredentials)(ready, this.now);
    this.setRole("leader");
    this.state.activeAt = this.now;
    this.state.reachable = result.peers;
    this.state.changed = result.changed;
    if (result.changed) this.log(`다른 호스트로 인증 ${result.changed}건 전달`);
    for (const [serverId, { client }] of this.clients) if (!client.isConnected) this.close(serverId);
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.pass()
      .catch((error) => {
        // Only the error name: a connection failure may quote the endpoint it was given.
        this.log(`인증 전달 확인 실패: ${error instanceof Error ? error.name : "unknown"}`);
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
