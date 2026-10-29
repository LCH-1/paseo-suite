import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { decrypt, encrypt } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { ProviderCredentialSync, providerProfileDirectory } from "../server/provider-credentials";
import { normalizeScopes, serverContent, stableString } from "../shared/automation";
import type { ClientState, Snapshot } from "../shared/model";
import { credentialFreshnessDigest, credentialIdentityDigest } from "../shared/provider-credentials";

type PaseoApi = PluginHandlerContext["paseo"];
const password = "synthetic integrated provider recovery password";
const owner = "11111111-1111-4111-8111-111111111111";
const targetOwner = "22222222-2222-4222-8222-222222222222";
const providersOnly = normalizeScopes({ config: false, plugins: false, providers: true, hosts: false, preferences: false });
const preferencesOnly = { ...providersOnly, providers: false, preferences: true };
const empty = (): ClientState => ({ hosts: [], preferences: {} });

class MemoryVault {
  raw: string | null = null;
  sha: string | null = null;
  writes = 0;
  async read() { return { raw: this.raw, sha: this.sha }; }
  async write(raw: string, expected: string | null) {
    assert.equal(expected, this.sha);
    this.raw = raw; this.sha = `synthetic-revision-${++this.writes}`;
    return this.sha;
  }
  asVault() { return this as unknown as GitHubVault; }
}

class MemoryKeys extends CredentialStore {
  values = new Map<string, string>();
  override async protect(value: string): Promise<SecretReference> { const id = randomUUID(); this.values.set(id, value); return { kind: "secret-service", value: id }; }
  override async reveal(reference: SecretReference) { return this.values.get(reference.value)!; }
  override async remove(reference: SecretReference) { this.values.delete(reference.value); }
}

function merge(local: any, incoming: any): any {
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) return Object.fromEntries(Object.entries({ ...local, ...incoming }).map(([key, value]) => [key, key in incoming ? merge(local?.[key], value) : value]));
  return structuredClone(incoming);
}

function fakePaseo(initial: Record<string, unknown>) {
  let config: any = structuredClone(initial);
  const calls: Record<string, unknown>[] = [];
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (input: Record<string, unknown>) => {
      calls.push(structuredClone(input));
      const { removeProviders = [], ...values } = input;
      config = merge(config, values);
      if (values.plugins !== undefined) config.plugins = structuredClone(values.plugins);
      for (const id of removeProviders as string[]) delete config.providers[id];
      return { config: structuredClone(config) };
    },
  } } as unknown as PaseoApi;
  return { api, calls, current: () => config };
}

const oauth = (account: string, expiry = 2_100_000_000_000) => ({ claudeAiOauth: { accessToken: `synthetic-access-${account}-${expiry}`, refreshToken: `synthetic-refresh-${account}`, expiresAt: expiry, scopes: ["user:inference"] } });
async function claude(directory: string, account: string, expiry?: number) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth(account, expiry)));
  await writeFile(path.join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@synthetic.invalid` }, hasCompletedOnboarding: true, lastOnboardingVersion: "synthetic-version" }));
}
const jwt = (claims: Record<string, unknown>) => `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
async function codex(directory: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "synthetic-codex-account", id_token: jwt({ sub: "synthetic-codex-account" }), access_token: jwt({ sub: "synthetic-codex-account", exp: 2_100_000_000 }), refresh_token: "synthetic-codex-refresh" }, last_refresh: "2026-10-25T00:00:00.000Z", OPENAI_API_KEY: null }));
}

