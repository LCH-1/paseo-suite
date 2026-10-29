import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { decrypt, encrypt } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { GitHubLogin } from "../server/login";
import { ProviderCredentialSync } from "../server/provider-credentials";
import { SyncService } from "../server/service";
import { filterSnapshot, normalizeScopes, type AutoScopes } from "../shared/automation";
import type { ClientState, Snapshot } from "../shared/model";
import { rpc } from "../shared/rpc";

type PaseoApi = PluginHandlerContext["paseo"];
const password = "synthetic manual provider recovery password";
const none: AutoScopes = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
const providersOnly = { ...none, providers: true };
const preferencesOnly = { ...none, preferences: true };
const empty: ClientState = { hosts: [], preferences: {} };

function snapshot(expiry: number, account = "same-account"): Snapshot {
  return {
    version: 2, createdAt: "2026-10-25T00:00:00.000Z", device: "synthetic-source", client: empty,
    scopes: normalizeScopes({ config: true, plugins: true }),
    config: { providers: { claude: { enabled: true, env: { ANTHROPIC_AUTH_TOKEN: "synthetic-config-secret" } } } }, plugins: [],
    credentials: { version: 1, records: [{
      id: `claude-${"1".repeat(24)}`, vendor: "claude", providerIds: ["claude"],
      identity: (account === "same-account" ? "a" : "b").repeat(64), metadata: {}, updatedAt: expiry, expiresAt: expiry,
      credential: { claudeAiOauth: { accessToken: `synthetic-private-access-${account}-${expiry}`, refreshToken: `synthetic-private-refresh-${account}-${expiry}`, expiresAt: expiry } },
    }] },
  };
}

function memoryEnvironment(local: Snapshot) {
  return {
    home: "synthetic-unused-home",
    capture: async (_paseo: PaseoApi, client: ClientState, scopes: AutoScopes = providersOnly) => filterSnapshot({ ...structuredClone(local), client }, scopes),
    fingerprint: async () => "synthetic-fingerprint",
  } as unknown as Environment;
}

async function fixture(t: TestContext, saved = snapshot(2_100_000_000_000), environment = memoryEnvironment(snapshot(2_000_000_000_000))) {
  let raw = await encrypt(saved, password);
  let sha = "synthetic-revision-1";
  let writes = 0;
  const vault = {
    verify: async () => "synthetic-account",
    read: async () => ({ raw, sha }),
    write: async (next: string, expected: string | null) => {
      assert.equal(expected, sha);
      raw = next;
      sha = `synthetic-revision-${++writes + 1}`;
      return sha;
    },
  } as unknown as GitHubVault;
  const authentication = new GitHubLogin(async () => "synthetic-github-token", async () => "synthetic-account");
  const service = new SyncService(environment, () => vault, authentication);
  t.after(() => service.dispose());
  const connection = await service.connect({ flowId: (await service.start()).flowId, password });
  const api = { config: { get: async () => ({ config: { providers: { claude: { enabled: true } }, plugins: {} } }), patch: async () => { throw new Error("excluded config must not be changed"); } } } as unknown as PaseoApi;
  return { service, sessionId: connection.sessionId, connection, api, writes: () => writes, stored: () => decrypt(raw, password) };
}

test("manual upload preserves newer cloud tokens for the same provider account", async (t) => {
  const cloud = snapshot(2_100_000_000_000);
  const f = await fixture(t, cloud);
  const result = await f.service.push(f.sessionId, empty, f.api, providersOnly);
  const saved = await f.stored();
  assert.deepEqual(saved.credentials, cloud.credentials);
  assert.equal(f.writes(), 1);
  assert.equal(result.authentications, 1);
  assert.equal(result.providers, 1);
});

test("manual upload still selects a deliberately changed provider account", async (t) => {
  const replacement = snapshot(2_000_000_000_000, "other-account");
  const f = await fixture(t, snapshot(2_100_000_000_000), memoryEnvironment(replacement));
  await f.service.push(f.sessionId, empty, f.api, providersOnly);
  assert.deepEqual((await f.stored()).credentials, replacement.credentials);
});

test("manual service and RPC outputs contain provider IDs and counts without credential values or identities", async (t) => {
  const f = await fixture(t);
  const uploaded = rpc.push.output.parse(await f.service.push(f.sessionId, empty, f.api, providersOnly));
  const summary = rpc.preview.output.parse(await f.service.preview(f.sessionId, f.api, providersOnly));
  const resumed = rpc.resume.output.parse(await f.service.resume(f.sessionId));
  assert.deepEqual(Object.keys(uploaded).sort(), ["authentications", "createdAt", "hosts", "plugins", "providers"]);
  assert.deepEqual(summary.authenticatedProviders, ["claude"]);
  assert.deepEqual(summary.providers, ["claude"]);
  const publicResults = JSON.stringify({ connection: rpc.connect.output.parse(f.connection), uploaded, summary, resumed });
  for (const value of ["synthetic-private-access", "synthetic-private-refresh", "synthetic-config-secret", "a".repeat(64), "credential", password, "synthetic-github-token"]) assert.equal(publicResults.includes(value), false);
});

test("manual provider scope off neither reads nor restores authentication and preserves cloud accounts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-service-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^paseo-provider-service-[a-zA-Z0-9]+$/);
    await rm(root, { recursive: true, force: true });
  });
  let reads = 0;
  let restores = 0;
  const inaccessible = new ProviderCredentialSync({ home: root, userHome: path.join(root, "synthetic-user"), env: {}, platform: "linux" });
  inaccessible.capture = async () => { reads++; throw new Error("excluded authentication must not be read"); };
  inaccessible.restore = async () => { restores++; throw new Error("excluded authentication must not be restored"); };
  const environment = new Environment(root, async () => undefined, inaccessible);
  const cloud = snapshot(2_100_000_000_000);
  const f = await fixture(t, cloud, environment);
  const client = { hosts: [], preferences: { "@paseo:preferred-editor": "synthetic-editor" } };
  const uploaded = await f.service.push(f.sessionId, client, f.api, preferencesOnly);
  assert.equal(uploaded.authentications, 0);
  assert.equal(uploaded.providers, 0);
  assert.deepEqual((await f.stored()).credentials, cloud.credentials);
  const summary = await f.service.preview(f.sessionId, f.api, preferencesOnly);
  assert.deepEqual(summary.authenticatedProviders, []);
  assert.deepEqual(summary.providers, []);
  const restored = await f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: false, plugins: false, scopes: preferencesOnly }, f.api);
  assert.deepEqual(restored.scopes, preferencesOnly);
  assert.deepEqual(restored.client, client);
  assert.equal(reads, 0);
  assert.equal(restores, 0);
});
