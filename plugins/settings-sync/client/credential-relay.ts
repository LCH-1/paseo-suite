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
}
interface Status {
  version: 1;
  publicKey: string;
  accounts: AccountStatus[];
  provision?: boolean;
  refresh?: boolean;
  declined?: string[];
}
/** Keep a host's own login until it is this close to expiring; only then look elsewhere. */
const usableMarginMs = 10 * 60_000;
/** Nobody renews an account no session uses, so it would expire on every host at once. */
const renewWithinMs = 5 * 60_000;
const renewEveryMs = 5 * 60_000;
const renewAttempts = new Map<string, number>();
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
  options: { rpcTimeoutMs?: number; renewTimeoutMs?: number; attempts?: Map<string, number> } = {},
) {
  if (signal?.aborted) return { peers: 0, changed: 0 };
  const timeout = options.rpcTimeoutMs ?? 15000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error("Invalid Claude relay deadline");
  const invoke = (peer: RelayPeer, method: string, input: unknown) => invokeWith(peer, method, input, timeout);
  const invokeWith = (peer: RelayPeer, method: string, input: unknown, deadline: number) =>
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
        deadline,
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
  // One host renews, then the loop above delivers it: refresh tokens rotate, so several
  // hosts renewing the same login would invalidate each other.
  const attempts = options.attempts ?? renewAttempts;
  for (const identity of known) {
    const holders = ready
      .flatMap((peer) => {
        const own = peer.status.accounts.find((a) => a.identity === identity);
        return own ? [{ peer, expiry: own.availableExpiresAt ?? own.expiresAt ?? 0 }] : [];
      })
      .sort((a, b) => b.expiry - a.expiry || a.peer.serverId.localeCompare(b.peer.serverId));
    if ((holders[0]?.expiry ?? 0) > now + renewWithinMs) continue;
    if (now - (attempts.get(identity) ?? -Infinity) < renewEveryMs) continue;
    const renewer = holders.find(({ peer }) => peer.status.refresh && peer.endpoint === "sync")?.peer;
    if (!renewer || signal?.aborted) continue;
    attempts.set(identity, now);
    await invokeWith(renewer, "aster.credentials.refresh", { identity }, options.renewTimeoutMs ?? 60000).catch(() => {});
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
