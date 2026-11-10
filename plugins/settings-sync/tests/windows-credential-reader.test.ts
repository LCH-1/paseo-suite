import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeCredentialService, ProviderCredentialSync, WINDOWS_CREDENTIAL_SCRIPT, WindowsProviderSecureStore } from "../server/provider-credentials";
import { sharedWindowsCredentialReader, WindowsCredentialReader, WINDOWS_CREDENTIAL_READER_SCRIPT } from "../server/windows-credential-reader";
import { helperReply, syntheticCredentialHost } from "./fixtures/credential-helper";

const NAME = "claude-code-user";
const oauth = (token: string, expiresAt = 2_000_000_000_000) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "synthetic-refresh", expiresAt, scopes: ["user:inference"] } });
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function twoLogins(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-credential-reader-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "paseo"), userHome = path.join(root, "user");
  const host = syntheticCredentialHost();
  const providers: Record<string, { extends?: string; env: Record<string, string> }> = {};
  const targets: string[] = [];
  for (const [index, id] of ["claude", "claude-second"].entries()) {
    const directory = path.join(root, "profile-" + index);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "synthetic-account-" + index } }));
    providers[id] = { ...(index ? { extends: "claude" } : {}), env: { CLAUDE_CONFIG_DIR: directory, CLAUDE_SECURESTORAGE_CONFIG_DIR: directory, CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } };
    targets.push(`${claudeCredentialService(directory, false)}/${NAME}`);
    host.entries.set(targets[index], oauth("synthetic-access-" + index));
  }
  await mkdir(home); await mkdir(userHome);
  const tokens = async (sync: ProviderCredentialSync) => (await sync.capture(providers)).credentials.records.map((record) => (record.credential.claudeAiOauth as { accessToken: string }).accessToken).sort();
  return { home, userHome, host, providers, targets, tokens };
}

test("repeated login reads start one resident helper instead of a process per stored entry", async (t) => {
  const f = await twoLogins(t);
  const options = { home: f.home, userHome: f.userHome, platform: "win32" as const, env: {}, run: f.host.run };
  // Five status checks arrive together about once a minute; each reads both logins.
  const before = new ProviderCredentialSync(options);
  for (let check = 0; check < 5; check++) assert.deepEqual(await f.tokens(before), ["synthetic-access-0", "synthetic-access-1"]);
  assert.equal(f.host.oneShots.length, 20);
  assert.equal(f.host.helpers.length, 0);

  f.host.oneShots.length = 0;
  const reader = new WindowsCredentialReader({ spawn: f.host.spawn });
  t.after(() => reader.dispose());
  const after = new ProviderCredentialSync({ ...options, reader });
  for (let check = 0; check < 5; check++) assert.deepEqual(await f.tokens(after), ["synthetic-access-0", "synthetic-access-1"]);
  assert.equal(f.host.oneShots.length, 0);
  assert.equal(f.host.helpers.length, 1);
  assert.equal(f.host.helpers[0].requests.length, 20);
  // A second store, as the separately bundled relay has, shares the process too.
  assert.deepEqual(await f.tokens(new ProviderCredentialSync({ ...options, reader })), ["synthetic-access-0", "synthetic-access-1"]);
  assert.equal(f.host.helpers.length, 1);
});

test("a login the CLI renewed between two reads is what the next read returns", async (t) => {
  const f = await twoLogins(t);
  const reader = new WindowsCredentialReader({ spawn: f.host.spawn });
  t.after(() => reader.dispose());
  const sync = new ProviderCredentialSync({ home: f.home, userHome: f.userHome, platform: "win32", env: {}, run: f.host.run, reader });
  assert.deepEqual(await f.tokens(sync), ["synthetic-access-0", "synthetic-access-1"]);
  // The CLI writes the store directly; nothing tells this process that it happened.
  f.host.entries.set(f.targets[0], oauth("synthetic-renewed-by-cli", 2_100_000_000_000));
  assert.deepEqual(await f.tokens(sync), ["synthetic-access-1", "synthetic-renewed-by-cli"]);
  f.host.entries.delete(f.targets[1]);
  assert.deepEqual(await f.tokens(sync), ["synthetic-renewed-by-cli"]);
  assert.equal(f.host.helpers.length, 1);
  assert.equal(f.host.oneShots.length, 0);
});

