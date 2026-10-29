import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

const root = path.resolve(import.meta.dirname, "..");
const app = path.resolve(
  process.argv[2] ?? path.join(root, "dist/installers/win-unpacked"),
);
const resourcesPath = path.join(app, "resources");
const executable = path.join(app, "Paseo.exe");
const temporary = await fs.mkdtemp(
  path.join(os.tmpdir(), "paseo-suite-smoke-"),
);
const home = path.join(temporary, "host");
await fs.mkdir(home);
const previousLocal = process.env.LOCALAPPDATA;
let child, client;
const execute = promisify(execFile);
const runner = path.join(
  resourcesPath,
  "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
);
const cli = path.join(
  resourcesPath,
  "app.asar/node_modules/@getpaseo/cli/dist/index.js",
);
const args = [runner, "node-script", cli, "--home", home];
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  PASEO_HOME: home,
  PASEO_LISTEN: "127.0.0.1:0",
  PASEO_RELAY_ENABLED: "false",
  USERPROFILE: path.join(temporary, "user"),
  LOCALAPPDATA: temporary,
  PASEO_NODE_ENV: "production",
};
for (const key of Object.keys(env))
  if (
    /^(?:PASEO_AGENT_ID|PASEO_WORKSPACE_ID|PASEO_HOST|ANTHROPIC_|OPENAI_|CODEX_|GH_TOKEN|GITHUB_TOKEN)/.test(
      key,
    )
  )
    delete env[key];
try {
  process.env.LOCALAPPDATA = temporary;
  const { prepare } = await import(
    pathToFileURL(path.join(resourcesPath, "suite/bootstrap.mjs")).href
  );
  await prepare({
    home,
    resourcesPath,
    executable,
    isDaemonRunning: async () => false,
  });
  const config = JSON.parse(
    await fs.readFile(path.join(home, "config.json"), "utf8"),
  );
  assert.equal(Object.keys(config.plugins).length, 3);
  const flags = path.join(
    home,
    "plugin-settings/settings-sync/suite-sync.json",
  );
  await fs.writeFile(
    flags,
    JSON.stringify({ version: 1, values: { backup: false, relay: false } }),
  );
  const log = await fs.open(path.join(temporary, "daemon.log"), "w");
  child = spawn(executable, [...args, "daemon", "run"], {
    env,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  await log.close();
  const deadline = Date.now() + 60000;
  let metadata;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw Error(`Isolated daemon exited: ${child.exitCode}; ${temporary}`);
    metadata = await fs
      .readFile(path.join(home, "paseo.pid"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (metadata?.listen && !metadata.listen.endsWith(":0")) break;
    await delay(200);
  }
  assert.ok(
    metadata?.listen && !metadata.listen.endsWith(":0"),
    `No isolated daemon endpoint: ${temporary}`,
  );
  client = new DaemonClient({
    url: `ws://${metadata.listen}/ws`,
    clientId: "suite-package-smoke",
    reconnect: { enabled: false },
    localCredential: () =>
      fs
        .readFile(path.join(home, "local-credential"), "utf8")
        .then((value) => value.trim()),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await client.connect();
  const plugins = await client.listPlugins();
  assert.deepEqual(plugins.map((plugin) => plugin.id).sort(), [
    "aster",
    "settings-sync",
    "terminal-tabs",
  ]);
  for (const plugin of plugins)
    assert.equal(
      plugin.status,
      "running",
      `${plugin.id}: ${plugin.error ?? plugin.status}`,
    );
  const catalog = await client.getPluginCatalog();
  assert.ok(
    catalog.some((plugin) => plugin.id === "claude-usage-source") &&
      !catalog.some((plugin) => plugin.id === "claude-windows-usage"),
    "One built-in Claude engine must own Windows compatibility",
  );
  assert.deepEqual(
    await client.invokePluginRpc(
      "claude-usage-source",
      "claude.profiles.read.request",
      { providerIds: [] },
    ),
    { version: 1, profiles: [] },
  );
  await assert.rejects(
    client.invokePluginRpc(
      "settings-sync",
      "sync.credentials.status.request",
      {},
    ),
    /비활성|disabled/i,
  );
  await assert.rejects(
    client.invokePluginRpc("aster", "aster.credentials.status", {}),
    /비활성|disabled/i,
  );
  console.log(
    JSON.stringify({
      passed: true,
      plugins: plugins.map(({ id, status }) => ({ id, status })),
      builtin: "claude-usage-source",
      compatibilitySource: "claude-windows",
      legacyForwarding: true,
      isolatedHome: temporary,
    }),
  );
} finally {
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocal;
  client?.close();
  if (child && child.exitCode === null) {
    await execute(executable, [...args, "daemon", "stop"], {
      env,
      windowsHide: true,
      timeout: 15000,
    }).catch(() => {
      child.kill();
    });
  }
}
