import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decrypt, decryptLocal, encrypt, encryptLocal } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { normalizeScopes, type AutoScopesInput } from "../shared/automation";
import type { ClientState, PluginBackup, Snapshot } from "../shared/model";
import { portableState } from "../shared/portable";

const password = "synthetic scope test password";
const owner = "11111111-1111-4111-8111-111111111111";
const observer = "22222222-2222-4222-8222-222222222222";
const all = normalizeScopes({ config: true, plugins: true });
const none = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
const preferencesOnly = { ...none, preferences: true };
const sourceClient = (): ClientState => ({ hosts: [{ serverId: "synthetic-remote", label: "local host", preferredConnectionId: "relay", connections: [{ id: "relay", type: "relay", relayEndpoint: "example.invalid:443", daemonPublicKeyB64: "synthetic-public-key" }] }], preferences: { "@paseo:app-settings": JSON.stringify({ theme: "light" }) } });
const b64 = (raw: string) => Buffer.from(raw).toString("base64");
const plugin = (): PluginBackup => ({ id: "example", enabled: true, files: { "paseo-plugin.json": b64('{"id":"example"}'), "index.server.ts": b64("export default function contribute() {}\n") }, settings: {} });
const cloud = (): Snapshot => ({ version: 1, createdAt: "2026-10-23T00:00:00.000Z", device: "synthetic-cloud", client: { hosts: [{ serverId: "cloud-host", connections: [{ id: "ssh", type: "remoteSsh", host: "synthetic@example.invalid" }] }], preferences: { "@paseo:app-settings": JSON.stringify({ theme: "dark" }) } }, config: { providers: { claude: { enabled: true, env: { CLOUD: "before" } } }, appendSystemPrompt: "cloud prompt" }, plugins: [plugin()], scopes: all });
function deepMerge(local: any, incoming: any): any {
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    const result = { ...local };
    for (const [key, value] of Object.entries(incoming)) result[key] = deepMerge(result[key], value);
    return result;
  }
  return structuredClone(incoming);
}
class Credentials extends CredentialStore {
  values = new Map<string, string>();
  override async protect(value: string): Promise<SecretReference> { const id = randomUUID(); this.values.set(id, value); return { kind: "secret-service", value: id }; }
  override async reveal(reference: SecretReference) { return this.values.get(reference.value)!; }
  override async remove(reference: SecretReference) { this.values.delete(reference.value); }
}
async function fixture(scopes: AutoScopesInput = all, brokenPlugin = false) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-auto-scopes-"));
  const directory = path.join(home, "source-plugin");
  if (!brokenPlugin) {
    await mkdir(directory);
    for (const [name, raw] of Object.entries(plugin().files)) await writeFile(path.join(directory, name), Buffer.from(raw, "base64"));
  }
  let config: any = { providers: { claude: { enabled: true, env: { LOCAL: "keep" } } }, metadataGeneration: { providers: [{ provider: "claude", model: "synthetic-model" }] }, appendSystemPrompt: "local prompt", plugins: { example: { source: "directory", path: directory, enabled: true } } };
  const calls = { capture: 0, restore: 0, token: 0, read: 0, write: 0 };
  let raw: string | null = null;
  let revision: string | null = null;
  let sequence = 0;
  const vault = {
    read: async () => { calls.read++; return { raw, sha: revision }; },
    write: async (next: string, expected: string | null) => { calls.write++; assert.equal(expected, revision); raw = next; revision = `revision-${++sequence}`; return revision; },
  } as unknown as GitHubVault;
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: any) => {
      const { removeProviders = [], ...values } = patch;
      config = deepMerge(config, values);
      if (values.plugins !== undefined) config.plugins = structuredClone(values.plugins);
      for (const id of removeProviders) {
        delete config.providers[id];
        config.metadataGeneration.providers = config.metadataGeneration.providers.filter((entry: any) => entry.provider !== id);
      }
      return { config: structuredClone(config) };
    },
  } } as unknown as PluginHandlerContext["paseo"];
  const environment = new Environment(home, async () => undefined);
  const capture = environment.capture.bind(environment);
  const restore = environment.restore.bind(environment);
  environment.capture = async (...args) => { calls.capture++; return capture(...args); };
  environment.restore = async (...args) => { calls.restore++; return restore(...args); };
  const credentials = new Credentials();
  const factory = () => new AutoSync(environment, credentials, () => vault, async () => { calls.token++; return "synthetic-token"; }, async () => "example");
  const auto = factory();
  await auto.enable({ login: "example", password, vault }, scopes, owner);
  return { home, directory, environment, auto, api, calls, factory, current: () => config, backup: async () => decrypt(raw!, password), seed: async (snapshot: Snapshot) => { raw = await encrypt(snapshot, password); revision = `seed-${++sequence}`; } };
}
function applyClient(current: ClientState, operation: { client: ClientState; scopes: typeof all }): ClientState {
  return { hosts: operation.scopes.hosts ? operation.client.hosts : current.hosts, preferences: operation.scopes.preferences ? operation.client.preferences : current.preferences };
}

