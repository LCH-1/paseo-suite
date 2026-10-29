import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { Environment } from "../server/environment";
import { RestoreConfig } from "../server/restore-config";
import { ProviderCredentialSync } from "../server/provider-credentials";

type Api = PluginHandlerContext["paseo"];
const scopes = { hosts: false, preferences: false, providers: false, config: true, plugins: true };
const setting = (theme: string) => JSON.stringify({ version: 1, values: { theme } });
function merge(before: any, patch: any): any {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const next = { ...before };
  for (const [key, value] of Object.entries(patch)) next[key] = merge(next[key], value);
  return next;
}
async function fixture(t: TestContext, authentication?: ProviderCredentialSync) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-restore-race-"));
  t.after(async () => {
    assert.equal(path.dirname(home), path.resolve(tmpdir()));
    assert.ok(path.basename(home).startsWith("paseo-restore-race-"));
    await rm(home, { recursive: true, force: true });
  });
  const directory = path.join(home, "plugin"), file = path.join(home, "plugin-settings/example/display.json");
  await mkdir(directory); await mkdir(path.dirname(file), { recursive: true });
  await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "example" }));
  await writeFile(path.join(directory, "index.server.ts"), "export default function() {}");
  await writeFile(file, setting("before"));
  let config: any = {
    providers: { custom: { enabled: true, env: { KEEP: "before", OLD: "original" } } },
    metadataGeneration: { providers: [{ provider: "custom", model: "original" }] },
    appendSystemPrompt: "before", browserTools: { enabled: false },
    plugins: { example: { source: "directory", path: directory, enabled: true } },
  };
  let check: () => Promise<void> = async () => {};
  let beforePatch: (patch: any) => Promise<void> = async () => {};
  let afterPatch: (patch: any) => Promise<void> = async () => {};
  const calls: any[] = [];
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: any) => {
      calls.push(structuredClone(patch));
      await beforePatch(patch);
      const { removeProviders = [], ...values } = patch;
      config = merge(config, values);
      if (values.plugins !== undefined) config.plugins = structuredClone(values.plugins);
      for (const id of removeProviders) delete config.providers[id];
      config.metadataGeneration.providers = config.metadataGeneration.providers.filter((entry: any) => !removeProviders.includes(entry.provider));
      await afterPatch(patch);
      return { config: structuredClone(config) };
    },
  } } as unknown as Api;
  const environment = new Environment(home, async () => check(), authentication);
  const snapshot = await environment.capture(api, { hosts: [], preferences: {} }, scopes);
  snapshot.plugins[0].settings.display.values = { theme: "remote" };
  snapshot.config.appendSystemPrompt = "remote";
  return {
    home, directory, file, api, environment, snapshot, calls, current: () => config,
    check: (fn: typeof check) => { check = fn; }, beforePatch: (fn: typeof beforePatch) => { beforePatch = fn; }, afterPatch: (fn: typeof afterPatch) => { afterPatch = fn; },
    restore: async (options = {}) => environment.restore(api, snapshot, await environment.fingerprint(api, snapshot), { ...scopes, ...options }),
  };
}

test("failed restore preserves a concurrent file edit and still rolls back other owned changes", async (t) => {
  const f = await fixture(t);
  const untouched = path.join(path.dirname(f.file), "other.json");
  await writeFile(untouched, setting("other-before"));
  f.snapshot.plugins[0].settings.other = { version: 1, values: { theme: "other-remote" } };
  f.check(async () => { await writeFile(f.file, setting("user-edit")); throw Error("verification failed"); });
  await assert.rejects(f.restore(), AggregateError);
  assert.equal(await readFile(f.file, "utf8"), setting("user-edit"));
  assert.equal(await readFile(untouched, "utf8"), setting("other-before"));
  assert.equal(f.current().appendSystemPrompt, "before");
  assert.equal(f.current().plugins.example.enabled, true);
});

test("rollback preserves changed and unrelated config leaves, provider env and replacement plugin sources", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.current());
  f.snapshot.config.providers = { custom: { enabled: false, env: { KEEP: "remote", NEW: "remote" } } };
  f.check(async () => {
    f.current().appendSystemPrompt = "user-prompt";
    f.current().browserTools.enabled = true;
    f.current().providers.custom.env.KEEP = "user-env";
    f.current().providers.custom.env.EXTRA = "user-added";
    f.current().providers.user = { enabled: true };
    f.current().plugins.example = { source: "directory", path: path.join(f.home, "user-plugin"), enabled: true };
    f.current().plugins.user = { source: "directory", path: path.join(f.home, "extra-plugin"), enabled: false };
    throw Error("verification failed");
  });
  await assert.rejects(f.restore({ providers: true, merge: false }), AggregateError);
  assert.equal(f.current().appendSystemPrompt, "user-prompt");
  assert.equal(f.current().browserTools.enabled, true);
  assert.deepEqual(f.current().providers.custom, { enabled: true, env: { KEEP: "user-env", OLD: "original", EXTRA: "user-added" } });
  assert.deepEqual(f.current().providers.user, { enabled: true });
  assert.equal(f.current().plugins.example.path, path.join(f.home, "user-plugin"));
  assert.equal(f.current().plugins.example.enabled, true);
  assert.ok(f.current().plugins.user);
  assert.deepEqual(f.current().metadataGeneration, original.metadataGeneration);
  assert.equal(await readFile(f.file, "utf8"), setting("before"));
});

