import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { Environment } from "../server/environment";
import { GitHubConflictError, GitHubVault } from "../server/github";
import { decrypt, decryptLocal, encrypt, encryptLocal } from "../server/crypto";
import { portablePlugin } from "../server/plugin-compat";
import { verifyPlugins } from "../server/plugin-runtime";
import { AutoClient } from "../client/automation";
import { capture, hostKey, type StorageAdapter } from "../client/storage";
import { offStatus } from "../shared/automation";
import { preferenceKeys, type ClientState, type Snapshot, type PluginBackup } from "../shared/model";

const password = "synthetic automation password";
const scopes = { config: true, plugins: true };
const empty = (): ClientState => ({ hosts: [], preferences: {} });
const sourceClient = (): ClientState => ({
  hosts: [{ serverId: "remote-example", label: "remote", password: "synthetic host secret", preferredConnectionId: "relay", connections: [{ id: "relay", type: "relay", relayEndpoint: "relay.example:443", daemonPublicKeyB64: "example" }] }],
  preferences: { "@paseo:app-settings": JSON.stringify({ theme: "light" }) },
});
const snapshot = (): Snapshot => ({ version: 1, createdAt: "2026-10-22T00:00:00.000Z", device: "example", client: sourceClient(), config: { appendSystemPrompt: "remote prompt", providers: { claude: { env: { EXAMPLE_REMOTE: "remote" } } } }, plugins: [] });
const b64 = (value: string) => Buffer.from(value).toString("base64");
const examplePlugin = (): PluginBackup => ({ id: "example", enabled: true, settings: { display: { version: 1, values: { theme: "blue" } } }, files: { "paseo-plugin.json": b64('{"id":"example"}'), "index.server.ts": b64("export default function contribute() {}") } });

function fakeApi(initial: Record<string, unknown>) {
  let config = structuredClone(initial);
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: Record<string, unknown>) => {
      const { removeProviders, ...values } = patch;
      config = { ...config, ...values };
      for (const id of removeProviders as string[] ?? []) delete (config.providers as Record<string, unknown>)[id];
      return { config };
    },
  } } as unknown as PluginHandlerContext["paseo"];
  return { api, current: () => config };
}
class MemoryVault {
  raw: string | null = null;
  sha: string | null = null;
  writes = 0;
  conflicts: string[] | null = null;
  async read() { return { raw: this.raw, sha: this.sha, ...(this.conflicts ? { conflicts: this.conflicts } : {}) }; }
  async write(raw: string, expected: string | null, resolveConflicts = false) {
    assert.equal(expected, this.sha);
    if (this.conflicts && !resolveConflicts) throw new GitHubConflictError();
    this.conflicts = null;
    this.raw = raw; this.sha = `revision-${++this.writes}`; return this.sha;
  }
  asVault() { return this as unknown as GitHubVault; }
}
class MemoryCredentials extends CredentialStore {
  values = new Map<string, string>();
  override async protect(value: string): Promise<SecretReference> { const id = crypto.randomUUID(); this.values.set(id, value); return { kind: "secret-service", value: id }; }
  override async reveal(reference: SecretReference) { const value = this.values.get(reference.value); if (!value) throw Error("locked"); return value; }
  override async remove(reference: SecretReference) { this.values.delete(reference.value); }
}
async function fixture(vault = new MemoryVault(), credentials = new MemoryCredentials()) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-auto-"));
  const environment = new Environment(home, async () => undefined);
  const factory = () => new AutoSync(environment, credentials, () => vault.asVault(), async () => "synthetic token", async () => "example");
  const auto = factory();
  const api = fakeApi({ providers: {}, plugins: {}, appendSystemPrompt: "local" });
  await auto.enable({ login: "example", password, vault: vault.asVault() }, scopes);
  return { home, environment, vault, credentials, factory, auto, ...api };
}

test("automatic source backup is encrypted, persists across restart and uploads only changes", async () => {
  const f = await fixture();
  const first = await f.auto.tick(sourceClient(), f.api);
  assert.equal(first.status.state, "ready"); assert.equal(f.vault.writes, 1);
  assert.deepEqual((await decrypt(f.vault.raw!, password)).client, sourceClient());
  const record = await readFile(path.join(f.home, "settings-sync", "automation.json"), "utf8");
  for (const secret of [password, "synthetic token", "synthetic host secret", "remote-example"]) assert.ok(!record.includes(secret));
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.status()).enabled, true);
  await resumed.tick(sourceClient(), f.api); assert.equal(f.vault.writes, 1);
  await f.api.config.patch({ appendSystemPrompt: "edited" });
  await resumed.tick(sourceClient(), f.api); assert.equal(f.vault.writes, 2);
  await resumed.disable(); assert.equal(f.credentials.values.size, 0);
  assert.equal((await f.factory().status()).enabled, false);
});

