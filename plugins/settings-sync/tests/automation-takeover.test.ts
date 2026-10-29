import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decrypt, decryptLocal, encrypt, encryptLocal } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { offStatus, type AutoScopesInput } from "../shared/automation";
import type { ClientState } from "../shared/model";

const password = "synthetic atomic takeover password";
const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const third = "33333333-3333-4333-8333-333333333333";
const none = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
const preferencesOnly = { ...none, preferences: true };
const client = (theme: string): ClientState => ({ hosts: [{ serverId: `remote-${theme}`, connections: [{ id: "ssh", type: "remoteSsh", host: "synthetic@example.invalid" }] }], preferences: { "@paseo:app-settings": JSON.stringify({ theme }) } });
class Credentials extends CredentialStore {
  values = new Map<string, string>();
  override async protect(value: string): Promise<SecretReference> { const id = randomUUID(); this.values.set(id, value); return { kind: "secret-service", value: id }; }
  override async reveal(reference: SecretReference) { return this.values.get(reference.value)!; }
  override async remove(reference: SecretReference) { this.values.delete(reference.value); }
}
async function fixture(scopes: AutoScopesInput = offStatus.scopes) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-auto-takeover-"));
  const directory = path.join(home, "development-plugin");
  await mkdir(directory);
  await writeFile(path.join(directory, "paseo-plugin.json"), '{"id":"example"}');
  await writeFile(path.join(directory, "index.server.ts"), "export default function contribute() {}\n");
  let config: any = { providers: { claude: { env: { EXAMPLE: "original" } } }, plugins: { example: { source: "directory", path: directory, enabled: true } }, appendSystemPrompt: "original prompt" };
  const calls = { capture: 0, restore: 0, read: 0, write: 0, token: 0 };
  let raw: string | null = null, revision: string | null = null;
  let sequence = 0;
  const vault = {
    read: async () => { calls.read++; return { raw, sha: revision }; },
    write: async (next: string, expected: string | null) => { calls.write++; assert.equal(expected, revision); raw = next; revision = `revision-${++sequence}`; return revision; },
  } as unknown as GitHubVault;
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: any) => { const { removeProviders = [], ...values } = patch; config = { ...config, ...values }; for (const id of removeProviders) delete config.providers[id]; return { config }; },
  } } as unknown as PluginHandlerContext["paseo"];
  const environment = new Environment(home, async () => undefined);
  const capture = environment.capture.bind(environment), restore = environment.restore.bind(environment);
  environment.capture = async (...args) => { calls.capture++; return capture(...args); };
  environment.restore = async (...args) => { calls.restore++; return restore(...args); };
  const credentials = new Credentials();
  const factory = () => new AutoSync(environment, credentials, () => vault, async () => { calls.token++; return "synthetic-token"; }, async () => "example");
  const auto = factory();
  await auto.enable({ login: "example", password, vault }, scopes, first);
  const file = path.join(home, "settings-sync", "automation.json");
  return { home, directory, file, auto, factory, api, calls, current: () => config, saved: async () => { const record = JSON.parse(await readFile(file, "utf8")); return await decryptLocal(record.encrypted, password) as any; }, backup: () => decrypt(raw!, password), seed: async (snapshot: Awaited<ReturnType<typeof decrypt>>) => { raw = await encrypt(snapshot, password); revision = `seed-${++sequence}`; } };
}

test("takeover and new-only scopes commit together once without synchronizing removed categories", async () => {
  const f = await fixture();
  await f.auto.tick(client("old"), f.api, undefined, first);
  const before = await f.saved();
  const reads = f.calls.read, writes = f.calls.write, restores = f.calls.restore;
  f.current().plugins.example.path = `${f.directory}-missing`;
  let saves = 0;
  const save = (f.auto as any).save.bind(f.auto);
  (f.auto as any).save = async () => { saves++; await save(); };
  const selected = await f.auto.configure(preferencesOnly, client("new"), f.api, second, { expectedOwnerClientId: first });
  assert.equal(selected.ownerClientId, second); assert.deepEqual(selected.scopes, preferencesOnly);
  assert.equal(selected.lastSyncedAt, before.lastSyncedAt);
  assert.equal(saves, 1);
  assert.equal(f.calls.read, reads); assert.equal(f.calls.write, writes); assert.equal(f.calls.restore, restores);
  const state = await f.saved();
  assert.equal(state.ownerClientId, second); assert.deepEqual(state.scopes, preferencesOnly);
  assert.equal(state.reconcileScopes.preferences, true); assert.equal(state.reconcileScopes.hosts, false);
  assert.equal(state.lastRevision, null);
  assert.equal((await f.auto.tick(client("old"), f.api, "local", first)).operation, null);
  assert.equal(f.calls.write, writes);
});

