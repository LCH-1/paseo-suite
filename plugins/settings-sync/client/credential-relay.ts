export interface RelayClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}
export interface RelayPeer {
  serverId: string;
  client: RelayClient;
  endpoint?: "sync" | "aster";
}
interface AccountStatus {
  identity: string;
  expiresAt: number | null;
  availableExpiresAt?: number | null;
  revision: string | null;
  chains?: string[];
}
interface Status {
  version: 1;
  publicKey: string;
  accounts: AccountStatus[];
  provision?: boolean;
  borrow?: boolean;
  platform?: string;
  declined?: string[];
  daemonRelay?: { capable?: boolean; role?: string; activeAt?: number | null; reachable?: number };
}
/** What a daemon needs to reach another host; the app already holds it for every saved host. */
export interface PeerConnection {
  serverId: string;
  relayEndpoint: string;
  useTls: boolean;
  daemonPublicKeyB64: string;
  password?: string;
  platform?: string;
}
export function peerConnectionsOf(registry: unknown): PeerConnection[] {
  if (!Array.isArray(registry)) return [];
  return registry.flatMap((host: any) => {
    const relay = Array.isArray(host?.connections) ? host.connections.find((c: any) => c?.type === "relay") : null;
    if (typeof host?.serverId !== "string" || !relay?.relayEndpoint || !relay.daemonPublicKeyB64) return [];
    return [
      {
        serverId: host.serverId,
        relayEndpoint: String(relay.relayEndpoint),
        useTls: relay.useTls ?? true,
        daemonPublicKeyB64: String(relay.daemonPublicKeyB64),
        ...(typeof host.password === "string" && host.password ? { password: host.password } : {}),
      },
    ];
  });
}
/** A running daemon relay does this work; a window only steps in where it can reach more hosts. */
const daemonRelayFreshMs = 3 * 60_000;
/** Keep a host's own login until it is this close to expiring; only then look elsewhere. */
const usableMarginMs = 10 * 60_000;
function status(value: unknown): Status {
  const s = value as Partial<Status> | null;
  if (
    !s ||
    s.version !== 1 ||
    typeof s.publicKey !== "string" ||
    s.publicKey.length > 8192 ||
    !s.publicKey.startsWith("-----BEGIN PUBLIC KEY-----") ||
    !Array.isArray(s.accounts) ||
    s.accounts.length > 200
  )
    throw Error("Unsupported Claude sharing status");
  const seen = new Set<string>();
  for (const a of s.accounts) {
    if (
      !a ||
      typeof a.identity !== "string" ||
      !/^[a-f0-9]{64}$/.test(a.identity) ||
      seen.has(a.identity) ||
      !(
        a.expiresAt === null ||
        (typeof a.expiresAt === "number" && Number.isFinite(a.expiresAt))
      ) ||
      !(
        a.availableExpiresAt == null ||
        (typeof a.availableExpiresAt === "number" && Number.isFinite(a.availableExpiresAt))
      )
    )
      throw Error("Invalid Claude account ownership");
    seen.add(a.identity);
  }
  return s as Status;
}
export async function relayCredentials(
  peers: readonly RelayPeer[],
  now = Date.now(),
  signal?: AbortSignal,
  options: {
    rpcTimeoutMs?: number;
    connections?: readonly PeerConnection[];
    shared?: Map<string, string>;
    deferToDaemon?: boolean;
  } = {},
) {
  if (signal?.aborted) return { peers: 0, changed: 0 };
  const timeout = options.rpcTimeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error("Invalid Claude relay deadline");
  const invoke = (peer: RelayPeer, method: string, input: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (value: unknown, error = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(value);
        else resolve(value);
      };
      const onAbort = () => finish(new Error("Claude relay disposed"), true);
      const timer = setTimeout(
        () => finish(new Error("Claude relay RPC timed out"), true),
        timeout,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      Promise.resolve()
        .then(() => {
          if (settled) throw Error("Claude relay stopped");
          return peer.client.invokePluginRpc(peer.endpoint === "sync" ? "settings-sync" : "aster",
            peer.endpoint === "sync" ? method.replace("aster.credentials.", "sync.credentials.") + ".request" : method, input);
        })
        .then(
          (value) => finish(value),
          (error) => finish(error, true),
        );
    });
  const loaded = await Promise.allSettled(
    peers.map(async (peer) => {
      // COMPAT(asterCredentialRelay): old hosts retain Aster endpoints until they
      // install the Suite; negotiate each host independently, never resend writes.
      for (const endpoint of peer.endpoint ? [peer.endpoint] : ["sync", "aster"] as const) {
        const candidate = { ...peer, endpoint };
        try { return { ...candidate, status: status(await invoke(candidate, "aster.credentials.status", {})) }; }
        catch (error) { if (endpoint === "aster" || signal?.aborted) throw error; }
      }
      throw Error("Claude relay endpoint unavailable");
    }),
  );
  const ready = loaded.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (options.connections?.length) {
    const connections = options.connections.map((connection) => {
      const platform = ready.find((peer) => peer.serverId === connection.serverId)?.status.platform;
      return platform ? { ...connection, platform } : connection;
    });
    const revision = JSON.stringify(connections);
    for (const peer of ready) {
      if (!peer.status.daemonRelay || peer.endpoint !== "sync" || options.shared?.get(peer.serverId) === revision) continue;
      await invoke(peer, "aster.credentials.peers", { peers: connections }).then(
        () => options.shared?.set(peer.serverId, revision),
        () => {},
      );
    }
  }
  if (
    options.deferToDaemon &&
    ready.some(({ status: { daemonRelay } }) =>
      daemonRelay?.role === "leader" &&
      now - (daemonRelay.activeAt ?? 0) < daemonRelayFreshMs &&
      (daemonRelay.reachable ?? 0) >= ready.length)
  )
    return { peers: ready.length, changed: 0 };
  let changed = 0;
  const usableAfter = now + usableMarginMs;
  const known = [...new Set(ready.flatMap((peer) => peer.status.accounts.map((a) => a.identity)))];
  for (const target of ready) {
    const wanted = [
      // An account this host has but cannot use right now.
      ...target.status.accounts.filter((a) => (a.expiresAt ?? 0) <= usableAfter),
      // An account logged in elsewhere that this host has never seen.
      ...(target.status.provision
        ? known
            .filter(
              (identity) =>
                !target.status.accounts.some((a) => a.identity === identity) &&
                !target.status.declined?.includes(identity),
            )
            .map((identity) => ({ identity, expiresAt: null }))
        : []),
    ];
    for (const account of wanted) {
      const sources = ready
        .flatMap((source) => {
          const other = source.status.accounts.find((a) => a.identity === account.identity);
          const available = other?.availableExpiresAt ?? other?.expiresAt ?? 0;
          return other && available > Math.max(usableAfter, account.expiresAt ?? 0)
            ? [{ source, expiry: available }]
            : [];
        })
        // The host's own healthy alias comes first; other hosts are the fallback.
        .sort(
          (a, b) =>
            Number(b.source === target) - Number(a.source === target) ||
            b.expiry - a.expiry ||
            a.source.serverId.localeCompare(b.source.serverId),
        );
      for (const { source } of sources) {
        if (signal?.aborted) return { peers: ready.length, changed };
        try {
          const envelope = await invoke(source, "aster.credentials.export", {
            publicKey: target.status.publicKey,
            identities: [account.identity],
          });
          if (signal?.aborted) return { peers: ready.length, changed };
          const result = (await invoke(target, "aster.credentials.receive", envelope)) as {
            changed?: unknown;
          };
          if (
            typeof result?.changed !== "number" ||
            !Number.isInteger(result.changed) ||
            result.changed < 0 ||
            result.changed > 2
          )
            throw Error("Invalid Claude relay result");
          changed += result.changed;
          break;
        } catch {
          /* A changed key, in-flight CLI refresh or disconnected host is retried next cycle. */
        }
      }
    }
  }
  // A refresh token on two hosts dies on the first renewal, so only one of them may keep it.
  // Linux hosts stay on, which makes them the better place to keep a login alive.
  const holders = new Map<string, { identity: string; peers: RelayPeer[] }>();
  for (const peer of ready) {
    if (!peer.status.borrow || peer.endpoint !== "sync") continue;
    for (const account of peer.status.accounts) {
      for (const chain of account.chains ?? []) {
        const entry = holders.get(chain) ?? { identity: account.identity, peers: [] };
        entry.peers.push(peer);
        holders.set(chain, entry);
      }
    }
  }
  for (const [chain, { identity, peers: owners }] of holders) {
    if (owners.length < 2 || signal?.aborted) continue;
    const rank = (peer: (typeof ready)[number]) => (peer.status.platform === "win32" ? 1 : 0);
    const [, ...others] = [...owners].sort(
      (a, b) => rank(a as (typeof ready)[number]) - rank(b as (typeof ready)[number]) || a.serverId.localeCompare(b.serverId),
    );
    for (const peer of others) {
      await invoke(peer, "aster.credentials.release", { identity, chain }).catch(() => {});
    }
  }
  return { peers: ready.length, changed };
}
export function startCredentialRelay(peers: () => RelayPeer[], connections?: () => PeerConnection[]) {
  const abort = new AbortController();
  const shared = new Map<string, string>();
  let pending: Promise<unknown> | null = null;
  const state: { lastSuccessAt: number | null; peers: number; changed: number } = {
    lastSuccessAt: null,
    peers: 0,
    changed: 0,
  };
  const tick = () => {
    if (abort.signal.aborted) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() =>
        relayCredentials(peers(), Date.now(), abort.signal, {
          connections: connections?.(),
          shared,
          deferToDaemon: true,
        }),
      )
      .then((result) => {
        if (!abort.signal.aborted)
          Object.assign(state, result, {
            lastSuccessAt: result.peers > 0 ? Date.now() : state.lastSuccessAt,
          });
      })
      .catch(() => {})
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const first = setTimeout(() => void tick(), 1000),
    timer = setInterval(() => void tick(), 45000);
  return {
    tick,
    state,
    dispose() {
      abort.abort();
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
