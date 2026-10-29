import assert from "node:assert/strict";
import { test } from "node:test";
import { AutoClient, clientIdKey } from "../client/automation";
import { capture, hostKey, type StorageAdapter } from "../client/storage";
import { offStatus, type AutoStatus } from "../shared/automation";
import { preferenceKeys } from "../shared/model";

class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}
const firstId = "bd4bb290-5b1c-4caa-ad7f-6f45dab81aa8";
const secondId = "f0ba1266-ae66-4e93-a235-834da37586b5";
const ready = (ownerClientId: string | null): AutoStatus => ({ ...offStatus, enabled: true, state: "ready", ownerClientId });
const desired = { hosts: [], preferences: { "@paseo:app-settings": '{"theme":"dark"}' } };

test("app identity persists as a raw UUID across plugin instances and stays outside backups", async () => {
  const storage = new MemoryStorage();
  const transport = {
    status: async () => offStatus, enable: async () => offStatus, disable: async () => offStatus,
    tick: async () => { throw new Error("off clients must not tick"); }, acknowledge: async () => offStatus,
  };
  const first = new AutoClient(transport, () => storage, null);
  await first.synchronize();
  const identity = storage.getItem(clientIdKey)!;
  assert.match(identity, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  first.dispose();
  const second = new AutoClient(transport, () => storage, null);
  await second.synchronize();
  assert.equal(storage.getItem(clientIdKey), identity);
  assert.deepEqual(capture(storage), { hosts: [], preferences: {}, hostSettings: { hosts: [], order: null }, preferenceCoverage: [...preferenceKeys] });
  second.dispose();
});

for (const owner of [null, secondId]) {
  test(`unclaimed and other-owner connections observe without reading app settings or claiming (${owner === null ? "unclaimed" : "other"})`, async () => {
    const storage = new MemoryStorage();
    storage.setItem(hostKey, "invalid JSON should never be captured by an observer");
    let ticks = 0;
    let claims = 0;
    const client = new AutoClient({
      status: async () => ready(owner), enable: async () => ready(owner), disable: async () => offStatus,
      claim: async () => { claims++; return ready(firstId); },
      tick: async () => { ticks++; return { status: ready(owner), operation: null }; },
      acknowledge: async () => { throw new Error("observers must not acknowledge"); },
    }, () => storage, null, firstId);
    await client.synchronize();
    await client.synchronize("local");
    await client.synchronize("remote");
    assert.equal(client.getSnapshot().owned, false);
    assert.equal(client.getSnapshot().status.state, "ready");
    assert.equal(ticks, 0);
    assert.equal(claims, 0);
    client.dispose();
  });
}

test("only the assigned app sends its identity with restore and acknowledgement", async () => {
  const storage = new MemoryStorage();
  let ticks = 0;
  let acknowledgements = 0;
  const client = new AutoClient({
    status: async () => ready(firstId), enable: async () => ready(firstId), disable: async () => offStatus,
    tick: async (input) => { assert.equal(input.clientId, firstId); ticks++; return { status: ready(firstId), operation: { id: firstId, client: desired } }; },
    acknowledge: async (input) => { assert.equal(input.clientId, firstId); assert.deepEqual(input.client, { ...desired, hostSettings: { hosts: [], order: null }, preferenceCoverage: [...preferenceKeys] }); acknowledgements++; return ready(firstId); },
  }, () => storage, null, firstId);
  await client.synchronize();
  assert.equal(client.getSnapshot().owned, true);
  assert.equal(ticks, 1);
  assert.equal(acknowledgements, 1);
  assert.deepEqual(capture(storage), { ...desired, hostSettings: { hosts: [], order: null }, preferenceCoverage: [...preferenceKeys] });
  client.dispose();
});

test("an ownership change during a tick prevents the returned operation from reaching local storage", async () => {
  const storage = new MemoryStorage();
  const client = new AutoClient({
    status: async () => ready(firstId), enable: async () => ready(firstId), disable: async () => offStatus,
    tick: async () => ({ status: ready(secondId), operation: { id: firstId, client: desired } }),
    acknowledge: async () => { throw new Error("new owner must acknowledge its own changes"); },
  }, () => storage, null, firstId);
  await client.synchronize();
  assert.equal(client.getSnapshot().owned, false);
  assert.deepEqual(capture(storage), { hosts: [], preferences: {}, hostSettings: { hosts: [], order: null }, preferenceCoverage: [...preferenceKeys] });
  client.dispose();
});

test("explicit ownership handover stops the old app and starts the newly selected app", async () => {
  let owner: string | null = null;
  const calls: string[] = [];
  const storageA = new MemoryStorage();
  const storageB = new MemoryStorage();
  const transport = {
    status: async () => ready(owner), enable: async () => ready(owner), disable: async () => offStatus,
    claim: async ({ clientId }: { clientId: string }) => { owner = clientId; return ready(owner); },
    tick: async ({ clientId }: { clientId?: string }) => { assert.equal(clientId, owner); calls.push(clientId!); return { status: ready(owner), operation: null }; },
    acknowledge: async () => ready(owner),
  };
  const first = new AutoClient(transport, () => storageA, null, firstId);
  const second = new AutoClient(transport, () => storageB, null, secondId);
  await first.synchronize();
  await second.synchronize();
  assert.deepEqual(calls, []);
  await first.claim();
  await second.synchronize();
  assert.deepEqual(calls, [firstId]);
  await second.claim();
  await first.synchronize();
  assert.deepEqual(calls, [firstId, secondId]);
  assert.equal(first.getSnapshot().owned, false);
  assert.equal(second.getSnapshot().owned, true);
  first.dispose(); second.dispose();
});

test("enabling automatic sync assigns the current app before its first tick", async () => {
  const storage = new MemoryStorage();
  let assigned: string | null = null;
  let ticks = 0;
  const client = new AutoClient({
    status: async () => ready(assigned), disable: async () => offStatus,
    enable: async (input) => { assert.equal(input.clientId, firstId); assigned = input.clientId!; return ready(assigned); },
    tick: async (input) => { assert.equal(input.clientId, assigned); ticks++; return { status: ready(assigned), operation: null }; },
    acknowledge: async () => ready(assigned),
  }, () => storage, null, firstId);
  await client.enable(secondId);
  assert.equal(client.getSnapshot().owned, true);
  assert.equal(ticks, 1);
  client.dispose();
});