test("a user deletion of a restored provider is preserved", async (t) => {
  const f = await fixture(t);
  f.snapshot.config.providers = { custom: { enabled: false } };
  f.check(async () => { delete f.current().providers.custom; throw Error("verification failed"); });
  await assert.rejects(f.restore({ providers: true, merge: false }), AggregateError);
  assert.equal(f.current().providers.custom, undefined);
});

test("settings edited while authentication prepares are preserved before any config or file write", async (t) => {
  let f: Awaited<ReturnType<typeof fixture>>, rollbacks = 0;
  const authentication = {
    restore: async (providers: unknown) => {
      await writeFile(f.file, setting("user-edit-during-auth"));
      return { providers, commit: async () => {}, rollback: async () => { rollbacks++; } };
    },
  } as unknown as ProviderCredentialSync;
  f = await fixture(t, authentication);
  f.snapshot.config.providers = structuredClone(f.current().providers);
  f.snapshot.credentials = { records: [], version: 1 };
  // The fixture has no real credential store; only the auth preparation boundary is under test.
  const fingerprint = f.environment.fingerprint.bind(f.environment);
  f.environment.fingerprint = (api, snapshot) => fingerprint(api, { ...snapshot, credentials: undefined });
  await assert.rejects(f.restore({ providers: true }), /인증 복원 준비 중/);
  assert.equal(f.calls.length, 0);
  assert.equal(await readFile(f.file, "utf8"), setting("user-edit-during-auth"));
  assert.equal(rollbacks, 1);
});

test("a config edit between restore steps aborts without reverting that edit or unwritten settings", async (t) => {
  const f = await fixture(t);
  f.afterPatch(async (patch) => {
    if (patch.plugins?.example.enabled === false) {
      f.current().appendSystemPrompt = "user-prompt";
      await writeFile(f.file, setting("user-before-write"));
      f.afterPatch(async () => {});
    }
  });
  await assert.rejects(f.restore(), /설정/);
  assert.equal(f.current().appendSystemPrompt, "user-prompt");
  assert.equal(await readFile(f.file, "utf8"), setting("user-before-write"));
  assert.equal(f.current().plugins.example.enabled, true);
});

for (const applied of [false, true]) test(`rollback recovers an uncertain native patch failure ${applied ? "after" : "before"} applying`, async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.current());
  f.snapshot.config.providers = { custom: { enabled: false }, added: { enabled: true } };
  const hook = async (patch: any) => {
    if (patch.providers) {
      f.beforePatch(async () => {}); f.afterPatch(async () => {});
      throw Error("native patch failed");
    }
  };
  if (applied) f.afterPatch(hook); else f.beforePatch(hook);
  await assert.rejects(f.restore({ providers: true, merge: false }), /native patch failed/);
  assert.deepEqual(f.current(), original);
  assert.equal(await readFile(f.file, "utf8"), setting("before"));
});

test("provider-only rollback restores metadata references removed by native provider deletion", async (t) => {
  const f = await fixture(t), original = structuredClone(f.current());
  const journal = new RestoreConfig(f.api, original);
  await journal.patch({ removeProviders: ["custom"] });
  assert.deepEqual(f.current().metadataGeneration.providers, []);
  await journal.rollback();
  assert.deepEqual(f.current(), original);
});

test("rollback clears a plugin map introduced on a host without configured plugins", async (t) => {
  const f = await fixture(t);
  delete f.current().plugins;
  const journal = new RestoreConfig(f.api, structuredClone(f.current()));
  await journal.patch({ plugins: { example: { source: "directory", path: f.directory, enabled: true } } });
  await journal.rollback();
  assert.deepEqual(f.current().plugins, {});
});

test("an edit during rollback provider removal is preserved, including metadata and new plugin IDs", async (t) => {
  const f = await fixture(t), original = structuredClone(f.current());
  const journal = new RestoreConfig(f.api, original);
  await journal.patch({ providers: { custom: { env: { KEEP: "remote", NEW: "remote" } } } });
  f.afterPatch(async (patch) => {
    if (patch.removeProviders) {
      f.current().providers.custom = { enabled: false, env: { USER: "during-rollback" } };
      f.current().metadataGeneration.providers = [{ provider: "custom", model: "user-model" }];
      f.current().plugins.user = { source: "directory", path: path.join(f.home, "user-plugin"), enabled: true };
      f.afterPatch(async () => {});
    }
  });
  await assert.rejects(journal.rollback(), /외부에서 수정/);
  assert.deepEqual(f.current().providers.custom, { enabled: false, env: { USER: "during-rollback" } });
  assert.deepEqual(f.current().metadataGeneration.providers, [{ provider: "custom", model: "user-model" }]);
  assert.ok(f.current().plugins.user);
});
