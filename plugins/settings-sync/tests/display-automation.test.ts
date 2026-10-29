import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decrypt, decryptLocal, encrypt, encryptLocal } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { clientContent, filterSnapshot, mergeClients, mergeSnapshot, normalizeScopes, replacePortableClient, selectClient, stableString, type AutoScopesInput } from "../shared/automation";
import { legacyPreferenceKeys, preferenceKeys, type ClientState, type Snapshot } from "../shared/model";
import { portableState } from "../shared/portable";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { hostOrderKey, hostPresentationKey, serializeHostPresentationCache } from "../shared/host-settings";

const password = "synthetic display sync password";
const scopes = normalizeScopes({ config: false, plugins: false, providers: false });
const api = {} as PluginHandlerContext["paseo"];
const host = (id: string, label = id): ClientState["hosts"][number] => ({ serverId: id, label, connections: [{ id: `${id}-relay`, type: "relay", relayEndpoint: "synthetic.invalid:443", daemonPublicKeyB64: "synthetic" }], preferredConnectionId: `${id}-relay` });
const legacy = (): ClientState => ({ hosts: [host("srv_a"), host("srv_b")], preferences: { "@paseo:app-settings": '{"theme":"dark"}' } });
const display = (): ClientState => ({ ...legacy(), hostSettings: { hosts: [{ serverId: "srv_a", label: "Host A" }, { serverId: "srv_b", label: "Host B" }], order: ["srv_b", "srv_a"] }, preferenceCoverage: [...preferenceKeys], preferences: { ...legacy().preferences, "sidebar-view": '{"state":{"groupMode":"host"},"version":8}' } });
const snapshot = (client: ClientState, version: Snapshot["version"] = 1): Snapshot => ({ version, createdAt: "2026-10-26T00:00:00.000Z", device: "synthetic", client, config: {}, plugins: [], scopes });

class MemoryVault {
  raw: string | null = null;
  sha: string | null = null;
  writes = 0;
  async read() { return { raw: this.raw, sha: this.sha }; }
  async write(raw: string, expected: string | null) { assert.equal(expected, this.sha); this.raw = raw; return this.sha = `revision-${++this.writes}`; }
  asVault() { return this as unknown as GitHubVault; }
}
class MemoryCredentials extends CredentialStore {
  override async protect(): Promise<SecretReference> { return { kind: "secret-service", value: "synthetic-display-key" }; }
  override async reveal() { return password; }
  override async remove() {}
}
class DisplayEnvironment extends Environment {
  override async capture(_api: typeof api, client: ClientState, input: AutoScopesInput = scopes): Promise<Snapshot> {
    return { ...snapshot(portableState(selectClient(client, input))), scopes: normalizeScopes(input) };
  }
}
async function fixture(vault = new MemoryVault()) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-display-auto-"));
  const credentials = new MemoryCredentials();
  const environment = new DisplayEnvironment(home);
  const factory = () => new AutoSync(environment, credentials, () => vault.asVault(), async () => "synthetic token", async () => "synthetic");
  const auto = factory();
  await auto.enable({ login: "synthetic", password, vault: vault.asVault() }, scopes);
  return { home, vault, auto, factory, async dispose() { auto.dispose(); await rm(home, { recursive: true, force: true }); } };
}

test("host metadata and complete preference availability follow their selected scopes", () => {
  const current = display();
  assert.deepEqual(selectClient(current, { ...scopes, hosts: false, preferences: false }), { hosts: [], preferences: {} });
  assert.equal(selectClient(current, { ...scopes, preferences: false }).preferenceCoverage, undefined);
  assert.equal(selectClient(current, { ...scopes, hosts: false }).hostSettings, undefined);
  assert.equal(filterSnapshot(snapshot(current, 3), { ...scopes, hosts: false }).client.hostSettings, undefined);
});

