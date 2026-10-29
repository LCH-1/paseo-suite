import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { Environment } from "../server/environment";
import { readPluginSettings } from "../server/files";
import { preparePluginState } from "../server/plugin-state";
import type { PluginBackup, Snapshot } from "../shared/model";

const key = "paseo-nest.aster-settings.v1";
const scopes = { hosts: false, preferences: false, providers: false, config: false, plugins: true };
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-plugin-state-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pluginPath = path.join(home, "plugin"), file = path.join(home, "aster/settings.json");
  await mkdir(pluginPath); await mkdir(path.dirname(file));
  await writeFile(path.join(pluginPath, "paseo-plugin.json"), JSON.stringify({ id: "aster" }));
  await writeFile(path.join(pluginPath, "index.server.ts"), "export default function () {}\n");
  const before = JSON.stringify({ command: { file: "local-host-cli", args: ["--local-only"] }, capacities: { claude: 5 }, unrelated: true });
  await writeFile(file, before);
  let config: any = { providers: {}, plugins: { aster: { source: "directory", path: pluginPath, enabled: true } } };
  const api = { config: { get: async () => ({ config: structuredClone(config) }), patch: async (patch: any) => { config = { ...config, ...patch }; return { config }; } } } as unknown as PluginHandlerContext["paseo"];
  let fail = false;
  const environment = new Environment(home, async () => { if (fail) throw new Error("synthetic runtime failure"); });
  const snapshot = await environment.capture(api, { hosts: [], preferences: {} }, scopes);
  return { home, file, before, api, environment, snapshot, fail: () => { fail = true; } };
}

test("Aster backup includes capacities but never a machine-specific command or arbitrary local state", async t => {
  const f = await fixture(t), settings = f.snapshot.plugins[0].settings;
  assert.deepEqual(settings[key], { version: 1, values: { capacities: { claude: 5 } } });
  assert.ok(!JSON.stringify(settings).includes("local-host-cli"));
  assert.ok(!JSON.stringify(settings).includes("unrelated"));
  assert.deepEqual(await readPluginSettings(f.home, "other-plugin"), {});
});

test("Aster restore applies capacities, retains local command, and recaptures without drift", async t => {
  const f = await fixture(t);
  f.snapshot.plugins[0].settings[key].values = { capacities: { claude: 20, "claude-second": 5 } };
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), { ...scopes, merge: false });
  const actual = JSON.parse(await readFile(f.file, "utf8"));
  assert.deepEqual(actual.command, JSON.parse(f.before).command);
  assert.equal(actual.unrelated, true);
  assert.deepEqual(actual.capacities, { claude: 20, "claude-second": 5 });
  const next = await f.environment.capture(f.api, { hosts: [], preferences: {} }, scopes);
  assert.deepEqual(next.plugins[0].settings, f.snapshot.plugins[0].settings);
});

test("failed Aster reload rolls back its own settings file together with official settings", async t => {
  const f = await fixture(t);
  f.snapshot.plugins[0].settings[key].values = { capacities: { claude: 20 } };
  f.fail();
  await assert.rejects(f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), { ...scopes, merge: false }), /runtime failure/);
  assert.equal(await readFile(f.file, "utf8"), f.before);
  assert.deepEqual((await readPluginSettings(f.home, "aster"))[key].values, { capacities: { claude: 5 } });
});

test("legacy backups preserve Aster own settings and concurrent local edits invalidate preview", async t => {
  const f = await fixture(t), fingerprint = await f.environment.fingerprint(f.api, f.snapshot);
  await writeFile(f.file, JSON.stringify({ capacities: { claude: 10 } }));
  await assert.rejects(f.environment.restore(f.api, f.snapshot, fingerprint, { ...scopes, merge: false }), /미리보기/);
  delete f.snapshot.plugins[0].settings[key];
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), { ...scopes, merge: false });
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { capacities: { claude: 10 } });
});

test("Aster cannot import an executable or arbitrary state through the known adapter", async t => {
  const f = await fixture(t);
  const plugin: PluginBackup = structuredClone(f.snapshot.plugins[0]);
  plugin.settings[key].values = { capacities: {}, command: { file: "foreign-command" } };
  await assert.rejects(preparePluginState(f.home, plugin));
  assert.equal(await readFile(f.file, "utf8"), f.before);
});
