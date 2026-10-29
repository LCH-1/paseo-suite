import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoClient } from "../client/automation";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { offStatus, type AutoScopes, type AutoStatus } from "../shared/automation";
import { preferenceKeys } from "../shared/model";

class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const clientId = "10e4f9b2-2246-4e10-8df0-65a106568c8e";
const none: AutoScopes = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
const ready = (scopes: AutoScopes): AutoStatus => ({ ...offStatus, enabled: true, ownerClientId: clientId, state: "ready", scopes });
const appKey = "@paseo:app-settings";

test("capture never reads or parses deselected host and preference groups", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "invalid host JSON");
  storage.setItem(appKey, "invalid preference JSON");
  const read = storage.getItem.bind(storage);
  storage.getItem = (key) => { if (key === hostKey || key === appKey) throw new Error("deselected storage read"); return read(key); };
  assert.deepEqual(capture(storage, none), { hosts: [], preferences: {} });
  storage.getItem = read;
  storage.setItem(appKey, '{"theme":"dark"}');
  assert.deepEqual(capture(storage, { ...none, preferences: true }), { hosts: [], preferences: { [appKey]: '{"theme":"dark"}' }, preferenceCoverage: [...preferenceKeys] });
  storage.setItem(hostKey, "[]");
  storage.setItem(appKey, "invalid preference JSON");
  assert.deepEqual(capture(storage, { ...none, hosts: true }), { hosts: [], preferences: {}, hostSettings: { hosts: [], order: null } });
});

for (const disabled of ["hosts", "preferences"] as const) {
  test(`restore does not read, parse, write or remove a disabled ${disabled} group`, () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, "invalid local hosts");
    storage.setItem(appKey, "invalid local preferences");
    const snapshot = new Map(storage.values);
    const guarded = (key: string) => disabled === "hosts" ? key === hostKey : key !== hostKey;
    const get = storage.getItem.bind(storage);
    const set = storage.setItem.bind(storage);
    const remove = storage.removeItem.bind(storage);
    storage.getItem = (key) => { if (guarded(key)) throw new Error("disabled get"); return get(key); };
    storage.setItem = (key, value) => { if (guarded(key)) throw new Error("disabled set"); set(key, value); };
    storage.removeItem = (key) => { if (guarded(key)) throw new Error("disabled remove"); remove(key); };
    if (disabled === "hosts") {
      restore(storage, { hosts: null as never, preferences: { [appKey]: '{"theme":"dark"}' } }, { merge: false, hosts: false });
      assert.equal(storage.values.get(hostKey), snapshot.get(hostKey));
      assert.equal(storage.values.get(appKey), '{"theme":"dark"}');
    } else {
      set(hostKey, "[]");
      restore(storage, { hosts: [], preferences: null as never }, { merge: false, preferences: false });
      assert.equal(storage.values.get(appKey), snapshot.get(appKey));
    }
  });
}

test("automatic tick and acknowledgement send only selected client groups", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "invalid deselected hosts");
  storage.setItem(appKey, '{"theme":"light"}');
  const scopes = { ...none, preferences: true };
  const client = new AutoClient({
    status: async () => ready(scopes), enable: async () => ready(scopes), disable: async () => offStatus,
    tick: async (input) => {
      assert.deepEqual(input.client, { hosts: [], preferences: { [appKey]: '{"theme":"light"}' }, preferenceCoverage: [...preferenceKeys] });
      return { status: ready(scopes), operation: { id: clientId, scopes, client: { hosts: [], preferences: { [appKey]: '{"theme":"dark"}' } } } };
    },
    acknowledge: async (input) => { assert.deepEqual(input.client, { hosts: [], preferences: { [appKey]: '{"theme":"dark"}' }, preferenceCoverage: [...preferenceKeys] }); return ready(scopes); },
  }, () => storage, null, clientId);
  await client.synchronize();
  assert.equal(client.getSnapshot().status.state, "ready");
  assert.equal(storage.values.get(hostKey), "invalid deselected hosts");
  client.dispose();
});