async function device(root: string, label: string, initial: Record<string, unknown>) {
  const home = path.join(root, label, "paseo");
  const userHome = path.join(root, label, "user");
  await mkdir(home, { recursive: true }); await mkdir(userHome, { recursive: true });
  const credentials = new ProviderCredentialSync({ home, userHome, platform: "linux", env: {} });
  const environment = new Environment(home, async () => undefined, credentials, { home: userHome, platform: "linux", env: {}, resolveExecutable: async (name) => label === "source" ? `/home/source/.local/bin/${name}` : `/usr/local/bin/${name}`, exists: async () => false });
  return { home, userHome, credentials, environment, ...fakePaseo({ providers: {}, plugins: {}, metadataGeneration: { providers: [] }, ...initial }) };
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-sync-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^paseo-provider-sync-[a-zA-Z0-9]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const first = path.join(root, "source", "user", "profiles", "first");
  const second = path.join(root, "source", "user", "profiles", "second");
  const coding = path.join(root, "source", "user", "profiles", "codex");
  await claude(first, "first-account"); await claude(second, "second-account"); await codex(coding);
  const providers = {
    claude: { enabled: true, command: ["/home/source/.local/bin/claude", "--verbose"], env: { CLAUDE_CONFIG_DIR: first, CLAUDE_SECURESTORAGE_CONFIG_DIR: first } },
    personal: { extends: "claude", label: "Synthetic personal", enabled: true, env: { CLAUDE_CONFIG_DIR: second, CLAUDE_SECURESTORAGE_CONFIG_DIR: second } },
    codex: { enabled: true, command: ["node", "/home/source/.npm-global/lib/node_modules/@openai/codex/bin/codex.js"], env: { CODEX_HOME: coding } },
  };
  const source = await device(root, "source", { providers });
  const target = await device(root, "target", {});
  return { root, source, target, first, second, coding, providers };
}

async function automation(host: Awaited<ReturnType<typeof device>>, vault: MemoryVault, id: string, scopes = providersOnly) {
  const keys = new MemoryKeys();
  const factory = () => new AutoSync(host.environment, keys, () => vault.asVault(), async () => "synthetic-github-token", async () => "synthetic-account");
  const auto = factory();
  await auto.enable({ login: "synthetic-account", password, vault: vault.asVault() }, scopes, id);
  return { auto, factory };
}

async function synchronize(auto: AutoSync, api: PaseoApi, id: string) {
  const result = await auto.tick(empty(), api, undefined, id);
  assert.notEqual(result.status.state, "error", result.status.message);
  assert.notEqual(result.status.state, "conflict", result.status.message);
  const status = result.operation ? await auto.acknowledge(result.operation.id, result.operation.client, api, id) : result.status;
  assert.equal(status.state, "ready"); assert.equal(status.pendingOperations, 0);
  return status;
}

test("a previously initialized offline device restarts and catches up both expired Claude accounts without changing bindings", async t => {
  const f = await fixture(t), expired = Date.now() - 60_000;
  await claude(f.first, "first-account", expired); await claude(f.second, "second-account", expired);
  const vault = new MemoryVault(), source = await automation(f.source, vault, owner), target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner);
  const bindings = structuredClone(f.target.current().providers);
  target.auto.dispose();
  const renewed = new Map<string, ReturnType<typeof oauth>>();
  for (let generation = 1; generation <= 2; generation++) {
    for (const [directory, account] of [[f.first, "first-account"], [f.second, "second-account"]]) {
      const value = oauth(account, Date.now() + (generation + 1) * 3_600_000);
      value.claudeAiOauth.refreshToken = `synthetic-rotated-${account}-${generation}`;
      renewed.set(account, value); await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(value));
    }
    await synchronize(source.auto, f.source.api, owner);
  }
  const resumed = target.factory(); t.after(() => resumed.dispose());
  assert.equal((await resumed.status()).enabled, true);
  await synchronize(resumed, f.target.api, targetOwner);
  for (const [id, account] of [["claude", "first-account"], ["personal", "second-account"]]) {
    assert.equal(f.target.current().providers[id].env.CLAUDE_CONFIG_DIR, bindings[id].env.CLAUDE_CONFIG_DIR);
    assert.deepEqual(JSON.parse(await readFile(path.join(bindings[id].env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")), renewed.get(account));
  }
  const settled = vault.writes;
  for (let round = 0; round < 3; round++) { await synchronize(source.auto, f.source.api, owner); await synchronize(resumed, f.target.api, targetOwner); }
  assert.equal(vault.writes, settled);
  const persisted = await readFile(path.join(f.target.home, "settings-sync/automation.json"), "utf8");
  assert.equal(persisted.includes("synthetic-rotated-"), false);
});

test("returning device provider edits cannot republish either account's older token over fresher cloud credentials", async t => {
  const f = await fixture(t), vault = new MemoryVault();
  const source = await automation(f.source, vault, owner), target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner);
  const targetBefore = await f.target.credentials.capture(f.target.current().providers);
  for (const [directory, account] of [[f.first, "first-account"], [f.second, "second-account"]]) {
    const value = oauth(account, 2_200_000_000_000); value.claudeAiOauth.refreshToken = `synthetic-renewed-${account}`;
    await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(value));
  }
  await synchronize(source.auto, f.source.api, owner);
  const currentCloud = (await decrypt(vault.raw!, password)).credentials!;
  f.target.current().providers.claude.label = "Returning device provider label";
  await synchronize(target.auto, f.target.api, targetOwner);
  const uploaded = (await decrypt(vault.raw!, password)).credentials!;
  for (const record of currentCloud.records.filter(record => record.vendor === "claude")) {
    assert.deepEqual(uploaded.records.find(candidate => candidate.identity === record.identity)!.credential, record.credential);
  }
  // Still-valid independent local logins are preserved while cloud freshness stays monotonic.
  assert.equal(credentialFreshnessDigest((await f.target.credentials.capture(f.target.current().providers)).credentials), credentialFreshnessDigest(targetBefore.credentials));
});

