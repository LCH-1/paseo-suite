import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PaseoApi } from "@getpaseo/client";
import { encrypt, decrypt } from "../server/crypto";
import { Environment } from "../server/environment";
import { checkedRelative, packPlugin, unpackPlugin } from "../server/files";
import { GitHubConflictError, GitHubVault, GIST_DESCRIPTION, GIST_FILENAME, REVISION_FILENAME } from "../server/github";
import { GitHubLogin } from "../server/login";
import { SyncService } from "../server/service";
import { capture, hostKey, restore, type StorageAdapter } from "../client/storage";
import { portableState } from "../shared/portable";
import type { Snapshot, PluginBackup } from "../shared/model";

const password = "test-only recovery password";
const snapshot = (): Snapshot => ({ version: 1, createdAt: "2026-10-22T00:00:00.000Z", device: "source-device",
  client: { hosts: [], preferences: { "@paseo:preferred-editor": "vscode" } },
  config: { appendSystemPrompt: "hello" }, plugins: [] });
const encoded = (value: string) => Buffer.from(value).toString("base64");
const plugin = () => ({ id: "example", enabled: true,
  files: { "paseo-plugin.json": encoded('{"id":"example"}'), "index.server.ts": encoded("export default function contribute() {}") },
  settings: { display: { version: 1, values: { color: "blue" } } } });

