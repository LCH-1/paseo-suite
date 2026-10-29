import assert from "node:assert/strict";
import { test } from "node:test";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { clientContent, filterSnapshot, offStatus, selectClient, stableString } from "../shared/automation";
import { preferenceKeys, type ClientState, type Snapshot } from "../shared/model";
import { decrypt, encrypt } from "../server/crypto";

const appKey = "@paseo:app-settings";
const sidebarKeys = ["sidebar-view", "sidebar-collapsed-sections", "sidebar-project-workspace-order"] as const;
const preferencesOnly = { ...offStatus.scopes, hosts: false, providers: false, config: false, plugins: false };
class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  reads: string[] = [];
  writes: string[] = [];
  getItem(key: string) { this.reads.push(key); return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.writes.push(key); this.values.set(key, value); }
  removeItem(key: string) { this.writes.push(key); this.values.delete(key); }
}
function sidebarValues(label: string): Record<string, string> {
  const project = `shared-project-${label} `;
  return {
    [appKey]: JSON.stringify({ theme: "dark", sidebarRowItems: { host: true }, sidebarNavItems: [{ key: "plugin:settings-sync:sync", visible: true }, { key: "history", visible: false }, { key: "plugin:terminal-tabs", visible: true }], sidebarFooterItems: [{ key: "plugin:sidebar-title-sync", visible: false }] }),
    "sidebar-view": JSON.stringify({ state: { groupMode: "host", showBackground: true, hostFilters: ["host-b", "host-a"], projectFilters: [project], labelFilter: { labels: ["review", ""] } }, version: 8 }),
    "sidebar-collapsed-sections": JSON.stringify({ state: { collapsedProjectKeys: [project], collapsedWorkspaceGroupKeys: ["host-b::running"], collapsedPinned: true }, version: 0 }),
    "sidebar-project-workspace-order": JSON.stringify({ state: { projectOrder: [project, "another-project"], pinnedWorkspaceOrder: ["host-b:workspace-2", "host-a:workspace-1"], workspaceOrderByProject: { [project]: ["host-b:workspace-2", "host-a:workspace-1"] } }, version: 1 }),
  };
}
function storageWith(label: string) {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(sidebarValues(label))) storage.values.set(key, value);
  storage.values.set(hostKey, "[]");
  return storage;
}

test("capture includes persistent sidebar values and their declared coverage without collecting active UI state", () => {
  const storage = storageWith("source");
  const excluded = ["paseo:last-workspace-route-selection", "workspace-layout-state", "panel-state", "paseo-drafts", "@paseo:settings-sync-client-id", "@paseo:unknown-future-state"];
  for (const key of excluded) storage.values.set(key, "private transient value");
  const current = capture(storage, preferencesOnly);
  assert.deepEqual(current.preferences, sidebarValues("source"));
  assert.deepEqual([...current.preferenceCoverage ?? []].sort(), [...preferenceKeys].sort());
  for (const key of sidebarKeys) assert.ok(current.preferenceCoverage?.includes(key));
  for (const key of excluded) { assert.equal(storage.reads.includes(key), false); assert.equal(key in current.preferences, false); }
});

test("sidebar group, collapse, project order and plugin visibility roundtrip through two client stores", () => {
  const source = storageWith("source");
  const target = storageWith("target");
  const first = capture(source, preferencesOnly);
  restore(target, first, { merge: false, hosts: false });
  assert.deepEqual(capture(target, preferencesOnly).preferences, sidebarValues("source"));
  const nav = JSON.parse(target.values.get(appKey)!);
  assert.deepEqual(nav.sidebarNavItems.map((entry: { key: string }) => entry.key), ["plugin:settings-sync:sync", "history", "plugin:terminal-tabs"]);
  assert.equal(nav.sidebarNavItems[1].visible, false);
  assert.deepEqual(nav.sidebarFooterItems, [{ key: "plugin:sidebar-title-sync", visible: false }]);
  target.values.set("sidebar-view", JSON.stringify({ state: { groupMode: "project", showBackground: false, hostFilters: ["host-a"], projectFilters: [], labelFilter: { labels: [] } }, version: 8 }));
  restore(source, capture(target, preferencesOnly), { merge: false, hosts: false });
  assert.deepEqual(capture(source, preferencesOnly).preferences, capture(target, preferencesOnly).preferences);
  assert.equal(stableString(clientContent(capture(source, preferencesOnly))), stableString(clientContent(capture(target, preferencesOnly))));
});

test("legacy backups preserve unsupported sidebar keys while retaining the previous five-key deletion behavior", () => {
  const target = storageWith("local");
  target.values.set("@paseo:preferred-editor", "local-editor");
  const before = new Map(target.values);
  const legacy: ClientState = { hosts: [], preferences: { [appKey]: '{"theme":"light","sidebarNavItems":[{"key":"history","visible":false}]}' } };
  restore(target, legacy, { merge: false, hosts: false });
  for (const key of sidebarKeys) assert.equal(target.values.get(key), before.get(key));
  assert.equal(target.values.get(appKey), legacy.preferences[appKey]);
  assert.equal(target.values.has("@paseo:preferred-editor"), false);
});