test("v3 host order is observable while legacy content retains its existing hash representation", () => {
  const current = legacy();
  assert.equal(stableString(clientContent(current)), stableString(clientContent({ ...current, hosts: [...current.hosts].reverse() })));
  const selected = display();
  assert.notEqual(stableString(clientContent(selected)), stableString(clientContent({ ...selected, hosts: [...selected.hosts].reverse() })));
  assert.notEqual(stableString(clientContent(selected)), stableString(clientContent({ ...selected, hostSettings: { ...selected.hostSettings!, order: null } })));
  assert.notEqual(stableString(clientContent(selected)), stableString(clientContent({ ...selected, hostSettings: { ...selected.hostSettings!, hosts: [...selected.hostSettings!.hosts].reverse() } })));
});

test("metadata-only known IDs preserve all target connections and apply names/order without phantom hosts", () => {
  const local = { ...host("srv_a"), connections: [{ id: "pipe", type: "directPipe", path: "synthetic-local-only" }, ...host("srv_a").connections] };
  const current: ClientState = { hosts: [local, host("srv_b"), host("removed")], preferences: {} };
  const incoming: ClientState = { hosts: [], preferences: {}, hostSettings: { hosts: [{ serverId: "srv_b", label: "Second" }, { serverId: "srv_a", label: "Renamed" }, { serverId: "unregistered", label: "Cached" }], order: ["srv_b", "srv_a", "unregistered"] } };
  const restored = replacePortableClient(current, incoming);
  assert.deepEqual(restored.hosts.map((entry) => entry.serverId), ["srv_b", "srv_a"]);
  assert.deepEqual(restored.hosts[1].connections, local.connections);
  assert.equal(restored.hosts[1].label, "Renamed");
  assert.equal(restored.hostSettings!.hosts.length, 3);
  assert.equal(restored.hosts.some((entry) => entry.serverId === "unregistered"), false);
});

test("authoritative display replacement retains surviving physical local hosts without reviving deleted cached metadata", () => {
  const pipe = { serverId: "srv_target_only", label: "Target local", connections: [{ id: "target-pipe", type: "directPipe", path: "synthetic-target" }] };
  const current: ClientState = { hosts: [pipe, host("shared")], preferences: {}, hostSettings: { hosts: [{ serverId: "srv_target_only", label: "Target local" }, { serverId: "shared", label: "shared" }, { serverId: "cached-removed", label: "Delete cache" }], order: ["srv_target_only"] } };
  const incoming: ClientState = { hosts: [host("shared", "Cloud shared")], preferences: {}, hostSettings: { hosts: [{ serverId: "shared", label: "Cloud shared" }], order: null } };
  const desired = replacePortableClient(current, incoming);
  assert.deepEqual(desired.hostSettings!.hosts, [{ serverId: "shared", label: "Cloud shared" }, { serverId: "srv_target_only", label: "Target local" }]);
  assert.deepEqual(desired.hosts.map((entry) => entry.serverId), ["shared", "srv_target_only"]);
  assert.equal(desired.hostSettings!.hosts.some((entry) => entry.serverId === "cached-removed"), false);
  const values = new Map([[hostKey, JSON.stringify(current.hosts)]]);
  const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  restore(storage, desired, { merge: false });
  assert.deepEqual(capture(storage).hostSettings, desired.hostSettings);
});

test("local host identity context is scoped input and never affects shared content", () => {
  const current = { ...display(), localHostIds: ["srv_target_only"] };
  assert.deepEqual(selectClient(current, scopes).localHostIds, current.localHostIds);
  assert.equal(selectClient(current, { ...scopes, hosts: false }).localHostIds, undefined);
  assert.deepEqual(clientContent(current), clientContent(display()));
  assert.equal(mergeSnapshot(null, snapshot(current), scopes).client.localHostIds, undefined);
});