for (const selected of ["local", "remote"] as const) test(`forked backups pause automatic restoration until ${selected} is explicitly selected`, async () => {
  const f = await fixture();
  f.vault.raw = await encrypt(snapshot(), password);
  f.vault.sha = "fork-latest";
  f.vault.conflicts = ["fork-latest", "fork-other"];
  const paused = await f.auto.tick(empty(), f.api);
  assert.equal(paused.status.state, "conflict");
  assert.equal(paused.operation, null);
  assert.equal(f.vault.writes, 0);
  assert.equal(f.current().appendSystemPrompt, "local");
  const resolved = await f.auto.tick(empty(), f.api, selected);
  const status = resolved.operation ? await f.auto.acknowledge(resolved.operation.id, resolved.operation.client, f.api) : resolved.status;
  assert.equal(status.state, "ready");
  assert.equal(status.pendingOperations, 0);
  assert.equal(f.vault.conflicts, null);
  assert.equal(f.current().appendSystemPrompt, selected === "local" ? "local" : "remote prompt");
  f.auto.dispose();
});

test("new device restores cloud first, merges hosts/providers and checkpoints without repeated restoration", async () => {
  const vault = new MemoryVault();
  await vault.write(await encrypt(snapshot(), password), null);
  const f = await fixture(vault);
  await f.api.config.patch({ providers: { claude: { env: { EXAMPLE_LOCAL: "local" } }, codex: { env: { EXAMPLE_CODEX: "kept" } } } });
  const target = { hosts: [{ serverId: "unique-target", connections: [{ id: "ssh", type: "remoteSsh", host: "user@example.org" }] }], preferences: {} };
  const operation = (await f.auto.tick(target, f.api)).operation!;
  assert.ok(operation); assert.equal(vault.writes, 1);
  assert.equal((await f.auto.status()).pendingOperations, 1);
  assert.equal(f.current().appendSystemPrompt, "remote prompt");
  assert.deepEqual((f.current().providers as any).claude.env, { EXAMPLE_LOCAL: "local", EXAMPLE_REMOTE: "remote" });
  assert.ok((f.current().providers as any).codex);
  assert.equal(operation.client.hosts.length, 2);
  assert.equal(operation.client.preferences["@paseo:app-settings"], sourceClient().preferences["@paseo:app-settings"]);
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.status()).state, "syncing");
  assert.equal((await resumed.status()).pendingOperations, 1);
  const replay = await resumed.tick(operation.client, f.api);
  assert.equal(replay.operation, null);
  assert.equal(replay.status.state, "ready");
  assert.equal((await resumed.status()).pendingOperations, 0);
  assert.equal(vault.writes, 2);
  assert.equal((await resumed.tick(operation.client, f.api)).operation, null);
  assert.equal(vault.writes, 2);
});

test("simultaneous local/cloud changes pause without overwriting either environment", async () => {
  const f = await fixture();
  await f.auto.tick(empty(), f.api);
  await f.api.config.patch({ appendSystemPrompt: "local edit" });
  await f.vault.write(await encrypt(snapshot(), password), f.vault.sha);
  const result = await f.auto.tick(empty(), f.api);
  assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
  assert.equal(f.current().appendSystemPrompt, "local edit"); assert.equal(f.vault.writes, 2);
  const forced = await f.auto.tick(empty(), f.api, "remote");
  assert.ok(forced.operation);
  assert.equal(f.current().appendSystemPrompt, "remote prompt");
});

test("forced server restoration completes without an app operation when the owner's actual client values already match", async () => {
  const f = await fixture();
  const saved = { ...snapshot(), scopes: { hosts: true, preferences: true, providers: true, config: true, plugins: true } };
  await f.vault.write(await encrypt(saved, password), null);
  let restores = 0;
  const restore = f.environment.restore.bind(f.environment);
  f.environment.restore = async (...args) => { restores++; return restore(...args); };
  const result = await f.auto.tick(sourceClient(), f.api, "remote");
  assert.equal(result.operation, null); assert.equal(result.status.state, "ready");
  assert.equal(result.status.pendingOperations, 0); assert.ok(result.status.lastSyncedAt);
  assert.equal(f.current().appendSystemPrompt, "remote prompt"); assert.equal(f.vault.writes, 1);
  const record = JSON.parse(await readFile(path.join(f.home, "settings-sync", "automation.json"), "utf8"));
  const state = await decryptLocal(record.encrypted, password) as { pending: unknown; lastRevision: string };
  assert.equal(state.pending, null); assert.equal(state.lastRevision, f.vault.sha);
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.tick(sourceClient(), f.api)).status.pendingOperations, 0);
  assert.equal(f.vault.writes, 1); assert.equal(restores, 1);
});