class MemoryStorage implements StorageAdapter {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function githubMock() {
  const entries: { id: string; raw: string; public: boolean; created_at: string; description: string; revision?: string }[] = [];
  let counter = 0;
  const writes: unknown[] = [];
  const pages: number[] = [];
  const store = (raw: string, description = GIST_DESCRIPTION, revision?: string) => {
    const entry = { id: (++counter).toString(16).padStart(32, "0"), raw, public: false, created_at: new Date(Date.now() + counter * 1000).toISOString(), description, ...(revision ? { revision } : {}) };
    entries.unshift(entry); return entry;
  };
  const metadata = (entry: typeof entries[number]) => ({ ...entry, owner: { login: "example" }, files: { [GIST_FILENAME]: { filename: GIST_FILENAME }, ...(entry.revision ? { [REVISION_FILENAME]: { filename: REVISION_FILENAME } } : {}) } });
  const detail = (entry: typeof entries[number]) => ({ ...metadata(entry), history: [{ version: "v1" }], files: { [GIST_FILENAME]: { filename: GIST_FILENAME, content: entry.raw, size: Buffer.byteLength(entry.raw), truncated: false }, ...(entry.revision ? { [REVISION_FILENAME]: { filename: REVISION_FILENAME, content: entry.revision, size: Buffer.byteLength(entry.revision) } } : {}) } });
  const request: typeof fetch = async (input, init) => {
    const url = String(input);
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-test-token");
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/user")) return Response.json({ login: "example" });
    if (url.includes("/gists?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return Response.json(entries.slice((page - 1) * 100, page * 100).map(metadata));
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      assert.equal(body.public, false);
      return Response.json(detail(store(body.files[GIST_FILENAME].content, body.description, body.files[REVISION_FILENAME]?.content)));
    }
    const found = entries.find((entry) => url.endsWith(`/gists/${entry.id}`));
    return found ? Response.json(detail(found)) : Response.json({}, { status: 404 });
  };
  return { request, writes, pages, seed: store, current: () => entries[0] ?? null, replace: (raw: string) => { store(raw); }, makePublic: () => { entries[0].public = true; }, all: () => entries };
}

test("encryption round trip, random salt and IV, wrong password, tampering and KDF bounds", async () => {
  const first = await encrypt(snapshot(), password);
  assert.deepEqual(await decrypt(first, password), snapshot());
  assert.notEqual(first, await encrypt(snapshot(), password));
  assert.ok(!first.includes("source-device"));
  await assert.rejects(decrypt(first, "different recovery password"), /암호/);
  const changed = JSON.parse(first);
  changed.tag = encoded("invalid-auth-tag!");
  await assert.rejects(decrypt(JSON.stringify(changed), password), /암호/);
  changed.iterations = 2 ** 31;
  await assert.rejects(decrypt(JSON.stringify(changed), password));
  await assert.rejects(encrypt(snapshot(), "short"), /12자/);
});

test("Gist discovery, secret snapshots, stale-write rejection and previous backup preservation", async () => {
  const mock = githubMock();
  const vault = new GitHubVault("fake-test-token", mock.request);
  assert.equal(await vault.verify(), "example");
  assert.deepEqual(await vault.read(), { sha: null, raw: null });
  const sha = await vault.write("ciphertext", null);
  assert.deepEqual(await vault.read(), { sha, raw: "ciphertext" });
  mock.replace("another device");
  await assert.rejects(vault.write("stale", sha), /다른 기기/);
  mock.makePublic();
  await assert.rejects(vault.write("secret", sha), /공개/);
  assert.equal(mock.writes.length, 1);
  assert.equal(mock.all()[1].raw, "ciphertext");
});

test("concurrent Gist uploads retain both branches and require an explicit resolution", async () => {
  const mock = githubMock();
  const base = mock.seed("legacy base");
  let posted = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const request: typeof fetch = async (input, init) => {
    const response = await mock.request(input, init);
    if (init?.method === "POST" && posted < 2) { if (++posted === 2) release(); await barrier; }
    return response;
  };
  const first = new GitHubVault("fake-test-token", request);
  const second = new GitHubVault("fake-test-token", request);
  const writes = await Promise.allSettled([first.write("first device", `${base.id}:v1`), second.write("second device", `${base.id}:v1`)]);
  assert.ok(writes.every((result) => result.status === "rejected" && result.reason instanceof GitHubConflictError));
  const fork = await first.read();
  assert.equal(fork.conflicts?.length, 2);
  assert.deepEqual(new Set(mock.all().map((entry) => entry.raw)), new Set(["legacy base", "first device", "second device"]));
  await assert.rejects(first.write("must not resolve implicitly", fork.sha), GitHubConflictError);
  const resolved = await first.write("explicitly selected environment", fork.sha, true);
  assert.deepEqual(await second.read(), { sha: resolved, raw: "explicitly selected environment" });
  assert.deepEqual(new Set(JSON.parse(mock.current()!.revision!).parents), new Set(fork.conflicts));
  assert.equal(mock.all().length, 4);
});

test("revision discovery reads only the recent parent range and preserves every historical Gist", async () => {
  const mock = githubMock();
  for (let index = 0; index < 250; index++) mock.seed(`legacy-${index}`);
  const vault = new GitHubVault("fake-test-token", mock.request);
  const parent = await vault.read();
  const revision = await vault.write("new encrypted snapshot", parent.sha);
  const count = mock.all().length;
  mock.pages.length = 0;
  assert.deepEqual(await vault.read(), { sha: revision, raw: "new encrypted snapshot" });
  assert.deepEqual(mock.pages, [1]);
  assert.equal(mock.all().length, count);
  assert.equal(count, 251);
});

test("revision ancestry determines the current backup when device clocks sort a parent first", async () => {
  const mock = githubMock();
  const parent = mock.seed("parent", `${GIST_DESCRIPTION} · 2099-01-01T00:00:00.000Z`, JSON.stringify({ version: 1, parents: [] }));
  const child = mock.seed("child", `${GIST_DESCRIPTION} · 2000-01-01T00:00:00.000Z`, JSON.stringify({ version: 1, parents: [`${parent.id}:v1`] }));
  child.created_at = parent.created_at;
  assert.deepEqual(await new GitHubVault("fake-test-token", mock.request).read(), { sha: `${child.id}:v1`, raw: "child" });
});

test("a legacy backup with a future clock cannot hide its new revision in the same server second", async () => {
  const mock = githubMock();
  const parent = mock.seed("legacy", `${GIST_DESCRIPTION} · 2099-01-01T00:00:00.000Z`);
  const child = mock.seed("new format", `${GIST_DESCRIPTION} · 2000-01-01T00:00:00.000Z`, JSON.stringify({ version: 1, parents: [`${parent.id}:v1`] }));
  child.created_at = parent.created_at;
  assert.deepEqual(await new GitHubVault("fake-test-token", mock.request).read(), { sha: `${child.id}:v1`, raw: "new format" });
});

test("truncated Gist content uses its own raw host and never sends the OAuth token there", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    urls.push(String(url));
    if (String(url).endsWith("/user")) return Response.json({ login: "example" });
    if (String(url).includes("/gists?")) return Response.json([{ id: "abc", public: false, description: GIST_DESCRIPTION, created_at: "2026-10-22T00:00:00Z", owner: { login: "example" }, files: { [GIST_FILENAME]: { filename: GIST_FILENAME } } }]);
    if (String(url).startsWith("https://gist.githubusercontent.com/")) { assert.equal(new Headers(init?.headers).has("Authorization"), false); return new Response("large ciphertext"); }
    return Response.json({ public: false, owner: { login: "example" }, history: [{ version: "version" }], files: { [GIST_FILENAME]: { size: 1_100_000, truncated: true, raw_url: `https://gist.githubusercontent.com/example/abc/raw/version/${GIST_FILENAME}` } } });
  };
  assert.deepEqual(await new GitHubVault("fake", request).read(), { sha: "abc:version", raw: "large ciphertext" });
  assert.ok(urls.at(-1)!.startsWith("https://gist.githubusercontent.com/example/abc/raw/"));
});