test("authenticated SDK defaults become installable commands without replacing alias inheritance", async (t) => {
  const f = await fixture(t);
  delete f.source.current().providers.claude.command;
  delete f.source.current().providers.codex.command;
  const snapshot = await f.source.environment.capture(f.source.api, empty(), providersOnly);
  const providers = snapshot.config.providers as Record<string, any>;
  assert.deepEqual(providers.claude.command, ["claude"]);
  assert.deepEqual(providers.codex.command, ["codex"]);
  assert.equal(providers.personal.command, undefined);
  await f.target.environment.restore(f.target.api, snapshot, await f.target.environment.fingerprint(f.target.api, snapshot), { providers: true, config: false, plugins: false, merge: false });
  assert.deepEqual(f.target.current().providers.claude.command, ["/usr/local/bin/claude"]);
  assert.equal(f.target.current().providers.personal.command, undefined);
});

test("encrypted provider snapshot restores two Claude accounts and Codex with target bindings and identical canonical content", async (t) => {
  const f = await fixture(t);
  const captured = await f.source.environment.capture(f.source.api, empty(), providersOnly);
  assert.equal(captured.credentials?.records.length, 3);
  const raw = await encrypt(captured, password);
  for (const value of ["synthetic-access", "synthetic-codex-refresh", f.first, password]) assert.equal(raw.includes(value), false);
  const snapshot = await decrypt(raw, password);
  const before = structuredClone(f.source.current().providers);
  await f.target.environment.restore(f.target.api, snapshot, await f.target.environment.fingerprint(f.target.api, snapshot), { providers: true, config: false, plugins: false, merge: false });
  const restored = f.target.current().providers;
  assert.deepEqual(restored.claude.command, ["/usr/local/bin/claude", "--verbose"]);
  assert.deepEqual(restored.codex.command, ["/usr/local/bin/codex"]);
  assert.notEqual(restored.claude.env.CLAUDE_CONFIG_DIR, restored.personal.env.CLAUDE_CONFIG_DIR);
  for (const record of snapshot.credentials!.records) {
    const directory = providerProfileDirectory(f.target.home, record.id);
    const id = record.providerIds[0];
    assert.equal(restored[id].env[record.vendor === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"], directory);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, record.vendor === "claude" ? ".credentials.json" : "auth.json"), "utf8")), record.credential);
  }
  const recaptured = await f.target.environment.capture(f.target.api, empty(), providersOnly);
  assert.equal(stableString(serverContent(recaptured, providersOnly)), stableString(serverContent(snapshot, providersOnly)));
  assert.equal(credentialIdentityDigest(recaptured.credentials), credentialIdentityDigest(snapshot.credentials));
  assert.equal(credentialFreshnessDigest(recaptured.credentials), credentialFreshnessDigest(snapshot.credentials));
  assert.deepEqual(f.source.current().providers, before);
});

test("two provider environments finish with no pending work and do not republish machine-specific paths", async (t) => {
  const f = await fixture(t);
  const vault = new MemoryVault();
  const source = await automation(f.source, vault, owner);
  const target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner);
  await synchronize(target.auto, f.target.api, targetOwner);
  const writes = vault.writes;
  for (let round = 0; round < 4; round++) {
    await synchronize(source.auto, f.source.api, owner);
    await synchronize(target.auto, f.target.api, targetOwner);
  }
  assert.equal(vault.writes, writes);
  assert.equal((await source.auto.status()).pendingOperations, 0);
  assert.equal((await target.auto.status()).pendingOperations, 0);
  assert.equal(f.source.current().providers.claude.env.CLAUDE_CONFIG_DIR, f.first);
  assert.equal(f.source.current().providers.personal.env.CLAUDE_CONFIG_DIR, f.second);
});

test("Claude refresh backups preserve each device's local login without conflicts or recurring uploads", async (t) => {
  const f = await fixture(t);
  const vault = new MemoryVault();
  const source = await automation(f.source, vault, owner);
  const target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner);
  const firstIdentity = credentialIdentityDigest((await decrypt(vault.raw!, password)).credentials);
  await claude(f.first, "first-account", 2_200_000_000_000);
  const beforeRefresh = vault.writes;
  await synchronize(source.auto, f.source.api, owner);
  assert.equal(vault.writes, beforeRefresh + 1);
  await synchronize(target.auto, f.target.api, targetOwner);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.target.current().providers.claude.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")), oauth("first-account"));
  const personal = f.target.current().providers.personal.env.CLAUDE_CONFIG_DIR;
  await claude(personal, "second-account", 2_300_000_000_000);
  await synchronize(target.auto, f.target.api, targetOwner); await synchronize(source.auto, f.source.api, owner);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.second, ".credentials.json"), "utf8")), oauth("second-account"));
  assert.equal(f.source.current().providers.personal.env.CLAUDE_CONFIG_DIR, f.second);
  assert.equal(credentialIdentityDigest((await decrypt(vault.raw!, password)).credentials), firstIdentity);
  const settled = vault.writes;
  for (let round = 0; round < 3; round++) { await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner); }
  assert.equal(vault.writes, settled);
});

