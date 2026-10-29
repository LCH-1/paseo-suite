import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { Environment } from "../server/environment";
import { stableString } from "../shared/automation";

type PaseoApi = PluginHandlerContext["paseo"];
const scopes = { plugins: true, config: true };
const b64 = (raw: string) => Buffer.from(raw).toString("base64");
function deepMerge(local: any, incoming: any): any {
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    const result = { ...local };
    for (const [key, value] of Object.entries(incoming)) result[key] = deepMerge(result[key], value);
    return result;
  }
  return structuredClone(incoming);
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-env-sync-"));
  const originalDirectory = path.join(home, "development-plugin");
  const syncDirectory = path.join(home, "sync-plugin");
  const removedDirectory = path.join(home, "local-plugin");
  for (const [directory, id] of [[originalDirectory, "example"], [syncDirectory, "settings-sync"], [removedDirectory, "local"]]) {
    await mkdir(directory);
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id }));
    await writeFile(path.join(directory, "index.server.ts"), "export default function contribute() {}\n");
  }
  await mkdir(path.join(home, "plugin-settings", "example"), { recursive: true });
  await writeFile(path.join(home, "plugin-settings", "example", "display.json"), JSON.stringify({ version: 1, values: { theme: "blue" } }));
  let config: any = {
    providers: { claude: { enabled: true, env: { KEEP: "before", REMOVE: "local" } }, local: { enabled: false } },
    appendSystemPrompt: "before",
    plugins: {
      example: { source: "directory", path: originalDirectory },
      local: { source: "directory", path: removedDirectory, enabled: true },
      "settings-sync": { source: "directory", path: syncDirectory, enabled: true },
    },
  };
  const calls: any[] = [];
  const checked: { id: string; path: string }[][] = [];
  let failRuntime = false;
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: any) => {
      calls.push(structuredClone(patch));
      const { removeProviders = [], ...values } = patch;
      config = deepMerge(config, values);
      if (values.plugins !== undefined) config.plugins = structuredClone(values.plugins);
      for (const id of removeProviders) delete config.providers[id];
      return { config: structuredClone(config) };
    },
  } } as unknown as PaseoApi;
  const environment = new Environment(home, async (_home, plugins) => {
    checked.push(plugins);
    if (failRuntime) throw Error("synthetic runtime failure");
  });
  const snapshot = await environment.capture(api, { hosts: [], preferences: {} });
  return { home, originalDirectory, syncDirectory, removedDirectory, snapshot, environment, api, calls, checked, current: () => config, failRuntime: () => { failRuntime = true; } };
}

test("unchanged plugin code preserves development paths and avoids plugin config changes", async () => {
  const f = await fixture();
  f.snapshot.config.appendSystemPrompt = "remote prompt";
  f.snapshot.client.preferences["@paseo:app-settings"] = JSON.stringify({ theme: "light" });
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.equal(f.current().plugins["settings-sync"].path, f.syncDirectory);
  assert.equal(f.current().appendSystemPrompt, "remote prompt");
  assert.ok(f.calls.every((patch) => patch.plugins === undefined));
  assert.deepEqual(f.checked, [[]]);
  const edited = "export default function contribute() { return () => undefined; }\n";
  await writeFile(path.join(f.originalDirectory, "index.server.ts"), edited);
  const next = await f.environment.capture(f.api, { hosts: [], preferences: {} });
  assert.equal(next.plugins.find((plugin) => plugin.id === "example")!.files["index.server.ts"], b64(edited));
});

test("plugin settings and enabled-state changes retain the original code directory", async () => {
  const f = await fixture();
  const incoming = f.snapshot.plugins.find((plugin) => plugin.id === "example")!;
  incoming.settings.display.values = { theme: "green" };
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.home, "plugin-settings", "example", "display.json"), "utf8")), incoming.settings.display);
  assert.deepEqual(f.checked.at(-1), [{ id: "example", path: f.originalDirectory }]);
  incoming.enabled = false;
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  assert.deepEqual(f.current().plugins.example, { source: "directory", path: f.originalDirectory, enabled: false });
  assert.deepEqual(f.checked.at(-1), []);
  incoming.enabled = true;
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.equal(f.current().plugins.example.enabled, true);
  assert.deepEqual(f.checked.at(-1), [{ id: "example", path: f.originalDirectory }]);
});

test("only changed plugin code is installed in a new directory", async () => {
  const f = await fixture();
  const incoming = f.snapshot.plugins.find((plugin) => plugin.id === "example")!;
  incoming.files["index.server.ts"] = b64("export default function contribute() { return () => undefined; }\n");
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  const installed = f.current().plugins.example.path;
  assert.notEqual(installed, f.originalDirectory);
  assert.equal(f.current().plugins.local.path, f.removedDirectory);
  assert.deepEqual(f.checked.at(-1), [{ id: "example", path: installed }]);
  assert.equal(await readFile(path.join(f.originalDirectory, "index.server.ts"), "utf8"), "export default function contribute() {}\n");
});

