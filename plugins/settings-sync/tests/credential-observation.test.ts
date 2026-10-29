import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutoSync } from "../server/automation";
import { Environment } from "../server/environment";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import type { GitHubVault } from "../server/github";
import { normalizeScopes } from "../shared/automation";
import { credentialFreshnessDigest, mergeCredentialFreshness, type ProviderCredentials } from "../shared/provider-credentials";
import type { Snapshot } from "../shared/model";

const credentials = (profileFetchedAt: number): ProviderCredentials => ({ version: 1, records: [{ id: `claude-${"a".repeat(24)}`, vendor: "claude", providerIds: ["claude"], identity: "b".repeat(64), credential: { claudeAiOauth: { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: 2_100_000_000_000 } }, metadata: { oauthAccount: { accountUuid: "synthetic-account", profileFetchedAt } }, updatedAt: 2_100_000_000_000, expiresAt: 2_100_000_000_000 }] });

test("local Claude profile observation times cannot appear as refreshed authentication", () => {
  const first = credentials(1), second = credentials(2);
  assert.equal(credentialFreshnessDigest(first), credentialFreshnessDigest(second));
  assert.equal(credentialFreshnessDigest(mergeCredentialFreshness(first, second)), credentialFreshnessDigest(first));
  for (const field of ["accessToken", "refreshToken", "expiresAt"]) {
    const rotated = structuredClone(second);
    (rotated.records[0].credential.claudeAiOauth as Record<string, unknown>)[field] = field === "expiresAt" ? 2_200_000_000_000 : "synthetic-rotated";
    assert.notEqual(credentialFreshnessDigest(first), credentialFreshnessDigest(rotated));
  }
});

test("two automatic clients with independent profile observation times converge without repeated Gist writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-observation-"));
  const password = "synthetic observation regression password";
  let raw: string | null = null, sha: string | null = null, writes = 0;
  const vault = { read: async () => ({ raw, sha }), write: async (next: string, expected: string | null) => { assert.equal(expected, sha); raw = next; sha = `revision-${++writes}`; return sha; } } as unknown as GitHubVault;
  class Keys extends CredentialStore {
    override async protect(): Promise<SecretReference> { return { kind: "dpapi", value: "synthetic" }; }
    override async reveal() { return password; }
  }
  const client = { hosts: [], preferences: {} };
  const owners = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const scopes = normalizeScopes({ hosts: false, preferences: false, providers: true, config: false, plugins: false });
  const devices = owners.map((owner, i) => {
    const snapshot: Snapshot = { version: 1, createdAt: "2026-10-27T00:00:00.000Z", device: `synthetic-${i}`, client, config: { providers: { claude: { enabled: true } } }, plugins: [], credentials: credentials(i) };
    const environment = { home: path.join(root, String(i)), capture: async () => structuredClone(snapshot), fingerprint: async () => "synthetic", restore: async () => undefined } as unknown as Environment;
    return { owner, auto: new AutoSync(environment, new Keys(), () => vault, async () => "synthetic", async () => "example") };
  });
  const api = {} as Parameters<AutoSync["tick"]>[1];
  try {
    for (const { owner, auto } of devices) {
      await auto.enable({ login: "example", password, vault }, scopes, owner);
      const result = await auto.tick(client, api, undefined, owner);
      assert.equal(result.status.state, "ready", result.status.message);
    }
    assert.equal(writes, 1);
    for (let pass = 0; pass < 4; pass++) for (const { owner, auto } of devices) {
      const result = await auto.tick(client, api, undefined, owner);
      assert.equal(result.status.state, "ready");
      assert.equal(result.status.pendingOperations, 0);
    }
    assert.equal(writes, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