test("all scopes off persists without authentication, capture, cloud traffic or restoration", async () => {
  const f = await fixture(none, true);
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.status()).state, "ready");
  const result = await resumed.tick(sourceClient(), f.api, "local", owner);
  assert.equal(result.status.state, "ready"); assert.equal(result.operation, null);
  assert.deepEqual(result.status.scopes, none);
  assert.deepEqual(f.calls, { capture: 0, restore: 0, token: 0, read: 0, write: 0 });
});

test("preferences-only backup skips a broken disabled plugin and ignores excluded local edits", async () => {
  const f = await fixture(preferencesOnly, true);
  const client = sourceClient();
  assert.equal((await f.auto.tick(client, f.api, undefined, owner)).status.state, "ready");
  const saved = await f.backup();
  assert.deepEqual(saved.scopes, preferencesOnly);
  assert.deepEqual(saved.client.hosts, []); assert.deepEqual(saved.config, {}); assert.deepEqual(saved.plugins, []);
  f.current().providers.claude.env.LOCAL = "changed while disabled";
  f.current().appendSystemPrompt = "disabled prompt edit";
  client.hosts = [];
  assert.equal((await f.auto.tick(client, f.api, undefined, owner)).status.state, "ready");
  assert.equal(f.calls.write, 1); assert.equal(f.calls.restore, 0);
});

test("scoped publication preserves excluded cloud categories and disabled remote edits do not conflict", async () => {
  const f = await fixture(preferencesOnly, true);
  const saved = cloud();
  await f.seed(saved);
  let client = sourceClient();
  const first = await f.auto.tick(client, f.api, undefined, owner);
  assert.ok(first.operation); assert.deepEqual(first.operation.scopes, preferencesOnly);
  client = applyClient(client, first.operation);
  await f.auto.acknowledge(first.operation.id, client, f.api, owner);
  assert.equal(f.calls.restore, 0);
  const changedCloud = await f.backup();
  changedCloud.config.providers = { claude: { env: { CLOUD: "changed remotely" } } };
  await f.seed(changedCloud);
  client.preferences["@paseo:app-settings"] = JSON.stringify({ theme: "automatic" });
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(result.status.state, "ready"); assert.equal(result.operation, null);
  const uploaded = await f.backup();
  assert.deepEqual(uploaded.client.hosts, saved.client.hosts);
  assert.deepEqual(uploaded.config, changedCloud.config);
  assert.deepEqual(uploaded.plugins, saved.plugins);
  assert.deepEqual(uploaded.scopes, all);
  assert.deepEqual(uploaded.client.preferences, client.preferences);
});

test("unavailable cloud categories preserve local values and become available on acknowledgement", async () => {
  const f = await fixture();
  const partial = cloud(); partial.scopes = preferencesOnly; partial.client.hosts = []; partial.config = {}; partial.plugins = [];
  await f.seed(partial);
  let client = sourceClient();
  const providersBefore = structuredClone(f.current().providers);
  const pluginsBefore = structuredClone(f.current().plugins);
  const first = await f.auto.tick(client, f.api, undefined, owner);
  assert.ok(first.operation); assert.deepEqual(first.operation.scopes, preferencesOnly);
  client = applyClient(client, first.operation);
  await f.auto.acknowledge(first.operation.id, client, f.api, owner);
  assert.equal(f.calls.restore, 0);
  assert.deepEqual(f.current().providers, providersBefore); assert.deepEqual(f.current().plugins, pluginsBefore);
  const uploaded = await f.backup();
  assert.deepEqual(uploaded.scopes, all);
  assert.deepEqual(uploaded.client.hosts, sourceClient().hosts);
  assert.deepEqual(uploaded.config.providers, providersBefore);
  assert.equal(uploaded.plugins.length, 1);
  assert.equal((await f.auto.tick(client, f.api, undefined, owner)).operation, null);
});

