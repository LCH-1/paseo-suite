import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { AutoSync } from "../server/automation";
import { CredentialStore, type SecretReference } from "../server/credential-store";
import { encrypt } from "../server/crypto";
import { Environment } from "../server/environment";
import type { GitHubVault } from "../server/github";
import { MAX_BYTES, type Snapshot } from "../shared/model";

test("a valid large cloud backup resumes and acknowledges after a process restart", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-large-state-"));
  t.after(async () => { assert.equal(path.dirname(home), path.resolve(tmpdir())); assert.ok(path.basename(home).startsWith("paseo-large-state-")); await rm(home, { recursive: true, force: true }); });
  const password = "synthetic large state password";
  const scopes = { hosts: false, preferences: true, providers: false, config: false, plugins: false };
  const value = JSON.stringify({ theme: "dark", extensionState: "x".repeat(Math.floor(MAX_BYTES * 0.55)) });
  const snapshot: Snapshot = { version: 3, device: "remote", createdAt: "2026-10-28T00:00:00.000Z", config: {}, plugins: [], scopes, client: { hosts: [], preferences: { "@paseo:app-settings": value }, preferenceCoverage: ["@paseo:app-settings"] } };
  let raw = await encrypt(snapshot, password), sha = "initial";
  const vault = { read: async () => ({ raw, sha }), write: async (next: string, expected: string | null) => { assert.equal(expected, sha); raw = next; return sha = "acknowledged"; } } as unknown as GitHubVault;
  class Keys extends CredentialStore {
    override async protect(): Promise<SecretReference> { return { kind: "secret-service", value: randomUUID() }; }
    override async reveal() { return password; }
    override async remove() {}
  }
  const factory = () => new AutoSync(new Environment(home), new Keys(), () => vault, async () => "synthetic", async () => "example");
  const api = { config: { get: async () => ({ config: { providers: {}, plugins: {} } }) } } as unknown as PluginHandlerContext["paseo"];
  const empty = { hosts: [], preferences: {} };
  const first = factory();
  let resumed: AutoSync | undefined;
  try {
    await first.enable({ login: "example", password, vault }, scopes);
    const started = await first.tick(empty, api);
    assert.equal(started.status.state, "syncing", started.status.message);
    assert.ok(started.operation);
    assert.ok(!(await readFile(path.join(home, "settings-sync/automation.json"), "utf8")).includes("x".repeat(100)));
    first.dispose();
    resumed = factory();
    const continued = await resumed.tick(empty, api);
    assert.ok(continued.operation);
    assert.equal(continued.operation.id, started.operation.id);
    assert.equal(continued.operation.client.preferences["@paseo:app-settings"], value);
    const done = await resumed.acknowledge(continued.operation.id, continued.operation.client, api);
    assert.equal(done.state, "ready");
    assert.equal(done.pendingOperations, 0);
  } finally { first.dispose(); resumed?.dispose(); }
});
