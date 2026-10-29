import assert from "node:assert/strict";
import { watch, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureVendorCredentials, prepareVendorCredentialRestore, vendorCredentialFileFormats, vendorCredentialFilePath, type VendorCredentialFileOptions } from "../server/vendor-credential-files";
import { mergeCredentialFreshness, type ProviderCredentialRecord } from "../shared/provider-credentials";
import { projectProviders } from "../shared/provider-paths";

const cursor = { cursor: { extends: "acp", enabled: true, command: ["cursor-agent.cmd", "acp"] } };
const pi = { pi: { enabled: true } };
const opencode = { opencode: { enabled: true } };
const jwt = (sub: string, exp = 2_000_000_000) => `header.${Buffer.from(JSON.stringify({ sub, exp })).toString("base64url")}.signature`;
const cursorAuth = (sub: string, exp = 2_000_000_000) => ({ accessToken: jwt(sub, exp), refreshToken: "synthetic-refresh" });

for (const vendor of ["cursor", "pi", "opencode"] as const) test(`${vendor} preserves concurrent file rotation before replacement and retries with the newer token`, async (t) => {
  const f = await fixture(t);
  const providers = vendor === "cursor" ? cursor : vendor === "pi" ? pi : opencode;
  const token = (expiry: number) => vendor === "cursor" ? cursorAuth("same", expiry / 1000) : { account: { type: "oauth", access: jwt("same", expiry / 1000), refresh: "synthetic-refresh", expires: expiry, accountId: "same" } };
  const file = vendorCredentialFilePath(vendor, f.options);
  await f.put(file, token(2_100_000_000_000));
  const incoming = await f.capture(providers);
  await f.put(file, token(1_900_000_000_000));
  const refreshed = JSON.stringify({ ...token(2_300_000_000_000), ...(vendor === "cursor" ? { unrelatedLocalData: "synthetic-preserved" } : {}) });
  let rotated = false;
  const watcher = watch(path.dirname(file), (_event, filename) => {
    const name = filename?.toString() ?? "";
    if (!rotated && name.startsWith(`${path.basename(file)}.`) && name.endsWith(".tmp")) { rotated = true; writeFileSync(file, refreshed); }
  });
  t.after(() => watcher.close());
  await assert.rejects(() => prepareVendorCredentialRestore(f.options, incoming.providers, incoming.records, providers), /계정 또는 인증.*갱신/);
  watcher.close();
  assert.equal(rotated, true);
  assert.equal(await readFile(file, "utf8"), refreshed);
  const retried = await prepareVendorCredentialRestore(f.options, incoming.providers, incoming.records, providers); await retried.commit();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), JSON.parse(refreshed));
});

async function fixture(t: TestContext, platform: NodeJS.Platform = "win32") {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-vendor-credentials-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("paseo-vendor-credentials-") && path.dirname(root) === path.resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const options: VendorCredentialFileOptions = { home: path.join(root, "paseo"), userHome: path.join(root, "user"), platform, env: {} };
  const put = async (file: string, value: unknown, stamp = 1_800_000_000_000) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    await utimes(file, stamp / 1000, stamp / 1000);
  };
  const capture = (providers: Record<string, unknown> = cursor) => captureVendorCredentials(options, providers);
  return { root, options, put, capture };
}

function env(providers: Record<string, unknown>, id: string) {
  return (providers[id] as { env: Record<string, string> }).env;
}

test("Cursor ACP captures only the CLI auth fields and the JSON file format", async (t) => {
  const f = await fixture(t);
  const auth = { ...cursorAuth("account-a"), apiKey: "synthetic-api-key", bedrockCredentials: { accessKey: "synthetic-access", secretKey: "synthetic-secret", sessionToken: "synthetic-session" } };
  await f.put(vendorCredentialFilePath("cursor", f.options), { ...auth, desktopState: "must-stay-local", installationId: "must-stay-local" });
  await f.put(path.join(f.options.userHome!, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"), "must-not-read-the-desktop-db");
  const result = await f.capture();
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0].credential, auth);
  assert.deepEqual(result.records[0].providerIds, ["cursor"]);
  assert.equal(result.records[0].expiresAt, 2_000_000_000_000);
  assert.deepEqual(result.status, [{ vendor: "cursor", providerIds: ["cursor"], status: "available", store: "file" }]);
  assert.deepEqual(vendorCredentialFileFormats.cursor, { basename: "auth.json", mime: "application/json" });
});