test("partial cloud availability does not turn unrelated local edits into a conflict", async () => {
  const f = await fixture();
  const client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const partial = await f.backup();
  partial.scopes = preferencesOnly; partial.client.hosts = []; partial.config = {}; partial.plugins = [];
  await f.seed(partial);
  f.current().providers.claude.env.LOCAL = "new local provider value";
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(result.status.state, "ready"); assert.equal(result.operation, null);
  assert.equal(f.calls.restore, 0);
  const uploaded = await f.backup();
  assert.deepEqual(uploaded.scopes, all);
  assert.deepEqual(uploaded.config.providers, f.current().providers);
  assert.equal(uploaded.plugins.length, 1);
});

test("provider-only restoration leaves server settings, metadata choices and broken excluded plugins intact", async () => {
  const scopes = { ...none, providers: true };
  const f = await fixture(scopes, true);
  const beforeMetadata = structuredClone(f.current().metadataGeneration);
  const original = structuredClone(f.current());
  await f.auto.tick(sourceClient(), f.api, undefined, owner);
  const update = await f.backup();
  update.config.providers = { claude: { enabled: false, env: { REMOTE: "new" } } };
  await f.seed(update);
  const result = await f.auto.tick(sourceClient(), f.api, undefined, owner);
  assert.equal(result.operation, null); assert.equal(result.status.pendingOperations, 0);
  assert.equal(result.status.state, "ready");
  assert.deepEqual(f.current().providers, update.config.providers);
  assert.equal(f.current().appendSystemPrompt, original.appendSystemPrompt);
  assert.deepEqual(f.current().metadataGeneration, beforeMetadata);
  assert.deepEqual(f.current().plugins, original.plugins);
});

test("failed provider-only replacement rolls back touched values without reverting unrelated settings", async () => {
  const f = await fixture({ ...none, providers: true }, true);
  const original = structuredClone(f.current());
  const incoming = cloud();
  const patch = f.api.config.patch.bind(f.api.config);
  let failed = false;
  f.api.config.patch = async (values) => {
    if (!failed && values.providers) {
      failed = true;
      f.current().appendSystemPrompt = "concurrent local setting";
      throw Error("synthetic provider failure");
    }
    return patch(values);
  };
  await assert.rejects(f.environment.restore(f.api, incoming, await f.environment.fingerprint(f.api, incoming), { config: false, providers: true, plugins: false, merge: false }), /synthetic provider failure/);
  assert.deepEqual(f.current().providers, original.providers);
  assert.deepEqual(f.current().metadataGeneration, original.metadataGeneration);
  assert.deepEqual(f.current().plugins, original.plugins);
  assert.equal(f.current().appendSystemPrompt, "concurrent local setting");
});

test("owner can configure safe off/on scopes, persists settings and requires a choice before replacing local values", async () => {
  const f = await fixture(preferencesOnly, true);
  let client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const syncedAt = (await f.auto.status()).lastSyncedAt;
  await assert.rejects(f.auto.configure(none, client, f.api, observer), /담당/);
  client.preferences["@paseo:app-settings"] = JSON.stringify({ theme: "changed before configure" });
  await assert.rejects(f.auto.configure({ ...preferencesOnly, hosts: true }, client, f.api, owner), /변경/);
  await f.auto.tick(client, f.api, undefined, owner);
  const latestAt = (await f.auto.status()).lastSyncedAt;
  const disabled = await f.auto.configure(none, client, f.api, owner);
  assert.deepEqual(disabled.scopes, none); assert.equal(disabled.lastSyncedAt, latestAt);
  const writes = f.calls.write;
  const reads = f.calls.read;
  assert.equal((await f.auto.tick(client, f.api, undefined, owner)).status.state, "ready");
  assert.equal(f.calls.write, writes); assert.equal(f.calls.read, reads);
  f.auto.dispose();
  const resumed = f.factory();
  assert.deepEqual((await resumed.status()).scopes, none);
  const remote = await f.backup(); remote.client.preferences["@paseo:app-settings"] = JSON.stringify({ theme: "remote while disabled" });
  await f.seed(remote);
  await resumed.configure(preferencesOnly, client, f.api, owner);
  const enabled = await resumed.tick(client, f.api, undefined, owner);
  assert.equal(enabled.status.state, "conflict"); assert.equal(enabled.operation, null);
  assert.notEqual(client.preferences["@paseo:app-settings"], remote.client.preferences["@paseo:app-settings"]);
  const selected = await resumed.tick(client, f.api, "remote", owner);
  assert.ok(selected.operation);
  client = applyClient(client, selected.operation);
  await resumed.acknowledge(selected.operation.id, client, f.api, owner);
  assert.equal(client.preferences["@paseo:app-settings"], remote.client.preferences["@paseo:app-settings"]);
  assert.equal(f.calls.write, writes);
  assert.ok(syncedAt);
});