test("legacy incoming applies provided names while preserving display order and uncovered preferences", () => {
  const current = display();
  current.hostSettings!.hosts.push({ serverId: "local-only", label: "Local name", appearance: { color: "blue" } });
  const restored = replacePortableClient(current, legacy());
  assert.deepEqual(restored.hostSettings!.order, current.hostSettings!.order);
  assert.deepEqual(restored.hostSettings!.hosts.map((host) => host.serverId), current.hostSettings!.hosts.map((host) => host.serverId));
  assert.deepEqual(restored.hostSettings!.hosts.at(-1), current.hostSettings!.hosts.at(-1));
  assert.equal(restored.preferences["sidebar-view"], current.preferences["sidebar-view"]);
  assert.equal(restored.hosts[0].label, "srv_a");
  assert.equal(restored.hostSettings!.hosts[0].label, "srv_a");
  const covered = replacePortableClient(current, { ...legacy(), preferenceCoverage: [...preferenceKeys] });
  assert.equal(covered.preferences["sidebar-view"], undefined);
  const reset = replacePortableClient(current, { ...legacy(), hostSettings: { hosts: [...current.hostSettings!.hosts].reverse(), order: null } });
  assert.equal(reset.hostSettings!.order, null);
  assert.deepEqual(reset.hosts.map((entry) => entry.serverId), ["srv_b", "srv_a"]);
});

test("initial client merge combines identities with incoming display metadata and order", () => {
  const current = display();
  current.hostSettings!.hosts.push({ serverId: "local-only", label: "Kept" });
  const incoming: ClientState = { hosts: [], preferences: {}, hostSettings: { hosts: [{ serverId: "srv_b", label: "Cloud" }], order: null } };
  const merged = mergeClients(current, incoming);
  assert.deepEqual(merged.hostSettings!.hosts.map((entry) => entry.serverId), ["srv_b", "srv_a", "local-only"]);
  assert.equal(merged.hostSettings!.order, null);
  assert.equal(merged.hosts[0].label, "Cloud");
});

test("partial publication preserves cloud availability, uncovered values and maximum snapshot version", () => {
  const base = snapshot(display(), 3);
  const current = snapshot(legacy());
  const merged = mergeSnapshot(base, current, scopes);
  assert.equal(merged.version, 3);
  assert.deepEqual(merged.client.hostSettings!.order, base.client.hostSettings!.order);
  assert.equal(merged.client.hostSettings!.hosts[0].label, current.client.hosts[0].label);
  assert.equal(merged.client.preferences["sidebar-view"], base.client.preferences["sidebar-view"]);
  assert.deepEqual(new Set(merged.client.preferenceCoverage), new Set(preferenceKeys));
  const excluded = mergeSnapshot(base, current, { ...scopes, hosts: false, preferences: false });
  assert.deepEqual(excluded.client, base.client);
  assert.equal(mergeSnapshot(snapshot(legacy(), 2), snapshot(display()), scopes).version, 3);
  assert.equal(mergeSnapshot(snapshot(legacy(), 2), current, scopes).version, 2);
});

test("local-only rename and either host order publish once, survive restart and stop with an empty queue", async () => {
  const f = await fixture();
  try {
    const current = display();
    current.hosts = [];
    await f.auto.tick(current, api);
    current.hostSettings!.hosts[0].label = "Gaming renamed";
    assert.equal((await f.auto.tick(current, api)).status.state, "ready");
    assert.equal(f.vault.writes, 2);
    current.hostSettings!.hosts.reverse();
    await f.auto.tick(current, api);
    current.hostSettings!.order = null;
    await f.auto.tick(current, api);
    assert.equal(f.vault.writes, 4);
    assert.equal((await decrypt(f.vault.raw!, password)).version, 3);
    f.auto.dispose();
    const resumed = f.factory();
    const result = await resumed.tick(current, api);
    assert.equal(result.status.state, "ready"); assert.equal(result.status.pendingOperations, 0);
    assert.equal(f.vault.writes, 4);
    resumed.dispose();
  } finally { await f.dispose(); }
});