test("Cursor honors profile APPDATA and keeps distinct profiles separate", async (t) => {
  const f = await fixture(t);
  const first = path.join(f.root, "profile-one");
  const second = path.join(f.root, "profile-two");
  const providers = { ...cursor, one: { extends: "cursor", env: { APPDATA: first } }, two: { extends: "cursor", env: { APPDATA: second } } };
  await f.put(vendorCredentialFilePath("cursor", f.options, { APPDATA: first }), cursorAuth("account-one"));
  await f.put(vendorCredentialFilePath("cursor", f.options, { APPDATA: second }), cursorAuth("account-two"));
  const result = await f.capture(providers);
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records.map((record) => record.providerIds), [["one"], ["two"]]);
  assert.notEqual(result.records[0].identity, result.records[1].identity);
});

test("Cursor API-key precedence does not leak into a file-backed sibling", async (t) => {
  const f = await fixture(t);
  await f.put(vendorCredentialFilePath("cursor", f.options), cursorAuth("file-account"));
  const result = await f.capture({ ...cursor, keyed: { extends: "cursor", env: { CURSOR_API_KEY: "synthetic-env-key" } } });
  assert.deepEqual(result.records.map((record) => record.providerIds), [["cursor"]]);
  assert.equal(env(result.providers, "keyed").CURSOR_API_KEY, "synthetic-env-key");
  assert.equal(env(result.providers, "cursor").CURSOR_API_KEY, "");
  assert.equal(result.status.find((status) => status.providerIds.includes("keyed"))?.status, "environment");
});

test("Linux Cursor auth follows XDG_CONFIG_HOME and ignores CURSOR_CONFIG_DIR", async (t) => {
  const f = await fixture(t, "linux");
  const providers = { cursor: { ...cursor.cursor, env: { XDG_CONFIG_HOME: "~/custom-config", CURSOR_CONFIG_DIR: path.join(f.root, "other-config") } } };
  await f.put(path.join(f.options.userHome!, "custom-config", "cursor", "auth.json"), cursorAuth("linux-account"));
  const result = await f.capture(providers);
  assert.equal(result.records.length, 1);
});

test("Cursor keychain and memory stores are explicitly unsupported without reading fallback files", async (t) => {
  const f = await fixture(t, "darwin");
  await f.put(vendorCredentialFilePath("cursor", f.options), "not-json-and-must-not-be-read");
  const result = await f.capture();
  assert.equal(result.records.length, 0);
  assert.equal(result.status[0].status, "unsupported");
  assert.equal(result.status[0].store, "keychain");
  const memory = await f.capture({ cursor: { ...cursor.cursor, env: { AGENT_CLI_CREDENTIAL_STORE: "memory" } } });
  assert.equal(memory.status[0].store, "memory");
});

test("missing and empty auth files are normal and disabled providers are not collected", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.capture()).status[0].status, "missing");
  await f.put(vendorCredentialFilePath("cursor", f.options), {});
  assert.equal((await f.capture()).status[0].status, "missing");
  await f.put(vendorCredentialFilePath("cursor", f.options), "malformed-synthetic-credential");
  assert.deepEqual(await f.capture({ cursor: { ...cursor.cursor, enabled: false } }), { providers: { cursor: { ...cursor.cursor, enabled: false } }, records: [], status: [] });
});

test("malformed and oversized credential errors do not repeat their contents", async (t) => {
  const f = await fixture(t);
  const file = vendorCredentialFilePath("cursor", f.options);
  await f.put(file, "synthetic-private-fragment-not-json");
  await assert.rejects(f.capture(), (error: Error) => /손상/.test(error.message) && !error.message.includes("synthetic-private-fragment"));
  await f.put(file, "x".repeat(1_048_577));
  await assert.rejects(f.capture(), /안전하게 읽을 수 없습니다/);
});

test("credential files inside a linked directory are rejected", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.root, "actual-credentials");
  await f.put(path.join(destination, "auth.json"), cursorAuth("linked-account"));
  const file = vendorCredentialFilePath("cursor", f.options);
  await mkdir(path.dirname(path.dirname(file)), { recursive: true });
  await symlink(destination, path.dirname(file), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.capture(), /안전하게 읽을 수 없습니다/);
});

