import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync, LEGACY_CLIENT_ID } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decryptLocal, encrypt, encryptLocal } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import type { ClientState, Snapshot } from "../shared/model";

const password = "synthetic owner test password";
const scopes = { config: true, plugins: true };
const empty = (): ClientState => ({ hosts: [], preferences: {} });
const owner = "11111111-1111-4111-8111-111111111111";
const observer = "22222222-2222-4222-8222-222222222222";
class Credentials extends CredentialStore {
  values = new Map<string, string>();
  protects = 0;
  override async protect(value: string): Promise<SecretReference> {
    this.protects++;
    const id = randomUUID(); this.values.set(id, value);
    return { kind: "secret-service", value: id };
  }
  override async reveal(reference: SecretReference) { return this.values.get(reference.value)!; }
  override async remove(reference: SecretReference) { this.values.delete(reference.value); }
}
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-auto-owner-"));
  const calls = { capture: 0, token: 0, identity: 0, factory: 0, read: 0, write: 0 };
  const credentials = new Credentials();
  let remote: { raw: string | null; sha: string | null } = { raw: null, sha: null };
  const vault = {
    read: async () => { calls.read++; return { ...remote }; },
    write: async (raw: string, expected: string | null) => {
      calls.write++; assert.equal(expected, remote.sha);
      remote = { raw, sha: `revision-${calls.write}` }; return remote.sha;
    },
  } as unknown as GitHubVault;
  let config: any = { providers: {}, plugins: {}, appendSystemPrompt: "local" };
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: any) => { config = { ...config, ...patch }; return { config: structuredClone(config) }; },
  } } as unknown as PluginHandlerContext["paseo"];
  const environment = new Environment(home, async () => undefined);
  const capture = environment.capture.bind(environment);
  environment.capture = async (...args) => { calls.capture++; return capture(...args); };
  const factory = () => new AutoSync(environment, credentials, () => { calls.factory++; return vault; }, async () => { calls.token++; return "synthetic-token"; }, async () => { calls.identity++; return "example"; });
  const auto = factory();
  await auto.enable({ login: "example", password, vault }, scopes, owner);
  return { home, auto, api, calls, credentials, factory, seed: (value: typeof remote) => { remote = value; } };
}
function noDataCalls(calls: Awaited<ReturnType<typeof fixture>>["calls"]) {
  assert.deepEqual(calls, { capture: 0, token: 0, identity: 0, factory: 0, read: 0, write: 0 });
}

test("observer tick, forced tick and acknowledgement cannot touch captured data or cloud", async () => {
  const f = await fixture();
  const result = await f.auto.tick(empty(), f.api, undefined, observer);
  assert.equal(result.status.ownerClientId, owner);
  assert.equal(result.operation, null);
  assert.equal((await f.auto.tick(empty(), f.api, "local", observer)).operation, null);
  assert.equal((await f.auto.tick(empty(), f.api, "remote", observer)).operation, null);
  await assert.rejects(f.auto.acknowledge(randomUUID(), empty(), f.api, observer), /담당/);
  noDataCalls(f.calls);
});

test("persisted ownership blocks an observer before GitHub authentication after restart", async () => {
  const f = await fixture();
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.tick(empty(), f.api, "local", observer)).status.ownerClientId, owner);
  await assert.rejects(resumed.acknowledge(randomUUID(), empty(), f.api, observer), /담당/);
  noDataCalls(f.calls);
  const synced = await resumed.tick(empty(), f.api, undefined, owner);
  assert.equal(synced.status.state, "ready");
  assert.equal(f.calls.token, 1); assert.equal(f.calls.identity, 1); assert.equal(f.calls.write, 1);
  resumed.dispose();
  const again = f.factory();
  assert.equal((await again.tick(empty(), f.api, undefined, owner)).status.ownerClientId, owner);
  assert.equal(f.calls.write, 1);
});

test("legacy enabled state stays unowned until an explicit claim without password re-entry", async () => {
  const f = await fixture();
  const file = path.join(f.home, "settings-sync", "automation.json");
  const record = JSON.parse(await readFile(file, "utf8"));
  const state = await decryptLocal(record.encrypted, password) as Record<string, unknown>;
  delete state.ownerClientId;
  record.encrypted = await encryptLocal(state, password);
  await writeFile(file, JSON.stringify(record));
  f.auto.dispose();
  const migrated = f.factory();
  for (const clientId of [owner, observer, LEGACY_CLIENT_ID]) {
    const result = await migrated.tick(empty(), f.api, "local", clientId);
    assert.equal(result.status.ownerClientId, null); assert.equal(result.operation, null);
  }
  noDataCalls(f.calls);
  const claimed = await migrated.claim(owner);
  assert.equal(claimed.ownerClientId, owner);
  assert.equal(f.credentials.protects, 1);
  assert.equal(f.calls.read, 0); assert.equal(f.calls.write, 0); assert.equal(f.calls.capture, 0);
  assert.equal((await migrated.tick(empty(), f.api, undefined, owner)).status.state, "ready");
  assert.equal(f.calls.write, 1);
});

test("explicit handoff preserves pending restoration and only the new owner may acknowledge", async () => {
  const f = await fixture();
  const incoming: Snapshot = { version: 1, createdAt: "2026-10-23T00:00:00.000Z", device: "synthetic", client: { hosts: [], preferences: { "@paseo:app-settings": JSON.stringify({ theme: "light" }) } }, config: { providers: {}, appendSystemPrompt: "remote" }, plugins: [] };
  f.seed({ raw: await encrypt(incoming, password), sha: "incoming-revision" });
  const result = await f.auto.tick(empty(), f.api, undefined, owner);
  assert.ok(result.operation);
  const pendingId = result.operation.id;
  const captureBefore = f.calls.capture;
  const readBefore = f.calls.read;
  const writeBefore = f.calls.write;
  const handed = await f.auto.claim(observer);
  assert.equal(handed.ownerClientId, observer);
  assert.equal(handed.pendingOperations, 1);
  assert.equal(handed.state, "syncing");
  assert.equal(f.credentials.protects, 1);
  assert.equal(f.calls.capture, captureBefore); assert.equal(f.calls.read, readBefore); assert.equal(f.calls.write, writeBefore);
  assert.equal((await f.auto.tick(empty(), f.api, undefined, owner)).operation, null);
  await assert.rejects(f.auto.acknowledge(pendingId, result.operation.client, f.api, owner), /담당/);
  f.auto.dispose();
  const resumed = f.factory();
  const replay = await resumed.tick(empty(), f.api, undefined, observer);
  assert.equal(replay.operation!.id, pendingId);
  const done = await resumed.acknowledge(pendingId, replay.operation!.client, f.api, observer);
  assert.equal(done.pendingOperations, 0); assert.equal(done.ownerClientId, observer); assert.equal(done.state, "ready");
});

test("claim requires an enabled connection and rejects invalid owner IDs before storing a key", async () => {
  const f = await fixture();
  const count = f.credentials.protects;
  await assert.rejects(f.auto.enable({ login: "example", password, vault: {} as GitHubVault }, scopes, "invalid"));
  assert.equal(f.credentials.protects, count);
  await assert.rejects(f.auto.claim("invalid"));
  assert.equal((await f.auto.status()).ownerClientId, owner);
  await f.auto.disable();
  await assert.rejects(f.auto.claim(observer), /먼저 연결/);
});