test("metadata-only cloud restore keeps relay connections and checkpoints only the actual displayed result", async () => {
  const f = await fixture();
  try {
    const target = display();
    await f.auto.tick(target, api);
    const incoming = snapshot({ ...display(), hosts: [], hostSettings: { hosts: [{ serverId: "srv_b", label: "Cloud B" }, { serverId: "srv_a", label: "Cloud A" }, { serverId: "not-installed", label: "Cached" }], order: ["srv_b", "srv_a"] } }, 3);
    await f.vault.write(await encrypt(incoming, password), f.vault.sha);
    const result = await f.auto.tick(target, api);
    assert.ok(result.operation);
    assert.deepEqual(result.operation.client.hosts.map((entry) => entry.serverId), ["srv_b", "srv_a"]);
    assert.equal(result.operation.client.hosts[0].label, "Cloud B");
    assert.deepEqual(result.operation.client.hosts[0].connections, target.hosts[1].connections);
    await assert.rejects(f.auto.acknowledge(result.operation.id, target, api), /복원 결과/);
    const status = await f.auto.acknowledge(result.operation.id, result.operation.client, api);
    assert.equal(status.pendingOperations, 0); assert.equal(status.state, "ready");
    assert.equal((await f.auto.tick(result.operation.client, api)).operation, null);
  } finally { await f.dispose(); }
});

test("legacy server restoration and actual storage capture agree on provided metadata without resetting local-only names or order", async () => {
  const f = await fixture();
  const registered = [
    { ...host("srv_a", "Current A"), appearance: { color: "blue" } },
    host("srv_b", "Current B"),
    { serverId: "srv_local_only", label: "Keep local", appearance: { color: "green" }, connections: [{ id: "local-pipe", type: "directPipe", path: "synthetic-local" }] },
  ];
  const values = new Map([[hostKey, JSON.stringify(registered)], [hostOrderKey, '["srv_local_only","srv_b","srv_a"]']]);
  const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  try {
    const before = capture(storage, scopes);
    await f.auto.tick(before, api);
    const { label: _label, ...withoutPresentation } = host("srv_a");
    const incoming: ClientState = { hosts: [{ ...host("srv_b", "Legacy B"), appearance: { color: "red" } }, withoutPresentation], preferences: {} };
    await f.vault.write(await encrypt(snapshot(incoming), password), f.vault.sha);
    const result = await f.auto.tick(capture(storage, scopes), api);
    assert.ok(result.operation);
    const desired = result.operation.client;
    assert.deepEqual(desired.hostSettings!.order, before.hostSettings!.order);
    assert.deepEqual(desired.hostSettings!.hosts.map((entry) => entry.serverId), before.hostSettings!.hosts.map((entry) => entry.serverId));
    assert.equal(desired.hostSettings!.hosts[0].label, undefined);
    assert.equal(desired.hostSettings!.hosts[0].appearance, undefined);
    assert.deepEqual(desired.hostSettings!.hosts[1].appearance, { color: "red" });
    assert.deepEqual(desired.hostSettings!.hosts[2], before.hostSettings!.hosts[2]);
    restore(storage, desired, { merge: false, ...result.operation.scopes });
    const actual = capture(storage, scopes);
    assert.deepEqual(clientContent(actual), clientContent(desired));
    const status = await f.auto.acknowledge(result.operation.id, actual, api);
    assert.equal(status.pendingOperations, 0); assert.equal(status.state, "ready");
    assert.equal(storage.getItem(hostOrderKey), '["srv_local_only","srv_b","srv_a"]');
    assert.equal((await f.auto.tick(actual, api)).operation, null);
    const initial = mergeClients(before, incoming);
    assert.equal(initial.hostSettings!.hosts[0].label, "Current A");
    assert.deepEqual(initial.hostSettings!.hosts[0].appearance, { color: "blue" });
    assert.equal(initial.hostSettings!.hosts[1].label, "Legacy B");
    assert.deepEqual(initial.hostSettings!.order, before.hostSettings!.order);
  } finally { await f.dispose(); }
});