test("Cursor restore isolates another account and recaptures the same record", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cloud-account"));
  const original = cursorAuth("local-account");
  const originalFile = vendorCredentialFilePath("cursor", target.options);
  await target.put(originalFile, original);
  const captured = await source.capture();
  const restored = await prepareVendorCredentialRestore(target.options, cursor, captured.records);
  const targetEnv = env(restored.providers, "cursor");
  assert.equal(targetEnv.AGENT_CLI_CREDENTIAL_STORE, "file");
  assert.equal(targetEnv.APPDATA, path.join(target.options.home, "settings-sync", "provider-profiles", captured.records[0].id, "roaming"));
  assert.deepEqual(JSON.parse(await readFile(originalFile, "utf8")), original);
  await restored.commit();
  const actual = await target.capture(restored.providers);
  assert.deepEqual(actual.records, captured.records);
  assert.deepEqual(projectProviders(actual.providers), projectProviders(captured.providers));
});

test("newer tokens for the same Cursor account are retained at the existing profile", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("same-account", 2_000_000_000));
  const newer = { ...cursorAuth("same-account", 2_100_000_000), refreshToken: "newer-synthetic-refresh" };
  const targetFile = vendorCredentialFilePath("cursor", target.options);
  await target.put(targetFile, newer, 1_900_000_000_000);
  const restored = await prepareVendorCredentialRestore(target.options, cursor, (await source.capture()).records);
  assert.equal(env(restored.providers, "cursor").APPDATA, path.dirname(path.dirname(targetFile)));
  assert.deepEqual(JSON.parse(await readFile(targetFile, "utf8")), newer);
  await restored.commit();
});

test("Cursor Windows to Linux projection is stable and ambient credentials are cleared", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t, "linux");
  target.options.env = { CURSOR_API_KEY: "synthetic-target-only-api-key", CURSOR_AUTH_TOKEN: "synthetic-target-only-auth-token" };
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cross-platform-account"));
  const captured = await source.capture();
  const restored = await prepareVendorCredentialRestore(target.options, captured.providers, captured.records, cursor);
  assert.equal(env(restored.providers, "cursor").CURSOR_API_KEY, "");
  assert.equal(env(restored.providers, "cursor").CURSOR_AUTH_TOKEN, "");
  const actual = await target.capture(restored.providers);
  assert.equal(actual.status[0].status, "available");
  assert.deepEqual(projectProviders(actual.providers), projectProviders(captured.providers));
  assert.deepEqual(actual.records, captured.records);
  await restored.commit();
});

test("existing same-account restore drops stale foreign profile keys", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t, "linux");
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("same-account", 2_100_000_000));
  await target.put(vendorCredentialFilePath("cursor", target.options), cursorAuth("same-account"));
  const providers = { cursor: { ...cursor.cursor, env: { APPDATA: path.join(target.root, "unused-foreign-profile"), XDG_CONFIG_HOME: path.join(target.root, "incorrect-source-profile") } } };
  const restored = await prepareVendorCredentialRestore(target.options, providers, (await source.capture()).records, cursor);
  const expected = path.dirname(path.dirname(vendorCredentialFilePath("cursor", target.options)));
  assert.equal(env(restored.providers, "cursor").APPDATA, expected);
  assert.equal(env(restored.providers, "cursor").XDG_CONFIG_HOME, expected);
  assert.deepEqual(projectProviders(restored.providers), projectProviders((await source.capture()).providers));
  await restored.commit();
});

test("rollback restores previous credential bytes and timestamp", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("same-account", 2_100_000_000));
  const targetFile = vendorCredentialFilePath("cursor", target.options);
  const raw = JSON.stringify(cursorAuth("same-account"), null, 2);
  await target.put(targetFile, raw, 1_700_000_000_000);
  const restored = await prepareVendorCredentialRestore(target.options, cursor, (await source.capture()).records);
  assert.notEqual(await readFile(targetFile, "utf8"), raw);
  await restored.rollback();
  assert.equal(await readFile(targetFile, "utf8"), raw);
  assert.equal(Math.trunc((await stat(targetFile)).mtimeMs), 1_700_000_000_000);
});