test("a required host or theme change still returns a pending app operation", async () => {
  const f = await fixture();
  await f.vault.write(await encrypt(snapshot(), password), null);
  const result = await f.auto.tick(empty(), f.api, "remote");
  assert.ok(result.operation); assert.equal(result.status.pendingOperations, 1);
  assert.equal(result.status.state, "syncing");
  assert.deepEqual(result.operation.client, sourceClient());
  await assert.rejects(f.auto.acknowledge(result.operation.id, empty(), f.api), /복원 결과가 변경/);
  assert.equal((await f.auto.status()).pendingOperations, 1);
});

test("server-only completion refuses a cloud revision changed while restoring", async () => {
  const f = await fixture();
  await f.vault.write(await encrypt(snapshot(), password), null);
  const restore = f.environment.restore.bind(f.environment);
  f.environment.restore = async (...args) => { const result = await restore(...args); f.vault.sha = "new-concurrent-revision"; return result; };
  const result = await f.auto.tick(sourceClient(), f.api, "remote");
  assert.equal(result.operation, null); assert.equal(result.status.state, "conflict");
  assert.match(result.status.message, /복원 중 백업이 바뀌/);
  assert.equal(result.status.pendingOperations, 1); assert.equal(result.status.lastSyncedAt, null);
  assert.equal(f.vault.writes, 1);
});

test("server-only completion recaptures and rejects server changes after recording the restored digest", async () => {
  const f = await fixture();
  await f.vault.write(await encrypt(snapshot(), password), null);
  const capture = f.environment.capture.bind(f.environment); let captures = 0;
  f.environment.capture = async (...args) => {
    const current = await capture(...args);
    if (++captures === 2) await f.api.config.patch({ appendSystemPrompt: "concurrent local change" });
    return current;
  };
  const result = await f.auto.tick(sourceClient(), f.api, "remote");
  assert.equal(result.operation, null); assert.equal(result.status.state, "conflict");
  assert.match(result.status.message, /복원 결과가 변경/);
  assert.equal(result.status.pendingOperations, 1); assert.equal(result.status.lastSyncedAt, null);
  assert.equal(f.current().appendSystemPrompt, "concurrent local change");
  assert.equal(f.vault.writes, 1); assert.equal(captures, 3);
});

test("server-only completion cannot checkpoint after its owner changes during restore", async () => {
  const f = await fixture();
  await f.vault.write(await encrypt(snapshot(), password), null);
  const nextOwner = crypto.randomUUID();
  const restore = f.environment.restore.bind(f.environment);
  f.environment.restore = async (...args) => { const result = await restore(...args); await f.auto.claim(nextOwner); return result; };
  const result = await f.auto.tick(sourceClient(), f.api, "remote");
  assert.equal(result.operation, null); assert.equal(result.status.state, "conflict");
  assert.match(result.status.message, /담당 앱이나 복원 작업이 변경/);
  assert.equal(result.status.ownerClientId, nextOwner);
  assert.equal(result.status.pendingOperations, 1); assert.equal(result.status.lastSyncedAt, null);
  assert.equal(f.vault.writes, 1);
});

test("locked key store and changed GitHub identity prevent automatic backup", async () => {
  const f = await fixture(); f.auto.dispose();
  const mismatch = new AutoSync(f.environment, f.credentials, () => f.vault.asVault(), async () => "synthetic", async () => "other-account");
  assert.equal((await mismatch.status()).state, "locked");
  assert.equal((await mismatch.tick(empty(), f.api)).status.state, "error");
  assert.equal(f.vault.writes, 0);
  f.credentials.values.clear();
  assert.equal((await f.factory().status()).state, "locked");
});

test("local state cannot be replayed as a cloud backup or decrypted with a different key", async () => {
  const raw = await encryptLocal({ scopes, private: "example" }, password);
  assert.deepEqual(await decryptLocal(raw, password), { scopes, private: "example" });
  await assert.rejects(decrypt(raw, password), /암호/);
  await assert.rejects(decryptLocal(await encrypt(snapshot(), password), password), /암호/);
  await assert.rejects(decryptLocal(raw, "different synthetic key"), /암호/);
});