test("expired Claude login receives the same account's fresh cloud token automatically and converges", async (t) => {
  const f = await fixture(t), vault = new MemoryVault();
  const source = await automation(f.source, vault, owner), target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner);
  const directory = f.target.current().providers.claude.env.CLAUDE_CONFIG_DIR;
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth("first-account", Date.now() - 60_000)));
  const before = vault.writes;
  await synchronize(target.auto, f.target.api, targetOwner);
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, ".credentials.json"), "utf8")), oauth("first-account"));
  assert.equal(vault.writes, before);
  for (let i = 0; i < 3; i++) { await synchronize(source.auto, f.source.api, owner); await synchronize(target.auto, f.target.api, targetOwner); }
  assert.equal(vault.writes, before);
});

test("different local Claude accounts converge without replacing credentials or repeatedly publishing", async (t) => {
  const f = await fixture(t);
  const targetClaude = path.join(f.target.userHome, "existing-claude");
  await claude(targetClaude, "target-local-account");
  f.target.current().providers.claude = { ...f.providers.claude, command: ["/usr/local/bin/claude", "--verbose"], env: { CLAUDE_CONFIG_DIR: targetClaude, CLAUDE_SECURESTORAGE_CONFIG_DIR: targetClaude } };
  const vault = new MemoryVault();
  const source = await automation(f.source, vault, owner);
  const target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner);
  const cloudAccount = (await decrypt(vault.raw!, password)).credentials!.records.find((record) => record.providerIds.includes("claude"))!.identity;
  await synchronize(target.auto, f.target.api, targetOwner);
  f.target.current().providers.claude.label = "Updated target label";
  await synchronize(target.auto, f.target.api, targetOwner);
  assert.equal((await decrypt(vault.raw!, password)).credentials!.records.find((record) => record.providerIds.includes("claude"))!.identity, cloudAccount);
  const settled = vault.writes;
  for (let round = 0; round < 3; round++) {
    await synchronize(source.auto, f.source.api, owner);
    await synchronize(target.auto, f.target.api, targetOwner);
  }
  assert.equal(vault.writes, settled);
  assert.equal((await decrypt(vault.raw!, password)).credentials!.records.find((record) => record.providerIds.includes("claude"))!.identity, cloudAccount);
  assert.equal(f.target.current().providers.claude.env.CLAUDE_CONFIG_DIR, targetClaude);
  assert.deepEqual(JSON.parse(await readFile(path.join(targetClaude, ".credentials.json"), "utf8")), oauth("target-local-account"));
  assert.deepEqual(JSON.parse(await readFile(path.join(f.first, ".credentials.json"), "utf8")), oauth("first-account"));
  const selected = await target.auto.tick(empty(), f.target.api, "local", targetOwner);
  assert.equal(selected.status.state, "ready");
  assert.notEqual((await decrypt(vault.raw!, password)).credentials!.records.find((record) => record.providerIds.includes("claude"))!.identity, cloudAccount);
});