test("writes and deletes still run as their own process and the next read sees them at once", async (t) => {
  const host = syntheticCredentialHost();
  const reader = new WindowsCredentialReader({ spawn: host.spawn });
  t.after(() => reader.dispose());
  const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
  await store.write("Synthetic-Service", NAME, "synthetic-first");
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-first");
  await store.write("Synthetic-Service", NAME, "synthetic-second");
  assert.deepEqual(await store.read("Synthetic-Service", NAME), { value: "synthetic-second", updatedAt: 1_700_000_000_000, persistence: 3 });
  await store.normalizePersistence("Synthetic-Service", NAME, "synthetic-third");
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-third");
  await store.remove("Synthetic-Service", NAME);
  assert.equal(await store.read("Synthetic-Service", NAME), null);
  assert.deepEqual(host.oneShots.map((call) => call.operation), ["write", "write", "normalize", "delete"]);
  assert.equal(host.helpers.length, 1);
  assert.ok(host.helpers[0].requests.every((request) => request.operation === "read"));
});

test("the helper script cannot change a login and leaves standard input to its own loop", () => {
  assert.equal(/CredWriteW|CredDeleteW|WriteNative|DeleteNative/.test(WINDOWS_CREDENTIAL_READER_SCRIPT), false);
  // Windows PowerShell consumes standard input itself as soon as a script mentions this variable.
  assert.equal(WINDOWS_CREDENTIAL_READER_SCRIPT.toLowerCase().includes("$input"), false);
  // The native read is the one-shot helper's own text, so both always agree on what an entry holds.
  const native = WINDOWS_CREDENTIAL_READER_SCRIPT.split("\n").filter((line) => /^ (\[StructLayout|\[DllImport|public static object Read)/.test(line));
  assert.equal(native.length, 4);
  for (const line of native) assert.ok(WINDOWS_CREDENTIAL_SCRIPT.includes(line));
});

test("a helper that cannot run leaves every read to the one-shot process and is not restarted per read", async () => {
  const host = syntheticCredentialHost();
  host.entries.set("Synthetic-Service/" + NAME, "synthetic-value");
  let now = 1_000_000, starts = 0;
  const reader = new WindowsCredentialReader({
    now: () => now,
    spawn: () => {
      starts++;
      if (starts === 2) throw new Error("synthetic spawn failure");
      const helper = host.spawn();
      // The first one dies while starting, the way a blocked or missing PowerShell does.
      if (starts === 1) setImmediate(() => helper.emit("error"));
      return helper;
    },
  });
  const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
  for (let read = 0; read < 3; read++) assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal(starts, 1);
  assert.equal(host.oneShots.length, 3);
  now += 5 * 60_000;
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal(starts, 2);
  assert.equal(host.oneShots.length, 5);
  now += 5 * 60_000;
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal(starts, 3);
  assert.equal(host.oneShots.length, 5);
  reader.dispose();
});

test("a helper that stops answering is ended and its pending reads are decided by the one-shot process", async () => {
  const host = syntheticCredentialHost(() => null);
  host.entries.set("Synthetic-Service/" + NAME, "synthetic-value");
  const reader = new WindowsCredentialReader({ spawn: host.spawn, requestTimeoutMs: 20 });
  const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
  const [present, missing] = await Promise.all([store.read("Synthetic-Service", NAME), store.read("Synthetic-Service", NAME + "#m")]);
  assert.equal(present?.value, "synthetic-value");
  assert.equal(missing, null);
  assert.equal(host.helpers.length, 1);
  assert.equal(host.helpers[0].killed, true);
  assert.equal(host.oneShots.length, 2);
});

for (const [label, respond, survives] of [
  ["text that is not an answer", () => "Provider credential store failed.\n", false],
  ["an answer to a read nobody is waiting for", ({ id }: { id: number }) => JSON.stringify({ id: id + 100, ok: true, result: null }) + "\n", false],
  ["a failed read", ({ id }: { id: number }) => JSON.stringify({ id, ok: false }) + "\n", true],
  ["a success without a result", ({ id }: { id: number }) => JSON.stringify({ id, ok: true }) + "\n", true],
  ["a result that is not an entry", ({ id }: { id: number }) => JSON.stringify({ id, ok: true, result: "null" }) + "\n", true],
] as const) {
  test(`${label} from the helper never passes for a missing or present login`, async () => {
    const host = syntheticCredentialHost(respond);
    host.entries.set("Synthetic-Service/" + NAME, "synthetic-value");
    const reader = new WindowsCredentialReader({ spawn: host.spawn });
    const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
    assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
    assert.deepEqual(host.oneShots, [{ operation: "read", target: "Synthetic-Service/" + NAME }]);
    assert.equal(host.helpers[0].killed, !survives);
    reader.dispose();
  });
}

test("answers arriving together, out of order or in pieces reach the read that asked", async () => {
  const held: string[] = [];
  const host = syntheticCredentialHost((request, entries) => {
    held.push(helperReply(request, entries)!);
    return null;
  });
  for (let index = 0; index < 3; index++) host.entries.set(`Synthetic-Service-${index}/${NAME}`, "synthetic-value-" + index);
  const reader = new WindowsCredentialReader({ spawn: host.spawn });
  const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
  const reads = Promise.all([0, 1, 2, 3].map((index) => store.read("Synthetic-Service-" + index, NAME)));
  await settle();
  const output = [held[2], held[0], held[3], held[1]].join("").replace(/\n/g, "\r\n");
  for (let offset = 0; offset < output.length; offset += 7) host.helpers[0].stdout.emit("data", Buffer.from(output.slice(offset, offset + 7)));
  assert.deepEqual((await reads).map((entry) => entry?.value ?? null), ["synthetic-value-0", "synthetic-value-1", "synthetic-value-2", null]);
  assert.equal(host.oneShots.length, 0);
  reader.dispose();
});

test("an idle helper exits and the next read starts another one right away", async () => {
  const host = syntheticCredentialHost();
  host.entries.set("Synthetic-Service/" + NAME, "synthetic-value");
  const reader = new WindowsCredentialReader({ spawn: host.spawn, idleMs: 15 });
  const store = new WindowsProviderSecureStore(host.run, "C:\\Windows", reader);
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal(host.helpers[0].killed, false);
  await settle(80);
  assert.equal(host.helpers[0].killed, true);
  assert.equal((await store.read("Synthetic-Service", NAME))?.value, "synthetic-value");
  assert.equal(host.helpers.length, 2);
  assert.equal(host.oneShots.length, 0);
  reader.dispose();
});

test("the separately bundled backup and relay code reach the same helper", () => {
  const root = "C:\\Synthetic-Reader-Root";
  const shared = sharedWindowsCredentialReader(root);
  assert.equal(sharedWindowsCredentialReader(root), shared);
  const registry = (globalThis as Record<symbol, unknown>)[Symbol.for("paseo.settings-sync.windows-credential-reader.v1")] as Map<string, unknown>;
  assert.equal(registry.get(root), shared);
  assert.notEqual(sharedWindowsCredentialReader(root + "-other"), shared);
});

test("the helper script keeps answering over one Windows PowerShell process", { skip: process.platform !== "win32" }, async () => {
  // The native call is replaced before the script starts, so this never reaches the Credential Manager.
  const anchor = "public static object Read(string target) { ";
  assert.ok(WINDOWS_CREDENTIAL_READER_SCRIPT.includes(anchor));
  const synthetic = anchor + 'if(target.EndsWith("/absent"))return null; if(target.EndsWith("/broken"))throw new Exception(); if(target!=null)return new {value=Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(target)),updatedAt=(double)1700000000000.5,persistence=(UInt32)3}; ';
  let starts = 0;
  const reader = new WindowsCredentialReader({
    spawn: (executable, args) => {
      starts++;
      const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le").replace(anchor, synthetic);
      return spawn(executable, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: "pipe" });
    },
  });
  try {
    const targets = Array.from({ length: 12 }, (_, index) => `Synthetic 서비스-${index}/${NAME}#${index}`);
    const answers = await Promise.all(targets.map((target) => reader.read(target)));
    assert.deepEqual(answers.map((raw) => Buffer.from(JSON.parse(raw).value, "base64").toString("utf8")), targets);
    assert.deepEqual(JSON.parse(answers[0]), { value: Buffer.from(targets[0]).toString("base64"), updatedAt: 1700000000000.5, persistence: 3 });
    assert.equal(await reader.read("Synthetic-Service/absent"), "null");
    await assert.rejects(reader.read("Synthetic-Service/broken"));
    await assert.rejects(reader.read(""));
    assert.equal(await reader.read("Synthetic-Service/absent"), "null");
    assert.equal(starts, 1);
  } finally { reader.dispose(); }
});
