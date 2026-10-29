import assert from "node:assert/strict";
import { test } from "node:test";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { preferenceKeys, type ClientState } from "../shared/model";
import { AutoClient } from "../client/automation";
import { offStatus } from "../shared/automation";

class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

const remote = (id: string) => ({ id, type: "directTcp", endpoint: `${id}.example:6767` });
const testClientId = "26b0162d-1cd6-45d3-9a75-267f094a9e05";
const host = (id: string, connections: ClientState["hosts"][number]["connections"] = [remote(id)]): ClientState["hosts"][number] => ({ serverId: id, label: id, connections, preferredConnectionId: connections[0]?.id ? String(connections[0].id) : null });

test("initial restore keeps existing hosts and absent preferences by default", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([host("existing")]));
  storage.setItem("@paseo:preferred-editor", "vscode");
  restore(storage, { hosts: [host("incoming")], preferences: { "@paseo:app-settings": '{"theme":"dark"}' } });
  assert.deepEqual(capture(storage).hosts.map((entry) => entry.serverId), ["existing", "incoming"]);
  assert.equal(storage.getItem("@paseo:preferred-editor"), "vscode");
});

test("authoritative restore propagates host and connection deletion while preserving machine connections", () => {
  const storage = new MemoryStorage();
  const localHost = { serverId: "local:machine", connections: [{ id: "local-pipe", type: "directPipe", path: "local-pipe" }] };
  const shared = host("shared", [remote("kept"), remote("deleted")]);
  shared.connections.push({ id: "loopback", type: "directTcp", endpoint: "localhost:6767" });
  shared.connections.push({ id: "pipe", type: "directPipe", path: "machine-pipe" });
  const partial = host("removed-remote", [remote("remote-only"), { id: "local-only", type: "directTcp", endpoint: "127.0.0.1:7878" }]);
  storage.setItem(hostKey, JSON.stringify([localHost, shared, host("deleted-host"), partial]));
  storage.setItem("@paseo:app-settings", '{"theme":"light"}');
  storage.setItem("@paseo:preferred-editor", "vscode");
  storage.setItem("@paseo:machine-private", "preserved");
  const incoming = { hosts: [host("shared", [remote("kept")])], preferences: { "@paseo:app-settings": '{"theme":"dark"}' } };
  restore(storage, incoming, { merge: false });
  assert.deepEqual(capture(storage), { ...incoming, preferenceCoverage: [...preferenceKeys], hostSettings: { hosts: [{ serverId: "local:machine" }, { serverId: "shared", label: "shared" }, { serverId: "removed-remote", label: "removed-remote" }], order: null }, localHostIds: ["local:machine", "removed-remote"] });
  const stored: ClientState["hosts"] = JSON.parse(storage.getItem(hostKey)!);
  assert.deepEqual(stored.find((entry) => entry.serverId === localHost.serverId), localHost);
  assert.deepEqual(stored.find((entry) => entry.serverId === "shared")!.connections.map((entry) => entry.id), ["loopback", "pipe", "kept"]);
  assert.deepEqual(stored.find((entry) => entry.serverId === "removed-remote")!.connections.map((entry) => entry.id), ["local-only"]);
  assert.equal(stored.find((entry) => entry.serverId === "removed-remote")!.preferredConnectionId, "local-only");
  assert.equal(storage.getItem("@paseo:preferred-editor"), null);
  assert.equal(storage.getItem("@paseo:machine-private"), "preserved");
});

test("authoritative restore does not retain removed portable host fields", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([{ ...host("shared"), password: "synthetic-old-secret" }]));
  restore(storage, { hosts: [host("shared")], preferences: {} }, { merge: false });
  assert.equal(capture(storage).hosts[0].password, undefined);
});

