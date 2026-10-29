import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { finishManualRestore } from "../client/manual-restore";
import { SessionMemory } from "../client/session";
import { capture } from "../client/storage";
import { stableString } from "../shared/automation";
import type { RestoreStatus } from "../shared/manual-restore-rpc";
import { AutoClient } from "../client/automation";
import { offStatus } from "../shared/automation";

function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const host = "synthetic-host", memory = new SessionMemory();
  const values = new Map([["@paseo:preferred-editor", "before"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const scopes = { hosts: false, preferences: true, providers: false, config: false, plugins: false };
  const connection = { sessionId: randomUUID(), login: "synthetic", hasBackup: true, createdAt: "synthetic-date" };
  memory.connection(host, connection);
  const input = { sessionId: connection.sessionId, previewId: randomUUID(), plugins: false, config: false, scopes };
  memory.pending(host, { input, scopes, before: stableString(capture(storage, scopes)), phase: "server" });
  const completed: RestoreStatus = { state: "completed", result: { client: { hosts: [], preferences: { "@paseo:preferred-editor": "remote" } }, scopes, backupDirectory: "synthetic-backup" } };
  let starts = 0, polls = 0, releases = 0;
  const calls = {
    start: async (): Promise<RestoreStatus> => { starts++; return { state: "running" }; },
    status: async (): Promise<RestoreStatus> => { polls++; return structuredClone(completed); },
    release: async () => { releases++; return { ok: true }; },
  };
  const options = { host, memory, storage, calls, active: () => true, wait: async () => {} };
  return { host, memory, values, storage, scopes, connection, input, completed, calls, options, counts: () => ({ starts, polls, releases }) };
}

test("long restoration polls without app writes and releases only after applying settings", async () => {
  const f = fixture(), status = f.calls.status, release = f.calls.release;
  let checks = 0;
  f.calls.status = async () => {
    assert.equal(f.values.get("@paseo:preferred-editor"), "before");
    return ++checks < 3 ? { state: "running" } : status();
  };
  f.calls.release = async () => {
    assert.equal(f.values.get("@paseo:preferred-editor"), "remote");
    assert.equal(f.memory.read(f.host)?.pending?.phase, "applied");
    return release();
  };
  assert.deepEqual(await finishManualRestore(f.options), { backupDirectory: "synthetic-backup" });
  assert.equal(checks, 3);
  assert.equal(f.memory.read(f.host)?.pending, undefined);
  assert.deepEqual([...f.values.keys()], ["@paseo:preferred-editor"]);
});

test("leaving during an invoke preserves the job and a returning screen applies its result", async () => {
  const f = fixture(), delayed = gate<RestoreStatus>();
  let mounted = true;
  f.calls.start = async () => delayed.promise;
  const first = finishManualRestore({ ...f.options, active: () => mounted });
  mounted = false; delayed.resolve(f.completed);
  assert.equal(await first, null);
  assert.equal(f.values.get("@paseo:preferred-editor"), "before");
  assert.equal(f.memory.read(f.host)?.pending?.phase, "server");
  f.memory.connection(f.host, { ...f.connection });
  assert.deepEqual(await finishManualRestore(f.options), { backupDirectory: "synthetic-backup" });
  assert.equal(f.values.get("@paseo:preferred-editor"), "remote");
});

test("a newer screen takes ownership and the old delayed callback cannot replay settings", async () => {
  const f = fixture(), delayed = gate<RestoreStatus>();
  f.calls.start = async () => delayed.promise;
  const first = finishManualRestore(f.options);
  f.calls.start = async () => f.completed;
  assert.ok(await finishManualRestore(f.options));
  f.storage.setItem("@paseo:preferred-editor", "later-user-edit");
  delayed.resolve(f.completed);
  assert.equal(await first, null);
  assert.equal(f.values.get("@paseo:preferred-editor"), "later-user-edit");
  assert.equal(f.counts().releases, 1);
});

test("a lost release reply retries only release and preserves edits after successful app application", async () => {
  const f = fixture(), release = f.calls.release;
  f.calls.release = async () => { throw Error("synthetic lost reply"); };
  await assert.rejects(finishManualRestore(f.options), /lost reply/);
  assert.equal(f.memory.read(f.host)?.pending?.phase, "applied");
  const before = f.counts();
  f.storage.setItem("@paseo:preferred-editor", "later-user-edit");
  f.calls.release = release;
  assert.ok(await finishManualRestore(f.options));
  assert.equal(f.values.get("@paseo:preferred-editor"), "later-user-edit");
  assert.equal(f.counts().starts, before.starts);
  assert.equal(f.counts().polls, before.polls);
});

test("a concurrent app edit is preserved and the completed server result is released", async () => {
  const f = fixture(), status = f.calls.status;
  f.calls.status = async () => { f.storage.setItem("@paseo:preferred-editor", "user-edit"); return status(); };
  await assert.rejects(finishManualRestore(f.options), /사용자 수정을 보존/);
  assert.equal(f.values.get("@paseo:preferred-editor"), "user-edit");
  assert.equal(f.counts().releases, 1);
  assert.equal(f.memory.read(f.host)?.pending, undefined);
});

test("an app write failure retains the result for retry without another server restoration", async () => {
  const f = fixture(), set = f.storage.setItem;
  let failed = false;
  f.storage.setItem = (key, value) => {
    if (value === "remote" && !failed) { failed = true; throw Error("synthetic storage failure"); }
    set(key, value);
  };
  await assert.rejects(finishManualRestore(f.options), /앱 설정 적용에 실패/);
  assert.equal(f.values.get("@paseo:preferred-editor"), "before");
  assert.equal(f.memory.read(f.host)?.pending?.phase, "server");
  assert.equal(f.counts().releases, 0);
  f.calls.start = async () => f.completed; // Cached completed job; no server work is repeated.
  assert.ok(await finishManualRestore(f.options));
  assert.equal(f.values.get("@paseo:preferred-editor"), "remote");
});

test("failed server results are released and reported without applying any app settings", async () => {
  const f = fixture();
  f.calls.status = async () => ({ state: "failed", message: "synthetic server error" });
  await assert.rejects(finishManualRestore(f.options), /synthetic server error/);
  assert.equal(f.values.get("@paseo:preferred-editor"), "before");
  assert.equal(f.memory.read(f.host)?.pending, undefined);
  assert.equal(f.counts().releases, 1);
});

test("unknown jobs and network errors retain memory for an explicit retry or reconnect", async () => {
  const f = fixture();
  f.calls.start = async () => { throw Error("synthetic connection loss"); };
  await assert.rejects(finishManualRestore(f.options), /connection loss/);
  assert.equal(f.memory.read(f.host)?.pending?.phase, "server");
  f.calls.start = async () => ({ state: "missing" });
  await assert.rejects(finishManualRestore(f.options), /복원 작업을 찾을 수/);
  assert.equal(f.memory.read(f.host)?.pending?.phase, "server");
  assert.equal(f.values.get("@paseo:preferred-editor"), "before");
  assert.equal(f.counts().releases, 0);
});

test("changing the host connection invalidates an old pending response", async () => {
  const f = fixture(), delayed = gate<RestoreStatus>();
  f.calls.start = async () => delayed.promise;
  const first = finishManualRestore(f.options);
  const replacement = { ...f.connection, sessionId: randomUUID() };
  f.memory.connection(f.host, replacement);
  delayed.resolve(f.completed);
  assert.equal(await first, null);
  assert.equal(f.memory.read(f.host)?.connection?.sessionId, replacement.sessionId);
  assert.equal(f.values.get("@paseo:preferred-editor"), "before");
});

test("automatic restoration of the same goal while manual restoration waits is acknowledged without a false conflict or replay", async () => {
  const f = fixture(), clientId = randomUUID(), operationId = randomUUID();
  const ready = { ...offStatus, enabled: true, ownerClientId: clientId, state: "ready" as const, scopes: f.scopes };
  let acknowledgements = 0, writes = 0;
  const set = f.storage.setItem;
  f.storage.setItem = (key, value) => { if (key === "@paseo:preferred-editor" && value === "remote") writes++; set(key, value); };
  const auto = new AutoClient({
    status: async () => ready, enable: async () => ready, disable: async () => offStatus,
    tick: async () => ({ status: { ...ready, state: "syncing", pendingOperations: 1 }, operation: { id: operationId, client: f.completed.state === "completed" ? f.completed.result.client : { hosts: [], preferences: {} }, scopes: f.scopes } }),
    acknowledge: async () => { acknowledgements++; return ready; },
  }, () => f.storage, null, clientId);
  try {
    f.calls.status = async () => { await auto.synchronize(); return f.completed; };
    assert.ok(await finishManualRestore(f.options));
    assert.equal(acknowledgements, 1);
    assert.equal(writes, 1, "the manual client must not replay settings already applied by automatic sync");
    assert.equal(f.counts().releases, 1);
    assert.equal(f.memory.read(f.host)?.pending, undefined);
    assert.equal(f.values.get("@paseo:preferred-editor"), "remote");
  } finally { auto.dispose(); }
});