test("a later record failure removes the earlier staged credential", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cloud-account"));
  const first = (await source.capture()).records[0];
  const invalid: ProviderCredentialRecord = { ...first, id: `cursor-${"b".repeat(24)}`, providerIds: ["other"], credential: { unexpected: "synthetic-value" } };
  await assert.rejects(prepareVendorCredentialRestore(target.options, { ...cursor, other: { extends: "cursor" } }, [first, invalid]), /인증 파일 형식/);
  const staged = path.join(target.options.home, "settings-sync", "provider-profiles", first.id, "roaming", "Cursor", "auth.json");
  await assert.rejects(readFile(staged), { code: "ENOENT" });
});

test("rollback after commit leaves the committed file and rejects changed files during rollback", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cloud-account"));
  const restored = await prepareVendorCredentialRestore(target.options, cursor, (await source.capture()).records);
  const file = vendorCredentialFilePath("cursor", target.options, env(restored.providers, "cursor"));
  await restored.commit();
  await restored.rollback();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), cursorAuth("cloud-account"));
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cloud-account", 2_100_000_000));
  const next = await prepareVendorCredentialRestore(target.options, restored.providers, (await source.capture()).records);
  const nextFile = vendorCredentialFilePath("cursor", target.options, env(next.providers, "cursor"));
  await target.put(nextFile, cursorAuth("changed-account"));
  await assert.rejects(next.rollback(), /인증 복구에 실패/);
  assert.deepEqual(JSON.parse(await readFile(nextFile, "utf8")), cursorAuth("changed-account"));
});

test("record identities, provider bindings, and destination ids are validated before unsafe writes", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("cloud-account"));
  const captured = (await source.capture()).records[0];
  await assert.rejects(prepareVendorCredentialRestore(target.options, pi, [{ ...captured, providerIds: ["pi"] }]), /종류가 일치/);
  await assert.rejects(prepareVendorCredentialRestore(target.options, cursor, [{ ...captured, identity: "0".repeat(64) }]), /식별자/);
  await assert.rejects(prepareVendorCredentialRestore(target.options, cursor, [{ ...captured, id: "cursor-../../escape" }]), /백업 형식/);
});

test("macOS file credentials can only update an existing matching account", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t, "darwin");
  await source.put(vendorCredentialFilePath("cursor", source.options), cursorAuth("same-account", 2_100_000_000));
  const records = (await source.capture()).records;
  await assert.rejects(prepareVendorCredentialRestore(target.options, cursor, records), /기존의 같은 계정/);
  const providers = { cursor: { ...cursor.cursor, env: { AGENT_CLI_CREDENTIAL_STORE: "file" } } };
  await target.put(vendorCredentialFilePath("cursor", target.options), cursorAuth("same-account"));
  const restored = await prepareVendorCredentialRestore(target.options, providers, records);
  assert.equal(env(restored.providers, "cursor").AGENT_CLI_CREDENTIAL_STORE, "file");
  assert.deepEqual(JSON.parse(await readFile(vendorCredentialFilePath("cursor", target.options), "utf8")), cursorAuth("same-account", 2_100_000_000));
  await restored.commit();
});

test("Pi captures only known credential shapes and restores into an isolated profile", async (t) => {
  const source = await fixture(t);
  const target = await fixture(t);
  const auth = { anthropic: { type: "oauth", access: jwt("pi-account"), refresh: "synthetic-pi-refresh", expires: 2_000_000_000_000 }, openai: { type: "api_key", key: "synthetic-pi-api", env: { OPENAI_ORGANIZATION: "synthetic-org" } }, chatgpt: { type: "oauth", access: "synthetic-chatgpt", refresh: "synthetic-refresh", expires: 2_000_000_000_000, clientId: "synthetic-issued-client" } };
  await source.put(vendorCredentialFilePath("pi", source.options), auth);
  await source.put(path.join(source.options.userHome!, ".pi", "agent", "settings.json"), { unrelated: "must-stay-local" });
  const records = (await source.capture(pi)).records;
  assert.deepEqual(records[0].credential, auth);
  const restored = await prepareVendorCredentialRestore(target.options, pi, records);
  assert.equal(env(restored.providers, "pi").PI_CODING_AGENT_DIR, path.join(target.options.home, "settings-sync", "provider-profiles", records[0].id));
  assert.deepEqual((await target.capture(restored.providers)).records, records);
  assert.deepEqual(projectProviders((await target.capture(restored.providers)).providers), projectProviders((await source.capture(pi)).providers));
  await restored.commit();
});