test("same scopes still transfer ownership and differing new-app values require an explicit choice", async () => {
  const f = await fixture(preferencesOnly);
  await f.auto.tick(client("old"), f.api, undefined, first);
  const writes = f.calls.write;
  await f.auto.configure(preferencesOnly, client("new"), f.api, second, { expectedOwnerClientId: first });
  f.auto.dispose();
  const resumed = f.factory();
  const result = await resumed.tick(client("new"), f.api, undefined, second);
  assert.equal(result.status.ownerClientId, second); assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
  assert.match(result.status.message, /새로 선택/);
  assert.equal(f.calls.restore, 0); assert.equal(f.calls.write, writes);
  const selected = await resumed.tick(client("new"), f.api, "remote", second);
  assert.ok(selected.operation);
  const done = await resumed.acknowledge(selected.operation.id, { ...client("new"), preferences: selected.operation.client.preferences }, f.api, second);
  assert.equal(done.state, "ready"); assert.equal(done.ownerClientId, second);
});

test("takeover before the first checkpoint protects differing original plugin code until explicitly selected", async () => {
  const f = await fixture();
  const original = await readFile(path.join(f.directory, "index.server.ts"), "utf8");
  const app = client("same");
  await f.seed({
    version: 1, createdAt: "2026-10-23T00:00:00.000Z", device: "synthetic-cloud", scopes: offStatus.scopes,
    client: app, config: { providers: structuredClone(f.current().providers), appendSystemPrompt: f.current().appendSystemPrompt },
    plugins: [{ id: "example", enabled: true, files: {
      "paseo-plugin.json": Buffer.from('{"id":"example"}').toString("base64"),
      "index.server.ts": Buffer.from("export default function contribute() { return 'older cloud code'; }\n").toString("base64"),
    }, settings: {} }],
  });
  assert.equal((await f.saved()).baseline, null);
  await f.auto.configure(offStatus.scopes, app, f.api, second, { expectedOwnerClientId: first });
  assert.deepEqual((await f.saved()).reconcileScopes, offStatus.scopes);
  const result = await f.auto.tick(app, f.api, undefined, second);
  assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
  assert.equal(f.calls.restore, 0); assert.equal(f.calls.write, 0);
  assert.equal(f.current().plugins.example.path, f.directory);
  assert.equal(await readFile(path.join(f.directory, "index.server.ts"), "utf8"), original);
  f.auto.dispose();
  const resumed = f.factory();
  assert.equal((await resumed.tick(app, f.api, undefined, second)).status.state, "conflict");
  assert.equal(f.calls.restore, 0); assert.equal(f.calls.write, 0);
  const selected = await resumed.tick(app, f.api, "local", second);
  assert.equal(selected.status.state, "ready"); assert.equal(selected.operation, null);
  assert.equal((await f.backup()).plugins[0].files["index.server.ts"], Buffer.from(original).toString("base64"));
  assert.equal(f.current().plugins.example.path, f.directory);
});

test("stale expected owners and implicit ownership attempts are rejected before capture or save", async () => {
  const f = await fixture(preferencesOnly);
  await f.auto.tick(client("old"), f.api, undefined, first);
  await f.auto.claim(third);
  const raw = await readFile(f.file, "utf8");
  const captures = f.calls.capture;
  await assert.rejects(f.auto.configure(none, client("new"), f.api, second, { expectedOwnerClientId: first }), /담당 앱이 변경/);
  await assert.rejects(f.auto.configure(none, client("new"), f.api, second), /담당/);
  assert.equal(f.calls.capture, captures);
  assert.equal((await f.auto.status()).ownerClientId, third);
  assert.equal(await readFile(f.file, "utf8"), raw);
});

