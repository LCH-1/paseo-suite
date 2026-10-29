import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decrypt, decryptLocal, encrypt } from "../server/crypto";
import { Environment, ProviderCaptureError } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { ProviderCredentialSync } from "../server/provider-credentials";
import { normalizeScopes, stableString } from "../shared/automation";
import type { ClientState, Snapshot } from "../shared/model";

const password = "synthetic deferred provider password";
const owner = "11111111-1111-4111-8111-111111111111";
const scopes = normalizeScopes({ config: true, plugins: false });
const client = (theme = "dark"): ClientState => ({ hosts: [], preferences: { "@paseo:app-settings": JSON.stringify({ theme }) } });
class Keys extends CredentialStore {
  override async protect(): Promise<SecretReference> { return { kind: "secret-service", value: randomUUID() }; }
  override async reveal() { return password; }
  override async remove() {}
}
class Vault {
  raw: string | null = null;
  sha: string | null = null;
  writes = 0;
  async read() { return { raw: this.raw, sha: this.sha }; }
  async write(raw: string, previous: string | null) { assert.equal(previous, this.sha); this.raw = raw; return this.sha = `revision-${++this.writes}`; }
  asVault() { return this as unknown as GitHubVault; }
}
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-deferred-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "paseo"), userHome = path.join(root, "user"), profile = path.join(userHome, ".claude");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "synthetic-account" } }));
  const refresh = async (expiry = 2_100_000_000_000) => writeFile(path.join(profile, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `synthetic-token-${expiry}`, refreshToken: "synthetic-refresh", expiresAt: expiry } }));
  await refresh();
  const provider = { home, userHome, platform: "linux" as const, env: {} };
  const credentials = new ProviderCredentialSync(provider);
  const capture = credentials.capture.bind(credentials);
  let broken = false;
  credentials.capture = async (...args) => { if (broken) throw new Error("synthetic-sensitive-error"); return capture(...args); };
  const environment = new Environment(home, async () => undefined, credentials, { home: userHome, platform: "linux", env: {}, exists: async () => true, resolveExecutable: async name => `/usr/bin/${name}` });
  let config: any = { providers: { claude: { enabled: true } }, plugins: {}, appendSystemPrompt: "initial" };
  const api = { config: { get: async () => ({ config: structuredClone(config) }), patch: async (patch: any) => { const { removeProviders = [], ...values } = patch; config = { ...config, ...values }; for (const id of removeProviders) delete config.providers[id]; return { config }; } } } as unknown as PluginHandlerContext["paseo"];
  const vault = new Vault();
  const factory = () => new AutoSync(environment, new Keys(), () => vault.asVault(), async () => "synthetic", async () => "example");
  const auto = factory();
  await auto.enable({ login: "example", password, vault: vault.asVault() }, scopes, owner);
  const saved = async () => { const record = JSON.parse(await readFile(path.join(home, "settings-sync/automation.json"), "utf8")); return await decryptLocal(record.encrypted, password) as any; };
  return { environment, api, vault, auto, factory, saved, refresh, setBroken: (value: boolean) => { broken = value; }, current: () => config };
}

test("broken authentication cannot erase cloud credentials or block host preferences and server edits", async t => {
  const f = await fixture(t);
  assert.equal((await f.auto.tick(client(), f.api, undefined, owner)).status.state, "ready");
  const before = await decrypt(f.vault.raw!, password), checkpoint = await f.saved();
  f.setBroken(true);
  await f.api.config.patch({ appendSystemPrompt: "edited while auth unavailable" });
  const result = await f.auto.tick(client("light"), f.api, undefined, owner);
  assert.equal(result.status.state, "ready");
  assert.match(result.status.message, /인증은 대기/);
  assert.equal(result.status.scopes.providers, true);
  assert.equal(result.status.pendingOperations, 0);
  assert.ok(!result.status.message.includes("sensitive"));
  const after = await decrypt(f.vault.raw!, password);
  assert.deepEqual(after.credentials, before.credentials);
  assert.deepEqual(after.config.providers, before.config.providers);
  assert.equal(after.config.appendSystemPrompt, "edited while auth unavailable");
  assert.deepEqual(after.client.preferences, client("light").preferences);
  assert.equal((await f.saved()).baseline.categories.providers, checkpoint.baseline.categories.providers);
  f.auto.dispose();
  const restarted = f.factory();
  assert.match((await restarted.status()).message, /인증은 대기/);
  await restarted.tick(client("light"), f.api, undefined, owner);
  assert.equal(f.vault.writes, 2);
});

test("recovered credentials publish fresh tokens after partial revisions and restart", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  f.setBroken(true);
  await f.auto.tick(client("light"), f.api, undefined, owner);
  f.auto.dispose();
  f.setBroken(false); await f.refresh(2_200_000_000_000);
  const restarted = f.factory();
  const result = await restarted.tick(client("light"), f.api, undefined, owner);
  assert.equal(result.status.state, "ready", result.status.message);
  assert.doesNotMatch(result.status.message, /대기/);
  assert.equal((await decrypt(f.vault.raw!, password)).credentials!.records[0].expiresAt, 2_200_000_000_000);
  assert.equal((await f.saved()).deferredProviders, undefined);
});

test("partial remote restore survives restart and acknowledgement without reading blocked authentication", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  const remote = await decrypt(f.vault.raw!, password);
  remote.client = client("light");
  await f.vault.write(await encrypt(remote, password), f.vault.sha);
  f.setBroken(true);
  const result = await f.auto.tick(client(), f.api, undefined, owner);
  assert.ok(result.operation);
  assert.equal(result.operation.scopes?.providers, false);
  f.auto.dispose();
  const restarted = f.factory();
  const acknowledged = await restarted.acknowledge(result.operation.id, result.operation.client, f.api, owner);
  assert.equal(acknowledged.pendingOperations, 0);
  assert.match(acknowledged.message, /인증은 대기/);
  assert.equal(stableString((await decrypt(f.vault.raw!, password)).credentials), stableString(remote.credentials));
});

