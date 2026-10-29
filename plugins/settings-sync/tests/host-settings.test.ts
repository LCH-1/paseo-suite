import assert from "node:assert/strict";
import { test } from "node:test";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { hostOrderKey, hostPresentationKey, hostPresentationCacheSchema, hostSettingsSchema, type HostSettings } from "../shared/host-settings";
import { legacyPreferenceKeys, preferenceKeys, type ClientState } from "../shared/model";
import { clientContent, offStatus, replacePortableClient } from "../shared/automation";

class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const local = (serverId: string, label = serverId): ClientState["hosts"][number] => ({ serverId, label, connections: [{ id: `${serverId}-pipe`, type: "directPipe", path: "synthetic-machine-private-pipe" }], password: "synthetic-private-password" });
const remote = (serverId: string): ClientState["hosts"][number] => ({ serverId, label: serverId, connections: [{ id: serverId, type: "directTcp", endpoint: `${serverId}.example.invalid:6767` }] });
const metadata = (ids: string[], order: string[] | null = ids): HostSettings => ({ hosts: ids.map((serverId) => ({ serverId, label: `${serverId}-shared` })), order });
const cache = (storage: MemoryStorage, presentation: HostSettings, knownHostIds: string[]) => storage.setItem(hostPresentationKey, JSON.stringify({ presentation, knownHostIds }));
const registry = (storage: MemoryStorage): ClientState["hosts"] => JSON.parse(storage.getItem(hostKey) ?? "[]");

test("capture includes local host presentation and order without exporting machine credentials or writing storage", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([{ ...local("local:desktop"), appearance: { color: "blue", badgeDisplay: "icon" } }, remote("remote")]));
  storage.setItem(hostOrderKey, JSON.stringify(["remote", "local:desktop"]));
  const before = new Map(storage.values);
  const result = capture(storage);
  assert.deepEqual(result.hostSettings, { hosts: [{ serverId: "local:desktop", label: "local:desktop", appearance: { color: "blue", badgeDisplay: "icon" } }, { serverId: "remote", label: "remote" }], order: ["remote", "local:desktop"] });
  assert.equal(JSON.stringify(result.hostSettings).includes("private"), false);
  assert.deepEqual(result.hosts.map((host) => host.serverId), ["remote"]);
  assert.deepEqual(result.localHostIds, ["local:desktop"]);
  assert.deepEqual(result.preferenceCoverage, [...preferenceKeys]);
  assert.equal(hostOrderKey in result.preferences, false);
  assert.deepEqual(storage.values, before);
});

test("unknown host metadata survives restoration and capture without creating disconnected phantom hosts", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("current")]));
  const incoming = metadata(["unknown", "current"], ["unknown", "current"]);
  restore(storage, { hosts: [], preferences: {}, hostSettings: incoming }, { merge: false, preferences: false });
  assert.deepEqual(registry(storage).map((host) => host.serverId), ["current"]);
  assert.deepEqual(registry(storage)[0].connections, local("current").connections);
  assert.equal(registry(storage)[0].password, "synthetic-private-password");
  assert.deepEqual(capture(storage).hostSettings, incoming);
  assert.deepEqual(hostPresentationCacheSchema.parse(JSON.parse(storage.getItem(hostPresentationKey)!)).knownHostIds, ["current"]);
});

test("capture distinguishes physical local-only hosts from cached unknown metadata and omits empty local context", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("physical"), { serverId: "loopback", connections: [{ id: "tcp", type: "directTcp", endpoint: "localhost:6767" }] }, remote("remote")]));
  cache(storage, metadata(["unknown", "physical", "loopback", "remote"]), ["physical", "loopback", "remote"]);
  assert.deepEqual(capture(storage).localHostIds, ["physical", "loopback"]);
  assert.equal(capture(storage, { ...offStatus.scopes, hosts: false }).localHostIds, undefined);
  storage.setItem(hostKey, JSON.stringify([remote("remote")]));
  assert.equal(capture(storage).localHostIds, undefined);
});

test("authoritative v3 restore retains target-only local metadata, deletes cached unknown metadata and matches the server acknowledgement", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("target-only", "target-label")]));
  cache(storage, metadata(["cached-unknown", "target-only"]), ["target-only"]);
  const current = capture(storage);
  const incoming: ClientState = { hosts: [remote("source")], preferences: {}, hostSettings: metadata(["source"], null), localHostIds: ["source-only-context"] };
  const desired = replacePortableClient(current, incoming);
  restore(storage, incoming, { merge: false });
  const acknowledged = capture(storage);
  assert.deepEqual(acknowledged.hostSettings!.hosts, [{ serverId: "source", label: "source-shared" }, { serverId: "target-only", label: "target-label" }]);
  assert.deepEqual(acknowledged.localHostIds, ["target-only"]);
  assert.deepEqual(clientContent(acknowledged), clientContent(desired));
  const saved = hostPresentationCacheSchema.parse(JSON.parse(storage.getItem(hostPresentationKey)!));
  assert.deepEqual(saved.presentation, acknowledged.hostSettings);
  assert.equal(saved.presentation.hosts.some((host) => host.serverId === "cached-unknown"), false);
  assert.equal(JSON.stringify(saved).includes("source-only-context"), false);
});