for (const arrangement of ["cloud-grouped", "local-grouped", "same-account-split", "local-group-with-extra"] as const) test(`Claude provider bindings converge across ${arrangement} profiles without duplicate authentications`, async (t) => {
  const f = await fixture(t);
  if (arrangement !== "local-grouped") f.source.current().providers.personal.env = { CLAUDE_CONFIG_DIR: f.first, CLAUDE_SECURESTORAGE_CONFIG_DIR: f.first };
  const first = path.join(f.target.userHome, "existing-first");
  const sharedLocal = arrangement === "local-grouped" || arrangement === "local-group-with-extra";
  const second = sharedLocal ? first : path.join(f.target.userHome, "existing-second");
  const firstAccount = arrangement === "same-account-split" ? "first-account" : "target-first";
  const secondAccount = arrangement === "same-account-split" ? "first-account" : sharedLocal ? firstAccount : "target-second";
  await claude(first, firstAccount);
  await claude(second, secondAccount);
  f.target.current().providers.claude = { ...f.providers.claude, command: ["/usr/local/bin/claude", "--verbose"], env: { CLAUDE_CONFIG_DIR: first, CLAUDE_SECURESTORAGE_CONFIG_DIR: first } };
  f.target.current().providers.personal = { ...f.providers.personal, env: { CLAUDE_CONFIG_DIR: second, CLAUDE_SECURESTORAGE_CONFIG_DIR: second } };
  if (arrangement === "local-group-with-extra") f.target.current().providers.extra = { extends: "claude", env: { CLAUDE_CONFIG_DIR: first, CLAUDE_SECURESTORAGE_CONFIG_DIR: first } };
  const account = (id: string, home: string) => ({ id, base: "claude", home, signedIn: true, email: `${id}@synthetic.invalid`, identity: id });
  const sourceAccounts = [account("primary-account", f.first), ...(arrangement === "local-grouped" ? [account("personal-account", f.second)] : [])];
  const targetAccounts = [account("primary-account", first), ...(!sharedLocal ? [account("personal-account", second)] : [])];
  for (const [home, accounts] of [[f.source.home, sourceAccounts], [f.target.home, targetAccounts]] as const) {
    await mkdir(path.join(home, "paseo-accounts"), { recursive: true });
    await writeFile(path.join(home, "paseo-accounts", "accounts.json"), JSON.stringify({ accounts }));
  }
  const targetRegistry = await readFile(path.join(f.target.home, "paseo-accounts", "accounts.json"), "utf8");
  const vault = new MemoryVault();
  const source = await automation(f.source, vault, owner);
  const target = await automation(f.target, vault, targetOwner);
  t.after(() => { source.auto.dispose(); target.auto.dispose(); });
  await synchronize(source.auto, f.source.api, owner);
  const cloudIdentity = credentialIdentityDigest((await decrypt(vault.raw!, password)).credentials);
  await synchronize(target.auto, f.target.api, targetOwner);
  f.target.current().providers.personal.label = "Changed local label";
  await synchronize(target.auto, f.target.api, targetOwner);
  await synchronize(source.auto, f.source.api, owner);
  const settled = vault.writes;
  for (let round = 0; round < 3; round++) {
    await synchronize(target.auto, f.target.api, targetOwner);
    await synchronize(source.auto, f.source.api, owner);
  }
  assert.equal(vault.writes, settled);
  const saved = await decrypt(vault.raw!, password);
  assert.equal(credentialIdentityDigest({ version: 1, records: saved.credentials!.records.filter((record) => !record.providerIds.includes("extra")) }), cloudIdentity);
  if (arrangement === "local-group-with-extra") {
    assert.deepEqual(saved.credentials!.records.find((record) => record.providerIds.includes("extra"))!.providerIds, ["extra"]);
    assert.equal(credentialIdentityDigest((await f.source.environment.capture(f.source.api, empty(), providersOnly)).credentials), credentialIdentityDigest(saved.credentials));
  }
  const bindings = saved.credentials!.records.flatMap((record) => record.providerIds);
  assert.equal(new Set(bindings).size, bindings.length);
  const accountIds = saved.credentials!.records.flatMap((record) => record.metadata.accounts?.map((entry) => entry.id) ?? []);
  assert.equal(new Set(accountIds).size, accountIds.length);
  assert.equal(await readFile(path.join(f.target.home, "paseo-accounts", "accounts.json"), "utf8"), targetRegistry);
  assert.equal(f.target.current().providers.claude.env.CLAUDE_CONFIG_DIR, first);
  assert.equal(f.target.current().providers.personal.env.CLAUDE_CONFIG_DIR, second);
  assert.deepEqual(JSON.parse(await readFile(path.join(first, ".credentials.json"), "utf8")), oauth(firstAccount));
  assert.deepEqual(JSON.parse(await readFile(path.join(second, ".credentials.json"), "utf8")), oauth(secondAccount));
  const forced = await target.auto.tick(empty(), f.target.api, "local", targetOwner);
  assert.equal(forced.status.state, "ready");
  assert.deepEqual((await decrypt(vault.raw!, password)).credentials, (await f.target.environment.capture(f.target.api, empty(), providersOnly)).credentials);
});