test("existing GitHub CLI login works without Client ID or token input and keeps credentials server-side", async () => {
  const auth = new GitHubLogin(async () => "fake-test-token", async () => "example", () => { throw new Error("must not launch"); });
  const result = await auth.start();
  assert.equal(result.ready, true); assert.equal(result.login, "example");
  assert.equal("token" in result, false); assert.equal(result.code, null);
  assert.equal(auth.credentials(result.flowId).token, "fake-test-token");
  auth.remove(result.flowId);
  assert.throws(() => auth.credentials(result.flowId), /다시/);
  auth.dispose();
});

test("browser login exposes the one-time code and completes when GitHub CLI succeeds", async () => {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null as number | null, kill: () => true });
  const auth = new GitHubLogin(async () => "fake-test-token", async () => "example", () => {
    queueMicrotask(() => process.stderr.write("! First copy your one-time code: ABCD-1234\n"));
    return process as unknown as ChildProcessWithoutNullStreams;
  });
  const flow = await auth.start(true);
  assert.equal(flow.ready, false); assert.equal(flow.code, "ABCD-1234");
  assert.equal(flow.url, "https://github.com/login/device");
  process.exitCode = 0; process.emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(auth.poll(flow.flowId), { ready: true, login: "example" });
  auth.dispose();
});

test("host migration strips device-local endpoints, preserves remote credentials and plain editor string", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, JSON.stringify([
    { serverId: "old-local", connections: [{ id: "local", type: "directPipe", path: "old-pipe" }] },
    { serverId: "remote", password: "test-host-password", preferredConnectionId: "loopback", connections: [
      { id: "loopback", type: "directTcp", endpoint: "localhost:6767" },
      { id: "remote", type: "relay", relayEndpoint: "relay.example:443", useTls: true, daemonPublicKeyB64: "test-public-key" },
    ] },
  ]));
  storage.setItem("@paseo:preferred-editor", "vscode");
  storage.setItem("@paseo:client-id-v1", "do-not-copy");
  const captured = capture(storage);
  assert.equal(captured.hosts.length, 1);
  assert.equal(captured.hosts[0].password, "test-host-password");
  assert.equal(captured.hosts[0].preferredConnectionId, "remote");
  assert.deepEqual(captured.preferences, { "@paseo:preferred-editor": "vscode" });
  const target = new MemoryStorage();
  target.setItem(hostKey, JSON.stringify([{ serverId: "new-local", connections: [{ id: "new", type: "directPipe", path: "new-pipe" }] }]));
  restore(target, captured);
  assert.deepEqual(JSON.parse(target.getItem(hostKey)!).map((h: { serverId: string }) => h.serverId), ["remote", "new-local"]);
  assert.deepEqual(captured.hostSettings, { hosts: [{ serverId: "old-local" }, { serverId: "remote" }], order: null });
  assert.equal(target.getItem("@paseo:preferred-editor"), "vscode");
  assert.equal(target.getItem("@paseo:client-id-v1"), null);
});