test("server pending restoration preserves target-only registered metadata, removes deleted cache and acknowledges actual storage", async () => {
  const f = await fixture();
  const pipe = { serverId: "srv_target_only", label: "Target local", appearance: { color: "blue" }, connections: [{ id: "target-pipe", type: "directPipe", path: "synthetic-target" }] };
  const registered = [pipe, host("shared")];
  const cached = { hosts: [{ serverId: "srv_target_only", label: "Target local", appearance: { color: "blue" } }, { serverId: "shared", label: "shared" }, { serverId: "cached-removed", label: "Remove cache" }], order: null };
  const values = new Map([[hostKey, JSON.stringify(registered)], [hostPresentationKey, serializeHostPresentationCache(cached, registered)]]);
  const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  try {
    const before = capture(storage, scopes);
    assert.deepEqual(before.localHostIds, ["srv_target_only"]);
    assert.equal(before.hosts.some((entry) => entry.serverId === "srv_target_only"), false);
    await f.auto.tick(before, api);
    assert.equal((await decrypt(f.vault.raw!, password)).client.localHostIds, undefined);
    const incoming: ClientState = { hosts: [host("shared", "Cloud name")], preferences: {}, preferenceCoverage: [...preferenceKeys], hostSettings: { hosts: [{ serverId: "shared", label: "Cloud name" }], order: null } };
    await f.vault.write(await encrypt(snapshot(incoming, 3), password), f.vault.sha);
    const result = await f.auto.tick(before, api);
    assert.ok(result.operation);
    assert.deepEqual(result.operation.client.hostSettings!.hosts.map((entry) => entry.serverId), ["shared", "srv_target_only"]);
    restore(storage, result.operation.client, { merge: false, ...result.operation.scopes });
    const actual = capture(storage, scopes);
    assert.deepEqual(clientContent(actual), clientContent(result.operation.client));
    assert.deepEqual(actual.localHostIds, ["srv_target_only"]);
    assert.equal(actual.hostSettings!.hosts.some((entry) => entry.serverId === "cached-removed"), false);
    assert.ok(JSON.parse(storage.getItem(hostKey)!).find((entry: { serverId: string }) => entry.serverId === "srv_target_only").connections.some((connection: { id: string }) => connection.id === "target-pipe"));
    const status = await f.auto.acknowledge(result.operation.id, actual, api);
    assert.equal(status.state, "ready"); assert.equal(status.pendingOperations, 0);
    assert.equal((await decrypt(f.vault.raw!, password)).client.localHostIds, undefined);
    const writes = f.vault.writes;
    assert.equal((await f.auto.tick(actual, api)).operation, null);
    assert.equal(f.vault.writes, writes);
  } finally { await f.dispose(); }
});

