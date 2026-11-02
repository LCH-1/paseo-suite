import moduleIds from "./usage-modules.json";

interface UsageQuery {
  queryKey: readonly unknown[];
  options: { refetchInterval?: unknown };
  isActive(): boolean;
}
interface UsageQueryClient {
  getQueryCache(): { getAll(): UsageQuery[] };
  refetchQueries(
    filters: { predicate: (query: UsageQuery) => boolean },
    options: { cancelRefetch: false },
  ): Promise<unknown>;
}

/** COMPAT(usagePolling): older Core bundles lack a refresh timer; remove after 2027-05-01. */
export function startUsagePolling(
  queryClient: UsageQueryClient,
  canPollHost: (serverId: string) => boolean,
  shouldRefresh = () => true,
) {
  let stopped = false;
  let pending = false;
  const eligible = (query: UsageQuery) =>
    query.queryKey[0] === "usage" &&
    typeof query.queryKey[1] === "string" &&
    query.isActive() &&
    !query.options.refetchInterval &&
    canPollHost(query.queryKey[1]);
  const refresh = () => {
    if (stopped || pending || !shouldRefresh()) return;
    if (!queryClient.getQueryCache().getAll().some(eligible)) return;
    pending = true;
    void queryClient
      .refetchQueries({ predicate: eligible }, { cancelRefetch: false })
      .catch(() => console.warn("[paseo-ui] Usage auto-refresh failed"))
      .finally(() => {
        pending = false;
      });
  };
  const timer = setInterval(refresh, 60_000);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

export function installUsagePolling() {
  const runtime = globalThis as typeof globalThis & {
    __r?: (id: number) => {
      queryClient?: UsageQueryClient;
      useSessionStore?: {
        getState(): {
          sessions: Record<string, { client?: { isConnected: boolean } }>;
        };
      };
    };
  };
  const bundle = Array.from(document.scripts)
    .map((script) => script.src)
    .map((src) => src.match(/\/index-([a-f0-9]+)\.js(?:\?|$)/)?.[1])
    .find(Boolean);
  const ids = bundle
    ? (moduleIds as Record<string, { queryClient: number; sessions: number }>)[
        bundle
      ]
    : undefined;
  if (!ids || !runtime.__r) return () => {};
  const queryClient = runtime.__r(ids.queryClient).queryClient;
  const sessions = runtime.__r(ids.sessions).useSessionStore;
  if (!queryClient || !sessions) return () => {};
  return startUsagePolling(
    queryClient,
    (serverId) =>
      sessions.getState().sessions[serverId]?.client?.isConnected === true,
  );
}