test("a legacy backup that actually supplies a sidebar key applies it without deleting other newly supported keys", () => {
  const target = storageWith("local");
  const before = new Map(target.values);
  const incoming = sidebarValues("remote")["sidebar-view"];
  restore(target, { hosts: [], preferences: { "sidebar-view": incoming } }, { merge: false, hosts: false });
  assert.equal(target.values.get("sidebar-view"), incoming);
  for (const key of sidebarKeys.slice(1)) assert.equal(target.values.get(key), before.get(key));
});

test("legacy sidebar storage is projected under the canonical key without rewriting the app's migration format", () => {
  const storage = new MemoryStorage();
  const legacy = JSON.stringify({ state: { groupModeByServerId: { "host-a": "project", "host-b": "status" } }, version: 1 });
  storage.values.set("sidebar-group-mode", legacy);
  const current = capture(storage, preferencesOnly);
  assert.equal(current.preferences["sidebar-view"], legacy);
  assert.equal(current.preferences["sidebar-group-mode"], undefined);
  assert.equal(storage.values.has("sidebar-view"), false);
  assert.deepEqual(storage.writes, []);
  const canonical = sidebarValues("canonical")["sidebar-view"];
  storage.values.set("sidebar-view", canonical);
  assert.equal(capture(storage, preferencesOnly).preferences["sidebar-view"], canonical);
});

test("applying or resetting a provided canonical sidebar view removes its stale legacy fallback", () => {
  const target = storageWith("target");
  const legacy = JSON.stringify({ state: { groupMode: "status" }, version: 1 });
  const canonical = sidebarValues("source")["sidebar-view"];
  target.values.set("sidebar-group-mode", legacy);
  restore(target, { hosts: [], preferences: { "sidebar-view": canonical }, preferenceCoverage: ["sidebar-view"] }, { merge: false, hosts: false });
  assert.equal(target.values.get("sidebar-view"), canonical);
  assert.equal(target.values.has("sidebar-group-mode"), false);
  target.values.set("sidebar-group-mode", legacy);
  restore(target, { hosts: [], preferences: {}, preferenceCoverage: ["sidebar-view"] }, { merge: false, hosts: false });
  assert.equal(target.values.has("sidebar-view"), false);
  assert.equal(target.values.has("sidebar-group-mode"), false);
  assert.equal(capture(target, preferencesOnly).preferences["sidebar-view"], undefined);
});

test("an older backup that cannot provide sidebar view leaves the target's legacy fallback untouched", () => {
  const target = new MemoryStorage();
  const legacy = JSON.stringify({ state: { groupMode: "status" }, version: 1 });
  target.values.set("sidebar-group-mode", legacy);
  restore(target, { hosts: [], preferences: {} }, { merge: false, hosts: false });
  assert.equal(target.values.get("sidebar-group-mode"), legacy);
  assert.equal(capture(target, preferencesOnly).preferences["sidebar-view"], legacy);
});

test("declared sidebar coverage distinguishes an intentional reset from an unavailable key", () => {
  const target = storageWith("local");
  const before = new Map(target.values);
  restore(target, { hosts: [], preferences: {}, preferenceCoverage: ["sidebar-view"] }, { merge: false, hosts: false });
  assert.equal(target.values.has("sidebar-view"), false);
  for (const key of [appKey, ...sidebarKeys.slice(1)]) assert.equal(target.values.get(key), before.get(key));
  assert.equal(target.values.get(hostKey), "[]");
});

test("resetting covered sidebar keys propagates as absence and converges without resurrecting the local defaults", () => {
  const source = storageWith("source");
  const target = storageWith("target");
  for (const key of sidebarKeys) source.values.delete(key);
  const reset = capture(source, preferencesOnly);
  assert.ok(sidebarKeys.every((key) => reset.preferenceCoverage?.includes(key)));
  restore(target, reset, { merge: false, hosts: false });
  for (const key of sidebarKeys) assert.equal(target.values.has(key), false);
  const second = capture(target, preferencesOnly);
  restore(source, second, { merge: false, hosts: false });
  assert.deepEqual(capture(source, preferencesOnly).preferences, second.preferences);
});

test("disabled preference capture and restore never access sidebar data or reset its coverage", () => {
  const source = storageWith("local");
  for (const key of sidebarKeys) source.values.set(key, "malformed private JSON");
  const before = new Map(source.values);
  const none = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
  const disabled = capture(source, none);
  assert.deepEqual(disabled.preferences, {});
  assert.ok(!disabled.preferenceCoverage?.length);
  restore(source, { hosts: [], preferences: { "sidebar-view": "also malformed" }, preferenceCoverage: [...sidebarKeys] }, { merge: false, hosts: false, preferences: false });
  assert.deepEqual(source.reads, []); assert.deepEqual(source.writes, []);
  assert.deepEqual(source.values, before);
});

