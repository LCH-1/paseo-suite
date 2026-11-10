import { isModuleId, readAppBundle, resolveBundleModules } from "./bundle-modules";
import { peerConnectionsOf, startCredentialRelay, trackRemovedHosts } from "./credential-relay";

// Plugins are replaced one host at a time, so a shared loop must also yield to newer code.
const relayCodeVersion = 3;
interface RelayLease { owners: Set<symbol>; dispose(): void; version?: number; }
interface RelayModules { sessions: number; registry: number; }
export function contributeRelay() {
  const runtime = globalThis as typeof globalThis & {
    __r?: (id: number) => any;
    __PASEO_SYNC_CREDENTIAL_RELAY__?: RelayLease;
  };
  if (typeof document === "undefined" || !runtime.__r) return () => {};
  const owner = Symbol();
  const running = runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
  const outdated = running && (running.version ?? 0) < relayCodeVersion ? running : undefined;
  if (outdated) {
    outdated.dispose();
    delete runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
  }
  if (!runtime.__PASEO_SYNC_CREDENTIAL_RELAY__) {
    const request = new AbortController();
    let relay: ReturnType<typeof startCredentialRelay> | undefined;
    const lease: RelayLease = {
      // Hosts still on the older plugin keep this loop alive until they release it.
      owners: outdated?.owners ?? new Set(), version: relayCodeVersion,
      dispose() {
        request.abort();
        relay?.dispose();
        if (runtime.__PASEO_SYNC_CREDENTIAL_RELAY__ === lease) delete runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
      },
    };
    // Their cleanup calls the old lease, so it has to stop this one.
    if (outdated) outdated.dispose = () => lease.dispose();
    runtime.__PASEO_SYNC_CREDENTIAL_RELAY__ = lease;
    const scripts = [...new Set(Array.from(document.scripts, (script) => script.src)
      .filter((src) => /\/index-[a-f0-9]+\.js(?:\?.*)?$/.test(src)))];
    void (async () => {
      if (scripts.length !== 1) throw new Error("Settings Sync: 앱 번들을 확인할 수 없습니다.");
      const moduleId = (source: string, symbol: string) => {
        const candidates = source.split("\n").filter((line) => {
          const variable = line.match(/^__d\(function\(([^)]*)\)/)?.[1].split(",")[5]?.trim();
          if (!variable) return false;
          const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(?:^|[^\\w$])${escaped}\\.${symbol}\\s*=`).test(line)
            || new RegExp(`Object\\.defineProperty\\(${escaped},["']${symbol}["'],`).test(line);
        });
        if (candidates.length !== 1) throw new Error(`Settings Sync: ${symbol} 모듈을 확인할 수 없습니다.`);
        const match = candidates[0].match(/},(\d+),\[[^\]]*\]\);?$/);
        if (!match) throw new Error(`Settings Sync: ${symbol} 모듈 ID가 없습니다.`);
        return Number(match[1]);
      };
      const load = (ids: RelayModules) => ({
        sessions: runtime.__r!(ids.sessions).useSessionStore,
        registry: runtime.__r!(ids.registry).pluginRegistry,
      });
      const usable = (modules: ReturnType<typeof load>) =>
        typeof modules.sessions?.getState === "function" && typeof modules.registry?.getSnapshot === "function";
      const { ids, confirm } = await resolveBundleModules({
        name: "credential-relay",
        url: scripts[0],
        read: (url) => readAppBundle(url, request.signal),
        parse: (source): RelayModules => ({ sessions: moduleId(source, "useSessionStore"), registry: moduleId(source, "pluginRegistry") }),
        accepts: (remembered) => {
          const ids = remembered as Partial<RelayModules>;
          return isModuleId(ids.sessions) && isModuleId(ids.registry) && usable(load(ids as RelayModules));
        },
      });
      const { sessions, registry } = load(ids);
      if (usable({ sessions, registry })) confirm();
      if (request.signal.aborted) return;
      relay = startCredentialRelay(() => Object.entries(sessions.getState().sessions)
        .flatMap(([serverId, session]: [string, any]) => session.client && registry.getSnapshot()
          .some((plugin: any) => plugin.serverId === serverId && ["aster", "settings-sync"].includes(plugin.id) && !plugin.lifetime.signal.aborted)
          ? [{ serverId, client: session.client }] : []),
        () => {
          try {
            const peers = peerConnectionsOf(JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]"));
            // An empty list means the hosts are not loaded yet, never that all of them were deleted.
            if (!peers.length) return { peers: [], removed: [] };
            return { peers, removed: trackRemovedHosts(localStorage, peers.map((peer) => peer.serverId)) };
          } catch {
            return { peers: [], removed: [] };
          }
        });
    })().catch((error) => {
      if (!request.signal.aborted) console.error("[settings-sync] 인증 전달을 시작하지 못했습니다.", error);
    });
  }
  const lease = runtime.__PASEO_SYNC_CREDENTIAL_RELAY__!;
  lease.owners.add(owner);
  return () => {
    if (!lease.owners.delete(owner) || lease.owners.size) return;
    lease.dispose();
    if (runtime.__PASEO_SYNC_CREDENTIAL_RELAY__ === lease) delete runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
  };
}
