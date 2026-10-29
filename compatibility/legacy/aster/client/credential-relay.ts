export interface RelayClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}
export interface RelayPeer {
  serverId: string;
  client: RelayClient;
}
interface AccountStatus {
  identity: string;
  expiresAt: number | null;
  availableExpiresAt?: number | null;
  revision: string | null;
}
interface Status {
  version: 1;
  publicKey: string;
  accounts: AccountStatus[];
}
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
  options: { rpcTimeoutMs?: number } = {},
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
          return peer.client.invokePluginRpc("aster", method, input);
        })
        .then(
          (value) => finish(value),
          (error) => finish(error, true),
        );
    });
  const loaded = await Promise.allSettled(
    peers.map(async (peer) => ({
      ...peer,
      status: status(await invoke(peer, "aster.credentials.status", {})),
    })),
  );
  const ready = loaded.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  let changed = 0;
  for (const target of ready) {
    for (const account of target.status.accounts) {
      const sources = ready
        .flatMap((source) => {
          const other = source.status.accounts.find((a) => a.identity === account.identity);
          const available = other?.availableExpiresAt ?? other?.expiresAt ?? 0;
          return other && available > Math.max(now + 120000, account.expiresAt ?? 0)
            ? [{ source, expiry: available }]
            : [];
        })
        .sort((a, b) => b.expiry - a.expiry || a.source.serverId.localeCompare(b.source.serverId));
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
  return { peers: ready.length, changed };
}
export function startCredentialRelay(peers: () => RelayPeer[]) {
  const abort = new AbortController();
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
      .then(() => relayCredentials(peers(), Date.now(), abort.signal))
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