test("an unavailable remote group leaves selected local values intact in the acknowledgement", async () => {
  const storage = new MemoryStorage();
  storage.setItem(appKey, '{"theme":"local"}');
  const scopes = { ...none, preferences: true };
  const client = new AutoClient({
    status: async () => ready(scopes), enable: async () => ready(scopes), disable: async () => offStatus,
    tick: async () => ({ status: ready(scopes), operation: { id: clientId, scopes: none, client: { hosts: [], preferences: {} } } }),
    acknowledge: async (input) => { assert.deepEqual(input.client.preferences, { [appKey]: '{"theme":"local"}' }); return ready(scopes); },
  }, () => storage, null, clientId);
  await client.synchronize();
  assert.equal(storage.getItem(appKey), '{"theme":"local"}');
  assert.equal(client.getSnapshot().needsReload, false);
  client.dispose();
});

test("scope configuration captures only the new selection before cloud-first sync", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "invalid hosts outside both selections");
  storage.setItem(appKey, '{"theme":"local"}');
  const selected = { ...none, preferences: true };
  let scopes = none;
  const order: string[] = [];
  const client = new AutoClient({
    status: async () => ready(scopes), enable: async () => ready(scopes), disable: async () => offStatus,
    tick: async (input) => { order.push(scopes.preferences ? "new tick" : "old tick"); assert.deepEqual(input.client.hosts, []); return { status: ready(scopes), operation: null }; },
    configure: async (input) => { order.push("configure"); assert.deepEqual(input.client, { hosts: [], preferences: { [appKey]: '{"theme":"local"}' }, preferenceCoverage: [...preferenceKeys] }); scopes = input.scopes as AutoScopes; return ready(scopes); },
    acknowledge: async () => ready(scopes),
  }, () => storage, null, clientId);
  await client.configure(selected);
  assert.deepEqual(order, ["configure", "new tick"]);
  assert.deepEqual(client.getSnapshot().status.scopes, selected);
  client.dispose();
});

for (const state of ["conflict", "error"] as const) {
  test(`scope reduction can escape ${state} without reading removed client groups or syncing the old selection`, async () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, "broken removed hosts");
    storage.setItem(appKey, "broken removed preferences");
    let configured = 0;
    let selected = { ...none, hosts: true, preferences: true, plugins: true };
    let status: AutoStatus = { ...ready(selected), state, pendingOperations: 0 };
    const client = new AutoClient({
      status: async () => status, enable: async () => status, disable: async () => offStatus,
      tick: async (input) => { assert.deepEqual(selected, none); assert.deepEqual(input.client, { hosts: [], preferences: {} }); return { status, operation: null }; },
      configure: async (input) => { configured++; assert.deepEqual(input.client, { hosts: [], preferences: {} }); selected = input.scopes as AutoScopes; status = ready(selected); return status; },
      acknowledge: async () => status,
    }, () => storage, null, clientId);
    await client.configure(none);
    assert.equal(configured, 1);
    assert.deepEqual(client.getSnapshot().status.scopes, none);
    assert.equal(storage.getItem(hostKey), "broken removed hosts");
    assert.equal(storage.getItem(appKey), "broken removed preferences");
    client.dispose();
  });
}

test("scope configuration rejects pending restoration without capturing old or new groups", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "invalid hosts should not be captured");
  let configured = 0;
  const status = { ...ready(none), state: "syncing" as const, pendingOperations: 1 };
  const client = new AutoClient({
    status: async () => status, enable: async () => status, disable: async () => offStatus,
    tick: async () => { throw new Error("must not synchronize before configuration"); },
    configure: async () => { configured++; return ready(none); }, acknowledge: async () => status,
  }, () => storage, null, clientId);
  await assert.rejects(client.configure({ ...none, hosts: true }), /진행 중인 복원/);
  assert.equal(configured, 0);
  assert.deepEqual(client.getSnapshot().status.scopes, none);
  client.dispose();
});

test("new-only scope capture excludes valid removed hosts from configure and later ticks", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([{ serverId: "removed-host", connections: [{ id: "ssh", type: "remoteSsh", host: "synthetic@example.invalid" }] }]));
  storage.setItem(appKey, '{"theme":"local"}');
  let scopes = { ...none, hosts: true };
  const selected = { ...none, preferences: true };
  let configured = 0;
  const client = new AutoClient({
    status: async () => ready(scopes), enable: async () => ready(scopes), disable: async () => offStatus,
    configure: async (input) => { configured++; assert.deepEqual(input.client, { hosts: [], preferences: { [appKey]: '{"theme":"local"}' }, preferenceCoverage: [...preferenceKeys] }); scopes = input.scopes as AutoScopes; return ready(scopes); },
    tick: async (input) => { assert.deepEqual(scopes, selected); assert.deepEqual(input.client.hosts, []); return { status: ready(scopes), operation: null }; },
    acknowledge: async () => ready(scopes),
  }, () => storage, null, clientId);
  await client.configure(selected);
  assert.equal(configured, 1);
  client.dispose();
});