test("client restore rolls back after a storage write failure", () => {
  const storage = new MemoryStorage();
  storage.setItem(hostKey, "[]");
  const write = storage.setItem.bind(storage);
  let failed = false;
  storage.setItem = (key, value) => {
    if (!failed && key === "@paseo:preferred-editor") { failed = true; throw new Error("quota"); }
    write(key, value);
  };
  assert.throws(() => restore(storage, snapshot().client), /quota/);
  assert.equal(storage.getItem(hostKey), "[]");
  assert.equal(storage.getItem("@paseo:preferred-editor"), null);
});

test("file migration excludes hidden data, dependencies and sibling plugins; validates traversal before extraction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-sync-test-"));
  const source = path.join(root, "source");
  await mkdir(path.join(source, "client"), { recursive: true });
  await mkdir(path.join(source, "settings-sync"));
  await mkdir(path.join(source, "node_modules"));
  await writeFile(path.join(source, "paseo-plugin.json"), '{"id":"example"}');
  await writeFile(path.join(source, "index.server.ts"), "export default function contribute() {}");
  await writeFile(path.join(source, "client", "view.tsx"), "export const greeting = 1;");
  await writeFile(path.join(source, ".env"), "excluded-test-value");
  await writeFile(path.join(source, "settings-sync", "index.server.ts"), "excluded");
  await writeFile(path.join(source, "node_modules", "fake.js"), "excluded");
  const packed = (await packPlugin(root, "example", source, true))!;
  assert.deepEqual(Object.keys(packed.files).sort(), ["client/view.tsx", "index.server.ts", "paseo-plugin.json"]);
  const output = path.join(root, "restored"); await mkdir(output);
  await unpackPlugin(output, packed);
  assert.equal(await readFile(path.join(output, "example", "client", "view.tsx"), "utf8"), "export const greeting = 1;");
  const bad: PluginBackup = plugin(); bad.files = { ...bad.files, "../escape.ts": encoded("bad") };
  await assert.rejects(unpackPlugin(output, bad), /경로/);
  await assert.rejects(unpackPlugin(output, { ...plugin(), id: "settings-sync" }), /자체/);
  for (const relative of ["../bad", "a/../../bad", "C:/bad", "a\\bad", "NUL.txt", "dir/COM1", "file:stream", "x."]) assert.throws(() => checkedRelative(relative));
});

function fakePaseo(initial: Record<string, unknown>) {
  let config = structuredClone(initial);
  let failOnce = false;
  const calls: Record<string, unknown>[] = [];
  const api = { config: {
    get: async () => ({ config: structuredClone(config) }),
    patch: async (patch: Record<string, unknown>) => {
      calls.push(structuredClone(patch));
      if (failOnce && patch.appendSystemPrompt === "hello") { failOnce = false; throw new Error("test apply failure"); }
      config = { ...config, ...patch };
      return { config };
    },
  } } as unknown as PaseoApi;
  return { api, current: () => config, calls, failNextApply: () => { failOnce = true; } };
}

test("environment restore stages files, preserves unrelated plugins, writes settings and rejects stale previews", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-sync-restore-"));
  const environment = new Environment(home, async () => undefined);
  const original = { appendSystemPrompt: "old", providers: {}, plugins: { unrelated: { source: "directory", path: "/keep", enabled: true }, "settings-sync": { source: "directory", path: "/sync", enabled: true } } };
  const paseo = fakePaseo(original);
  const state = snapshot(); state.plugins = [plugin()];
  const fingerprint = await environment.fingerprint(paseo.api, state);
  await paseo.api.config.patch({ appendSystemPrompt: "changed" });
  await assert.rejects(environment.restore(paseo.api, state, fingerprint, { config: true, plugins: true }), /変更|변경/);
  const nextFingerprint = await environment.fingerprint(paseo.api, state);
  const operation = await environment.restore(paseo.api, state, nextFingerprint, { config: true, plugins: true });
  assert.equal(paseo.current().appendSystemPrompt, "hello");
  assert.equal((paseo.current().plugins as Record<string, { path: string }>).unrelated.path, "/keep");
  for (const patch of paseo.calls.filter((entry) => entry.plugins)) assert.equal((patch.plugins as Record<string, { path: string }>)["settings-sync"].path, "/sync");
  assert.equal((paseo.current().plugins as Record<string, { path: string }>).example.path, path.join(operation, "example"));
  assert.deepEqual(JSON.parse(await readFile(path.join(home, "plugin-settings", "example", "display.json"), "utf8")), plugin().settings.display);
  assert.ok((await readdir(operation)).includes("previous-config.json"));
});