for (const dirty of ["providers", "config", "plugins"] as const) {
  test(`dirty retained ${dirty} leaves the original owner and every saved setting unchanged`, async () => {
    const f = await fixture();
    await f.auto.tick(client("old"), f.api, undefined, first);
    if (dirty === "providers") f.current().providers.claude.env.EXAMPLE = "edited";
    if (dirty === "config") f.current().appendSystemPrompt = "edited";
    if (dirty === "plugins") await writeFile(path.join(f.directory, "index.server.ts"), "export default function contribute() { return () => {}; }\n");
    const raw = await readFile(f.file, "utf8");
    const before = await f.saved();
    const reads = f.calls.read, writes = f.calls.write;
    await assert.rejects(f.auto.configure(offStatus.scopes, client("different-app"), f.api, second, { expectedOwnerClientId: first }), /아직 전송하지 않은 변경/);
    assert.equal((await f.auto.status()).ownerClientId, first);
    assert.equal(await readFile(f.file, "utf8"), raw);
    assert.deepEqual(await f.saved(), before);
    assert.equal(f.calls.read, reads); assert.equal(f.calls.write, writes);
  });
}

test("pending restoration blocks takeover before ownership or scopes change", async () => {
  const f = await fixture(preferencesOnly);
  await f.auto.tick(client("old"), f.api, undefined, first);
  const incoming = await f.backup(); incoming.client.preferences = client("cloud").preferences;
  await f.seed(incoming);
  const pending = await f.auto.tick(client("old"), f.api, undefined, first);
  assert.ok(pending.operation);
  const raw = await readFile(f.file, "utf8");
  const captures = f.calls.capture;
  await assert.rejects(f.auto.configure(none, client("new"), f.api, second, { expectedOwnerClientId: first }), /진행 중인 복원/);
  assert.equal(f.calls.capture, captures);
  const state = await f.saved();
  assert.equal(state.ownerClientId, first); assert.equal(state.pending.id, pending.operation.id);
  assert.equal(await readFile(f.file, "utf8"), raw);
});

test("failed atomic persistence restores owner, scopes, baseline and reconciliation in memory and on disk", async () => {
  const f = await fixture(preferencesOnly);
  await f.auto.tick(client("old"), f.api, undefined, first);
  const raw = await readFile(f.file, "utf8");
  const before = structuredClone((f.auto as any).state);
  let saves = 0;
  (f.auto as any).save = async () => { saves++; throw Error("synthetic persistence failure"); };
  await assert.rejects(f.auto.configure(none, client("new"), f.api, second, { expectedOwnerClientId: first }), /synthetic persistence failure/);
  assert.equal(saves, 1);
  assert.deepEqual((f.auto as any).state, before);
  assert.equal((await f.auto.status()).ownerClientId, first);
  assert.equal(await readFile(f.file, "utf8"), raw);
});

test("explicit null-owner takeover with all scopes off does not authenticate or capture", async () => {
  const f = await fixture(none);
  const record = JSON.parse(await readFile(f.file, "utf8"));
  const state = await decryptLocal(record.encrypted, password) as any;
  delete state.ownerClientId;
  record.encrypted = await encryptLocal(state, password);
  await writeFile(f.file, JSON.stringify(record));
  f.auto.dispose();
  const resumed = f.factory();
  await assert.rejects(resumed.configure(none, client("new"), f.api, second), /담당/);
  const selected = await resumed.configure(none, client("new"), f.api, second, { expectedOwnerClientId: null });
  assert.equal(selected.ownerClientId, second); assert.deepEqual(selected.scopes, none);
  assert.deepEqual(f.calls, { capture: 0, restore: 0, read: 0, write: 0, token: 0 });
});

test("takeover validates UUIDs while an unchanged owner and scopes remain a no-op", async () => {
  const f = await fixture(none);
  const raw = await readFile(f.file, "utf8");
  await assert.rejects(f.auto.configure(none, client("new"), f.api, "invalid", { expectedOwnerClientId: first }));
  await assert.rejects(f.auto.configure(none, client("new"), f.api, second, { expectedOwnerClientId: "invalid" }));
  await f.auto.configure(none, client("old"), f.api, first);
  assert.equal(await readFile(f.file, "utf8"), raw);
  assert.equal((await f.auto.status()).ownerClientId, first);
});
