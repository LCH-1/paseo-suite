import assert from "node:assert/strict";
import test from "node:test";
import { offStatus } from "../shared/automation";
import { AutoSyncRpc } from "../server/auto-rpc";
import type { AutoSync } from "../server/automation";

const status = { ...offStatus, enabled: true, state: "ready" as const };
type TickResult = Awaited<ReturnType<AutoSync["tick"]>>;
const result: TickResult = { status, operation: null };
const restoration: TickResult = { status, operation: { id: "00000000-0000-4000-8000-000000000001", client: { hosts: [], preferences: {} }, scopes: status.scopes } };
function deferred() {
  let resolve!: (value: TickResult) => void;
  let reject!: (error: Error) => void;
  const task = new Promise<TickResult>((done, fail) => { resolve = done; reject = fail; });
  return { task, resolve, reject };
}

test("long synchronization returns progress before the host deadline and preserves one in-flight job", async () => {
  const gate = new AutoSyncRpc(async () => status, 10);
  const job = deferred();
  let calls = 0;
  const action = () => { calls++; return job.task; };
  const first = await gate.tick("owner", action);
  assert.equal(first.status.state, "syncing");
  assert.equal((await gate.status()).state, "syncing");
  const second = gate.tick("owner", action);
  job.resolve(restoration);
  assert.equal((await second).operation, null);
  assert.equal((await second).status.state, "syncing");
  assert.equal(calls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await gate.tick("owner", async () => restoration), restoration);
});

test("another client receives progress without the owner's restoration payload", async () => {
  const gate = new AutoSyncRpc(async () => status, 10);
  const job = deferred();
  const owner = gate.tick("owner", () => job.task);
  await new Promise(resolve => setImmediate(resolve));
  const other = await gate.tick("other", async () => { throw new Error("must not run"); });
  assert.equal(other.operation, null);
  assert.equal(other.status.state, "syncing");
  job.resolve(restoration);
  assert.deepEqual(await owner, restoration);
});

test("a force decision is never silently replaced by an already running normal tick", async () => {
  const gate = new AutoSyncRpc(async () => status, 10);
  const job = deferred();
  const normal = gate.tick("owner", () => job.task);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(gate.tick("owner", async () => result, true), /완료 후/);
  job.resolve(result);
  await normal;
});

test("a failed in-flight job is released and the next poll can retry", async () => {
  const gate = new AutoSyncRpc(async () => status, 10);
  await assert.rejects(gate.tick("owner", async () => { throw new Error("synthetic failure"); }), /synthetic failure/);
  assert.deepEqual(await gate.tick("owner", async () => result), result);
});
