import assert from "node:assert/strict";
import { watch, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { credentialFreshnessDigest, credentialIdentityDigest, mergeCredentialFreshness, providerCredentialsSchema } from "../shared/provider-credentials";
import { claudeCredentialService, ProviderCredentialSync, providerProfileDirectory, WindowsProviderSecureStore, type ProviderSecureStore, type SecureCredentialValue } from "../server/provider-credentials";
import { projectProviders } from "../shared/provider-paths";
import { Environment } from "../server/environment";
import { snapshotSchema } from "../shared/model";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

class MemoryStore implements ProviderSecureStore {
  values = new Map<string, SecureCredentialValue>();
  writes = 0;
  failWrite = false;
  beforeRead?: (service: string, name: string) => Promise<void>;
  async read(service: string, name: string) { await this.beforeRead?.(service, name); return this.values.get(`${service}/${name}`) ?? null; }
  async write(service: string, name: string, value: string) {
    if (this.failWrite) { this.failWrite = false; throw new Error("synthetic secure write failure"); }
    this.writes++;
    this.values.set(`${service}/${name}`, { value, updatedAt: 2_000_000_000_000 });
  }
  async remove(service: string, name: string) { this.values.delete(`${service}/${name}`); }
}

const oauth = (account: string, expiry = 2_000_000_000_000) => ({ claudeAiOauth: { accessToken: `synthetic-access-${account}-${expiry}`, refreshToken: `synthetic-refresh-${account}`, expiresAt: expiry, scopes: ["user:inference"] } });
const noClaudeToken = { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-provider-credentials-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "paseo");
  const userHome = path.join(root, "user");
  await mkdir(home, { recursive: true }); await mkdir(userHome, { recursive: true });
  const secure = new MemoryStore();
  const service = new ProviderCredentialSync({ home, userHome, platform: "win32", env: {}, secure });
  return { root, home, userHome, secure, service };
}
async function claude(directory: string, account: string, expiry = 2_000_000_000_000, extra = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth(account, expiry)));
  await writeFile(path.join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@synthetic.invalid` }, hasCompletedOnboarding: true, lastOnboardingVersion: "2.1.304", ...extra }));
}
const provider = (directory: string) => ({ env: { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory } });

test("Windows credential service follows the CLI's raw secure directory spelling", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "raw-service");
  await claude(directory, "same");
  await rm(path.join(directory, ".credentials.json"));
  const raw = directory + path.sep;
  const service = claudeCredentialService(raw, false);
  await f.secure.write(service, "claude-code-user", JSON.stringify(oauth("same")));
  const providers = { claude: { env: { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: raw, CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } } };
  const captured = await f.service.capture(providers);
  assert.equal(captured.credentials.records.length, 1);
  const incoming = structuredClone(captured.credentials);
  incoming.records[0].credential = oauth("same", 2_100_000_000_000);
  incoming.records[0].expiresAt = incoming.records[0].updatedAt = 2_100_000_000_000;
  const restored = await f.service.restore(providers, incoming, providers);
  await restored.commit();
  assert.equal((restored.providers.claude as typeof providers.claude).env.CLAUDE_SECURESTORAGE_CONFIG_DIR, raw);
  assert.equal(JSON.parse((await f.secure.read(service, "claude-code-user"))!.value).claudeAiOauth.expiresAt, 2_100_000_000_000);
  assert.equal(await f.secure.read(claudeCredentialService(directory, false), "claude-code-user"), null);
});

test("captures separate Claude accounts and only allowed profile metadata", async (t) => {
  const f = await fixture(t);
  const a = path.join(f.root, "account-a"); const b = path.join(f.root, "account-b");
  await claude(a, "a", undefined, { projects: { sensitiveProject: true }, telemetryId: "do-not-copy" }); await claude(b, "b");
  const { credentials } = await f.service.capture({ claude: provider(a), second: { extends: "claude", ...provider(b) } });
  assert.equal(credentials.records.length, 2);
  assert.notEqual(credentials.records[0].identity, credentials.records[1].identity);
  assert.deepEqual(Object.keys(credentials.records[0].metadata).sort(), ["hasCompletedOnboarding", "lastOnboardingVersion", "oauthAccount"]);
  assert.equal(JSON.stringify(credentials).includes("sensitiveProject"), false);
  assert.equal(JSON.stringify(credentials).includes(a.replaceAll("\\", "\\\\")), false);
});

test("restores two Claude accounts into separate managed profiles and recaptures without identity or freshness drift", async (t) => {
  const f = await fixture(t);
  const sourceA = path.join(f.root, "company-a"); const sourceB = path.join(f.root, "company-b");
  await claude(sourceA, "a"); await claude(sourceB, "b");
  const captured = await f.service.capture({ claude: provider(sourceA), second: { extends: "claude", ...provider(sourceB) } });
  const target = { claude: {}, second: { extends: "claude", label: "Second" } };
  const restored = await f.service.restore(target, captured.credentials);
  await restored.commit();
  const profiles = restored.providers as Record<string, { env: Record<string, string> }>;
  assert.notEqual(profiles.claude.env.CLAUDE_CONFIG_DIR, profiles.second.env.CLAUDE_CONFIG_DIR);
  for (const record of captured.credentials.records) {
    const directory = providerProfileDirectory(f.home, record.id);
    assert.equal(profiles[record.providerIds[0]].env.CLAUDE_CONFIG_DIR, directory);
    assert.equal(JSON.parse(await readFile(path.join(directory, ".credentials.json"), "utf8")).claudeAiOauth.accessToken, record.credential.claudeAiOauth && (record.credential.claudeAiOauth as Record<string, unknown>).accessToken);
    assert.ok(await f.secure.read(claudeCredentialService(directory, false), "claude-code-user"));
  }
  const recaptured = await f.service.capture(restored.providers);
  assert.equal(credentialIdentityDigest(recaptured.credentials), credentialIdentityDigest(captured.credentials));
  assert.equal(credentialFreshnessDigest(recaptured.credentials), credentialFreshnessDigest(captured.credentials));
});

test("same-account existing profile stays in place and newer local tokens are preserved", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "old"); const local = path.join(f.root, "local");
  await claude(source, "same", 1_900_000_000_000); await claude(local, "same", 2_100_000_000_000);
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: {} }, incoming, { claude: provider(local) });
  assert.equal((restored.providers.claude as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR, local);
  assert.equal(JSON.parse(await readFile(path.join(local, ".credentials.json"), "utf8")).claudeAiOauth.expiresAt, 2_100_000_000_000);
  assert.equal(f.secure.writes, 0);
  await restored.commit();
});

test("automatic restore preserves this device's Claude login even when cloud tokens look newer", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "cloud"); const local = path.join(f.root, "active");
  await claude(source, "same", 2_300_000_000_000);
  await claude(local, "same", 2_100_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const service = claudeCredentialService(local, false);
  const token = JSON.stringify(oauth("same", 2_100_000_000_000));
  await f.secure.write(service, "claude-code-user", token);
  const writes = f.secure.writes;
  const before = await readFile(path.join(local, ".credentials.json"), "utf8");
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: { ...provider(source), label: "Updated label" } }, incoming, { claude: provider(local) }, { preserveLocalClaude: true });
  await restored.commit();
  assert.equal((restored.providers.claude as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR, local);
  assert.equal((restored.providers.claude as { label: string }).label, "Updated label");
  assert.equal((await f.secure.read(service, "claude-code-user"))?.value, token);
  assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), before);
  assert.equal(f.secure.writes, writes);
});

test("automatic restore renews an expired same-account Claude login from valid cloud credentials", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "fresh-cloud"), local = path.join(f.root, "expired-local");
  await claude(source, "same", Date.now() + 3_600_000);
  await claude(local, "same", Date.now() - 3_600_000);
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: provider(source) }, incoming, { claude: provider(local) }, { preserveLocalClaude: true });
  await restored.commit();
  assert.equal((restored.providers.claude as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR, local);
  assert.equal(JSON.parse(await readFile(path.join(local, ".credentials.json"), "utf8")).claudeAiOauth.accessToken, (incoming.records[0].credential.claudeAiOauth as Record<string, unknown>).accessToken);
});

test("automatic restore cannot replace an expired local Claude account with another account's valid token", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "other-cloud"), local = path.join(f.root, "my-expired-local");
  await claude(source, "other", Date.now() + 3_600_000);
  await claude(local, "mine", Date.now() - 3_600_000);
  const before = await readFile(path.join(local, ".credentials.json"), "utf8");
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: provider(source) }, incoming, { claude: provider(local) }, { preserveLocalClaude: true });
  await restored.commit();
  assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), before);
});

test("automatic restore finds a live Windows login despite an empty file and disabled migration flag", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "cloud-old"); const local = path.join(f.root, "live-windows");
  await claude(source, "other", 1_900_000_000_000);
  await claude(local, "same", 2_100_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: false } });
  await writeFile(path.join(local, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 0 } }));
  const service = claudeCredentialService(local, false);
  const token = JSON.stringify(oauth("same", 2_100_000_000_000));
  await f.secure.write(service, "claude-code-user", token);
  const writes = f.secure.writes;
  const detected = await f.service.capture({ claude: provider(local) });
  assert.equal(detected.status[0].store, "windows-credman");
  assert.equal(detected.credentials.records.length, 1);
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: provider(source) }, incoming, { claude: provider(local) }, { preserveLocalClaude: true });
  await restored.commit();
  const env = (restored.providers.claude as { env: Record<string, string> }).env;
  assert.equal(env.CLAUDE_CONFIG_DIR, local);
  assert.equal(env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN, "1");
  assert.equal((await f.secure.read(service, "claude-code-user"))?.value, token);
  assert.equal(f.secure.writes, writes);
  const captured = await f.service.capture(restored.providers);
  assert.equal(captured.credentials.records[0].metadata.oauthAccount?.accountUuid, "same");
});

test("automatic restore keeps an existing Claude environment login and still bootstraps an unsigned device", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "cloud"); await claude(source, "same");
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const current = { claude: { env: { ANTHROPIC_API_KEY: "synthetic-current-key" } } };
  const kept = await f.service.restore({ claude: provider(source) }, incoming, current, { preserveLocalClaude: true });
  await kept.commit();
  assert.equal((kept.providers.claude as { env: Record<string, string> }).env.ANTHROPIC_API_KEY, "synthetic-current-key");
  const restored = await f.service.restore({ claude: {} }, incoming, { claude: {} }, { preserveLocalClaude: true });
  await restored.commit();
  assert.equal((await f.service.capture(restored.providers)).credentials.records.length, 1);
});

for (const missing of [false, true]) test(`automatic restore preserves an initialized Claude profile while credentials are ${missing ? "missing" : "empty"}`, async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "expired-cloud"); const local = path.join(f.root, "refreshing-local");
  await claude(source, "same", 1_900_000_000_000);
  await claude(local, "same");
  const file = path.join(local, ".credentials.json");
  if (missing) await rm(file);
  else await writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: "", expiresAt: 0 } }));
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const writes = f.secure.writes;
  const restored = await f.service.restore({ claude: provider(source) }, incoming, { claude: provider(local) }, { preserveLocalClaude: true });
  await restored.commit();
  assert.equal((restored.providers.claude as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR, local);
  assert.equal(f.secure.writes, writes);
  if (missing) await assert.rejects(readFile(file), { code: "ENOENT" });
  else assert.equal(JSON.parse(await readFile(file, "utf8")).claudeAiOauth.accessToken, "");
  const refreshed = JSON.stringify(oauth("same", 2_300_000_000_000));
  await writeFile(file, refreshed);
  const next = await f.service.restore({ claude: provider(source) }, incoming, restored.providers, { preserveLocalClaude: true });
  await next.commit();
  assert.equal(await readFile(file, "utf8"), refreshed);
});

test("fresher incoming tokens update existing profile and rollback restores metadata and authentication", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000); await claude(local, "same", 1_900_000_000_000, { projects: { local: true } });
  const beforeAuth = await readFile(path.join(local, ".credentials.json"), "utf8");
  const beforeConfig = await readFile(path.join(local, ".claude.json"), "utf8");
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: {} }, incoming, { claude: provider(local) });
  assert.equal(JSON.parse(await readFile(path.join(local, ".credentials.json"), "utf8")).claudeAiOauth.expiresAt, 2_100_000_000_000);
  assert.deepEqual(JSON.parse(await readFile(path.join(local, ".claude.json"), "utf8")).projects, { local: true });
  await restored.rollback();
  assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), beforeAuth);
  assert.equal(await readFile(path.join(local, ".claude.json"), "utf8"), beforeConfig);
});

test("missing credentials are normal on an uninitialized target and report availability", async (t) => {
  const f = await fixture(t);
  const captured = await f.service.capture({ claude: {}, second: { extends: "claude" }, codex: {} });
  assert.deepEqual(captured.credentials.records, []);
  assert.ok(captured.status.every((status) => status.status === "missing"));
  assert.equal(f.secure.writes, 0);
});

test("known auth environment values stay in the encrypted provider configuration", async (t) => {
  const f = await fixture(t);
  const providers = { claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-long-lived-token" } } };
  const captured = await f.service.capture(providers);
  assert.deepEqual(captured.providers, providers);
  assert.equal(captured.credentials.records.length, 0);
  assert.equal(captured.status.find((status) => status.vendor === "claude")?.status, "environment");
});

test("captures and restores Codex auth without copying unrelated configuration", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "codex-source"); await mkdir(source);
  const auth = { auth_mode: "chatgpt", tokens: { account_id: "synthetic-codex-user", access_token: "synthetic-codex-access", refresh_token: "synthetic-codex-refresh" }, last_refresh: "2026-10-25T00:00:00Z", OPENAI_API_KEY: null };
  await writeFile(path.join(source, "auth.json"), JSON.stringify(auth));
  await writeFile(path.join(source, "config.toml"), "unrelated_source_project = true");
  const captured = await f.service.capture({ codex: { env: { CODEX_HOME: source } } });
  const restored = await f.service.restore({ codex: {} }, captured.credentials);
  const directory = (restored.providers.codex as { env: Record<string, string> }).env.CODEX_HOME;
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, "auth.json"), "utf8")), auth);
  assert.deepEqual(await readdir(directory), ["auth.json"]);
  await restored.rollback();
  assert.deepEqual(await readdir(directory), []);
});

test("reads native Claude Credential Manager chunks and rejects missing chunks without including secret values", async (t) => {
  const f = await fixture(t);
  const profile = path.join(f.root, "secured"); await claude(profile, "secure", undefined, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  await rm(path.join(profile, ".credentials.json"));
  const service = claudeCredentialService(profile, false);
  const raw = JSON.stringify(oauth("secure")); const encoded = Buffer.from(raw).toString("base64");
  await f.secure.write(service, "claude-code-user#m", JSON.stringify({ n: 2, l: encoded.length }));
  await f.secure.write(service, "claude-code-user#0", encoded.slice(0, 120));
  await f.secure.write(service, "claude-code-user#1", encoded.slice(120));
  const captured = await f.service.capture({ claude: provider(profile) });
  assert.equal(captured.status[0].store, "windows-credman");
  assert.deepEqual(captured.credentials.records[0].credential, oauth("secure"));
  await f.secure.remove(service, "claude-code-user#1");
  await assert.rejects(() => f.service.capture({ claude: provider(profile) }), (error: Error) => !error.message.includes("synthetic-") && error.message.includes("일부 데이터"));
});

test("writes large secure credentials in Claude-compatible chunks", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "large"); await claude(source, "large");
  const payload = oauth("large"); payload.claudeAiOauth.accessToken = "synthetic-" + "a".repeat(6000);
  await writeFile(path.join(source, ".credentials.json"), JSON.stringify(payload));
  const captured = await f.service.capture({ claude: provider(source) });
  const restored = await f.service.restore({ claude: {} }, captured.credentials);
  const directory = providerProfileDirectory(f.home, captured.credentials.records[0].id);
  const meta = await f.secure.read(claudeCredentialService(directory, false), "claude-code-user#m");
  assert.ok(meta && JSON.parse(meta.value).n > 1);
  const recaptured = await f.service.capture(restored.providers);
  assert.deepEqual(recaptured.credentials.records[0].credential, payload);
  await restored.rollback();
  assert.equal(f.secure.values.size, 0);
});

test("failed secure-store writes rollback prepared files and never silently omit authentication", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const captured = await f.service.capture({ claude: provider(source) });
  f.secure.failWrite = true;
  await assert.rejects(() => f.service.restore({ claude: {} }, captured.credentials));
  const directory = providerProfileDirectory(f.home, captured.credentials.records[0].id);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(f.secure.values.size, 0);
});

test("alias additions keep the primary account record stable", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const first = await f.service.capture({ claude: provider(source) });
  const second = await f.service.capture({ claude: provider(source), another: { extends: "claude" } });
  assert.equal(first.credentials.records[0].id, second.credentials.records[0].id);
  assert.equal(first.credentials.records[0].identity, second.credentials.records[0].identity);
});

test("identity and raw freshness are independent and equal-freshness merges are deterministic", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const first = (await f.service.capture({ claude: provider(source) })).credentials;
  const second = structuredClone(first);
  (second.records[0].credential.claudeAiOauth as Record<string, unknown>).accessToken = "synthetic-refreshed";
  assert.equal(credentialIdentityDigest(first), credentialIdentityDigest(second));
  assert.notEqual(credentialFreshnessDigest(first), credentialFreshnessDigest(second));
  assert.deepEqual(mergeCredentialFreshness(first, second), mergeCredentialFreshness(second, first));
  assert.equal(providerCredentialsSchema.safeParse({ ...first, records: [...first.records, ...first.records] }).success, false);
});

test("Windows bridge sends credentials through stdin and uses UTF-8 blobs and exact Bun target names", async () => {
  const calls: { args: string[]; input: Record<string, unknown> }[] = [];
  const store = new WindowsProviderSecureStore(async (_executable, args, input) => {
    const request = JSON.parse(input); calls.push({ args, input: request });
    return request.operation === "read" ? JSON.stringify({ value: Buffer.from("synthetic-secret").toString("base64"), updatedAt: 123 }) : "";
  }, "C:\\Windows");
  await store.write("Claude Code-credentials", "claude-code-user", "synthetic-secret");
  assert.equal(calls[0].args.join(" ").includes("synthetic-secret"), false);
  assert.equal(calls[0].input.target, "Claude Code-credentials/claude-code-user");
  assert.equal(Buffer.from(calls[0].input.value as string, "base64").toString(), "synthetic-secret");
  assert.equal((await store.read("Claude Code-credentials", "claude-code-user"))?.value, "synthetic-secret");
});

test("rejects malformed IDs before creating profiles and rejects linked authentication files", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const captured = await f.service.capture({ claude: provider(source) });
  const invalid = structuredClone(captured.credentials); invalid.records[0].id = "claude-../../outside";
  await assert.rejects(() => f.service.restore({}, invalid), /형식/);
  assert.throws(() => providerProfileDirectory(f.home, "../outside"));
  const file = path.join(source, ".credentials.json"); const replacement = path.join(f.root, "linked.json");
  await writeFile(replacement, JSON.stringify(oauth("a"))); await rm(file);
  try { await symlink(replacement, file); } catch { return; }
  await assert.rejects(() => f.service.capture({ claude: provider(source) }), /심볼릭 링크/);
});

test("active Credential Manager data takes precedence over a newer stale plaintext account", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "active"); await claude(directory, "active", 2_200_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth("stale-file-account", 2_900_000_000_000)));
  await f.secure.write(claudeCredentialService(directory, false), "claude-code-user", JSON.stringify(oauth("actual-active-account", 2_100_000_000_000)));
  const captured = await f.service.capture({ claude: provider(directory) });
  assert.deepEqual(captured.credentials.records[0].credential, oauth("actual-active-account", 2_100_000_000_000));
  assert.equal(captured.status[0].store, "windows-credman");
});

test("default Claude account metadata comes from userHome while credentials come from userHome/.claude", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.userHome, ".claude"); await mkdir(directory);
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth("default")));
  await writeFile(path.join(f.userHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default" }, hasCompletedOnboarding: true }));
  const captured = await f.service.capture({});
  assert.equal(captured.credentials.records[0].metadata.oauthAccount?.accountUuid, "default");
  assert.equal(captured.credentials.records[0].metadata.hasCompletedOnboarding, true);
  const restored = await f.service.restore({}, captured.credentials);
  assert.deepEqual(restored.providers, { claude: { env: noClaudeToken } });
  await restored.commit();
});

test("default source and managed target capture the same canonical profile bindings", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.userHome, ".claude"));
  await writeFile(path.join(f.userHome, ".claude", ".credentials.json"), JSON.stringify(oauth("default")));
  await writeFile(path.join(f.userHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default" }, hasCompletedOnboarding: true }));
  const original = {};
  const captured = await f.service.capture(original);
  const otherUser = path.join(f.root, "other-user"); await mkdir(otherUser);
  const target = new ProviderCredentialSync({ home: f.home, userHome: otherUser, platform: "win32", env: {}, secure: f.secure });
  const restored = await target.restore({ claude: {} }, captured.credentials);
  const recaptured = await target.capture(restored.providers);
  assert.deepEqual(projectProviders(captured.providers), projectProviders(recaptured.providers));
  assert.deepEqual(original, {});
  const retained = await f.service.restore(restored.providers, captured.credentials, original);
  assert.deepEqual(retained.providers, { claude: { env: noClaudeToken } });
  await retained.commit(); await restored.commit();
});

test("explicit empty secure-store binding remains empty when preserving the original account", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.userHome, ".claude"); await mkdir(directory);
  await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(oauth("default")));
  await writeFile(path.join(f.userHome, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "default" } }));
  const current = { claude: { env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } } };
  const captured = await f.service.capture(current);
  const restored = await f.service.restore({ claude: provider(path.join(f.root, "incoming-path")) }, captured.credentials, current);
  assert.deepEqual(restored.providers, { claude: { env: { ...current.claude.env, ...noClaudeToken } } });
  await restored.commit();
});

test("explicit unsupported Codex keyring backend reports an actionable error instead of missing authentication", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.userHome, ".codex"); await mkdir(directory);
  await writeFile(path.join(directory, "config.toml"), 'cli_auth_credentials_store = "keyring"\n');
  await assert.rejects(() => f.service.capture({ codex: {} }), /OS 키링.*file/s);
});

test("restored Claude OAuth explicitly clears inherited environment tokens and Codex refuses ambiguous ambient keys", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const captured = await f.service.capture({ claude: provider(source) });
  const target = new ProviderCredentialSync({ home: f.home, userHome: f.userHome, platform: "win32", env: { ANTHROPIC_API_KEY: "synthetic-wrong-account" }, secure: f.secure });
  const restored = await target.restore({ claude: {} }, captured.credentials);
  const env = (restored.providers.claude as { env: Record<string, string> }).env;
  assert.equal(env.ANTHROPIC_API_KEY, ""); assert.equal(env.ANTHROPIC_AUTH_TOKEN, ""); assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");
  assert.equal((await target.capture(restored.providers)).credentials.records.length, 1);
  await restored.rollback();
  const codexDir = path.join(f.root, "codex"); await mkdir(codexDir);
  await writeFile(path.join(codexDir, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-access", account_id: "a" } }));
  const codex = await f.service.capture({ codex: { env: { CODEX_HOME: codexDir } } });
  const ambiguous = new ProviderCredentialSync({ home: f.home, userHome: f.userHome, platform: "win32", env: { OPENAI_API_KEY: "synthetic-wrong-account" }, secure: f.secure });
  await assert.rejects(() => ambiguous.restore({ codex: {} }, codex.credentials), (error: Error) => error.message.includes("API 키") && !error.message.includes("synthetic-"));
});

test("known account registry exports only matching whitelist entries with portable homes", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const registry = path.join(f.home, "paseo-accounts"); await mkdir(registry);
  await writeFile(path.join(registry, "accounts.json"), JSON.stringify({ version: 7, accounts: [
    { id: "claude-main", base: "claude", home: source, email: "synthetic@invalid", identity: "synthetic-identity", signedIn: true, name: "Main", secret: "must-not-copy" },
    { id: "other", base: "claude", home: path.join(f.root, "unrelated"), email: null, identity: null, signedIn: false },
  ] }));
  const captured = await f.service.capture({ claude: provider(source) });
  assert.deepEqual(captured.credentials.records[0].metadata.accounts, [{ id: "claude-main", base: "claude", home: null, email: "synthetic@invalid", identity: "synthetic-identity", signedIn: true, name: "Main" }]);
  assert.equal(JSON.stringify(captured.credentials).includes("must-not-copy"), false);
  const changed = structuredClone(captured.credentials); changed.records[0].metadata.accounts![0].name = "Renamed";
  assert.notEqual(credentialIdentityDigest(captured.credentials), credentialIdentityDigest(changed));
});

test("account registry restoration preserves unrelated entries, links managed Claude projects and rolls back", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const captured = await f.service.capture({ claude: provider(source) });
  captured.credentials.records[0].metadata.accounts = [{ id: "restored", base: "claude", home: null, email: null, identity: null, signedIn: true }];
  const registryDirectory = path.join(f.home, "paseo-accounts"); await mkdir(registryDirectory);
  const file = path.join(registryDirectory, "accounts.json");
  const previous = JSON.stringify({ version: 2, accounts: [{ id: "keep", base: "codex", home: null, email: null, identity: null, signedIn: false, preserve: true }] });
  await writeFile(file, previous);
  const restored = await f.service.restore({ claude: {} }, captured.credentials);
  const registry = JSON.parse(await readFile(file, "utf8"));
  assert.equal(registry.version, 2); assert.equal(registry.accounts[0].preserve, true);
  const directory = providerProfileDirectory(f.home, captured.credentials.records[0].id);
  assert.equal(registry.accounts[1].home, directory);
  assert.equal(JSON.parse(await readFile(path.join(directory, ".claude.json"), "utf8")).accounts, undefined);
  const { realpath } = await import("node:fs/promises");
  assert.equal(await realpath(path.join(directory, "projects")), await realpath(path.join(f.userHome, ".claude", "projects")));
  const recaptured = await f.service.capture(restored.providers);
  assert.equal(credentialFreshnessDigest(recaptured.credentials), credentialFreshnessDigest(captured.credentials));
  await restored.rollback();
  assert.equal(await readFile(file, "utf8"), previous);
  assert.deepEqual(await readdir(directory), []);
});

test("class composes Cursor authentication with Claude and one rollback covers both adapters", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const appdata = path.join(f.root, "roaming"); await mkdir(path.join(appdata, "Cursor"), { recursive: true });
  await writeFile(path.join(appdata, "Cursor", "auth.json"), JSON.stringify({ apiKey: "synthetic-cursor-key" }));
  const captured = await f.service.capture({ claude: provider(source), cursor: { extends: "acp", command: ["cursor-agent", "acp"], env: { APPDATA: appdata } } });
  assert.deepEqual(captured.credentials.records.map((record) => record.vendor).sort(), ["claude", "cursor"]);
  const restored = await f.service.restore({ claude: {}, cursor: { extends: "acp", command: ["cursor-agent", "acp"] } }, captured.credentials);
  assert.deepEqual((await f.service.capture(restored.providers)).credentials.records.map((record) => record.vendor).sort(), ["claude", "cursor"]);
  await restored.rollback();
  for (const record of captured.credentials.records) {
    const directory = providerProfileDirectory(f.home, record.id);
    const files = await readdir(directory, { recursive: true });
    assert.equal(files.some((file) => file.endsWith("auth.json") || file.endsWith(".credentials.json")), false);
  }
});

test("only vendor authentication fields cross the snapshot boundary while unrelated local credentials remain intact", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000); await claude(local, "same", 1_900_000_000_000);
  await writeFile(path.join(source, ".credentials.json"), JSON.stringify({ ...oauth("same", 2_100_000_000_000), mcpOAuth: { sourcePrivate: "must-not-upload" } }));
  await writeFile(path.join(local, ".credentials.json"), JSON.stringify({ ...oauth("same", 1_900_000_000_000), mcpOAuth: { targetPrivate: "must-preserve" } }));
  const captured = await f.service.capture({ claude: provider(source) });
  assert.equal(captured.credentials.records[0].credential.mcpOAuth, undefined);
  const incoming = structuredClone(captured.credentials); incoming.records[0].credential.unrelatedToken = "must-not-import";
  const restored = await f.service.restore({ claude: {} }, incoming, { claude: provider(local) });
  const file = JSON.parse(await readFile(path.join(local, ".credentials.json"), "utf8"));
  assert.deepEqual(file.mcpOAuth, { targetPrivate: "must-preserve" });
  assert.equal(file.unrelatedToken, undefined);
  assert.equal(file.claudeAiOauth.expiresAt, 2_100_000_000_000);
  await restored.rollback();
  const codexDirectory = path.join(f.root, "codex-whitelist"); await mkdir(codexDirectory);
  await writeFile(path.join(codexDirectory, "auth.json"), JSON.stringify({ tokens: { access_token: "synthetic-codex", refresh_token: "synthetic-refresh", account_id: "a", privateToken: "must-not-upload" }, unrelated: "must-not-upload", last_refresh: "2026-10-25T00:00:00Z" }));
  const codex = await f.service.capture({ codex: { env: { CODEX_HOME: codexDirectory } } });
  assert.equal(JSON.stringify(codex.credentials).includes("must-not-upload"), false);
});

test("replaced registry bindings are archived locally and newer authentication does not discard incoming registry choices", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); await claude(source, "a");
  const captured = await f.service.capture({ claude: provider(source) });
  captured.credentials.records[0].metadata.accounts = [{ id: "same-id", base: "claude", home: null, email: "new@synthetic.invalid", identity: "new", signedIn: true }];
  const newer = structuredClone(captured.credentials); newer.records[0].expiresAt! += 1000; newer.records[0].metadata.accounts![0].name = "Outdated registry name";
  assert.deepEqual(mergeCredentialFreshness(newer, captured.credentials).records[0].metadata, captured.credentials.records[0].metadata);
  const registry = path.join(f.home, "paseo-accounts"); await mkdir(registry);
  const previous = { id: "same-id", base: "claude", home: "old-path", email: "old@synthetic.invalid", identity: "old", signedIn: true };
  await writeFile(path.join(registry, "accounts.json"), JSON.stringify({ accounts: [previous] }));
  const restored = await f.service.restore({ claude: {} }, captured.credentials);
  const result = JSON.parse(await readFile(path.join(registry, "accounts.json"), "utf8"));
  assert.equal(result.accounts[0].email, "new@synthetic.invalid");
  assert.deepEqual(result.settingsSyncPreviousAccounts[0].account, previous);
  await restored.rollback();
});

test("rollback preserves credentials refreshed by an external CLI after preparation", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000); await claude(local, "same", 1_900_000_000_000);
  const captured = await f.service.capture({ claude: provider(source) });
  const restored = await f.service.restore({ claude: {} }, captured.credentials, { claude: provider(local) });
  const refreshed = JSON.stringify(oauth("same", 2_300_000_000_000));
  await writeFile(path.join(local, ".credentials.json"), refreshed);
  await f.secure.write(claudeCredentialService(local, false), "claude-code-user", refreshed);
  await assert.rejects(() => restored.rollback(), /복구에 실패/);
  assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), refreshed);
  assert.equal((await f.secure.read(claudeCredentialService(local, false), "claude-code-user"))?.value, refreshed);
});

test("linked profile directories are rejected before reading credential files", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const linked = path.join(f.root, "linked"); await claude(source, "a");
  try { await symlink(source, linked, process.platform === "win32" ? "junction" : "dir"); } catch { return; }
  await assert.rejects(() => f.service.capture({ claude: provider(linked) }), /심볼릭 링크/);
});

test("initial provider merge refuses target API keys that would hide incoming Codex OAuth", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "codex-source"); await mkdir(source);
  await writeFile(path.join(source, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "synthetic-source-account-a", account_id: "account-a" } }));
  const captured = await f.service.capture({ codex: { env: { CODEX_HOME: source } } });
  const incoming = snapshotSchema.parse({ version: 2, createdAt: new Date().toISOString(), device: "synthetic-source", client: { hosts: [], preferences: {} }, config: { providers: captured.providers }, credentials: captured.credentials, plugins: [] });
  const original = { providers: { codex: { env: { OPENAI_API_KEY: "synthetic-target-account-b" } } }, plugins: {} };
  let config: any = structuredClone(original);
  const api = { config: { get: async () => ({ config: structuredClone(config) }), patch: async (patch: any) => {
    for (const id of patch.removeProviders ?? []) delete config.providers[id];
    if (patch.providers) config.providers = { ...config.providers, ...patch.providers };
    return { config: structuredClone(config) };
  } } } as unknown as PluginHandlerContext["paseo"];
  const environment = new Environment(f.home, async () => {}, f.service, { home: f.userHome, env: {}, platform: "win32", resolveExecutable: async () => "C:\\synthetic\\codex.exe", exists: async () => true });
  const fingerprint = await environment.fingerprint(api, incoming);
  await assert.rejects(() => environment.restore(api, incoming, fingerprint, { providers: true, config: false, plugins: false, merge: true }), /Codex API 키/);
  assert.deepEqual(config, original);
  assert.equal(f.secure.writes, 0);
});

test("nested Claude and Codex aliases inherit profile directories and auth overrides recursively", async (t) => {
  const f = await fixture(t);
  const a = path.join(f.root, "a"); const b = path.join(f.root, "b"); await claude(a, "a"); await claude(b, "b");
  const captured = await f.service.capture({ claude: provider(a), parent: { extends: "claude", ...provider(b) }, child: { extends: "parent", env: { OTHER: "kept" } } });
  assert.deepEqual(captured.credentials.records.map((record) => record.providerIds), [["claude"], ["child", "parent"]]);
  assert.equal((captured.providers.child as { env: Record<string, string> }).env.CLAUDE_CONFIG_DIR, b);
  const codexDirectory = path.join(f.root, "codex-inherit"); await mkdir(codexDirectory);
  await writeFile(path.join(codexDirectory, "auth.json"), JSON.stringify({ tokens: { account_id: "a", access_token: "synthetic-codex" } }));
  const codex = await f.service.capture({ codex: { env: { CODEX_HOME: codexDirectory } }, parent: { extends: "codex" }, child: { extends: "parent" } });
  assert.deepEqual(codex.credentials.records[0].providerIds, ["child", "codex", "parent"]);
  await assert.rejects(() => f.service.restore({ codex: { env: { OPENAI_API_KEY: "synthetic-target-key" } }, parent: { extends: "codex" }, child: { extends: "parent" } }, codex.credentials), /Codex API 키/);
});

test("Codex preserves official OAuth authority and login owner and separates renewed login grants", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "codex-authority"); await mkdir(directory);
  const token = { access_token: "synthetic-codex", refresh_token: "synthetic-refresh", account_id: "a", oauth_provenance: { issuer: "https://auth.openai.com", client_id: "synthetic-client", unrelated: "omit" }, login_owner_id: "synthetic-login-one" };
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: token }));
  const first = await f.service.capture({ codex: { env: { CODEX_HOME: directory } } });
  assert.deepEqual((first.credentials.records[0].credential.tokens as Record<string, unknown>).oauth_provenance, { issuer: "https://auth.openai.com", client_id: "synthetic-client" });
  assert.equal((first.credentials.records[0].credential.tokens as Record<string, unknown>).login_owner_id, token.login_owner_id);
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { ...token, login_owner_id: "synthetic-login-two" } }));
  const second = await f.service.capture({ codex: { env: { CODEX_HOME: directory } } });
  assert.notEqual(first.credentials.records[0].identity, second.credentials.records[0].identity);
  await writeFile(path.join(directory, "auth.json"), JSON.stringify({ auth_mode: "agentIdentity", agent_identity: { token: "synthetic-unsupported" }, tokens: token }));
  await assert.rejects(() => f.service.capture({ codex: { env: { CODEX_HOME: directory } } }), /인증 형식/);
});

test("logged-out Claude files and other auth-only stores do not block the first cloud restore", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "logged-out"); await mkdir(directory);
  for (const credential of [{}, { mcpOAuth: { server: "synthetic-other-auth" } }, { claudeAiOauth: null }, { claudeAiOauth: {} }, { claudeAiOauth: { accessToken: "" } }, { claudeAiOauth: { accessToken: null } }, { claudeAiOauth: { accessToken: "   " } }]) {
    await writeFile(path.join(directory, ".credentials.json"), JSON.stringify(credential));
    const captured = await f.service.capture({ claude: provider(directory) });
    assert.equal(captured.credentials.records.length, 0);
    assert.equal(captured.status.find((status) => status.vendor === "claude")?.status, "missing");
  }
  const source = path.join(f.root, "signed-in"); await claude(source, "a");
  const incoming = await f.service.capture({ claude: provider(source) });
  const restored = await f.service.restore({ claude: {} }, incoming.credentials, { claude: provider(directory) });
  assert.equal((await f.service.capture(restored.providers)).credentials.records.length, 1);
  await restored.rollback();
});

test("Claude secure-store entries with only other credentials are missing while invalid OAuth types remain errors", async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.root, "secure-logged-out"); await claude(directory, "unused", undefined, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const service = claudeCredentialService(directory, false);
  for (const credential of [{ mcpOAuth: { server: "synthetic-other-auth" } }, { claudeAiOauth: { accessToken: "" } }]) {
    await f.secure.write(service, "claude-code-user", JSON.stringify(credential));
    assert.equal((await f.service.capture({ claude: provider(directory) })).credentials.records.length, 0);
  }
  for (const credential of [{ claudeAiOauth: [] }, { claudeAiOauth: "invalid" }, { claudeAiOauth: { accessToken: 123 } }]) {
    await f.secure.write(service, "claude-code-user", JSON.stringify(credential));
    await assert.rejects(() => f.service.capture({ claude: provider(directory) }), /형식/);
  }
});

test("Windows auth refreshed after selection or during the final store check survives abort and retry", async (t) => {
  for (const refreshRead of [4, 5]) {
    const f = await fixture(t);
    const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
    await claude(source, "same", 2_100_000_000_000);
    await claude(local, "same", 1_900_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
    const service = claudeCredentialService(local, false);
    await f.secure.write(service, "claude-code-user", JSON.stringify(oauth("same", 1_900_000_000_000)));
    const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
    const refreshed = JSON.stringify({ ...oauth("same", 2_300_000_000_000), mcpOAuth: { localOnly: "synthetic-preserved" } });
    let reads = 0;
    f.secure.beforeRead = async (current, name) => {
      if (current === service && name === "claude-code-user" && ++reads === refreshRead) {
        await f.secure.write(service, name, refreshed);
        await writeFile(path.join(local, ".credentials.json"), refreshed);
      }
    };
    await assert.rejects(() => f.service.restore({ claude: {} }, incoming, { claude: provider(local) }), /계정 또는 인증.*바뀌었습니다/);
    f.secure.beforeRead = undefined;
    assert.equal((await f.secure.read(service, "claude-code-user"))?.value, refreshed);
    assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), refreshed);
    const retried = await f.service.restore({ claude: {} }, incoming, { claude: provider(local) });
    await retried.commit();
    assert.equal((await f.secure.read(service, "claude-code-user"))?.value, refreshed);
  }
});

for (const vendor of ["claude", "codex"] as const) test(`${vendor} file refresh or account change before rename is preserved and retried safely`, async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
  const service = new ProviderCredentialSync({ home: f.home, userHome: f.userHome, platform: "linux", env: {} });
  const token = (expiry: number, account = "same") => vendor === "claude" ? oauth(account, expiry) : { auth_mode: "chatgpt", tokens: { account_id: account, access_token: `header.${Buffer.from(JSON.stringify({ sub: account, exp: expiry / 1000 })).toString("base64url")}.signature`, refresh_token: "synthetic-refresh" } };
  const file = path.join(local, vendor === "claude" ? ".credentials.json" : "auth.json");
  const providers = (directory: string) => ({ [vendor]: vendor === "claude" ? provider(directory) : { env: { CODEX_HOME: directory } } });
  await mkdir(source); await mkdir(local);
  await writeFile(path.join(source, path.basename(file)), JSON.stringify(token(2_100_000_000_000)));
  await writeFile(file, JSON.stringify(token(1_900_000_000_000)));
  const incoming = (await service.capture(providers(source))).credentials;
  const refreshed = JSON.stringify({ ...token(2_300_000_000_000), unrelatedLocalData: "synthetic-preserved" });
  let rotated = false;
  const watcher = watch(local, (_event, filename) => {
    const name = filename?.toString() ?? "";
    if (!rotated && name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp")) { rotated = true; writeFileSync(file, refreshed); }
  });
  t.after(() => watcher.close());
  await assert.rejects(() => service.restore({ [vendor]: {} }, incoming, providers(local)), /계정 또는 인증.*바뀌었습니다/);
  watcher.close();
  assert.equal(rotated, true);
  assert.equal(await readFile(file, "utf8"), refreshed);
  const retried = await service.restore({ [vendor]: {} }, incoming, providers(local)); await retried.commit();
  assert.equal(await readFile(file, "utf8"), refreshed);
});

test("an account changed by another process before credential replacement is rejected without overwriting the new login", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"); const local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000);
  await claude(local, "same", 1_900_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const service = claudeCredentialService(local, false);
  await f.secure.write(service, "claude-code-user", JSON.stringify(oauth("same", 1_900_000_000_000)));
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  let reads = 0;
  f.secure.beforeRead = async (current, name) => {
    if (current === service && name === "claude-code-user" && ++reads === 3) {
      await claude(local, "another-account", 2_300_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
      await f.secure.write(service, name, JSON.stringify(oauth("another-account", 2_300_000_000_000)));
    }
  };
  await assert.rejects(() => f.service.restore({ claude: {} }, incoming, { claude: provider(local) }), /계정 또는 인증.*바뀌었습니다/);
  f.secure.beforeRead = undefined;
  assert.equal(JSON.parse(await readFile(path.join(local, ".claude.json"), "utf8")).oauthAccount.accountUuid, "another-account");
  assert.deepEqual(JSON.parse((await f.secure.read(service, "claude-code-user"))!.value), oauth("another-account", 2_300_000_000_000));
});

for (const lock of [".oauth_refresh.lock", ".storage-write.lock", "legacy"]) test(`Claude automatic restore does not write while the CLI holds ${lock}`, async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "fresh-source"), local = path.join(f.root, "local");
  await claude(source, "same", Date.now() + 3_600_000);
  await claude(local, "same", Date.now() - 3_600_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const before = await readFile(path.join(local, ".credentials.json"), "utf8");
  const service = claudeCredentialService(local, false);
  await f.secure.write(service, "claude-code-user", before);
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const lockPath = lock === "legacy" ? `${local}.lock` : path.join(local, lock);
  await mkdir(lockPath);
  const writes = f.secure.writes;
  await assert.rejects(() => f.service.restore({ claude: provider(source) }, incoming, { claude: provider(local) }, { preserveLocalClaude: true }), /잠금/);
  assert.equal(f.secure.writes, writes);
  assert.equal((await f.secure.read(service, "claude-code-user"))?.value, before);
  assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), before);
});

test("Claude stops a split restore immediately when another writer replaces its lock", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"), local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000);
  const large = oauth("same", 2_100_000_000_000);
  large.claudeAiOauth.accessToken = "synthetic-" + "x".repeat(6000);
  await writeFile(path.join(source, ".credentials.json"), JSON.stringify(large));
  await claude(local, "same", 1_900_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const service = claudeCredentialService(local, false);
  const previous = JSON.stringify(oauth("same", 1_900_000_000_000));
  await f.secure.write(service, "claude-code-user", previous);
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const write = f.secure.write.bind(f.secure);
  let calls = 0;
  f.secure.write = async (current, name, value) => {
    await write(current, name, value);
    calls++;
    if (name === "claude-code-user#0") {
      await rm(path.join(local, ".storage-write.lock"), { recursive: true });
      await mkdir(path.join(local, ".storage-write.lock"));
    }
  };
  await assert.rejects(() => f.service.restore({ claude: {} }, incoming, { claude: provider(local) }), /잠금|복구/);
  assert.equal(calls, 2);
  assert.equal((await f.secure.read(service, "claude-code-user"))?.value, previous);
  assert.equal(await f.secure.read(service, "claude-code-user#m"), null);
});

test("Claude capture never reads a partial generation while the CLI owns its write lock", async (t) => {
  const f = await fixture(t);
  const local = path.join(f.root, "local");
  await claude(local, "same", undefined, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  await f.secure.write(claudeCredentialService(local, false), "claude-code-user", JSON.stringify(oauth("same")));
  await mkdir(path.join(local, ".storage-write.lock"));
  await assert.rejects(() => f.service.capture({ claude: provider(local) }), /잠금/);
});

for (const [oldLength, nextLength] of [[4000, 6000], [6000, 4000], [4000, 20]]) test(`Claude restores a complete generation after every secure-store failure (${oldLength} to ${nextLength})`, async (t) => {
  const large = (length: number, expiry: number) => {
    const credential = oauth("same", expiry);
    credential.claudeAiOauth.accessToken = "synthetic-" + "x".repeat(length);
    return credential;
  };
  const previous = JSON.stringify(large(oldLength, 1_900_000_000_000));
  const incomingRaw = JSON.stringify(large(nextLength, 2_100_000_000_000));
  const oldParts = Math.ceil(Buffer.from(previous).toString("base64").length / 2400);
  const nextParts = Buffer.byteLength(incomingRaw) > 2400 ? Math.ceil(Buffer.from(incomingRaw).toString("base64").length / 2400) : 0;
  const mutations = nextParts ? nextParts + 4 + Math.max(0, oldParts - nextParts) : oldParts + 4;
  for (let failingStep = 1; failingStep <= mutations; failingStep++) {
    const f = await fixture(t);
    const source = path.join(f.root, "source"), local = path.join(f.root, "local");
    await claude(source, "same", 2_100_000_000_000);
    await writeFile(path.join(source, ".credentials.json"), incomingRaw);
    await claude(local, "same", 1_900_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
    await writeFile(path.join(local, ".credentials.json"), previous);
    const service = claudeCredentialService(local, false);
    const encoded = Buffer.from(previous).toString("base64");
    for (let index = 0; index < oldParts; index++) await f.secure.write(service, `claude-code-user#${index}`, encoded.slice(index * 2400, (index + 1) * 2400));
    await f.secure.write(service, "claude-code-user#m", JSON.stringify({ n: oldParts, l: encoded.length }));
    const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
    const before = [...f.secure.values.entries()];
    const write = f.secure.write.bind(f.secure), remove = f.secure.remove.bind(f.secure);
    let step = 0;
    const inject = () => { if (++step === failingStep) throw new Error("synthetic store operation failed"); };
    f.secure.write = async (...args) => { inject(); await write(...args); };
    f.secure.remove = async (...args) => { inject(); await remove(...args); };
    await assert.rejects(() => f.service.restore({ claude: {} }, incoming, { claude: provider(local) }));
    assert.deepEqual([...f.secure.values.entries()].sort(), before.sort(), `failed operation ${failingStep}`);
    assert.equal(await readFile(path.join(local, ".credentials.json"), "utf8"), previous);
  }
});

test("a later restore cleans unfinished chunks left by an interrupted writer", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, "source"), local = path.join(f.root, "local");
  await claude(source, "same", 2_100_000_000_000);
  await claude(local, "same", 1_900_000_000_000, { cachedGrowthBookFeatures: { tengu_windows_credman: true } });
  const service = claudeCredentialService(local, false);
  await f.secure.write(service, "claude-code-user", JSON.stringify(oauth("same", 1_900_000_000_000)));
  await f.secure.write(service, "claude-code-user#p", "4");
  for (let index = 0; index < 4; index++) await f.secure.write(service, `claude-code-user#${index}`, "synthetic-orphan");
  const incoming = (await f.service.capture({ claude: provider(source) })).credentials;
  const restored = await f.service.restore({ claude: {} }, incoming, { claude: provider(local) });
  await restored.commit();
  assert.equal(await f.secure.read(service, "claude-code-user#p"), null);
  for (let index = 0; index < 4; index++) assert.equal(await f.secure.read(service, `claude-code-user#${index}`), null);
  assert.deepEqual(JSON.parse((await f.secure.read(service, "claude-code-user"))!.value), oauth("same", 2_100_000_000_000));
});
