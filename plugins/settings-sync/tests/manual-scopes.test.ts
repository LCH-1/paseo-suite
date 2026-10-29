import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { normalizeScopes, offStatus, type AutoScopes } from "../shared/automation";
import type { ClientState, Snapshot } from "../shared/model";
import { decrypt, encrypt } from "../server/crypto";
import { Environment } from "../server/environment";
import { GitHubVault } from "../server/github";
import { GitHubLogin } from "../server/login";
import { SyncService } from "../server/service";

type PaseoApi = PluginHandlerContext["paseo"];
const password = "manual-scopes synthetic recovery password";
const none: AutoScopes = { hosts: false, preferences: false, providers: false, config: false, plugins: false };
const client = (label: string): ClientState => ({
  hosts: [{ serverId: `remote-${label}`, label, password: `${label}-host-password`, connections: [{ id: "relay", type: "relay", relayEndpoint: "relay.example:443", daemonPublicKeyB64: "test-public-key" }] }],
  preferences: { "@paseo:preferred-editor": label },
});
const snapshot = (): Snapshot => ({
  version: 1, createdAt: "2026-10-23T00:00:00.000Z", device: "synthetic-source", scopes: offStatus.scopes,
  client: client("cloud"), config: { appendSystemPrompt: "cloud prompt", providers: { claude: { env: { EXAMPLE_CLOUD: "cloud-provider" } } } },
  plugins: [{ id: "example", enabled: true, files: { "paseo-plugin.json": Buffer.from('{"id":"example"}').toString("base64") }, settings: { display: { version: 1, values: { color: "blue" } } } }],
});

function fakePaseo() {
  let config: Record<string, unknown> = {
    appendSystemPrompt: "local prompt", providers: { codex: { env: { EXAMPLE_LOCAL: "local-provider" } } },
    plugins: { excluded: { source: "unsupported-source", path: "invalid-excluded-plugin", enabled: true } },
  };
  const calls: Record<string, unknown>[] = [];
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: Record<string, unknown>) => {
      calls.push(structuredClone(patch));
      config = { ...config, ...patch };
      return { config };
    },
  } } as unknown as PaseoApi;
  return { api, calls, current: () => config };
}

async function fixture(saved: Snapshot | null = snapshot()) {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-manual-scopes-"));
  let raw = saved ? await encrypt(saved, password) : null;
  let sha: string | null = saved ? "revision-1" : null;
  let writes = 0;
  let reads = 0;
  const vault = {
    verify: async () => "example",
    read: async () => { reads++; return { raw, sha }; },
    write: async (value: string, expected: string | null) => {
      assert.equal(expected, sha);
      raw = value; sha = `revision-${++writes + 1}`;
      return sha;
    },
  } as unknown as GitHubVault;
  const authentication = new GitHubLogin(async () => "fake-test-token", async () => "example");
  const service = new SyncService(new Environment(home, async () => undefined), () => vault, authentication);
  const connection = await service.connect({ flowId: (await service.start()).flowId, password });
  const paseo = fakePaseo();
  return { home, service, sessionId: connection.sessionId, paseo, reads: () => reads, writes: () => writes, stored: () => decrypt(raw!, password) };
}

test("manual partial backup excludes unselected hosts, providers, config and plugin sources", async () => {
  const f = await fixture(null);
  try {
    const scopes = { ...none, preferences: true };
    const result = await f.service.push(f.sessionId, client("local"), f.paseo.api, scopes);
    const saved = await f.stored();
    assert.deepEqual(saved.client, { hosts: [], preferences: client("local").preferences });
    assert.deepEqual(saved.config, {});
    assert.deepEqual(saved.plugins, []);
    assert.deepEqual(saved.scopes, scopes);
    assert.equal(result.hosts, 0); assert.equal(result.providers, 0); assert.equal(result.plugins, 0);
    assert.equal(f.writes(), 1);
  } finally { f.service.dispose(); }
});

test("manual partial backup preserves excluded cloud data and its availability", async () => {
  const original = snapshot();
  const f = await fixture(original);
  try {
    const result = await f.service.push(f.sessionId, client("local"), f.paseo.api, { ...none, preferences: true });
    const saved = await f.stored();
    assert.deepEqual(saved.client.hosts, original.client.hosts);
    assert.deepEqual(saved.client.preferences, client("local").preferences);
    assert.deepEqual(saved.config, original.config);
    assert.deepEqual(saved.plugins, original.plugins);
    assert.deepEqual(saved.scopes, offStatus.scopes);
    assert.equal(result.hosts, 0); assert.equal(result.providers, 0); assert.equal(result.plugins, 0);
  } finally { f.service.dispose(); }
});

test("manual backup and preview with every scope disabled never upload or inspect", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.push(f.sessionId, client("local"), f.paseo.api, none), /대상/);
    await assert.rejects(f.service.preview(f.sessionId, f.paseo.api, none), /대상/);
    assert.equal(f.writes(), 0);
    assert.deepEqual(await f.stored(), snapshot());
  } finally { f.service.dispose(); }
});

