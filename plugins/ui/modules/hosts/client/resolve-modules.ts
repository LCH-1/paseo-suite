import { isModuleId, resolveBundleModules } from "../../../client/bundle-modules";
import moduleMaps from "./module-maps";

export interface HostModuleMap {
  bundle: string;
  runtime: number;
  ordering: number;
  desktop: number;
}

export function parseModuleMap(bundle: string, source: string): HostModuleMap {
  const lines = source.split("\n");
  function moduleId(symbol: string): number {
    const matches = lines.filter(
      (line) =>
        line.includes(`.${symbol}=`) ||
        new RegExp(`Object\\.defineProperty\\([^,]+,["']${symbol}["'],`).test(line),
    );
    if (matches.length !== 1) throw new Error(`호스트 순서 모듈을 확인할 수 없습니다: ${symbol}`);
    const id = matches[0].match(/},(\d+),\[[^\]]*\]\);?$/);
    if (!id) throw new Error(`호스트 순서 모듈 ID를 확인할 수 없습니다: ${symbol}`);
    return Number(id[1]);
  }
  return {
    bundle,
    runtime: moduleId("getHostRuntimeStore"),
    ordering: moduleId("orderHostsLocalFirst"),
    desktop: moduleId("getDesktopDaemonStatus"),
  };
}

/** IDs remembered for this bundle are reused, and new ones remembered, only while `matches` finds the host exports behind them. */
export async function resolveModuleMap(
  scripts: readonly string[],
  readSource: (url: string) => Promise<string>,
  knownMaps: readonly HostModuleMap[] = moduleMaps,
  matches: (ids: HostModuleMap) => boolean = () => false,
): Promise<HostModuleMap | undefined> {
  const url = scripts.find((script) => /\/(index-[a-f0-9]+\.js)(?:\?.*)?$/.test(script));
  if (!url) return undefined;
  const bundle = url.split("?")[0].split("/").pop()!;
  const known = knownMaps.find((entry) => entry.bundle === bundle);
  if (known) return known;
  const resolved = await resolveBundleModules({
    name: "host-order",
    url,
    read: readSource,
    parse: (source) => parseModuleMap(bundle, source),
    accepts: (remembered) => {
      const ids = remembered as Partial<HostModuleMap>;
      return ids.bundle === bundle && isModuleId(ids.runtime) && isModuleId(ids.ordering) &&
        isModuleId(ids.desktop) && matches(ids as HostModuleMap);
    },
  });
  if (matches(resolved.ids)) resolved.confirm();
  return resolved.ids;
}