test("capture preserves cached global metadata order while overlaying labels and appending newly registered hosts", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("known", "edited")]));
  cache(storage, metadata(["unknown", "known"], null), ["known"]);
  assert.deepEqual(capture(storage).hostSettings!.hosts, [{ serverId: "unknown", label: "unknown-shared" }, { serverId: "known", label: "edited" }]);
  storage.setItem(hostKey, JSON.stringify([local("known", "edited"), local("new")]));
  assert.deepEqual(capture(storage).hostSettings!.hosts.map((host) => host.serverId), ["unknown", "known", "new"]);
});

test("adding or deleting registered hosts preserves the remaining cached global order", () => {
  const storage = new MemoryStorage();
  cache(storage, metadata(["one", "unknown", "removed", "two"]), ["one", "removed", "two"]);
  storage.setItem(hostKey, JSON.stringify([local("one"), local("new"), local("two")]));
  assert.deepEqual(capture(storage).hostSettings!.hosts.map((host) => host.serverId), ["one", "unknown", "two", "new"]);
});

test("capture treats registry reorder and known-host deletion as user changes while retaining never registered metadata", () => {
  const storage = new MemoryStorage();
  cache(storage, metadata(["unknown", "one", "two", "removed"]), ["one", "two", "removed"]);
  storage.setItem(hostKey, JSON.stringify([local("two"), local("one")]));
  storage.setItem(hostOrderKey, JSON.stringify(["removed", "two", "unknown", "one"]));
  assert.deepEqual(capture(storage).hostSettings!.hosts.map((host) => host.serverId), ["two", "one", "unknown"]);
  assert.deepEqual(capture(storage).hostSettings!.order, ["two", "unknown", "one"]);
});

test("authoritative restore applies metadata and registry order while retaining local connections and target-only hosts", () => {
  const storage = new MemoryStorage();
  const source = local("source", "old");
  source.appearance = { color: "red" };
  storage.setItem(hostKey, JSON.stringify([local("target-only"), source, local("second")]));
  const incoming = metadata(["second", "source", "unregistered"], ["source", "second"]);
  restore(storage, { hosts: [], preferences: {}, hostSettings: incoming }, { merge: false, preferences: false });
  assert.deepEqual(registry(storage).map((host) => host.serverId), ["second", "source", "target-only"]);
  assert.equal(registry(storage)[1].label, "source-shared");
  assert.equal(registry(storage)[1].appearance, undefined);
  assert.deepEqual(registry(storage)[1].connections, source.connections);
  assert.deepEqual(JSON.parse(storage.getItem(hostOrderKey)!), ["source", "second"]);
});

test("initial restore retains existing presentation records while incoming order and fields take precedence", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("existing")]));
  cache(storage, metadata(["unknown", "existing"]), ["existing"]);
  const incoming = metadata(["incoming"], null);
  restore(storage, { hosts: [remote("incoming")], preferences: {}, hostSettings: incoming }, { preferences: false });
  assert.deepEqual(capture(storage).hostSettings!.hosts.map((host) => host.serverId), ["incoming", "unknown", "existing"]);
  assert.equal(storage.getItem(hostOrderKey), null);
});

test("explicit null resets custom order and legacy backups preserve current host presentation storage", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([local("local")]));
  storage.setItem(hostOrderKey, '["local"]');
  restore(storage, { hosts: [], preferences: {}, hostSettings: metadata(["local"], null) }, { merge: false, preferences: false });
  assert.equal(storage.getItem(hostOrderKey), null);
  const storedCache = storage.getItem(hostPresentationKey);
  storage.setItem(hostOrderKey, '["local"]');
  restore(storage, { hosts: [], preferences: {} }, { merge: false, preferences: false });
  assert.equal(storage.getItem(hostOrderKey), '["local"]');
  assert.equal(storage.getItem(hostPresentationKey), storedCache);
});

