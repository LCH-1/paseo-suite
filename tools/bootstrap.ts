import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  planMigration,
  transitionPlugins,
  type Config,
  type PluginSource,
  type PluginAdapter,
} from "./migration";

const execute = promisify(execFile);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function optional(file: string) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function atomic(file: string, body: string) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}
interface Context {
  home: string;
  resourcesPath: string;
  executable: string;
  bundlePath?: string;
  isDaemonRunning(): Promise<boolean>;
}
interface Lock {
  schemaVersion: number;
  treeHash: string;
  plugins: Array<{
    id: string;
    name: string;
    files: Array<{ path: string; sha256: string }>;
  }>;
  compatibility?: Lock["plugins"];
}

export async function prepare(context: Context) {
  const { home, executable, resourcesPath } = context;
  const bundle = context.bundlePath ?? path.join(resourcesPath, "suite");
  const lock = JSON.parse(
    await fs.readFile(path.join(bundle, "suite-lock.json"), "utf8"),
  ) as Lock;
  if (
    lock.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(lock.treeHash) ||
    lock.plugins.length !== 3
  )
    throw Error("Invalid Suite lock");
  const { treeHash, ...contents } = lock;
  if (
    hash(JSON.stringify(contents)) !== treeHash ||
    new Set(lock.plugins.map((plugin) => plugin.name)).size !== 3
  )
    throw Error("Suite lock integrity mismatch");
  const release = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local/share"),
    "PaseoSuite/releases",
    lock.treeHash,
  );
  for (const item of [
    ...lock.plugins.map((plugin) => ({ plugin, prefix: "plugins" })),
    ...(lock.compatibility ?? []).map((plugin) => ({
      plugin,
      prefix: "compatibility/plugins",
    })),
  ]) {
    const { plugin, prefix } = item;
    const allowed =
      prefix === "plugins"
        ? ["ui", "aster", "settings-sync"]
        : [
            "terminal-tabs",
            "global-workspace-tabs",
            "host-order",
            "sidebar-title-sync",
            "session-import",
            "aster",
            "claude-windows-usage",
          ];
    if (!allowed.includes(plugin.name)) throw Error("Unexpected Suite plugin");
    for (const file of plugin.files) {
      if (
        !file.path ||
        file.path
          .split(/[\\/]/)
          .some((part) => !part || part === "." || part === "..") ||
        path.isAbsolute(file.path)
      )
        throw Error("Invalid Suite path");
      const source = path.join(bundle, prefix, plugin.name, file.path);
      if (!(await fs.lstat(source)).isFile())
        throw Error("Suite resources must be regular files");
      const body = await fs.readFile(source);
      if (hash(body) !== file.sha256)
        throw Error("Suite plugin integrity mismatch");
      const target = path.join(release, prefix, plugin.name, file.path);
      const existing = await fs
        .readFile(target)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (existing && hash(existing) !== file.sha256)
        throw Error("Installed Suite release was modified");
      if (!existing) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, body, { flag: "wx" });
      }
    }
  }
  const statePath = path.join(home, "suite", "installed.json");
  const oldState = await optional(statePath);
  const running = await context.isDaemonRunning();
  if (
    oldState &&
    JSON.parse(oldState).treeHash === lock.treeHash &&
    (!JSON.parse(oldState).nativeUsagePending || running)
  )
    return;
  const configPath = path.join(home, "config.json");
  const raw = await optional(configPath);
  const config: Config = raw === null ? {} : JSON.parse(raw);
  // On a running old host keep its Windows source alive until a normal daemon
  // restart. No running coding agent is stopped by the distribution installer.
  const migration = planMigration(config, release, {
    fresh: raw === null,
    nativeUsage: !running,
  });
  if (
    running &&
    config.pluginsEnabled === true &&
    Object.entries(migration.config.plugins ?? {}).some(
      ([id, source]) =>
        source.enabled === false && source.path !== config.plugins?.[id]?.path,
    )
  ) {
    throw Error(
      "Suite upgrade preserves disabled plugins and requires an idle host. Close its active sessions and retry after stopping that daemon.",
    );
  }
  const checkpoint = path.join(home, "suite", "checkpoints", randomUUID());
  await fs.mkdir(checkpoint, { recursive: true, mode: 0o700 });
  if (raw !== null)
    await fs.writeFile(path.join(checkpoint, "config.json"), raw, {
      mode: 0o600,
    });
  const settingsFiles: Array<{
    path: string;
    previous: string | null;
    written: string;
  }> = [];
  let onlineAdapter: PluginAdapter | undefined;
  let onlineApplied = false;
  let offlineConfig: string | undefined;
  const seed = async (relative: string, body: string) => {
    const target = path.join(home, relative);
    const previous = await optional(target);
    if (previous !== null) return;
    await atomic(target, body);
    settingsFiles.push({ path: target, previous, written: body });
  };
  const cli = async (...args: string[]) => {
    const runner = path.join(
      resourcesPath,
      "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
    );
    const entrypoint = path.join(
      resourcesPath,
      "app.asar/node_modules/@getpaseo/cli/dist/index.js",
    );
    const result = await execute(
      executable,
      [runner, "node-script", entrypoint, "--home", home, ...args],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_NODE_ENV: "production",
        },
      },
    );
    return result.stdout;
  };
  try {
    await seed(
      "plugin-settings/terminal-tabs/paseo-ui.json",
      JSON.stringify({ version: 1, values: migration.ui }),
    );
    await seed(
      "plugin-settings/settings-sync/suite-sync.json",
      JSON.stringify({ version: 1, values: migration.sync }),
    );
    const oldTitles = await optional(
      path.join(
        home,
        "plugin-settings/sidebar-title-sync/sidebar-title-sync.json",
      ),
    );
    if (oldTitles)
      await seed(
        "plugin-settings/terminal-tabs/sidebar-title-sync.json",
        oldTitles,
      );
    if (!running) {
      const nativeEnabled =
        raw === null ||
        Boolean(
          config.plugins?.["claude-windows-usage"] &&
            config.plugins["claude-windows-usage"].enabled !== false &&
            config.pluginsEnabled === true,
        );
      await seed(
        "plugin-settings/claude-windows-usage/native.json",
        JSON.stringify({ version: 1, values: { enabled: nativeEnabled } }),
      );
    }
    if (running) {
      // Paseo removePlugin also deletes that plugin's settings directory. Keep
      // exact copies available before every remove/install, including rollback.
      const copiedSettings = new Set<string>();
      const preserveSettings = async (id: string) => {
        if (!/^[a-z][a-z0-9-]*$/.test(id)) throw Error("Invalid plugin id");
        if (copiedSettings.has(id)) return;
        const source = path.join(home, "plugin-settings", id);
        const destination = path.join(checkpoint, "plugin-settings", id);
        try {
          await fs.cp(source, destination, {
            recursive: true,
            force: false,
            filter: async (entry) => {
              if ((await fs.lstat(entry)).isSymbolicLink())
                throw Error("Linked plugin settings cannot be migrated");
              return true;
            },
          });
          copiedSettings.add(id);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
      const restoreSettings = async (id: string) => {
        if (copiedSettings.has(id))
          await fs.cp(
            path.join(checkpoint, "plugin-settings", id),
            path.join(home, "plugin-settings", id),
            { recursive: true, force: false, errorOnExist: false },
          );
      };
      const adapter: PluginAdapter = {
        list: async () =>
          Object.fromEntries(
            (
              JSON.parse(await cli("plugin", "ls", "--json")) as Array<{
                id: string;
                path: string;
                enabled: boolean;
              }>
            ).map((item) => [
              item.id,
              {
                source: "directory" as const,
                path: item.path,
                enabled: item.enabled,
              },
            ]),
          ),
        remove: async (id: string) => {
          await preserveSettings(id);
          await cli("plugin", "remove", id);
          await restoreSettings(id);
        },
        install: async (id: string, source: PluginSource) => {
          await restoreSettings(id);
          await cli("plugin", "install", source.path, "--id", id);
          if (source.enabled === false) await cli("plugin", "disable", id);
        },
      };
      onlineAdapter = adapter;
      await transitionPlugins(
        adapter,
        migration.config.plugins ?? {},
        config.plugins ?? {},
      );
      onlineApplied = true;
    } else {
      if (await context.isDaemonRunning())
        throw Error("A daemon started during offline migration; retry");
      if ((await optional(configPath)) !== raw)
        throw Error("Config changed during Suite migration; retry");
      offlineConfig = JSON.stringify(migration.config, null, 2) + "\n";
      await atomic(configPath, offlineConfig);
    }
    await atomic(
      statePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          treeHash: lock.treeHash,
          release,
          checkpoint,
          nativeUsagePending: running,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (error) {
    if (onlineApplied && onlineAdapter)
      await transitionPlugins(
        onlineAdapter,
        config.plugins ?? {},
        migration.config.plugins ?? {},
      );
    if (offlineConfig && (await optional(configPath)) === offlineConfig) {
      if (raw === null) await fs.unlink(configPath);
      else await atomic(configPath, raw);
    }
    for (const file of settingsFiles.reverse()) {
      if ((await optional(file.path)) === file.written)
        await fs.unlink(file.path);
    }
    throw error;
  }
}