test("re-enabling preference capture includes sidebar edits made while sync was off", () => {
  const source = storageWith("local");
  capture(source, { ...preferencesOnly, preferences: false });
  const changed = sidebarValues("changed-while-disabled");
  source.values.set("sidebar-project-workspace-order", changed["sidebar-project-workspace-order"]);
  source.values.set("sidebar-view", changed["sidebar-view"]);
  const current = capture(source, preferencesOnly);
  assert.equal(current.preferences["sidebar-project-workspace-order"], changed["sidebar-project-workspace-order"]);
  assert.equal(current.preferences["sidebar-view"], changed["sidebar-view"]);
  assert.ok(current.preferenceCoverage?.includes("sidebar-view"));
});

test("failed sidebar writes roll back both applied values and declared resets", () => {
  const target = storageWith("target");
  target.values.set("sidebar-group-mode", '{"state":{"groupMode":"status"},"version":1}');
  const before = new Map(target.values);
  const write = target.setItem.bind(target); let failed = false;
  target.setItem = (key, value) => { if (key === "sidebar-project-workspace-order" && !failed) { failed = true; throw Error("synthetic sidebar write failure"); } write(key, value); };
  assert.throws(() => restore(target, { hosts: [], preferences: { "sidebar-project-workspace-order": sidebarValues("source")["sidebar-project-workspace-order"] }, preferenceCoverage: [...sidebarKeys] }, { merge: false, hosts: false }), /synthetic sidebar write failure/);
  assert.deepEqual(target.values, before);
});

test("new encrypted snapshots retain explicit sidebar coverage and ordered plugin preferences", async () => {
  const client = capture(storageWith("encrypted"), preferencesOnly);
  const snapshot: Snapshot = { version: 3, createdAt: "2026-10-26T00:00:00.000Z", device: "synthetic sidebar", client, config: {}, plugins: [], scopes: preferencesOnly };
  const password = "synthetic sidebar backup password";
  const encrypted = await encrypt(snapshot, password);
  for (const key of sidebarKeys) assert.equal(encrypted.includes(key), false);
  const restored = await decrypt(encrypted, password);
  assert.equal(restored.version, 3); assert.deepEqual(restored.client, client);
});

test("machine-local host context is input-only and never retained in an encrypted cloud snapshot", async () => {
  const client: ClientState = {
    ...capture(storageWith("input-context"), preferencesOnly),
    hostSettings: { hosts: [{ serverId: "synthetic-machine-only", label: "Portable display name" }], order: null },
    localHostIds: ["synthetic-machine-only"],
  };
  const snapshot: Snapshot = { version: 3, createdAt: "2026-10-26T00:00:00.000Z", device: "synthetic context", client, config: {}, plugins: [], scopes: offStatus.scopes };
  const restored = await decrypt(await encrypt(snapshot, "synthetic input context password"), "synthetic input context password");
  assert.equal(Object.hasOwn(restored.client, "localHostIds"), false);
  assert.deepEqual(restored.client.hostSettings, client.hostSettings);
  assert.deepEqual(restored.client.preferenceCoverage, client.preferenceCoverage);
  assert.deepEqual(snapshot.client.localHostIds, ["synthetic-machine-only"]);
});

test("deselecting hosts excludes machine-local host context from selected client and snapshot views", () => {
  const client: ClientState = { hosts: [], preferences: { [appKey]: '{"theme":"dark"}' }, localHostIds: ["synthetic-machine-only"], hostSettings: { hosts: [{ serverId: "synthetic-machine-only", label: "Local" }], order: null } };
  const selected = selectClient(client, preferencesOnly);
  assert.equal(selected.localHostIds, undefined); assert.equal(selected.hostSettings, undefined);
  assert.deepEqual(selected.preferences, client.preferences);
  const snapshot: Snapshot = { version: 3, createdAt: "2026-10-26T00:00:00.000Z", device: "synthetic context", client, config: {}, plugins: [], scopes: offStatus.scopes };
  assert.equal(filterSnapshot(snapshot, preferencesOnly).client.localHostIds, undefined);
});

test("machine-local host context does not change the synchronized client content hash", () => {
  const client: ClientState = { hosts: [], preferences: {}, hostSettings: { hosts: [{ serverId: "shared-display", label: "Original" }], order: null } };
  const original = stableString(clientContent(client));
  assert.equal(stableString(clientContent({ ...client, localHostIds: ["first-machine", "second-machine"] })), original);
  assert.equal(stableString(clientContent({ ...client, localHostIds: ["second-machine"] })), original);
  assert.equal(stableString(clientContent({ ...client, localHostIds: [] })), original);
  assert.notEqual(stableString(clientContent({ ...client, hostSettings: { ...client.hostSettings!, hosts: [{ serverId: "shared-display", label: "Changed display name" }] } })), original);
});
