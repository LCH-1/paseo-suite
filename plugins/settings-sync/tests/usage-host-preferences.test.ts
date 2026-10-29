import assert from "node:assert/strict";
import test from "node:test";
import { capture, restore, type StorageAdapter } from "../client/storage";
import { portableState } from "../shared/portable";

const key = "@paseo:app-settings";
const scopes = { hosts: false, preferences: true, providers: false, config: false, plugins: false };
function memory(value: unknown) {
  const values = new Map([[key, JSON.stringify(value)]]);
  const storage: StorageAdapter = { getItem: name => values.get(name) ?? null, setItem: (name, value) => { values.set(name, value); }, removeItem: name => { values.delete(name); } };
  return { storage, read: () => JSON.parse(values.get(key) ?? "{}") };
}

test("usage host selection stays off portable backups while display and pin choices still sync", () => {
  const f = memory({ theme: "dark", usage: { serverId: "windows-local", displayAs: "remaining", pins: [{ sourceId: "claude-windows", windowId: "weekly" }] } });
  const state = capture(f.storage, scopes);
  const saved = JSON.parse(state.preferences[key]);
  assert.equal(saved.usage.serverId, undefined);
  assert.equal(saved.usage.displayAs, "remaining");
  assert.equal(saved.usage.pins.length, 1);
  assert.equal(f.read().usage.serverId, "windows-local");
});

test("restoring a legacy Ubuntu selection keeps this PC's Windows host and converges", () => {
  const f = memory({ theme: "light", usage: { serverId: "windows-local", displayAs: "used", pins: null } });
  const incoming = { hosts: [], preferences: { [key]: JSON.stringify({ theme: "dark", usage: { serverId: "ubuntu-remote", displayAs: "remaining", pins: null } }) }, preferenceCoverage: [key] };
  restore(f.storage, incoming, { hosts: false, merge: false });
  assert.equal(f.read().usage.serverId, "windows-local");
  assert.equal(f.read().theme, "dark");
  assert.equal(f.read().usage.displayAs, "remaining");
  assert.deepEqual(capture(f.storage, scopes).preferences, portableState(incoming).preferences);
});

test("remote settings reset retains the device's usage host while resetting shared settings", () => {
  const f = memory({ theme: "dark", usage: { serverId: "windows-local", displayAs: "remaining", pins: [] } });
  restore(f.storage, { hosts: [], preferences: {}, preferenceCoverage: [key] }, { hosts: false, merge: false });
  assert.deepEqual(f.read(), { usage: { serverId: "windows-local" } });
  assert.deepEqual(capture(f.storage, scopes).preferences, {});
});

test("a null settings backup keeps only this device's usage host", () => {
  const f = memory({ theme: "dark", usage: { serverId: "windows-local" } });
  restore(f.storage, { hosts: [], preferences: { [key]: "null" }, preferenceCoverage: [key] }, { hosts: false, merge: false });
  assert.deepEqual(f.read(), { usage: { serverId: "windows-local" } });
});