test("Pi command-based keys and unknown OAuth extensions are not executed or copied", async (t) => {
  const f = await fixture(t);
  const file = vendorCredentialFilePath("pi", f.options);
  await f.put(file, { openai: { type: "api_key", key: "!echo must-not-execute" } });
  await assert.rejects(f.capture(pi), /인증 파일 형식/);
  await f.put(file, { custom: { type: "oauth", access: "synthetic", refresh: "synthetic", expires: 1234, script: "must-not-copy" } });
  await assert.rejects(f.capture(pi), /인증 파일 형식/);
});

test("OpenCode 1 auth records roundtrip without copying other state", async (t) => {
  const source = await fixture(t, "linux");
  const target = await fixture(t, "linux");
  const auth = { anthropic: { type: "oauth", access: jwt("opencode-account"), refresh: "synthetic-refresh", expires: 2_000_000_000_000, accountId: "synthetic-account" }, openai: { type: "api", key: "synthetic-api-key", metadata: { source: "synthetic" } }, "https://example.invalid": { type: "wellknown", key: "synthetic-key", token: "synthetic-token" } };
  await source.put(vendorCredentialFilePath("opencode", source.options), auth);
  const records = (await source.capture(opencode)).records;
  const restored = await prepareVendorCredentialRestore(target.options, opencode, records);
  assert.deepEqual((await target.capture(restored.providers)).records, records);
  assert.deepEqual(projectProviders((await target.capture(restored.providers)).providers), projectProviders((await source.capture(opencode)).providers));
  assert.equal(env(restored.providers, "opencode").XDG_DATA_HOME, path.join(target.options.home, "settings-sync", "provider-profiles", records[0].id, "data"));
  await restored.commit();
});

test("OpenCode 2 databases are reported as unsupported and never read as auth files", async (t) => {
  const f = await fixture(t);
  const file = vendorCredentialFilePath("opencode", f.options);
  await f.put(file, "stale-auth-json-must-not-be-read");
  await f.put(path.join(path.dirname(file), "opencode.db"), "database-contents-must-not-be-read");
  const result = await f.capture(opencode);
  assert.deepEqual(result.records, []);
  assert.equal(result.status[0].status, "unsupported");
  assert.equal(result.status[0].store, "database");
});

test("explicit OpenCode auth content is validated and retained as provider environment", async (t) => {
  const f = await fixture(t);
  const content = JSON.stringify({ openai: { type: "api", key: "synthetic-inline-key" } });
  const providers = { opencode: { enabled: true, env: { OPENCODE_AUTH_CONTENT: content } } };
  const result = await f.capture(providers);
  assert.equal(result.status[0].status, "environment");
  assert.equal(env(result.providers, "opencode").OPENCODE_AUTH_CONTENT, content);
  assert.deepEqual(result.records, []);
});

for (const vendor of ["pi", "opencode"] as const) {
  test(`${vendor} merges independent OAuth refreshes from both PCs per account entry`, async (t) => {
    const first = await fixture(t, "linux");
    const second = await fixture(t, "linux");
    const target = await fixture(t, "linux");
    const providers = { [vendor]: { enabled: true } };
    const oauth = (account: string, expires: number) => ({ type: "oauth", access: jwt(account, expires / 1000), refresh: `synthetic-${account}-${expires}`, expires });
    const aNew = oauth("account-a", 2_100_000_000_000);
    const aOld = oauth("account-a", 2_000_000_000_000);
    const bNew = oauth("account-b", 2_200_000_000_000);
    const bOld = oauth("account-b", 2_000_000_000_000);
    await first.put(vendorCredentialFilePath(vendor, first.options), { first: aNew, second: bOld });
    await second.put(vendorCredentialFilePath(vendor, second.options), { first: aOld, second: bNew });
    const left = { version: 1 as const, records: (await first.capture(providers)).records };
    const right = { version: 1 as const, records: (await second.capture(providers)).records };
    assert.equal(left.records[0].identity, right.records[0].identity);
    const merged = mergeCredentialFreshness(left, right);
    const reverse = mergeCredentialFreshness(right, left);
    assert.deepEqual(merged, reverse);
    assert.deepEqual(merged.records[0].credential, { first: aNew, second: bNew });
    assert.equal(merged.records[0].expiresAt, 2_100_000_000_000);
    const restored = await prepareVendorCredentialRestore(target.options, providers, merged.records);
    assert.deepEqual((await target.capture(restored.providers)).records, merged.records);
    await restored.commit();
  });
}
