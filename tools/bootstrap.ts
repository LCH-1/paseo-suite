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

const RELEASE_GRACE_MS = 24 * 60 * 60 * 1000;
const RECENT_CHECKPOINTS = 3;
const RELEASE_NAME = /^[a-f0-9]{64}$/i;
const CHECKPOINT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A removal is a same-directory rename first, so a half-deleted folder never
// keeps a valid name. Leftovers of an interrupted removal are retried here.
const REMOVING =
  /^\.(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-f0-9]{32}\.removing$/i;
const RELEASE_REFERENCE = /releases[\\/]+([a-f0-9]{64})(?![a-f0-9])/gi;
// The packaged main process console reaches no log file, so every run that
// removes, fails or stops is kept here (newest last) for diagnosis.
const CLEANUP_RECORD = "residue-cleanup.json";
const CLEANUP_RECORD_RUNS = 20;

export interface ResidueReport {
  removed: string[];
  failed: Array<{ name: string; code: string }>;
}

async function directories(root: string) {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  // Junctions and symbolic links are reported as links and never followed.
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

async function removeOwned(root: string, name: string, report: ResidueReport) {
  const staging = REMOVING.test(name)
    ? path.join(root, name)
    : path.join(root, `.${name}.${randomUUID().replaceAll("-", "")}.removing`);
  try {
    // Windows refuses this rename only while a process works in the folder or
    // holds a file open there, not for a running exe or a loaded module; the
    // reference checks above are the real protection.
    if (staging !== path.join(root, name))
      await fs.rename(path.join(root, name), staging);
    await fs.rm(staging, { recursive: true, force: true });
    report.removed.push(`${path.basename(root)}/${name}`);
  } catch (error) {
    report.failed.push({
      name: `${path.basename(root)}/${name}`,
      code: (error as NodeJS.ErrnoException).code ?? "unknown",
    });
  }
}

/**
 * Keeps the installed checkpoint plus the newest three distinct rollback points,
 * then every release that is current, younger than 24 hours, or named by the
 * config, installed state or any checkpoint still on disk. A checkpoint whose
 * config.json equals a newer kept one (a failed or interrupted migration copied
 * the same config) restores nothing else, so it takes no place and goes. A
 * checkpoint that survives (or fails removal) keeps its releases, so a retained
 * rollback point never loses its plugins. Without config.json no release is
 * judged unused. A passed report keeps what was already removed when a later
 * step throws.
 */
export async function pruneSuiteResidue(options: {
  home: string;
  releases: string;
  treeHash: string;
  now?: number;
  report?: ResidueReport;
}): Promise<ResidueReport> {
  const report: ResidueReport = options.report ?? { removed: [], failed: [] };
  const now = options.now ?? Date.now();
  const suite = path.join(options.home, "suite");
  const installedText = await optional(path.join(suite, "installed.json"));
  if (installedText === null) return report;
  const installed = JSON.parse(installedText) as { checkpoint?: unknown };
  const current =
    typeof installed.checkpoint === "string"
      ? path.basename(installed.checkpoint).toLowerCase()
      : null;

  const checkpoints = path.join(suite, "checkpoints");
  const candidates: Array<{
    name: string;
    modified: number;
    config: string | null;
  }> = [];
  for (const name of await directories(checkpoints)) {
    if (REMOVING.test(name)) await removeOwned(checkpoints, name, report);
    else if (CHECKPOINT_NAME.test(name)) {
      const body = await optional(path.join(checkpoints, name, "config.json"));
      candidates.push({
        name,
        modified: (await fs.lstat(path.join(checkpoints, name))).mtimeMs,
        config: body === null ? null : hash(body),
      });
    }
  }
  candidates.sort((a, b) => b.modified - a.modified);
  const kept = new Set<string | null>();
  for (const { name, config } of candidates) {
    const installedPoint = name.toLowerCase() === current;
    if (
      !kept.has(config) &&
      (installedPoint || kept.size < RECENT_CHECKPOINTS)
    ) {
      kept.add(config);
      continue;
    }
    if (installedPoint) continue;
    await removeOwned(checkpoints, name, report);
  }

  // Raw text keeps every string, including provider commands and malformed JSON.
  // A missing config (reset or mid-restore) would hide every plugin path in it.
  const config = await optional(path.join(options.home, "config.json"));
  const referenced = new Set([options.treeHash.toLowerCase()]);
  const sources = [
    path.join(suite, "installed.json"),
    path.join(suite, "rolled-back.json"),
    ...(await directories(checkpoints))
      .filter((name) => !REMOVING.test(name))
      .map((name) => path.join(checkpoints, name, "config.json")),
  ];
  for (const text of [config, ...(await Promise.all(sources.map(optional)))])
    for (const match of (text ?? "").matchAll(RELEASE_REFERENCE))
      referenced.add(match[1].toLowerCase());

  for (const name of await directories(options.releases)) {
    if (REMOVING.test(name)) {
      await removeOwned(options.releases, name, report);
      continue;
    }
    if (
      config === null ||
      !RELEASE_NAME.test(name) ||
      referenced.has(name.toLowerCase())
    )
      continue;
    const { mtimeMs } = await fs.lstat(path.join(options.releases, name));
    if (now - mtimeMs < RELEASE_GRACE_MS) continue;
    await removeOwned(options.releases, name, report);
  }
  return report;
}

// The releases folder is shared by every PASEO_HOME of this OS user, so only the
// default home decides which releases are still needed.
function isDefaultHome(home: string) {
  const expected = path.resolve(os.homedir(), ".paseo");
  const actual = path.resolve(home);
  return process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

interface CleanupRun extends ResidueReport {
  at: string;
  treeHash: string;
  error?: string;
}

async function recordCleanup(file: string, run: CleanupRun) {
  let runs: unknown[] = [];
  try {
    const previous = JSON.parse((await optional(file)) ?? "{}") as {
      runs?: unknown;
    };
    if (Array.isArray(previous.runs)) runs = previous.runs;
  } catch {
    // A damaged history is replaced; it never decides what is removed.
  }
  await atomic(
    file,
    JSON.stringify(
      { schemaVersion: 1, runs: [...runs, run].slice(-CLEANUP_RECORD_RUNS) },
      null,
      2,
    ) + "\n",
  );
}

async function cleanupResidue(home: string, release: string, treeHash: string) {
  if (!isDefaultHome(home)) return;
  const run: CleanupRun = {
    at: new Date().toISOString(),
    treeHash,
    removed: [],
    failed: [],
  };
  try {
    await pruneSuiteResidue({
      home,
      releases: path.dirname(release),
      treeHash,
      report: run,
    });
  } catch (error) {
    // Cleanup must never block startup; the next start retries.
    run.error = (error as Error).message ?? String(error);
  }
  if (!run.removed.length && !run.failed.length && !run.error) return;
  const file = path.join(home, "suite", CLEANUP_RECORD);
  const summary =
    `[suite] residue cleanup removed ${run.removed.length}` +
    (run.failed.length
      ? `, kept ${run.failed.length} in use or locked (${run.failed
          .map((entry) => `${entry.name}: ${entry.code}`)
          .join(", ")}); retried at next start`
      : "") +
    (run.error ? `; stopped: ${run.error}` : "");
  if (run.error) console.warn(`${summary} (details: ${file})`);
  else console.info(`${summary} (details: ${file})`);
  try {
    await recordCleanup(file, run);
  } catch (error) {
    console.warn(
      `[suite] residue cleanup record not saved: ${(error as Error).message}`,
    );
  }
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
  ) {
    // A pending native usage switch keeps the old host's sources until restart.
    if (!JSON.parse(oldState).nativeUsagePending)
      await cleanupResidue(home, release, lock.treeHash);
    return;
  }
  const configPath = path.join(home, "config.json");
  const raw = await optional(configPath);
  const config: Config = raw === null ? {} : JSON.parse(raw);
  // On a running old host keep its Windows source alive until a normal daemon
  // restart. No running coding agent is stopped by the distribution installer.
  const migration = planMigration(config, release, {
    fresh: raw === null,
    nativeUsage: !running,
    consolidated: oldState !== null,
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
  // Set before the first plugin is removed or installed on the running host.
  let pluginsTouched = false;
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
          pluginsTouched = true;
          await preserveSettings(id);
          await cli("plugin", "remove", id);
          await restoreSettings(id);
        },
        install: async (id: string, source: PluginSource) => {
          pluginsTouched = true;
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
    // Nothing of this attempt is left to undo, so its checkpoint is no rollback
    // point. Kept, every failed start would add one more copy of the config.
    // A config this attempt wrote and someone then replaced keeps it.
    if (
      !pluginsTouched &&
      (offlineConfig === undefined || (await optional(configPath)) === raw)
    )
      await fs
        .rm(checkpoint, { recursive: true, force: true })
        .catch(() => undefined);
    throw error;
  }
  if (!running) await cleanupResidue(home, release, lock.treeHash);
}