test("disabled provider scope neither reads credentials nor includes them in a new backup", async (t) => {
  const f = await fixture(t);
  let captures = 0; let restores = 0;
  const inaccessible = new ProviderCredentialSync({ home: f.target.home, userHome: f.target.userHome, platform: "linux", env: {} });
  inaccessible.capture = async () => { captures++; throw Error("must not inspect excluded authentication"); };
  inaccessible.restore = async () => { restores++; throw Error("must not restore excluded authentication"); };
  const environment = new Environment(f.target.home, async () => undefined, inaccessible, { home: f.target.userHome, platform: "linux", env: {}, resolveExecutable: async () => { throw Error("must not resolve excluded provider command"); } });
  const selected = await environment.capture(f.target.api, empty(), preferencesOnly);
  assert.equal(selected.credentials, undefined); assert.deepEqual(selected.config, {});
  const vault = new MemoryVault();
  const auto = new AutoSync(environment, new MemoryKeys(), () => vault.asVault(), async () => "synthetic-github-token", async () => "synthetic-account");
  t.after(() => auto.dispose());
  await auto.enable({ login: "synthetic-account", password, vault: vault.asVault() }, preferencesOnly, targetOwner);
  await synchronize(auto, f.target.api, targetOwner);
  const saved = await decrypt(vault.raw!, password);
  assert.equal(saved.credentials, undefined);
  assert.equal(captures, 0); assert.equal(restores, 0);
  await environment.restore(f.target.api, selected, await environment.fingerprint(f.target.api, selected), { config: false, providers: false, plugins: false });
  assert.equal(captures, 0); assert.equal(restores, 0);
});