test("provider-only and unrelated capture failures stay errors without false progress", async t => {
  const f = await fixture(t);
  await f.auto.enable({ login: "example", password, vault: f.vault.asVault() }, { hosts: false, preferences: false, providers: true, config: false, plugins: false }, owner);
  f.setBroken(true);
  const result = await f.auto.tick(client(), f.api, undefined, owner);
  assert.equal(result.status.state, "error"); assert.equal(f.vault.writes, 0);
  assert.ok(new ProviderCaptureError() instanceof Error);
  f.environment.capture = async () => { throw new Error("synthetic plugin failure"); };
  await f.auto.enable({ login: "example", password, vault: f.vault.asVault() }, scopes, owner);
  const unrelated = await f.auto.tick(client(), f.api, undefined, owner);
  assert.equal(unrelated.status.state, "error"); assert.match(unrelated.status.message, /plugin failure/);
  assert.equal(f.vault.writes, 0);
});

test("different categories merge local preferences and remote server settings into one published backup", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  const remote = await decrypt(f.vault.raw!, password);
  remote.config.appendSystemPrompt = "remote server edit";
  await f.vault.write(await encrypt(remote, password), f.vault.sha);
  const result = await f.auto.tick(client("light"), f.api, undefined, owner);
  const status = result.operation ? await f.auto.acknowledge(result.operation.id, result.operation.client, f.api, owner) : result.status;
  assert.equal(status.state, "ready", status.message);
  const merged = await decrypt(f.vault.raw!, password);
  assert.equal(merged.config.appendSystemPrompt, "remote server edit");
  assert.deepEqual(merged.client.preferences, client("light").preferences);
  assert.equal(f.vault.writes, 3);
  await f.auto.tick(client("light"), f.api, undefined, owner);
  assert.equal(f.vault.writes, 3);
});

test("a partial merge survives app acknowledgement and restart without losing local edits", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  const remote = await decrypt(f.vault.raw!, password);
  remote.config.appendSystemPrompt = "remote server edit";
  remote.client.hosts = [{ serverId: "synthetic-remote", connections: [{ id: "tcp", type: "directTcp", endpoint: "synthetic.example:6767" }] }];
  await f.vault.write(await encrypt(remote, password), f.vault.sha);
  f.setBroken(true);
  const result = await f.auto.tick(client("light"), f.api, undefined, owner);
  assert.ok(result.operation, result.status.message);
  assert.equal(result.operation.scopes?.providers, false);
  f.auto.dispose();
  const restarted = f.factory();
  const status = await restarted.acknowledge(result.operation.id, result.operation.client, f.api, owner);
  assert.equal(status.state, "ready"); assert.equal(status.pendingOperations, 0);
  const merged = await decrypt(f.vault.raw!, password);
  assert.equal(merged.client.hosts.length, 1);
  assert.deepEqual(merged.client.preferences, client("light").preferences);
  assert.equal(merged.config.appendSystemPrompt, "remote server edit");
});

test("same-category conflicting preferences never overwrite either side", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  const remote = await decrypt(f.vault.raw!, password);
  remote.client = client("remote-theme");
  await f.vault.write(await encrypt(remote, password), f.vault.sha);
  const result = await f.auto.tick(client("local-theme"), f.api, undefined, owner);
  assert.equal(result.status.state, "conflict"); assert.equal(result.operation, null);
  assert.equal(f.vault.writes, 2);
  assert.deepEqual((await decrypt(f.vault.raw!, password)).client.preferences, client("remote-theme").preferences);
});

test("provider edits received during deferral are rechecked after recovery even when the revision was already observed", async t => {
  const f = await fixture(t);
  await f.auto.tick(client(), f.api, undefined, owner);
  f.setBroken(true);
  await f.auto.tick(client("light"), f.api, undefined, owner);
  const remote = await decrypt(f.vault.raw!, password);
  (remote.config.providers as Record<string, Record<string, unknown>>).claude.label = "remote provider edit";
  await f.vault.write(await encrypt(remote, password), f.vault.sha);
  const deferred = await f.auto.tick(client("light"), f.api, undefined, owner);
  assert.equal(deferred.status.state, "ready");
  assert.equal(f.current().providers.claude.label, undefined);
  f.auto.dispose(); f.setBroken(false);
  const restarted = f.factory();
  const recovered = await restarted.tick(client("light"), f.api, undefined, owner);
  const status = recovered.operation ? await restarted.acknowledge(recovered.operation.id, recovered.operation.client, f.api, owner) : recovered.status;
  assert.equal(status.state, "ready", status.message);
  assert.equal(f.current().providers.claude.label, "remote provider edit");
  assert.equal((await f.saved()).deferredProviders, undefined);
});

test("first partial backup declares missing provider coverage and later adds authentication without erasing other settings", async t => {
  const f = await fixture(t);
  f.setBroken(true);
  const partial = await f.auto.tick(client(), f.api, undefined, owner);
  assert.equal(partial.status.state, "ready");
  const before = await decrypt(f.vault.raw!, password);
  assert.equal(before.scopes?.providers, false); assert.equal(before.credentials, undefined);
  f.setBroken(false);
  const complete = await f.auto.tick(client(), f.api, undefined, owner);
  assert.equal(complete.status.state, "ready", complete.status.message);
  const after = await decrypt(f.vault.raw!, password);
  assert.equal(after.scopes?.providers, true); assert.equal(after.credentials?.records.length, 1);
  assert.deepEqual(after.client, before.client);
});
