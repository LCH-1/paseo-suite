import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { transitionPlugins } from "./migration.ts";
const executable = path.resolve(process.argv[2]);
const checkpoint = path.resolve(process.argv[3]);
const home = path.resolve(
  process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
);
const resources = path.join(path.dirname(executable), "resources");
const original = JSON.parse(
  await fs.readFile(path.join(checkpoint, "config.json"), "utf8"),
);
const execute = promisify(execFile);
async function cli(...args) {
  return (
    await execute(
      executable,
      [
        path.join(
          resources,
          "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
        ),
        "node-script",
        path.join(
          resources,
          "app.asar/node_modules/@getpaseo/cli/dist/index.js",
        ),
        "--home",
        home,
        ...args,
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      },
    )
  ).stdout;
}
const saved = new Map();
const adapter = {
  list: async () =>
    Object.fromEntries(
      JSON.parse(await cli("plugin", "ls", "--json")).map((item) => [
        item.id,
        { source: "directory", path: item.path, enabled: item.enabled },
      ]),
    ),
  remove: async (id) => {
    const directory = path.join(home, "plugin-settings", id);
    const files = await fs.readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    saved.set(
      id,
      await Promise.all(
        files
          .filter((name) => name.endsWith(".json"))
          .map(async (name) => [
            name,
            await fs.readFile(path.join(directory, name)),
          ]),
      ),
    );
    await cli("plugin", "remove", id);
    await fs.mkdir(directory, { recursive: true });
    for (const [name, body] of saved.get(id))
      await fs.writeFile(path.join(directory, name), body, { flag: "wx" });
  },
  install: async (id, source) => {
    await cli("plugin", "install", source.path, "--id", id);
    if (source.enabled === false) await cli("plugin", "disable", id);
  },
};
const current = await adapter.list();
const expected = JSON.parse(
  await fs.readFile(path.join(home, "config.json"), "utf8"),
).plugins;
const own = new Set([
  "terminal-tabs",
  "global-workspace-tabs",
  "host-order",
  "session-import",
  "sidebar-title-sync",
  "aster",
  "settings-sync",
  "claude-windows-usage",
]);
const target = { ...current };
for (const id of own) {
  if (original.plugins?.[id]) target[id] = original.plugins[id];
  else delete target[id];
}
await transitionPlugins(adapter, target, expected);
await fs.rename(
  path.join(home, "suite/installed.json"),
  path.join(home, "suite/rolled-back.json"),
);
console.log(
  "Suite plugin sources rolled back; conversations and unrelated configuration retained.",
);