for (const failingOperation of ["write", "remove"]) {
  test(`authoritative restore rolls back all writes and removals after a ${failingOperation} failure`, () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, JSON.stringify([host("existing")]));
    storage.setItem("@paseo:app-settings", '{"theme":"light"}');
    storage.setItem("@paseo:keyboard-shortcut-overrides", '{"old":"binding"}');
    storage.setItem("@paseo:changes-preferences", '{"old":true}');
    const before = new Map(storage.values);
    const write = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    let failed = false;
    storage.setItem = (key, value) => {
      if (!failed && failingOperation === "write" && key === "@paseo:preferred-editor") { failed = true; throw new Error("storage write failed"); }
      write(key, value);
    };
    storage.removeItem = (key) => {
      if (!failed && failingOperation === "remove" && key === "@paseo:changes-preferences") { failed = true; throw new Error("storage remove failed"); }
      remove(key);
    };
    assert.throws(() => restore(storage, { hosts: [], preferences: { "@paseo:preferred-editor": "cursor" } }, { merge: false }), /storage .* failed/);
    assert.deepEqual(storage.values, before);
  });
}

test("automatic restore refreshes once after completion without a settings screen", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = new MemoryStorage();
  const desired = { hosts: [host("incoming")], preferences: { "@paseo:app-settings": '{"theme":"dark"}' } };
  const ready = { ...offStatus, enabled: true, state: "ready" as const, ownerClientId: testClientId };
  let pending = true;
  let reloads = 0;
  const client = new AutoClient({
    status: async () => ready, enable: async () => ready, disable: async () => offStatus,
    tick: async () => ({ status: ready, operation: pending ? { id: "operation", client: desired } : null }),
    acknowledge: async ({ client: actual }) => { assert.deepEqual(actual, { ...desired, preferenceCoverage: [...preferenceKeys], hostSettings: { hosts: [{ serverId: "incoming", label: "incoming" }], order: null } }); pending = false; return ready; },
  }, () => storage, () => { reloads++; }, testClientId);
  await client.synchronize();
  assert.equal(reloads, 0);
  await client.synchronize();
  context.mock.timers.tick(0);
  assert.equal(reloads, 1);
  assert.equal(client.getSnapshot().needsReload, false);
  await client.synchronize();
  context.mock.timers.runAll();
  assert.equal(reloads, 1);
  client.dispose();
});

for (const outcome of ["error", "conflict", "pending"]) {
  test(`automatic restore does not refresh after ${outcome}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const storage = new MemoryStorage();
    const ready = { ...offStatus, enabled: true, state: "ready" as const, ownerClientId: testClientId };
    let reloads = 0;
    const client = new AutoClient({
      status: async () => ready, enable: async () => ready, disable: async () => offStatus,
      tick: async () => ({ status: ready, operation: { id: "operation", client: { hosts: [host("incoming")], preferences: {} } } }),
      acknowledge: async () => {
        if (outcome === "error") throw new Error("acknowledgement failed");
        return { ...ready, state: outcome === "conflict" ? "conflict" : "ready", pendingOperations: outcome === "pending" ? 1 : 0 };
      },
    }, () => storage, () => { reloads++; }, testClientId);
    await client.synchronize();
    context.mock.timers.runAll();
    assert.equal(reloads, 0);
    assert.equal(client.getSnapshot().needsReload, true);
    client.dispose();
  });
}

test("disposing the automatic client cancels its scheduled refresh", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const storage = new MemoryStorage();
  const ready = { ...offStatus, enabled: true, state: "ready" as const, ownerClientId: testClientId };
  let reloads = 0;
  const client = new AutoClient({
    status: async () => ready, enable: async () => ready, disable: async () => offStatus,
    tick: async () => ({ status: ready, operation: { id: "operation", client: { hosts: [host("incoming")], preferences: {} } } }),
    acknowledge: async () => ready,
  }, () => storage, () => { reloads++; }, testClientId);
  await client.synchronize();
  client.dispose();
  context.mock.timers.runAll();
  assert.equal(reloads, 0);
});
