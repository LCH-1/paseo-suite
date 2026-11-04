export interface ProviderEntry {
  extends?: string;
  enabled?: boolean;
  selectable?: boolean;
  command?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}
export type ProviderEntries = Record<string, ProviderEntry>;

export function providerFamily(id: string, providers: ProviderEntries): string {
  const visited = new Set<string>();
  while (!visited.has(id)) {
    visited.add(id);
    const parent = providers[id]?.extends;
    if (!parent) return id;
    id = parent;
  }
  throw Error("프로바이더 상속 설정에 순환이 있습니다.");
}

/** Aliases stay launchable for existing conversations, but only two roots appear in pickers. */
export function providerPolicy(providers: ProviderEntries) {
  const patch: Record<string, { enabled: boolean; selectable: boolean }> = {};
  const builtins = [
    "claude",
    "codex",
    "copilot",
    "opencode",
    "pi",
    "omp",
    "antigravity",
    "muse",
    "acp",
  ];
  for (const id of new Set([...builtins, ...Object.keys(providers)])) {
    const family = providerFamily(id, providers);
    const enabled = family === "claude" || family === "codex";
    const selectable = enabled && id === family;
    if (
      providers[id]?.enabled !== enabled ||
      providers[id]?.selectable !== selectable
    )
      patch[id] = { enabled, selectable };
  }
  return patch;
}