test("newly enabled plugin differences pause across restart until the local original is selected", async () => {
  const f = await fixture(preferencesOnly);
  const client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const incoming = cloud(); incoming.client.preferences = client.preferences;
  await f.seed(incoming);
  const original = "export default function contribute() { return 'locally developed'; }\n";
  await writeFile(path.join(f.directory, "index.server.ts"), original);
  await f.auto.configure({ ...preferencesOnly, plugins: true }, client, f.api, owner);
  const first = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(first.status.state, "conflict"); assert.equal(first.operation, null);
  assert.match(first.status.message, /새로 선택/);
  assert.equal(f.calls.restore, 0); assert.equal(f.calls.write, 1);
  assert.equal(await readFile(path.join(f.directory, "index.server.ts"), "utf8"), original);
  f.auto.dispose();
  const resumed = f.factory();
  const afterRestart = await resumed.tick(client, f.api, undefined, owner);
  assert.equal(afterRestart.status.state, "conflict"); assert.equal(afterRestart.operation, null);
  assert.equal(f.calls.restore, 0);
  const selected = await resumed.tick(client, f.api, "local", owner);
  assert.equal(selected.status.state, "ready"); assert.equal(selected.operation, null);
  assert.equal((await f.backup()).plugins[0].files["index.server.ts"], b64(original));
  assert.equal(f.current().plugins.example.path, f.directory);
  const record = JSON.parse(await readFile(path.join(f.home, "settings-sync", "automation.json"), "utf8"));
  assert.equal(Object.hasOwn(await decryptLocal(record.encrypted, password) as object, "reconcileScopes"), false);
  resumed.dispose();
  assert.equal((await f.factory().tick(client, f.api, undefined, owner)).status.state, "ready");
});

test("newly enabled hosts and providers cannot be deleted until cloud is explicitly selected", async () => {
  const f = await fixture(preferencesOnly, true);
  let client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const incoming = cloud(); incoming.client.preferences = client.preferences;
  await f.seed(incoming);
  const scopes = { ...preferencesOnly, hosts: true, providers: true };
  const originalProviders = structuredClone(f.current().providers);
  await f.auto.configure(scopes, client, f.api, owner);
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
  assert.equal(f.calls.restore, 0);
  assert.deepEqual(client.hosts, sourceClient().hosts);
  assert.deepEqual(f.current().providers, originalProviders);
  const selected = await f.auto.tick(client, f.api, "remote", owner);
  assert.ok(selected.operation);
  client = applyClient(client, selected.operation);
  const acknowledged = await f.auto.acknowledge(selected.operation.id, client, f.api, owner);
  assert.equal(acknowledged.state, "ready"); assert.equal(acknowledged.pendingOperations, 0);
  assert.deepEqual(client.hosts, portableState(incoming.client).hosts);
  assert.deepEqual(f.current().providers, incoming.config.providers);
  const record = JSON.parse(await readFile(path.join(f.home, "settings-sync", "automation.json"), "utf8"));
  assert.equal(Object.hasOwn(await decryptLocal(record.encrypted, password) as object, "reconcileScopes"), false);
});

test("already enabled changes reconcile normally when newly enabled data is identical or unavailable", async () => {
  const f = await fixture(preferencesOnly, true);
  let client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const incoming = await f.backup();
  incoming.client.preferences["@paseo:app-settings"] = JSON.stringify({ theme: "remote" });
  incoming.client.hosts = client.hosts;
  incoming.scopes = { ...preferencesOnly, hosts: true };
  await f.seed(incoming);
  const scopes = { ...preferencesOnly, hosts: true, providers: true };
  await f.auto.configure(scopes, client, f.api, owner);
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.ok(result.operation); assert.notEqual(result.status.state, "conflict");
  assert.equal(result.operation.scopes.providers, false);
  client = applyClient(client, result.operation);
  const acknowledged = await f.auto.acknowledge(result.operation.id, client, f.api, owner);
  assert.equal(acknowledged.state, "ready");
  assert.deepEqual(client.preferences, incoming.client.preferences);
  assert.deepEqual((await f.backup()).config.providers, f.current().providers);
});