test("legacy backups apply provided remote names while preserving newer order and metadata cache", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([{ ...remote("shared"), label: "current-v3-name" }, local("local")]));
  storage.setItem(hostOrderKey, '["local","shared","unknown"]');
  cache(storage, metadata(["unknown", "shared", "local"]), ["shared", "local"]);
  const beforeCache = storage.getItem(hostPresentationKey);
  const beforeOrder = storage.getItem(hostOrderKey);
  restore(storage, { hosts: [{ ...remote("shared"), label: "legacy-provided-name" }], preferences: {} }, { merge: false, preferences: false });
  assert.equal(registry(storage).find((host) => host.serverId === "shared")!.label, "legacy-provided-name");
  assert.equal(registry(storage).find((host) => host.serverId === "local")!.label, "local");
  assert.equal(storage.getItem(hostPresentationKey), beforeCache);
  assert.equal(storage.getItem(hostOrderKey), beforeOrder);
  assert.equal(capture(storage).hostSettings!.hosts.find((host) => host.serverId === "shared")!.label, "legacy-provided-name");
});

test("disabled host scope never reads or writes registry, presentation cache or host order", () => {
  const storage = new MemoryStorage();
  const guarded = new Set([hostKey, hostOrderKey, hostPresentationKey]);
  for (const operation of ["getItem", "setItem", "removeItem"] as const) {
    const original = storage[operation].bind(storage) as (key: string, value?: string) => string | null | void;
    storage[operation] = ((key: string, value?: string) => { if (guarded.has(key)) throw new Error("disabled host access"); return original(key, value); }) as never;
  }
  assert.equal(capture(storage, { ...offStatus.scopes, hosts: false }).hostSettings, undefined);
  restore(storage, { hosts: null as never, hostSettings: null as never, preferences: {} }, { merge: false, hosts: false });
});

for (const failingKey of [hostOrderKey, hostPresentationKey, "@paseo:app-settings"]) {
  test(`restoration rolls back host presentation, order, registry and preferences after ${failingKey} fails`, () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, JSON.stringify([local("local", "before")]));
    storage.setItem(hostOrderKey, '["local"]');
    storage.setItem("@paseo:app-settings", '{"theme":"light"}');
    cache(storage, metadata(["local"]), ["local"]);
    const before = new Map(storage.values);
    const set = storage.setItem.bind(storage);
    let failed = false;
    storage.setItem = (key, value) => { if (!failed && key === failingKey) { failed = true; throw new Error("synthetic write failure"); } set(key, value); };
    assert.throws(() => restore(storage, { hosts: [], preferences: { "@paseo:app-settings": '{"theme":"dark"}' }, hostSettings: metadata(["local"], ["new-order"]) }, { merge: false }), /synthetic write failure/);
    assert.deepEqual(storage.values, before);
  });
}

test("presentation schemas reject connection secrets and duplicate identifiers", () => {
  assert.equal(hostSettingsSchema.safeParse({ hosts: [{ serverId: "one", password: "synthetic-private" }], order: null }).success, false);
  assert.equal(hostSettingsSchema.safeParse({ hosts: [{ serverId: "one", connections: [] }], order: null }).success, false);
  assert.equal(hostSettingsSchema.safeParse({ hosts: [{ serverId: "one" }, { serverId: "one" }], order: null }).success, false);
  assert.equal(hostSettingsSchema.safeParse({ hosts: [], order: ["one", "one"] }).success, false);
});

test("legacy sidebar grouping is captured virtually without changing storage and canonical values win", () => {
  const storage = new MemoryStorage();
  const legacy = '{"state":{"groupModeByServerId":{"synthetic":"status"}},"version":1}';
  storage.setItem("sidebar-group-mode", legacy);
  const before = new Map(storage.values);
  assert.equal(capture(storage).preferences["sidebar-view"], legacy);
  assert.deepEqual(storage.values, before);
  const current = '{"state":{"groupMode":"project"},"version":8}';
  storage.setItem("sidebar-view", current);
  assert.equal(capture(storage).preferences["sidebar-view"], current);
});

test("covered sidebar restore removes its legacy fallback so an explicit reset cannot resurrect old grouping", () => {
  const storage = new MemoryStorage();
  storage.setItem("sidebar-view", '{"state":{"groupMode":"host"},"version":8}');
  storage.setItem("sidebar-group-mode", '{"state":{"groupMode":"status"},"version":1}');
  restore(storage, { hosts: [], preferences: {}, preferenceCoverage: ["sidebar-view"] }, { merge: false, hosts: false });
  assert.equal(storage.getItem("sidebar-view"), null);
  assert.equal(storage.getItem("sidebar-group-mode"), null);
  storage.setItem("sidebar-group-mode", '{"state":{"groupMode":"status"},"version":1}');
  restore(storage, { hosts: [], preferences: {}, preferenceCoverage: [...legacyPreferenceKeys] }, { merge: false, hosts: false });
  assert.notEqual(storage.getItem("sidebar-group-mode"), null);
});