test("manual restore with every scope disabled rejects before cloud reads, mutations or staging", async () => {
  const f = await fixture();
  try {
    const scopes = { ...none, providers: true };
    const summary = await f.service.preview(f.sessionId, f.paseo.api, scopes);
    const before = structuredClone(f.paseo.current());
    const reads = f.reads();
    const entries = await readdir(f.home);
    await assert.rejects(f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: false, plugins: false, scopes: none }, f.paseo.api), /대상/);
    assert.equal(f.reads(), reads);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.paseo.calls, []);
    assert.deepEqual(f.paseo.current(), before);
    assert.deepEqual(await readdir(f.home), entries);
    await assert.rejects(readdir(path.join(f.home, "settings-sync", "restore")), { code: "ENOENT" });
  } finally { f.service.dispose(); }
});

test("manual provider-only preview and restore preserve excluded server, client and plugin data", async () => {
  const f = await fixture();
  try {
    const scopes = { ...none, providers: true };
    const before = structuredClone(f.paseo.current());
    const summary = await f.service.preview(f.sessionId, f.paseo.api, scopes);
    assert.deepEqual(summary.hosts, []); assert.deepEqual(summary.preferences, []); assert.deepEqual(summary.plugins, []);
    assert.deepEqual(summary.config, ["providers"]); assert.deepEqual(summary.providers, ["claude"]);
    const restored = await f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: false, plugins: false, scopes }, f.paseo.api);
    assert.deepEqual(restored.scopes, scopes);
    assert.deepEqual(restored.client, { hosts: [], preferences: {} });
    assert.equal(f.paseo.current().appendSystemPrompt, before.appendSystemPrompt);
    assert.deepEqual(f.paseo.current().plugins, before.plugins);
    assert.deepEqual(f.paseo.current().providers, { ...before.providers as object, ...snapshot().config.providers as object });
    assert.ok(f.paseo.calls.every((patch) => !Object.hasOwn(patch, "appendSystemPrompt") && !Object.hasOwn(patch, "plugins")));
  } finally { f.service.dispose(); }
});

test("manual config-only restore does not import providers or broaden disabled legacy flags", async () => {
  const f = await fixture();
  try {
    const scopes = { ...none, config: true };
    const summary = await f.service.preview(f.sessionId, f.paseo.api, scopes);
    assert.deepEqual(summary.providers, []); assert.deepEqual(summary.config, ["appendSystemPrompt"]);
    const providers = structuredClone(f.paseo.current().providers);
    const restored = await f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: true, plugins: false, scopes }, f.paseo.api);
    assert.equal(f.paseo.current().appendSystemPrompt, "cloud prompt");
    assert.deepEqual(f.paseo.current().providers, providers);
    assert.deepEqual(restored.scopes, scopes);
    assert.ok(f.paseo.calls.every((patch) => !Object.hasOwn(patch, "providers") && !Object.hasOwn(patch, "removeProviders")));
  } finally { f.service.dispose(); }
});

test("manual preview ignores malformed settings of excluded plugins and rejects later scope expansion", async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.home, "plugin-settings", "example");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "display.json"), "invalid-json");
    const scopes = { ...none, providers: true };
    const summary = await f.service.preview(f.sessionId, f.paseo.api, scopes);
    await assert.rejects(f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: true, plugins: false, scopes: { ...scopes, config: true } }, f.paseo.api), /미리보기/);
    assert.deepEqual(f.paseo.calls, []);
    const restored = await f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: false, plugins: false, scopes }, f.paseo.api);
    assert.deepEqual(restored.scopes, scopes);
  } finally { f.service.dispose(); }
});

test("manual scoped restore checks the preview fingerprint and remote availability", async () => {
  const source = snapshot(); source.scopes = { ...none, preferences: true };
  const f = await fixture(source);
  try {
    const summary = await f.service.preview(f.sessionId, f.paseo.api);
    assert.deepEqual(summary.hosts, []); assert.deepEqual(summary.providers, []); assert.deepEqual(summary.config, []); assert.deepEqual(summary.plugins, []);
    await f.paseo.api.config.patch({ appendSystemPrompt: "edited after preview" });
    await assert.rejects(f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: true, plugins: true }, f.paseo.api), /미리보기 이후/);
    const fresh = await f.service.preview(f.sessionId, f.paseo.api);
    const restored = await f.service.restore({ sessionId: f.sessionId, previewId: fresh.id, config: true, plugins: true }, f.paseo.api);
    assert.deepEqual(restored.scopes, source.scopes);
    assert.deepEqual(restored.client, { hosts: [], preferences: source.client.preferences });
    assert.equal(f.paseo.current().appendSystemPrompt, "edited after preview");
  } finally { f.service.dispose(); }
});

test("legacy manual restore flags keep their provider and client meaning", async () => {
  const f = await fixture();
  try {
    const providers = structuredClone(f.paseo.current().providers);
    const summary = await f.service.preview(f.sessionId, f.paseo.api);
    const restored = await f.service.restore({ sessionId: f.sessionId, previewId: summary.id, config: false, plugins: false }, f.paseo.api);
    assert.deepEqual(restored.scopes, normalizeScopes({ config: false, plugins: false }));
    assert.deepEqual(restored.client, snapshot().client);
    assert.deepEqual(f.paseo.current().providers, providers);
    assert.equal(f.paseo.current().appendSystemPrompt, "local prompt");
    assert.deepEqual(f.paseo.calls, []);
  } finally { f.service.dispose(); }
});
