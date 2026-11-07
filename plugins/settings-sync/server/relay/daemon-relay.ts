import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { relayCredentials, type RelayClient, type RelayPeer } from "../../client/credential-relay";

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
    updatedAt: z.string().max(40).optional(),
  })
  .strict();
export const peerConnections = z.array(peerConnection).max(64);
export const removedPeers = z.array(z.string().min(1).max(200)).max(64);
export type PeerConnection = z.infer<typeof peerConnection>;

const peersFile = (home: string) => path.join(home, "settings-sync", "relay-peers.json");

export async function readPeers(
  home: string,
  log: (message: string) => void = console.log,
): Promise<PeerConnection[]> {
  let raw: string;
  try {
    raw = await readFile(peersFile(home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const parsed = peerConnections.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* Reported below. */
  }
  // Treated as empty so the next list an app window sends can replace it.
  log("[settings-sync] 호스트 접속 정보 파일이 손상되어 무시합니다.");
  return [];
}

const stamp = (peer: PeerConnection) => Date.parse(peer.updatedAt ?? "");
/**
 * Windows can hold different host lists, so a list only removes hosts it names as removed.
 * A window with an older copy of a host cannot put back the connection details it replaced.
 */
export function mergePeers(
  current: readonly PeerConnection[],
  incoming: readonly PeerConnection[],
  removed: readonly string[] = [],
) {
  const merged = new Map(current.map((peer) => [peer.serverId, peer]));
  for (const serverId of removed) merged.delete(serverId);
  for (const peer of incoming) {
    const previous = merged.get(peer.serverId);
    const platform = peer.platform ?? previous?.platform;
    const chosen = previous && stamp(peer) < stamp(previous) ? previous : peer;
    merged.set(peer.serverId, { ...chosen, ...(platform ? { platform } : {}) });
  }
  return [...merged.values()].sort((a, b) => a.serverId.localeCompare(b.serverId));
}

const systemProgram = (name: string) =>
  path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
const run = (file: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
  });
/** A Windows profile grants inherited read access to other groups, which mode bits cannot remove. */
export function ownerOnlyArguments(file: string, userSid: string) {
  return [file, "/inheritance:r", "/grant:r", `*${userSid}:F`, "*S-1-5-18:F"];
}
/** SIDs, because account and group names are localized and may need a domain to resolve. */
async function restrictOnWindows(file: string) {
  const sid = (await run(systemProgram("whoami.exe"), ["/user", "/fo", "csv", "/nh"])).match(/S-1-[\d-]+/)?.[0];
  if (!sid) throw new Error("Windows user SID not found");
  await run(systemProgram("icacls.exe"), ownerOnlyArguments(file, sid));
}

export async function savePeers(
  home: string,
  incoming: readonly PeerConnection[],
  options: {
    removed?: readonly string[];
    platform?: NodeJS.Platform;
    restrict?: (file: string) => Promise<void>;
  } = {},
) {
  const file = peersFile(home);
  const restrict = (options.platform ?? process.platform) === "win32" ? (options.restrict ?? restrictOnWindows) : null;
  const current = await readPeers(home);
  const next = mergePeers(current, incoming, options.removed);
  if (JSON.stringify(next) === JSON.stringify(current)) {
    // Earlier versions may have left inherited access on a list that still works.
    if (current.length) await restrict?.(file).catch(() => console.log("[settings-sync] 호스트 접속 정보 파일 권한을 다시 확인하지 못했습니다."));
    return next.length;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    // Restricted before it takes the name, so a failure leaves the working list untouched.
    await restrict?.(temporary);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
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
  /** Measured on the reporting daemon, so clock differences between hosts do not matter. */
  ageMs: number | null;
  reachable: number;
  reached: string[];
  changed: number;
}
const statusMethod = "sync.credentials.status.request";
const probeTimeoutMs = 15_000;
const offlineRetryMs = 5 * 60_000;
const tickMs = 60_000;
const firstTickMs = 20_000;
const leaderFreshMs = 3 * 60_000;

/**
 * Standing by is only safe behind a daemon proven to be delivering to this host. Anything less,
 * such as a leader that lost its connections, leaves this daemon doing the work as well.
 */
export function leadsFor(relay: Partial<DaemonRelayState> | undefined, selfId: string) {
  return (
    relay?.role === "leader" &&
    typeof relay.ageMs === "number" &&
    relay.ageMs < leaderFreshMs &&
    relay.reached?.includes(selfId) === true
  );
}

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
  private readonly failing = new Set<string>();
  private state: { role: DaemonRelayState["role"]; activeAt: number | null; reached: string[]; changed: number } = {
    role: "idle",
    activeAt: null,
    reached: [],
    changed: 0,
  };
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
    const peers = await readPeers(this.options.home, () => {}).catch(() => []);
    return {
      ...this.state,
      capable: peers.length > 0,
      ageMs: this.state.activeAt === null ? null : this.now - this.state.activeAt,
      reachable: this.state.reached.length,
    };
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
      this.failing.delete(peer.serverId);
      return client;
    } catch (error) {
      // A host that is off must not cost a connection attempt every minute.
      this.retryAt.set(peer.serverId, this.now + offlineRetryMs);
      // Only the error name, once per outage: the message may quote the connection details.
      if (!this.failing.has(peer.serverId)) {
        this.failing.add(peer.serverId);
        this.log(`${peer.serverId.slice(0, 12)} 연결 실패: ${error instanceof Error ? error.name : "unknown"}`);
      }
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
    this.state.reached = [];
  }
  private async pass() {
    if (!(await this.options.enabled().catch(() => false))) return this.idle();
    const peers = rankPeers(await readPeers(this.options.home, (message) => this.log(message.replace("[settings-sync] ", ""))));
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
      if (leadsFor((answer as { daemonRelay?: Partial<DaemonRelayState> } | null)?.daemonRelay, selfId)) {
        this.closeAll(peer.serverId);
        this.setRole("standby", peer.serverId);
        this.state.activeAt = null;
        this.state.reached = [];
        return;
      }
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
    for (const [serverId, { client }] of this.clients) if (!client.isConnected) this.close(serverId);
    if (!result.peers) return this.idle();
    this.setRole("leader");
    this.state.activeAt = this.now;
    this.state.reached = result.reached;
    this.state.changed = result.changed;
    if (result.changed) this.log(`다른 호스트로 인증 ${result.changed}건 전달`);
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