test("environment restores previous settings and plugin configuration when apply fails", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-sync-rollback-"));
  const environment = new Environment(home, async () => undefined);
  const paseo = fakePaseo({ appendSystemPrompt: "old", providers: {}, plugins: { example: { source: "directory", path: "/original", enabled: true } } });
  await mkdir(path.join(home, "plugin-settings", "example"), { recursive: true });
  const oldSettings = JSON.stringify({ version: 1, values: { color: "red" } });
  await writeFile(path.join(home, "plugin-settings", "example", "display.json"), oldSettings);
  const state = snapshot(); state.plugins = [plugin()];
  const expected = await environment.fingerprint(paseo.api, state);
  paseo.failNextApply();
  await assert.rejects(environment.restore(paseo.api, state, expected, { config: true, plugins: true }), /test apply failure/);
  assert.equal(paseo.current().appendSystemPrompt, "old");
  assert.equal((paseo.current().plugins as Record<string, { path: string }>).example.path, "/original");
  assert.equal(await readFile(path.join(home, "plugin-settings", "example", "display.json"), "utf8"), oldSettings);
});

test("two devices: explicit backup, authenticated preview, restore, concurrent-write conflict, disconnect", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-sync-flow-"));
  const mock = githubMock();
  const authentication = new GitHubLogin(async () => "fake-test-token", async () => "example");
  const service = new SyncService(new Environment(home), (token) => new GitHubVault(token, mock.request), authentication);
  const a = await service.connect({ flowId: (await service.start()).flowId, password });
  const b = await service.connect({ flowId: (await service.start()).flowId, password });
  assert.equal(mock.writes.length, 0);
  const paseo = fakePaseo({ appendSystemPrompt: "hello", providers: {}, plugins: {}, serverId: "never-copy" });
  await service.push(a.sessionId, snapshot().client, paseo.api);
  assert.ok(!mock.current()!.raw.includes("hello"));
  await assert.rejects(service.push(b.sessionId, snapshot().client, paseo.api), /다른 기기/);
  const summary = await service.preview(b.sessionId, paseo.api);
  assert.equal("password" in summary, false);
  assert.equal(summary.config.includes("serverId"), false);
  const restored = await service.restore({ sessionId: b.sessionId, previewId: summary.id, config: true, plugins: false }, paseo.api);
  assert.deepEqual(restored.client.preferences, snapshot().client.preferences);
  service.disconnect(b.sessionId);
  await assert.rejects(service.preview(b.sessionId, paseo.api), /만료/);
  service.dispose();
});

test("screen session resumes, discovers later backups and expires only after idle timeout", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-sync-resume-"));
  const mock = githubMock();
  let now = 1;
  const auth = new GitHubLogin(async () => "fake-test-token", async () => "example");
  const service = new SyncService(new Environment(home, async () => undefined), () => new GitHubVault("fake-test-token", mock.request), auth, () => now);
  try {
    const connection = await service.connect({ flowId: (await service.start()).flowId, password });
    assert.equal(connection.hasBackup, false);
    now += 29 * 60_000;
    assert.deepEqual(await service.resume(connection.sessionId), connection);
    mock.replace(await encrypt(snapshot(), password));
    assert.equal((await service.resume(connection.sessionId))!.hasBackup, true);
    assert.equal(mock.writes.length, 0);
    now += 30 * 60_000;
    assert.equal(await service.resume(connection.sessionId), null);
  } finally { service.dispose(); }
});