test("an old baseline upgrades new fields without mistaking uncovered local sidebar values for a simultaneous edit", async () => {
  const f = await fixture();
  try {
    await f.auto.tick(legacy(), api);
    const file = path.join(f.home, "settings-sync", "automation.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    const state = await decryptLocal(record.encrypted, password) as any;
    delete state.baseline.clientFeatures; delete state.baseline.legacyClient; delete state.baseline.legacyCategories;
    await writeFile(file, JSON.stringify({ ...record, encrypted: await encryptLocal(state, password) }));
    f.auto.dispose();
    const resumed = f.factory();
    await f.vault.write(await encrypt(snapshot(legacy()), password), f.vault.sha);
    const upgraded = display();
    upgraded.hostSettings!.hosts = upgraded.hosts.map(({ serverId, label }) => ({ serverId, label }));
    const result = await resumed.tick(upgraded, api);
    assert.equal(result.status.state, "ready"); assert.equal(result.status.pendingOperations, 0);
    assert.equal((await decrypt(f.vault.raw!, password)).version, 3);
    assert.equal((await decrypt(f.vault.raw!, password)).client.preferences["sidebar-view"], display().preferences["sidebar-view"]);
    resumed.dispose();
  } finally { await f.dispose(); }
});

test("new metadata from another upgraded PC requires explicit choice when no display baseline exists", async () => {
  const f = await fixture();
  try {
    await f.auto.tick(legacy(), api);
    const incoming = display(); incoming.hostSettings!.hosts[0].label = "Other PC";
    await f.vault.write(await encrypt(snapshot(incoming, 3), password), f.vault.sha);
    const result = await f.auto.tick(display(), api);
    assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
    assert.equal(f.vault.writes, 2);
  } finally { await f.dispose(); }
});

test("a token-only remote revision cannot checkpoint away newly available display settings before uploading them", async () => {
  const f = await fixture();
  try {
    await f.auto.tick(legacy(), api);
    const incoming: Snapshot = {
      ...snapshot(legacy(), 2), scopes: { ...scopes, providers: true }, config: { providers: { claude: { enabled: true } } },
      credentials: { version: 1, records: [{ id: `claude-${"1".repeat(24)}`, vendor: "claude", providerIds: ["claude"], identity: "a".repeat(64), metadata: {}, updatedAt: 2_100_000_000_000, expiresAt: 2_100_000_000_000, credential: { claudeAiOauth: { accessToken: "synthetic-rotated-access", refreshToken: "synthetic-rotated-refresh", expiresAt: 2_100_000_000_000 } } }] },
    };
    await f.vault.write(await encrypt(incoming, password), f.vault.sha);
    const current = display(); current.hostSettings!.hosts = current.hosts.map(({ serverId, label }) => ({ serverId, label }));
    const result = await f.auto.tick(current, api);
    assert.equal(result.status.state, "ready"); assert.equal(result.status.pendingOperations, 0);
    assert.equal(f.vault.writes, 3);
    const uploaded = await decrypt(f.vault.raw!, password);
    assert.equal(uploaded.version, 3); assert.deepEqual(uploaded.client.hostSettings, current.hostSettings);
    assert.equal(uploaded.client.preferences["sidebar-view"], current.preferences["sidebar-view"]);
    assert.deepEqual(uploaded.credentials, incoming.credentials);
    await f.auto.tick(current, api);
    assert.equal(f.vault.writes, 3);
  } finally { await f.dispose(); }
});

test("legacy pending work resumes after upgrade without deleting newly captured sidebar or host-order settings", async () => {
  const f = await fixture();
  try {
    await f.auto.tick(legacy(), api);
    const incoming = legacy(); incoming.preferences["@paseo:app-settings"] = '{"theme":"light"}';
    await f.vault.write(await encrypt(snapshot(incoming), password), f.vault.sha);
    assert.ok((await f.auto.tick(legacy(), api)).operation);
    const file = path.join(f.home, "settings-sync", "automation.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    const state = await decryptLocal(record.encrypted, password) as any;
    delete state.pending.clientFeatures; delete state.pending.desiredClientFeatures;
    await writeFile(file, JSON.stringify({ ...record, encrypted: await encryptLocal(state, password) }));
    f.auto.dispose();
    const values = new Map([[hostKey, JSON.stringify(legacy().hosts)], ["@paseo:app-settings", legacy().preferences["@paseo:app-settings"]], ["sidebar-view", display().preferences["sidebar-view"]], [hostOrderKey, '["srv_b","srv_a"]']]);
    const storage: StorageAdapter = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
    const resumed = f.factory();
    const result = await resumed.tick(capture(storage, scopes), api);
    assert.ok(result.operation);
    restore(storage, result.operation.client, { merge: false, ...result.operation.scopes });
    const status = await resumed.acknowledge(result.operation.id, capture(storage, scopes), api);
    assert.equal(status.state, "ready"); assert.equal(status.pendingOperations, 0);
    assert.equal(storage.getItem("sidebar-view"), display().preferences["sidebar-view"]);
    assert.equal(storage.getItem(hostOrderKey), '["srv_b","srv_a"]');
    assert.equal((await decrypt(f.vault.raw!, password)).version, 3);
    resumed.dispose();
  } finally { await f.dispose(); }
});

test("host and sidebar edits in different categories merge after a v3 checkpoint", async () => {
  const f = await fixture();
  try {
    const current = display();
    await f.auto.tick(current, api);
    current.hostSettings!.hosts[0].label = "Local changed";
    const incoming = display(); incoming.preferences["sidebar-view"] = '{"state":{"groupMode":"status"},"version":8}';
    await f.vault.write(await encrypt(snapshot(incoming, 3), password), f.vault.sha);
    const result = await f.auto.tick(current, api);
    assert.ok(result.operation);
    const status = await f.auto.acknowledge(result.operation.id, result.operation.client, api);
    assert.equal(status.state, "ready"); assert.equal(status.pendingOperations, 0);
    const merged = (await decrypt(f.vault.raw!, password)).client;
    assert.equal(merged.hostSettings!.hosts[0].label, "Local changed");
    assert.equal(merged.preferences["sidebar-view"], incoming.preferences["sidebar-view"]);
    assert.equal(f.vault.writes, 3);
  } finally { await f.dispose(); }
});

test("legacy coverage only authorizes deletion of its original five preferences", () => {
  const current = display();
  const incoming: ClientState = { hosts: [], preferences: {} };
  const result = replacePortableClient(current, incoming);
  for (const key of legacyPreferenceKeys) assert.equal(result.preferences[key], undefined);
  assert.equal(result.preferences["sidebar-view"], current.preferences["sidebar-view"]);
});

test("different machine-local connections converge display state in both directions with actual storage acknowledgement", async () => {
  const vault = new MemoryVault();
  const source = await fixture(vault);
  const target = await fixture(vault);
  const storage = (hosts: ClientState["hosts"]): StorageAdapter => {
    const values = new Map([[hostKey, JSON.stringify(hosts)]]);
    return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: (key) => { values.delete(key); } };
  };
  const local = (id: string) => ({ ...host(id), connections: [{ id: `${id}-pipe`, type: "directPipe", path: `synthetic-${id}-pipe` }] });
  const sourceStorage = storage([local("srv_a"), host("srv_b")]);
  const targetStorage = storage([local("srv_b"), host("srv_a")]);
  const synchronize = async (auto: AutoSync, current: StorageAdapter) => {
    const result = await auto.tick(capture(current, scopes), api);
    assert.notEqual(result.status.state, "conflict", result.status.message);
    if (!result.operation) return result.status;
    restore(current, result.operation.client, { merge: false, ...result.operation.scopes });
    return auto.acknowledge(result.operation.id, capture(current, scopes), api);
  };
  try {
    await synchronize(source.auto, sourceStorage);
    await synchronize(target.auto, targetStorage);
    await synchronize(source.auto, sourceStorage);
    assert.deepEqual(capture(sourceStorage).hostSettings, capture(targetStorage).hostSettings);
    const targetHosts: ClientState["hosts"] = JSON.parse(targetStorage.getItem(hostKey)!);
    targetHosts.find((entry) => entry.serverId === "srv_b")!.label = "Gaming renamed locally";
    targetStorage.setItem(hostKey, JSON.stringify(targetHosts));
    targetStorage.setItem(hostOrderKey, JSON.stringify(["srv_b", "srv_a"]));
    targetStorage.setItem("sidebar-view", '{"state":{"groupMode":"host"},"version":8}');
    await synchronize(target.auto, targetStorage);
    await synchronize(source.auto, sourceStorage);
    assert.deepEqual(capture(sourceStorage).hostSettings, capture(targetStorage).hostSettings);
    assert.equal(capture(sourceStorage).hostSettings!.hosts.find((entry) => entry.serverId === "srv_b")!.label, "Gaming renamed locally");
    assert.equal(sourceStorage.getItem("sidebar-view"), targetStorage.getItem("sidebar-view"));
    const sourceHosts: ClientState["hosts"] = JSON.parse(sourceStorage.getItem(hostKey)!);
    assert.ok(sourceHosts.find((entry) => entry.serverId === "srv_a")!.connections.some((connection) => connection.id === "srv_a-pipe"));
    assert.equal(sourceHosts.some((entry) => entry.connections.some((connection) => connection.id === "srv_b-pipe")), false);
    sourceHosts.reverse();
    sourceHosts.find((entry) => entry.serverId === "srv_a")!.label = "Source renamed locally";
    sourceStorage.setItem(hostKey, JSON.stringify(sourceHosts));
    sourceStorage.removeItem(hostOrderKey);
    await synchronize(source.auto, sourceStorage);
    await synchronize(target.auto, targetStorage);
    assert.deepEqual(capture(sourceStorage).hostSettings, capture(targetStorage).hostSettings);
    assert.equal(targetStorage.getItem(hostOrderKey), null);
    assert.equal((await source.auto.status()).pendingOperations, 0);
    assert.equal((await target.auto.status()).pendingOperations, 0);
    const writes = vault.writes;
    await synchronize(source.auto, sourceStorage);
    await synchronize(target.auto, targetStorage);
    assert.equal(vault.writes, writes);
  } finally { await source.dispose(); await target.dispose(); }
});
