import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { decrypt, encrypt } from "../server/crypto";
import { filterSnapshot, mergeSnapshot, normalizeScopes, serverContent } from "../shared/automation";
import { snapshotSchema, type Snapshot } from "../shared/model";

function fixture(): Snapshot {
  return {
    version: 1, createdAt: "2026-10-25T00:00:00.000Z", device: "synthetic", client: { hosts: [], preferences: {} },
    config: { providers: { claude: { enabled: true } } }, plugins: [],
    credentials: { version: 1, records: [{
      id: `claude-${"0".repeat(24)}`, vendor: "claude", providerIds: ["claude"],
      identity: "a".repeat(64), metadata: {}, updatedAt: 2000, expiresAt: 3000,
      credential: { claudeAiOauth: { accessToken: "synthetic-private-access", refreshToken: "synthetic-private-refresh", expiresAt: 3000 } },
    }] },
  };
}

test("credential backups use a version an old plugin refuses instead of silently dropping authentication", async () => {
  const encrypted = await encrypt(fixture(), "synthetic provider vault password");
  assert.ok(!encrypted.includes("synthetic-private-access"));
  assert.ok(!encrypted.includes("synthetic-private-refresh"));
  const restored = await decrypt(encrypted, "synthetic provider vault password");
  assert.equal(restored.version, 2);
  assert.deepEqual(restored.credentials, fixture().credentials);
  assert.equal(z.object({ version: z.literal(1) }).safeParse(restored).success, false);
});

test("authentication cannot introduce an unconfigured provider or attach Claude authentication to Codex", () => {
  const snapshot = fixture();
  snapshot.credentials!.records[0].providerIds = ["codex"];
  assert.equal(snapshotSchema.safeParse(snapshot).success, false);
  snapshot.config.providers = { codex: { enabled: true } };
  assert.equal(snapshotSchema.safeParse(snapshot).success, false);
});

test("disabled providers remove credentials from captured views and preserve existing encrypted cloud accounts", () => {
  const scopes = normalizeScopes({ config: true, plugins: true, providers: false });
  const cloud = fixture();
  cloud.version = 2;
  const excluded = filterSnapshot(cloud, scopes);
  assert.equal("credentials" in excluded, false);
  assert.equal("credentials" in serverContent(cloud, scopes), false);
  const published = mergeSnapshot(cloud, { ...excluded, config: { appendSystemPrompt: "synthetic edit" } }, scopes);
  assert.deepEqual(published.credentials, cloud.credentials);
  assert.equal(published.version, 2);
  assert.deepEqual(published.config.providers, cloud.config.providers);
});

test("legacy backups without authentication remain readable", async () => {
  const { credentials: _credentials, ...legacy } = fixture();
  const restored = await decrypt(await encrypt(legacy, "synthetic provider vault password"), "synthetic provider vault password");
  assert.equal(restored.version, 1);
  assert.equal(restored.credentials, undefined);
});
