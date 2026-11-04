export interface MenuModuleMap {
  form: number;
  profiles: number;
  registry: number;
  catalog: number;
  profileState: number;
  settings: number;
}

function parseExportModule(source: string, symbol: string, optional = false) {
  const lines = source.split("\n");
  const candidates = lines.flatMap((line) => {
    const factory = line.match(/^__d\(function\(([^)]*)\)/);
    const exported = factory?.[1].split(",")[5]?.trim();
    if (!exported) return [];
    const name = exported.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assigned = new RegExp(`(?:^|[^\\w$])${name}\\.${symbol}\\s*=`).test(
      line,
    );
    const localGetter = new RegExp(
      `Object\\.defineProperty\\(${name},["']${symbol}["'],\\{[^}]*get:function\\(\\)\\{return [\\w$]+\\}\\}`,
    ).test(line);
    return assigned || localGetter ? [line] : [];
  });
  if (optional && candidates.length === 0) return null;
  if (candidates.length !== 1)
    throw new Error(`Aster: 메뉴 모듈을 확인할 수 없습니다: ${symbol}`);
  const id = candidates[0].match(/},(\d+),\[[^\]]*\]\);?$/);
  if (!id)
    throw new Error(`Aster: 메뉴 모듈 ID를 확인할 수 없습니다: ${symbol}`);
  return Number(id[1]);
}

export function parseSessionStoreModule(source: string) {
  return parseExportModule(source, "useSessionStore", true);
}

export function parseMenuModules(source: string): MenuModuleMap {
  return {
    form: parseExportModule(source, "useAgentFormState")!,
    profiles: parseExportModule(source, "useAgentProfilePicker")!,
    registry: parseExportModule(source, "pluginRegistry")!,
    catalog: parseExportModule(source, "useAgentProfileFormCatalog")!,
    profileState: parseExportModule(source, "useAgentProfileFormState")!,
    settings: parseExportModule(source, "useSessionSettings")!,
  };
}

export async function resolveMenuModules(
  scripts: readonly string[],
  readSource: (url: string) => Promise<string>,
) {
  const bundles = [
    ...new Set(
      scripts.filter((script) =>
        /\/(index-[a-f0-9]+\.js)(?:\?.*)?$/.test(script),
      ),
    ),
  ];
  if (bundles.length !== 1)
    throw new Error("Aster: 현재 앱의 메뉴 확장 호환성을 확인할 수 없습니다.");
  return parseMenuModules(await readSource(bundles[0]));
}