test("plugin runtime failure rolls back providers, plugin paths and settings", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-runtime-rollback-"));
  const env = new Environment(home, async () => { throw Error("runtime validation failed"); });
  const initial = { providers: {}, plugins: {}, appendSystemPrompt: "original" };
  const api = fakeApi(initial);
  const state = snapshot(); state.plugins = [examplePlugin()];
  await assert.rejects(env.restore(api.api, state, await env.fingerprint(api.api, state), scopes), /runtime validation/);
  assert.deepEqual(api.current(), initial);
  await assert.rejects(readFile(path.join(home, "plugin-settings", "example", "display.json")), { code: "ENOENT" });
});

test("runtime verification rejects failure and requires all enabled plugins running", async () => {
  await assert.rejects(verifyPlugins("unused", [{ id: "example", path: "/restored" }], async () => [{ id: "example", path: "/restored", status: "failed" }]), /example/);
  await verifyPlugins("unused", [{ id: "example", path: "/restored" }], async () => [{ id: "example", path: "/restored", status: "running" }]);
  let reads = 0;
  await verifyPlugins("unused", [{ id: "example", path: "/restored" }], async () => [{ id: "example", path: ++reads === 1 ? "/original" : "/restored", status: reads === 1 ? "failed" : "running" }]);
  assert.equal(reads, 2);
  await verifyPlugins("unused", [], async () => { throw Error("must not execute"); });
});

test("old plugin backups get SDK type adapters without source dependencies; unsupported imports fail", () => {
  const original = examplePlugin();
  original.files["client/view.tsx"] = b64('import type { PaseoApi as Api, PaseoAgent } from "@getpaseo/client";\nexport type Value = Api;');
  const portable = portablePlugin(original);
  assert.ok(portable.files["client/paseo-sync-types.d.ts"]);
  assert.match(Buffer.from(portable.files["client/view.tsx"], "base64").toString(), /\.\/paseo-sync-types.d.ts/);
  assert.equal(original.files["client/paseo-sync-types.d.ts"], undefined);
  assert.deepEqual(portablePlugin(portable), portable);
  original.files["client/view.tsx"] = b64('import type { UnknownType } from "@getpaseo/client";');
  assert.throws(() => portablePlugin(original), /지원하지 않는/);
});

test("Windows DPAPI protects synthetic keys for the current user", { skip: process.platform !== "win32" }, async () => {
  const store = new CredentialStore();
  const reference = await store.protect(password);
  assert.equal(reference.kind, "dpapi"); assert.notEqual(reference.value, password);
  assert.equal(await new CredentialStore().reveal(reference), password);
  await store.remove(reference);
});

test("client restores hosts/theme, acknowledges actual storage and marks one window refresh", async () => {
  const values = new Map<string, string>();
  const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  values.set(hostKey, JSON.stringify([{ serverId: "local:target", connections: [{ id: "pipe", type: "directPipe" }] }]));
  let pending = true; let acknowledged = 0;
  const clientId = "26b0162d-1cd6-45d3-9a75-267f094a9e05";
  const ready = { ...offStatus, enabled: true, login: "example", state: "ready" as const, ownerClientId: clientId };
  const client = new AutoClient({
    status: async () => ready, enable: async () => ready, disable: async () => offStatus,
    tick: async () => ({ status: ready, operation: pending ? { id: crypto.randomUUID(), client: sourceClient() } : null }),
    acknowledge: async (input) => { assert.deepEqual(input.client, { ...sourceClient(), preferenceCoverage: [...preferenceKeys], hostSettings: { hosts: [{ serverId: "local:target" }, { serverId: "remote-example", label: "remote" }], order: null }, localHostIds: ["local:target"] }); acknowledged++; pending = false; return ready; },
  }, () => storage, null, clientId);
  await client.synchronize();
  assert.equal(acknowledged, 1); assert.equal(client.getSnapshot().needsReload, true);
  assert.equal(JSON.parse(values.get(hostKey)!).length, 2);
  assert.deepEqual(capture(storage), { ...sourceClient(), preferenceCoverage: [...preferenceKeys], hostSettings: { hosts: [{ serverId: "local:target" }, { serverId: "remote-example", label: "remote" }], order: null }, localHostIds: ["local:target"] });
  await client.synchronize(); assert.equal(acknowledged, 1);
  client.dispose();
});