test("disabling a broken plugin scope never reads its source and retains other scopes", async () => {
  const f = await fixture();
  const client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  f.current().plugins.example.path = `${f.directory}-missing`;
  const scopes = { ...all, plugins: false };
  const configured = await f.auto.configure(scopes, client, f.api, owner);
  assert.deepEqual(configured.scopes, scopes);
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(result.operation, null); assert.equal(result.status.pendingOperations, 0);
  assert.equal(result.status.state, "ready");
  assert.equal(f.current().plugins.example.path, `${f.directory}-missing`);
  assert.equal(f.calls.write, 1);
});

test("turning dirty categories off neither uploads their edits nor discards local values", async () => {
  const f = await fixture();
  let client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const previous = await f.backup();
  f.current().providers.claude.env.LOCAL = "changed but now excluded";
  f.current().appendSystemPrompt = "changed but excluded prompt";
  client.hosts = [];
  const configured = await f.auto.configure(preferencesOnly, client, f.api, owner);
  assert.deepEqual(configured.scopes, preferencesOnly);
  const result = await f.auto.tick(client, f.api, undefined, owner);
  assert.equal(result.operation, null); assert.equal(result.status.pendingOperations, 0);
  assert.equal(result.status.state, "ready");
  const after = await f.backup();
  assert.deepEqual(after.config, previous.config);
  assert.deepEqual(after.client.hosts, previous.client.hosts);
  assert.equal(f.current().providers.claude.env.LOCAL, "changed but now excluded");
  assert.equal(f.current().appendSystemPrompt, "changed but excluded prompt");
  assert.deepEqual(client.hosts, []);
  assert.equal(f.calls.write, 1);
});

test("legacy category baselines reject uncertain retained edits but can disable every scope", async () => {
  const f = await fixture(preferencesOnly, true);
  const client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const file = path.join(f.home, "settings-sync", "automation.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  const state = await decryptLocal(record.encrypted, password) as any;
  delete state.baseline.categories;
  record.encrypted = await encryptLocal(state, password);
  await writeFile(file, JSON.stringify(record));
  f.auto.dispose();
  const resumed = f.factory();
  await assert.rejects(resumed.configure({ ...preferencesOnly, providers: true }, client, f.api, owner), /기존 동기화/);
  assert.deepEqual((await resumed.status()).scopes, preferencesOnly);
  assert.deepEqual((await resumed.configure(none, client, f.api, owner)).scopes, none);
});

test("an unchanged legacy baseline gains category hashes and can configure scopes after restart", async () => {
  const f = await fixture(preferencesOnly, true);
  const client = sourceClient();
  await f.auto.tick(client, f.api, undefined, owner);
  const file = path.join(f.home, "settings-sync", "automation.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  const state = await decryptLocal(record.encrypted, password) as any;
  delete state.baseline.categories;
  record.encrypted = await encryptLocal(state, password);
  await writeFile(file, JSON.stringify(record));
  f.auto.dispose();
  const resumed = f.factory();
  const migrated = await resumed.tick(client, f.api, undefined, owner);
  assert.equal(migrated.status.state, "ready"); assert.equal(migrated.operation, null);
  assert.equal(f.calls.write, 1);
  resumed.dispose();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok((await decryptLocal(saved.encrypted, password) as any).baseline.categories);
  const restarted = f.factory();
  const scopes = { ...preferencesOnly, providers: true };
  assert.deepEqual((await restarted.configure(scopes, client, f.api, owner)).scopes, scopes);
  assert.equal(f.calls.write, 1);
});

test("configure refuses pending restore and legacy scopes migrate with their previous behavior", async () => {
  const f = await fixture({ config: false, plugins: false }, true);
  const file = path.join(f.home, "settings-sync", "automation.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  const state = await decryptLocal(record.encrypted, password) as any;
  state.scopes = { config: false, plugins: false };
  record.encrypted = await encryptLocal(state, password);
  await writeFile(file, JSON.stringify(record));
  f.auto.dispose();
  const resumed = f.factory();
  const incoming = cloud(); incoming.scopes = { ...none, hosts: true, preferences: true }; incoming.config = {}; incoming.plugins = [];
  await f.seed(incoming);
  const result = await resumed.tick(sourceClient(), f.api, undefined, owner);
  assert.deepEqual(result.status.scopes, { ...none, hosts: true, preferences: true });
  assert.ok(result.operation);
  await assert.rejects(resumed.configure(none, sourceClient(), f.api, owner), /진행 중/);
  assert.equal(f.calls.restore, 0);
});
