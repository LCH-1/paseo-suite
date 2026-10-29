import assert from "node:assert/strict";
import { test } from "node:test";
import { availableScopes, autoScopesInputSchema, clientContent, filterSnapshot, mergeSnapshot, normalizeScopes, offStatus, serverContent } from "../shared/automation";
import type { Snapshot } from "../shared/model";

const all = offStatus.scopes;
const empty = (): Snapshot => ({ version: 1, createdAt: "2026-10-23T00:00:00.000Z", device: "example", client: { hosts: [], preferences: {} }, config: {}, plugins: [] });
const remote = (): Snapshot => ({
  ...empty(), client: { hosts: [{ serverId: "example", connections: [{ id: "remote", type: "directTcp", endpoint: "remote.example:6767" }] }], preferences: { "@paseo:app-settings": '{"theme":"light"}' } },
  config: { providers: { claude: { enabled: true } }, appendSystemPrompt: "saved" },
  plugins: [{ id: "example", enabled: true, files: {}, settings: {} }], scopes: all,
});

test("legacy scope migration preserves the old provider switch and always-on client categories", () => {
  assert.deepEqual(autoScopesInputSchema.parse({ config: false, plugins: false }), { hosts: true, preferences: true, providers: false, config: false, plugins: false });
  assert.deepEqual(normalizeScopes({ config: true, plugins: true }), all);
  assert.equal(autoScopesInputSchema.parse({ config: false, plugins: true, providers: true }).providers, true);
});

test("partial publishing preserves excluded cloud contents and their availability", () => {
  const saved = remote();
  const current = empty();
  current.client.hosts = [{ serverId: "changed", connections: [] }];
  const scopes = { ...all, preferences: false, providers: false, config: false, plugins: false };
  const merged = mergeSnapshot(saved, current, scopes);
  assert.deepEqual(merged.client.hosts, current.client.hosts);
  assert.deepEqual(merged.client.preferences, saved.client.preferences);
  assert.deepEqual(merged.config, saved.config);
  assert.deepEqual(merged.plugins, saved.plugins);
  assert.deepEqual(merged.scopes, all);
  assert.deepEqual(saved, remote());
});

test("a new partial backup distinguishes absent categories from authoritative empty categories", () => {
  const scopes = { ...all, preferences: false, providers: false, config: false, plugins: false };
  const first = mergeSnapshot(null, empty(), scopes);
  assert.deepEqual(first.scopes, scopes);
  assert.deepEqual(availableScopes(first, all), scopes);
  const incoming = filterSnapshot(first, all);
  assert.equal(incoming.scopes!.hosts, true);
  assert.equal(incoming.scopes!.plugins, false);
  assert.deepEqual(availableScopes(empty(), all), { ...all, providers: false, config: false, plugins: false });
});

test("legacy partial backups do not turn missing provider or plugin data into a deletion", () => {
  const legacy = remote(); delete legacy.scopes;
  assert.deepEqual(availableScopes(legacy, all), all);
  legacy.config = {}; legacy.plugins = [];
  const restored = filterSnapshot(legacy, all);
  assert.equal(restored.scopes!.providers, false);
  assert.equal(restored.scopes!.config, false);
  assert.equal(restored.scopes!.plugins, false);
  assert.equal(mergeSnapshot(legacy, empty(), { ...all, providers: false, config: false, plugins: false }).scopes!.plugins, false);
});

test("provider and server config selection are independent in hashes and overlays", () => {
  const saved = remote();
  const current = empty();
  current.config = { providers: {}, appendSystemPrompt: "local" };
  assert.deepEqual(serverContent(saved, { ...all, providers: false }).config, { appendSystemPrompt: "saved" });
  assert.deepEqual(serverContent(saved, { ...all, config: false }).config, { providers: { claude: { enabled: true } } });
  assert.deepEqual(mergeSnapshot(saved, current, { ...all, providers: false }).config, { providers: { claude: { enabled: true } }, appendSystemPrompt: "local" });
  assert.deepEqual(mergeSnapshot(saved, current, { ...all, config: false }).config, { appendSystemPrompt: "saved", providers: {} });
});

test("excluded client groups do not change the selected content", () => {
  const saved = remote();
  assert.deepEqual(clientContent(saved.client, { ...all, hosts: false }), { hosts: [], preferences: saved.client.preferences });
  assert.deepEqual(clientContent(saved.client, { ...all, preferences: false }), { hosts: saved.client.hosts, preferences: {} });
});

test("all 32 scope combinations preserve excluded cloud groups and publish selected empty deletions", () => {
  const keys = ["hosts", "preferences", "providers", "config", "plugins"] as const;
  for (let mask = 0; mask < 32; mask++) {
    const scopes = Object.fromEntries(keys.map((key, index) => [key, Boolean(mask & (1 << index))])) as typeof all;
    const saved = remote();
    const result = mergeSnapshot(saved, empty(), scopes);
    assert.deepEqual(result.client.hosts, scopes.hosts ? [] : saved.client.hosts, `hosts ${mask}`);
    assert.deepEqual(result.client.preferences, scopes.preferences ? {} : saved.client.preferences, `preferences ${mask}`);
    assert.deepEqual(result.config.providers, scopes.providers ? undefined : saved.config.providers, `providers ${mask}`);
    assert.equal(result.config.appendSystemPrompt, scopes.config ? undefined : "saved", `config ${mask}`);
    assert.deepEqual(result.plugins, scopes.plugins ? [] : saved.plugins, `plugins ${mask}`);
    assert.deepEqual(result.scopes, all, `availability ${mask}`);
    assert.deepEqual(mergeSnapshot(null, empty(), scopes).scopes, scopes, `new availability ${mask}`);
    assert.deepEqual(saved, remote(), `immutable ${mask}`);
  }
});