test("plugin code updates reach connected and returning offline devices without manual reinstall", async () => {
  const source = await fixture();
  const target = await fixture(source.vault);
  const offline = await fixture(source.vault);
  const plugin = examplePlugin();
  const directory = path.join(source.home, "source-plugin");
  await mkdir(directory);
  for (const [name, content] of Object.entries(plugin.files)) await writeFile(path.join(directory, name), Buffer.from(content, "base64"));
  await source.api.config.patch({ plugins: { example: { source: "directory", path: directory, enabled: true } } });
  await source.auto.tick(empty(), source.api);
  const install = await target.auto.tick(empty(), target.api);
  assert.equal(install.operation, null); assert.equal(install.status.pendingOperations, 0);
  assert.equal(install.status.state, "ready");
  const originalTargetPath = (target.current().plugins as any).example.path;
  const updatedCode = "export default function contribute() { return () => undefined; }";
  await writeFile(path.join(directory, "index.server.ts"), updatedCode);
  await source.auto.tick(empty(), source.api);
  assert.equal(source.vault.writes, 2);
  for (const device of [target, offline]) {
    const update = await device.auto.tick(empty(), device.api);
    assert.equal(update.operation, null); assert.equal(update.status.pendingOperations, 0);
    assert.equal(update.status.state, "ready");
    const installed = (device.current().plugins as any).example.path;
    assert.equal(await readFile(path.join(installed, "index.server.ts"), "utf8"), updatedCode);
    assert.equal((await device.auto.tick(empty(), device.api)).operation, null);
  }
  assert.notEqual((target.current().plugins as any).example.path, originalTargetPath);
  assert.equal(source.vault.writes, 2);
});

test("first connection preserves edited source plugins until the original PC is selected", async () => {
  const vault = new MemoryVault();
  const saved = snapshot(); saved.plugins = [examplePlugin()];
  await vault.write(await encrypt(saved, password), null);
  const source = await fixture(vault);
  const directory = path.join(source.home, "development-plugin");
  await mkdir(directory);
  const plugin = examplePlugin();
  const code = "export default function contribute() { return () => undefined; }";
  plugin.files["index.server.ts"] = b64(code);
  for (const [name, content] of Object.entries(plugin.files)) await writeFile(path.join(directory, name), Buffer.from(content, "base64"));
  await source.api.config.patch({ plugins: { example: { source: "directory", path: directory, enabled: true } } });
  const first = await source.auto.tick(empty(), source.api);
  assert.equal(first.status.state, "conflict"); assert.equal(first.operation, null);
  assert.equal((source.current().plugins as any).example.path, directory);
  assert.equal(vault.writes, 1);
  assert.equal((await source.auto.tick(empty(), source.api, "local")).status.state, "ready");
  assert.equal((source.current().plugins as any).example.path, directory);
  assert.equal(Buffer.from((await decrypt(vault.raw!, password)).plugins[0].files["index.server.ts"], "base64").toString(), code);
});

test("connected devices propagate provider and client deletions and later edits in both directions", async () => {
  const source = await fixture();
  const target = await fixture(source.vault);
  await source.api.config.patch({ providers: { claude: { env: { EXAMPLE: "source" } } } });
  await source.auto.tick(sourceClient(), source.api);
  const first = (await target.auto.tick(empty(), target.api)).operation!;
  assert.ok(first);
  await target.auto.acknowledge(first.id, first.client, target.api);
  await source.api.config.patch({ providers: {} });
  await source.auto.tick(empty(), source.api);
  const removal = (await target.auto.tick(first.client, target.api)).operation!;
  assert.ok(removal);
  assert.deepEqual(removal.client, empty());
  assert.deepEqual(target.current().providers, {});
  await target.auto.acknowledge(removal.id, removal.client, target.api);
  assert.equal((await target.auto.status()).pendingOperations, 0);
  await target.api.config.patch({ providers: { codex: { env: { EXAMPLE: "target" } } } });
  await target.auto.tick(empty(), target.api);
  const reverse = await source.auto.tick(empty(), source.api);
  assert.equal(reverse.operation, null); assert.equal(reverse.status.pendingOperations, 0);
  assert.equal(reverse.status.state, "ready");
  assert.deepEqual(source.current().providers, target.current().providers);
  assert.equal((await source.auto.status()).pendingOperations, 0);
  assert.equal((await source.auto.tick(empty(), source.api)).operation, null);
  assert.equal((await target.auto.tick(empty(), target.api)).operation, null);
});
