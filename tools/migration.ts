import path from "node:path";

export const uiModules = {
  tabs: "global-workspace-tabs",
  hosts: "host-order",
  import: "session-import",
  titles: "sidebar-title-sync",
  terminal: "terminal-tabs",
} as const;
export interface PluginSource {
  source: "directory";
  path: string;
  enabled?: boolean;
}
export interface Config {
  pluginsEnabled?: boolean;
  plugins?: Record<string, PluginSource>;
  [key: string]: unknown;
}
export interface Migration {
  config: Config;
  ui: { modules: Record<keyof typeof uiModules, boolean> };
  sync: { backup: boolean; relay: boolean };
  retired: string[];
}

/** Pure plan: it neither changes caller objects nor touches settings/auth files. */
export function planMigration(
  config: Config,
  release: string,
  options: {
    fresh?: boolean;
    nativeUsage?: boolean;
    consolidated?: boolean;
  } = {},
): Migration {
  const previous = config.plugins ?? {};
  const enabled = (id: string) =>
    previous[id] ? previous[id].enabled !== false : options.fresh === true;
  const modules = Object.fromEntries(
    Object.entries(uiModules).map(([id, legacy]) => [
      id,
      options.consolidated ? true : enabled(legacy),
    ]),
  ) as Migration["ui"]["modules"];
  // An existing Suite already stores module flags separately. Their defaults
  // must stay unchanged if a settings file is absent; seed() retains saved flags.
  const sync = options.consolidated
    ? { backup: true, relay: true }
    : { backup: enabled("settings-sync"), relay: enabled("aster") };
  const replaced = new Set([
    ...Object.values(uiModules),
    "aster",
    "settings-sync",
  ]);
  const plugins = Object.fromEntries(
    Object.entries(previous).filter(([id]) => !replaced.has(id)),
  );
  plugins["terminal-tabs"] = {
    source: "directory",
    path: path.join(release, "plugins/ui"),
    enabled: options.consolidated
      ? enabled("terminal-tabs")
      : Object.values(modules).some(Boolean),
  };
  plugins.aster = {
    source: "directory",
    path: path.join(release, "plugins/aster"),
    enabled: enabled("aster"),
  };
  plugins["settings-sync"] = {
    source: "directory",
    path: path.join(release, "plugins/settings-sync"),
    enabled: options.consolidated
      ? enabled("settings-sync")
      : sync.backup || sync.relay,
  };
  if (options.nativeUsage) delete plugins["claude-windows-usage"];
  return {
    config: {
      ...config,
      ...(options.fresh && config.pluginsEnabled === undefined
        ? { pluginsEnabled: true }
        : {}),
      plugins,
    },
    ui: { modules },
    sync,
    retired: Object.keys(previous).filter((id) => !(id in plugins)),
  };
}

export interface PluginAdapter {
  list(): Promise<Record<string, PluginSource>>;
  remove(id: string): Promise<void>;
  install(id: string, source: PluginSource): Promise<void>;
}
function equal(
  left: PluginSource | undefined,
  right: PluginSource | undefined,
) {
  return (
    left?.path === right?.path &&
    (left?.enabled !== false) === (right?.enabled !== false) &&
    Boolean(left) === Boolean(right)
  );
}

/** Only the changed plugin entries are rolled back. Concurrent unknown edits survive. */
export async function transitionPlugins(
  adapter: PluginAdapter,
  target: Record<string, PluginSource>,
  expected?: Record<string, PluginSource>,
) {
  const before = await adapter.list();
  const baseline = expected ?? before;
  const changed: Array<{
    id: string;
    allowed: Array<PluginSource | undefined>;
  }> = [];
  try {
    for (const id of new Set([
      ...Object.keys(baseline),
      ...Object.keys(target),
    ])) {
      if (equal(baseline[id], target[id])) continue;
      const fresh = await adapter.list();
      if (!equal(fresh[id], baseline[id]))
        throw new Error(`Plugin changed concurrently: ${id}`);
      const change = { id, allowed: [before[id], undefined, target[id]] };
      changed.push(change);
      if (before[id]) await adapter.remove(id);
      if (target[id]) await adapter.install(id, target[id]);
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const { id, allowed } of changed.reverse()) {
      try {
        const fresh = await adapter.list();
        if (!allowed.some((expected) => equal(fresh[id], expected)))
          throw new Error(`Rollback would replace a concurrent edit: ${id}`);
        if (equal(fresh[id], before[id])) continue;
        if (fresh[id]) await adapter.remove(id);
        if (before[id]) await adapter.install(id, before[id]);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        "Plugin transition and rollback need recovery",
      );
    throw error;
  }
}