test("disposing while scope status is loading prevents configuration and client capture", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "invalid hosts must not be captured after disposal");
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let configured = 0;
  const client = new AutoClient({
    status: async () => { entered(); await gate; return ready(none); }, enable: async () => ready(none), disable: async () => offStatus,
    tick: async () => { throw new Error("disposed clients must not tick"); },
    configure: async () => { configured++; return ready(none); }, acknowledge: async () => ready(none),
  }, () => storage, null, clientId);
  const configuring = client.configure({ ...none, hosts: true });
  await started;
  client.dispose();
  release();
  await configuring;
  assert.equal(configured, 0);
});

test("scope configuration and enable remain serialized and busy while configuration is in flight", async () => {
  const storage = new MemoryStorage();
  let scopes = none;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const order: string[] = [];
  const client = new AutoClient({
    status: async () => ready(scopes), disable: async () => offStatus,
    tick: async () => ({ status: ready(scopes), operation: null }), acknowledge: async () => ready(scopes),
    configure: async (input) => { order.push("configure start"); entered(); await gate; scopes = input.scopes as AutoScopes; order.push("configure end"); return ready(scopes); },
    enable: async (input) => { order.push("enable"); scopes = input.scopes as AutoScopes; return ready(scopes); },
  }, () => storage, null, clientId);
  const changing = client.configure({ ...none, plugins: true });
  const enabling = client.enable(clientId, { ...none, providers: true });
  await started;
  assert.equal(client.getSnapshot().busy, true);
  assert.deepEqual(order, ["configure start"]);
  release();
  await Promise.all([changing, enabling]);
  assert.deepEqual(order, ["configure start", "configure end", "enable"]);
  assert.equal(client.getSnapshot().busy, false);
  assert.deepEqual(client.getSnapshot().status.scopes, { ...none, providers: true });
  client.dispose();
});

test("an observer cannot configure without an explicit ownership request", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "must not capture observer hosts");
  const previousOwner = "290b1d35-43df-419f-9d3c-8c974af4d514";
  const status = { ...ready(none), ownerClientId: previousOwner };
  let mutations = 0;
  const client = new AutoClient({
    status: async () => status, enable: async () => status, disable: async () => offStatus,
    claim: async () => { mutations++; return status; },
    configure: async () => { mutations++; return status; },
    tick: async () => { mutations++; return { status, operation: null }; }, acknowledge: async () => status,
  }, () => storage, null, clientId);
  await assert.rejects(client.configure({ ...none, hosts: true }), /동기화 담당/);
  assert.equal(mutations, 0);
  assert.equal(client.getSnapshot().owned, false);
  client.dispose();
});

for (const previousOwner of [null, "290b1d35-43df-419f-9d3c-8c974af4d514"]) {
  test(`explicit scope takeover uses one configure RPC without a separate claim or old-scope tick (${previousOwner ? "other app" : "unclaimed"})`, async () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, "deselected hosts must never be read");
    storage.setItem(appKey, "deselected preferences must never be read");
    let status: AutoStatus = { ...ready(offStatus.scopes), ownerClientId: previousOwner };
    const selected = { ...none, plugins: true };
    const order: string[] = [];
    const client = new AutoClient({
      status: async () => status, enable: async () => status, disable: async () => offStatus,
      claim: async () => { throw new Error("separate claim must not run"); },
      configure: async (input) => {
        order.push("configure");
        assert.deepEqual(input.takeover, { expectedOwnerClientId: previousOwner });
        assert.deepEqual(input.client, { hosts: [], preferences: {} });
        assert.deepEqual(input.scopes, selected);
        status = ready(selected);
        return status;
      },
      tick: async (input) => { order.push("new tick"); assert.deepEqual(status.scopes, selected); assert.deepEqual(input.client, { hosts: [], preferences: {} }); return { status, operation: null }; },
      acknowledge: async () => status,
    }, () => storage, null, clientId);
    await client.configure(selected, true);
    assert.deepEqual(order, ["configure", "new tick"]);
    assert.equal(client.getSnapshot().owned, true);
    client.dispose();
  });
}

