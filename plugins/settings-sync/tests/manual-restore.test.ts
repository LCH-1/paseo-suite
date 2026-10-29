import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { SyncService } from "../server/service";
import { GitHubLogin } from "../server/login";
import type { GitHubVault } from "../server/github";
import type { Environment } from "../server/environment";
import { encrypt } from "../server/crypto";
import { manualRpc } from "../shared/manual-restore-rpc";
import type { Snapshot } from "../shared/model";

const password = "synthetic manual restore password";
const scopes = { hosts: false, preferences: true, providers: false, config: false, plugins: false };
function gate() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const entered = gate(), release = gate();
  let now = 0, calls = 0, failed = false;
  const saved: Snapshot = { version: 1, createdAt: "2026-10-28T00:00:00.000Z", device: "synthetic", config: {}, plugins: [], client: { hosts: [], preferences: { "@paseo:preferred-editor": "remote-editor" } }, scopes };
  const raw = await encrypt(saved, password);
  const vault = { verify: async () => "synthetic-account", read: async () => ({ sha: "revision", raw }) } as unknown as GitHubVault;
  const environment = {
    fingerprint: async () => "fingerprint",
    restore: async () => { calls++; entered.resolve(); await release.promise; if (failed) throw Error("synthetic restore failure"); return "synthetic-backup-directory"; },
  } as unknown as Environment;
  const service = new SyncService(environment, () => vault, new GitHubLogin(async () => "synthetic-token", async () => "synthetic-account"), () => now);
  t.after(async () => { release.resolve(); await service.dispose(); });
  const connect = async () => service.connect({ flowId: (await service.start()).flowId, password });
  const connection = await connect();
  const api = {} as PluginHandlerContext["paseo"];
  const summary = await service.preview(connection.sessionId, api, scopes);
  const input = { sessionId: connection.sessionId, previewId: summary.id, plugins: false, config: false, scopes };
  return { service, api, input, entered, release, connect, calls: () => calls, clock: (value: number) => { now = value; }, fail: (value: boolean) => { failed = value; } };
}

test("a timed-out legacy invoke can retrieve its completed result and retry without restoring twice", async (t) => {
  const f = await fixture(t);
  const original = f.service.restore(f.input, f.api);
  await f.entered.promise;
  let timer: ReturnType<typeof setTimeout>;
  await assert.rejects(Promise.race([original, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("synthetic host deadline")), 5); })]), /host deadline/);
  clearTimeout(timer!);
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "running" });
  f.release.resolve();
  const expected = await original;
  const status = manualRpc.restoreStatus.output.parse(f.service.restoreStatus(f.input.sessionId, f.input.previewId));
  assert.deepEqual(status, { state: "completed", result: expected });
  assert.deepEqual(await f.service.restore(f.input, f.api), expected);
  assert.equal(f.calls(), 1);
});

test("start and status return while restoration is gated, duplicate starts share one operation", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.startRestore(f.input, f.api), { state: "running" });
  await f.entered.promise;
  assert.deepEqual(f.service.startRestore(f.input, f.api), { state: "running" });
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "running" });
  assert.throws(() => f.service.releaseRestore(f.input.sessionId, f.input.previewId), /진행 중/);
  assert.equal(f.calls(), 1);
  f.release.resolve();
  const expected = await f.service.restore(f.input, f.api);
  const exposed = f.service.restoreStatus(f.input.sessionId, f.input.previewId);
  if (exposed.state !== "completed") assert.fail("expected completion");
  exposed.result.client.preferences["@paseo:preferred-editor"] = "mutated";
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "completed", result: expected });
});

test("changed restore arguments and pending app results block replacement previews and uploads", async (t) => {
  const f = await fixture(t);
  f.service.startRestore(f.input, f.api);
  await f.entered.promise;
  assert.throws(() => f.service.startRestore({ ...f.input, scopes: { ...scopes, hosts: true } }, f.api), /먼저 확인/);
  await assert.rejects(f.service.preview(f.input.sessionId, f.api, scopes), /앱 반영/);
  f.release.resolve(); await f.service.restore(f.input, f.api);
  await assert.rejects(f.service.preview(f.input.sessionId, f.api, scopes), /앱 반영/);
  await assert.rejects(f.service.push(f.input.sessionId, { hosts: [], preferences: {} }, f.api, scopes), /앱 반영/);
  assert.throws(() => f.service.authorizeAutomation(f.input.sessionId), /앱 반영/);
  assert.deepEqual(f.service.releaseRestore(f.input.sessionId, f.input.previewId), { ok: true });
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "missing" });
  assert.deepEqual(f.service.releaseRestore(f.input.sessionId, f.input.previewId), { ok: true });
  assert.ok((await f.service.preview(f.input.sessionId, f.api, scopes)).id);
});

test("completed client settings are bound to the authenticated session and exact preview", async (t) => {
  const f = await fixture(t);
  const other = await f.connect();
  f.service.startRestore(f.input, f.api); f.release.resolve(); await f.service.restore(f.input, f.api);
  assert.deepEqual(f.service.restoreStatus(other.sessionId, f.input.previewId), { state: "missing" });
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, randomUUID()), { state: "missing" });
  assert.throws(() => f.service.restoreStatus(randomUUID(), f.input.previewId), /로그인이 만료/);
  assert.throws(() => f.service.releaseRestore(f.input.sessionId, randomUUID()), /일치하지/);
  assert.equal(JSON.stringify(f.service.restoreStatus(other.sessionId, f.input.previewId)).includes("remote-editor"), false);
});

test("running jobs survive inactivity and completed results get a fresh bounded session lifetime", async (t) => {
  const f = await fixture(t);
  f.service.startRestore(f.input, f.api); await f.entered.promise;
  f.clock(31 * 60_000);
  assert.equal(f.service.restoreStatus(f.input.sessionId, f.input.previewId).state, "running");
  f.release.resolve(); await f.service.restore(f.input, f.api);
  f.clock(60 * 60_000);
  assert.equal(f.service.restoreStatus(f.input.sessionId, f.input.previewId).state, "completed");
  f.clock(91 * 60_000);
  assert.throws(() => f.service.restoreStatus(f.input.sessionId, f.input.previewId), /로그인이 만료/);
});

test("failed operations are retained without repeating side effects and a new preview explicitly retries", async (t) => {
  const f = await fixture(t);
  f.fail(true); f.service.startRestore(f.input, f.api); f.release.resolve();
  await assert.rejects(f.service.restore(f.input, f.api), /synthetic restore failure/);
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "failed", message: "synthetic restore failure" });
  assert.equal(f.service.startRestore(f.input, f.api).state, "failed");
  assert.equal(f.calls(), 1);
  f.fail(false);
  const preview = await f.service.preview(f.input.sessionId, f.api, scopes);
  await f.service.restore({ ...f.input, previewId: preview.id }, f.api);
  assert.equal(f.calls(), 2);
});

test("a new legacy preview invalidates the old cached result without consuming the new preview", async (t) => {
  const f = await fixture(t);
  f.release.resolve(); await f.service.restore(f.input, f.api);
  const preview = await f.service.preview(f.input.sessionId, f.api, scopes);
  await assert.rejects(f.service.restore(f.input, f.api), /다시 여세요/);
  assert.deepEqual(f.service.restoreStatus(f.input.sessionId, f.input.previewId), { state: "missing" });
  await f.service.restore({ ...f.input, previewId: preview.id }, f.api);
  assert.equal(f.calls(), 2);
});