test("subsequent sync removes deleted providers, nested fields, plugins and setting keys while preserving Sync", async () => {
  const f = await fixture();
  f.snapshot.plugins = f.snapshot.plugins.filter((plugin) => plugin.id === "example");
  f.snapshot.config.providers = { claude: { enabled: true, env: { KEEP: "after" } } };
  await writeFile(path.join(f.home, "plugin-settings", "example", "removed.json"), JSON.stringify({ version: 1, values: { old: true } }));
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), { ...scopes, merge: false });
  assert.deepEqual(f.current().providers, f.snapshot.config.providers);
  assert.deepEqual(Object.keys(f.current().plugins).sort(), ["example", "settings-sync"]);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.equal(f.current().plugins["settings-sync"].path, f.syncDirectory);
  await assert.rejects(readFile(path.join(f.home, "plugin-settings", "example", "removed.json")), { code: "ENOENT" });
  assert.ok(f.calls.some((patch) => stableString(patch.removeProviders) === stableString(["claude", "local"])));
});

test("initial/manual merge retains local providers, plugins and setting keys", async () => {
  const f = await fixture();
  f.snapshot.plugins = f.snapshot.plugins.filter((plugin) => plugin.id === "example");
  f.snapshot.config.providers = { claude: { env: { KEEP: "after" } } };
  const localSetting = path.join(f.home, "plugin-settings", "example", "local.json");
  await writeFile(localSetting, JSON.stringify({ version: 1, values: { local: true } }));
  await f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes);
  assert.deepEqual(f.current().providers.claude.env, { KEEP: "after", REMOVE: "local" });
  assert.ok(f.current().providers.local);
  assert.ok(f.current().plugins.local);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.ok(await readFile(localSetting, "utf8"));
});

test("failed replacement restores provider fields, plugin paths and deleted settings", async () => {
  const f = await fixture();
  const before = structuredClone(f.current());
  const incoming = f.snapshot.plugins.find((plugin) => plugin.id === "example")!;
  incoming.settings.display.values = { theme: "changed" };
  f.snapshot.plugins = [incoming];
  f.snapshot.config.providers = { claude: { enabled: false, env: { NEW: "new" } }, added: { enabled: true } };
  const setting = path.join(f.home, "plugin-settings", "example", "removed.json");
  const settingRaw = JSON.stringify({ version: 1, values: { keep: true } });
  await writeFile(setting, settingRaw);
  f.failRuntime();
  await assert.rejects(f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), { ...scopes, merge: false }), /synthetic runtime failure/);
  assert.deepEqual(f.current(), before);
  assert.equal(await readFile(setting, "utf8"), settingRaw);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.home, "plugin-settings", "example", "display.json"), "utf8")), { version: 1, values: { theme: "blue" } });
});

test("failed restoration clears optional launch profiles introduced by the failed operation", async () => {
  const f = await fixture();
  f.snapshot.config.terminalProfiles = [{ id: "remote-shell", name: "Remote shell", command: "synthetic-shell" }];
  f.snapshot.config.agentProfiles = [{ id: "remote-agent", name: "Remote agent", provider: "claude" }];
  f.snapshot.plugins[0].files["index.server.ts"] = b64("export default function contribute() { return () => {}; }\n");
  f.failRuntime();
  await assert.rejects(f.environment.restore(f.api, f.snapshot, await f.environment.fingerprint(f.api, f.snapshot), scopes), /synthetic runtime failure/);
  assert.deepEqual(f.current().terminalProfiles, []);
  assert.deepEqual(f.current().agentProfiles, []);
});

test("plugin source edits after preview invalidate restoration without switching the source directory", async () => {
  const f = await fixture();
  const expected = await f.environment.fingerprint(f.api, f.snapshot);
  const edited = "export default function contribute() { return 'edited after preview'; }\n";
  await writeFile(path.join(f.originalDirectory, "index.server.ts"), edited);
  assert.notEqual(await f.environment.fingerprint(f.api, f.snapshot), expected);
  await assert.rejects(f.environment.restore(f.api, f.snapshot, expected, scopes), /미리보기 이후/);
  assert.equal(f.current().plugins.example.path, f.originalDirectory);
  assert.equal(await readFile(path.join(f.originalDirectory, "index.server.ts"), "utf8"), edited);
  assert.equal(f.calls.length, 0);
});
