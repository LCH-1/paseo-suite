import { startCredentialRelay } from "./credential-relay";

interface RelayLease { owners: Set<symbol>; dispose(): void; }
export function contributeRelay() {
  const runtime = globalThis as typeof globalThis & {
    __r?: (id: number) => any;
    __PASEO_SYNC_CREDENTIAL_RELAY__?: RelayLease;
  };
  if (typeof document === "undefined" || !runtime.__r) return () => {};
  const owner = Symbol();
  if (!runtime.__PASEO_SYNC_CREDENTIAL_RELAY__) {
    const request = new AbortController();
    let relay: ReturnType<typeof startCredentialRelay> | undefined;
    const lease: RelayLease = {
      owners: new Set(), dispose() { request.abort(); relay?.dispose(); },
    };
    runtime.__PASEO_SYNC_CREDENTIAL_RELAY__ = lease;
    const scripts = [...new Set(Array.from(document.scripts, (script) => script.src)
      .filter((src) => /\/index-[a-f0-9]+\.js(?:\?.*)?$/.test(src)))];
    void (async () => {
      if (scripts.length !== 1) throw new Error("Settings Sync: 앱 번들을 확인할 수 없습니다.");
      const response = await fetch(scripts[0], { signal: request.signal });
      if (!response.ok) throw new Error("Settings Sync: 앱 번들을 읽을 수 없습니다.");
      const source = await response.text();
      const moduleId = (symbol: string) => {
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
      const sessions = runtime.__r!(moduleId("useSessionStore")).useSessionStore;
      const registry = runtime.__r!(moduleId("pluginRegistry")).pluginRegistry;
      if (request.signal.aborted) return;
      relay = startCredentialRelay(() => Object.entries(sessions.getState().sessions)
        .flatMap(([serverId, session]: [string, any]) => session.client && registry.getSnapshot()
          .some((plugin: any) => plugin.serverId === serverId && ["aster", "settings-sync"].includes(plugin.id) && !plugin.lifetime.signal.aborted)
          ? [{ serverId, client: session.client }] : []));
    })().catch((error) => {
      if (!request.signal.aborted) console.error("[settings-sync] 인증 전달을 시작하지 못했습니다.", error);
    });
  }
  const lease = runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
  lease.owners.add(owner);
  return () => {
    if (!lease.owners.delete(owner) || lease.owners.size) return;
    lease.dispose();
    if (runtime.__PASEO_SYNC_CREDENTIAL_RELAY__ === lease) delete runtime.__PASEO_SYNC_CREDENTIAL_RELAY__;
  };
}