test("explicit takeover remains available when the selected scopes are unchanged", async () => {
  const storage = new MemoryStorage();
  const previousOwner = "290b1d35-43df-419f-9d3c-8c974af4d514";
  let status: AutoStatus = { ...ready(none), ownerClientId: previousOwner };
  let configured = 0;
  const client = new AutoClient({
    status: async () => status, enable: async () => status, disable: async () => offStatus,
    configure: async (input) => { configured++; assert.deepEqual(input.scopes, none); assert.deepEqual(input.takeover, { expectedOwnerClientId: previousOwner }); status = ready(none); return status; },
    tick: async () => ({ status, operation: null }), acknowledge: async () => status,
  }, () => storage, null, clientId);
  await client.configure(none, true);
  assert.equal(configured, 1);
  assert.equal(client.getSnapshot().owned, true);
  client.dispose();
});

test("a rejected stale-owner takeover never updates the observer or starts synchronization", async () => {
  const storage = new MemoryStorage();
  const observedOwner = "290b1d35-43df-419f-9d3c-8c974af4d514";
  const newerOwner = "91bf8d80-567d-4872-a678-9d9d35289fa6";
  const observed = { ...ready(none), ownerClientId: observedOwner };
  let serverOwner = observedOwner;
  let ticks = 0;
  const client = new AutoClient({
    status: async () => { serverOwner = newerOwner; return observed; }, enable: async () => observed, disable: async () => offStatus,
    configure: async (input) => { assert.deepEqual(input.takeover, { expectedOwnerClientId: observedOwner }); assert.notEqual(serverOwner, input.takeover?.expectedOwnerClientId); throw new Error("동기화 담당 앱이 변경되었습니다. 다시 확인하세요."); },
    tick: async () => { ticks++; return { status: observed, operation: null }; }, acknowledge: async () => observed,
  }, () => storage, null, clientId);
  await assert.rejects(client.configure({ ...none, plugins: true }, true), /담당 앱이 변경/);
  assert.equal(serverOwner, newerOwner);
  assert.equal(client.getSnapshot().owned, false);
  assert.deepEqual(client.getSnapshot().status.scopes, none);
  assert.equal(ticks, 0);
  client.dispose();
});

test("pending restoration blocks explicit takeover before client capture", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "must not capture pending hosts");
  const status = { ...ready(none), ownerClientId: "290b1d35-43df-419f-9d3c-8c974af4d514", pendingOperations: 1 };
  let configured = 0;
  const client = new AutoClient({
    status: async () => status, enable: async () => status, disable: async () => offStatus,
    configure: async () => { configured++; return status; },
    tick: async () => { throw new Error("pending observer must not tick"); }, acknowledge: async () => status,
  }, () => storage, null, clientId);
  await assert.rejects(client.configure({ ...none, hosts: true }, true), /진행 중인 복원/);
  assert.equal(configured, 0);
  assert.equal(client.getSnapshot().owned, false);
  client.dispose();
});

test("a tick queued behind atomic takeover sees only the saved scopes", async () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "removed hosts must not be captured");
  const selected = { ...none, providers: true };
  let status: AutoStatus = { ...ready(offStatus.scopes), ownerClientId: "290b1d35-43df-419f-9d3c-8c974af4d514" };
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const client = new AutoClient({
    status: async () => status, enable: async () => status, disable: async () => offStatus,
    configure: async () => { order.push("configure start"); entered(); await gate; status = ready(selected); order.push("configure saved"); return status; },
    tick: async (input) => { assert.deepEqual(status.scopes, selected); assert.deepEqual(input.client, { hosts: [], preferences: {} }); order.push("saved-scope tick"); return { status, operation: null }; },
    acknowledge: async () => status,
  }, () => storage, null, clientId);
  const configuring = client.configure(selected, true);
  const queued = client.synchronize();
  await started;
  assert.deepEqual(order, ["configure start"]);
  assert.equal(client.getSnapshot().busy, true);
  release();
  await Promise.all([configuring, queued]);
  assert.deepEqual(order, ["configure start", "configure saved", "saved-scope tick", "saved-scope tick"]);
  client.dispose();
});
