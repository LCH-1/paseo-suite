import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCredentialService, ProviderCredentialSync, providerProfileDirectory, WindowsProviderSecureStore } from "../server/provider-credentials";
import { ClaudeSecureJournal } from "../server/claude-secure-journal";
import { CrashStore, syntheticJournal } from "./fixtures/claude-crash-store";
import { createRequire } from "node:module";

const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

const oauth = (token: string, expiresAt: number) => ({ claudeAiOauth: { accessToken: token, refreshToken: "synthetic-refresh", expiresAt, scopes: ["user:inference"] } });
const worker = fileURLToPath(new URL("./fixtures/claude-crash-worker.ts", import.meta.url).href);
async function fixture(t: test.TestContext, oldSize: number, nextSize: number, native = false) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-auth-crash-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "paseo"), userHome = path.join(root, "user"), source = path.join(root, "source");
  await Promise.all([home, userHome, source].map(directory => mkdir(directory)));
  const previous = oauth("A".repeat(oldSize), 2_000_000_000_000), next = oauth("B".repeat(nextSize), 2_100_000_000_000);
  await writeFile(path.join(source, ".credentials.json"), JSON.stringify(previous));
  await writeFile(path.join(source, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "synthetic-account" } }));
  const makeJournal = () => native ? new ClaudeSecureJournal(path.join(root, "journal")) : syntheticJournal(root);
  const options = { home, userHome, platform: "win32" as const, env: {}, secure: native ? new WindowsProviderSecureStore() : new CrashStore(path.join(root, "secure")), journal: makeJournal() };
  const sync = new ProviderCredentialSync(options);
  const original = (await sync.capture({ claude: { env: { CLAUDE_CONFIG_DIR: source, CLAUDE_SECURESTORAGE_CONFIG_DIR: source } } })).credentials;
  if (native) {
    const syntheticService = claudeCredentialService(providerProfileDirectory(home, original.records[0].id), false);
    t.after(async () => {
      const clean = new WindowsProviderSecureStore();
      for (const name of ["claude-code-user", "claude-code-user#m", "claude-code-user#p", ...Array.from({ length: 5 }, (_, index) => "claude-code-user#" + index)]) await clean.remove(syntheticService, name);
    });
  }
  const initialized = await sync.restore({ claude: {} }, original); await initialized.commit();
  const incoming = structuredClone(original); incoming.records[0].credential = next;
  incoming.records[0].expiresAt = incoming.records[0].updatedAt = next.claudeAiOauth.expiresAt;
  const input = { home, userHome, providers: initialized.providers, incoming, native };
  await writeFile(path.join(root, "input.json"), JSON.stringify(input));
  const crash = (boundary: number, action = "restore") => new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [TSX_CLI, worker, root, String(boundary), action], { windowsHide: true, timeout: native ? 90_000 : 30_000, maxBuffer: 1_000_000 }, error => {
      if ((error as { code?: string | number } | null)?.code === 23) resolve();
      else reject(new Error("Expected fixture-only abrupt process exit 23", { cause: error }));
    });
  });
  const directory = (initialized.providers.claude as { env: Record<string, string> }).env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const service = claudeCredentialService(directory, false);
  const replace = async (value: unknown) => {
    const store = options.secure, name = "claude-code-user", raw = JSON.stringify(value), encoded = Buffer.from(raw).toString("base64");
    for (const key of [name, name + "#m", name + "#p", ...Array.from({ length: 5 }, (_, index) => name + "#" + index)]) await store.remove(service, key);
    if (Buffer.byteLength(raw) <= 2400) await store.write(service, name, raw);
    else {
      const count = Math.ceil(encoded.length / 2400);
      for (let index = 0; index < count; index++) await store.write(service, name + "#" + index, encoded.slice(index * 2400, (index + 1) * 2400));
      await store.write(service, name + "#m", JSON.stringify({ n: count, l: encoded.length }));
    }
  };
  const journal = async () => { const directory = path.join(root, "journal"), files = await readdir(directory); const file = path.join(directory, files[0]); return { file, envelope: JSON.parse(await readFile(file, "utf8")) }; };
  return { root, next, previous, input, options, directory, service, replace, journal, crash, capture: () => new ProviderCredentialSync({ ...options, journal: makeJournal() }).capture(initialized.providers) };
}

for (const [label, oldSize, nextSize] of [["growth", 4000, 6000], ["shrink", 6000, 4000], ["single to split", 50, 6000], ["split to single", 6000, 50], ["single replacement", 50, 60]] as const) {
  const chunks = (size: number, token: string, expiry: number) => { const raw = JSON.stringify(oauth(token.repeat(size), expiry)); return Buffer.byteLength(raw) > 2400 ? Math.ceil(Buffer.from(raw).toString("base64").length / 2400) : 0; };
  const oldCount = chunks(oldSize, "A", 2_000_000_000_000), nextCount = chunks(nextSize, "B", 2_100_000_000_000);
  const mutations = nextCount ? 4 + Math.max(oldCount, nextCount) : oldCount ? oldCount + 4 : 3;
  for (let boundary = 1; boundary <= mutations; boundary++) test(`${label}: recovers a complete generation after process death at mutation ${boundary}/${mutations}`, async t => {
    const f = await fixture(t, oldSize, nextSize);
    await f.crash(boundary);
    // No manual lock removal: the journal must verify and reap its dead writer's leases.
    const result = await f.capture();
    assert.deepEqual(result.credentials.records[0].credential, f.next);
    assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
    assert.equal(JSON.stringify(result).includes("A".repeat(50)), false);
  });
}

test("a second process death during recovery also resumes a complete generation", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2); await f.crash(2, "capture");
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
});

test("journal files contain encrypted generations and no token text", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const files = await readdir(path.join(f.root, "journal")); assert.equal(files.length, 1);
  const encrypted = await readFile(path.join(f.root, "journal", files[0]), "utf8");
  assert.equal(encrypted.includes("synthetic-refresh"), false); assert.equal(encrypted.includes("BBBBBBBB"), false);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
});

test("an independently advanced complete login supersedes an interrupted restore", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const renewed = oauth("C".repeat(6100), 2_200_000_000_000); await f.replace(renewed);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, renewed);
  assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
});

test("an explicit cleared OAuth entry supersedes the journal instead of reviving a login", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2); await f.replace({});
  assert.equal((await f.capture()).credentials.records.length, 0);
  assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
  assert.equal((await f.options.secure.read(f.service, "claude-code-user"))?.value, "{}");
});

test("a changed account identity preserves the new account and retires the old journal", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const other = oauth("D".repeat(6100), 2_200_000_000_000); await f.replace(other);
  await writeFile(path.join(f.directory, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "different-synthetic-account" }, cachedGrowthBookFeatures: { tengu_windows_credman: true } }));
  assert.deepEqual((await f.capture()).credentials.records[0].credential, other);
  assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
});

test("unknown malformed external fragments are retained and never replaced by journal data", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  await f.options.secure.write(f.service, "claude-code-user#0", "external-unknown");
  await assert.rejects(f.capture);
  assert.equal((await f.options.secure.read(f.service, "claude-code-user#0"))?.value, "external-unknown");
  assert.equal((await readdir(path.join(f.root, "journal"))).length, 1);
});

test("an outliving actual writer blocks reaping until its process is gone", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const { file, envelope } = await f.journal(), marker = file + ".writer-" + envelope.nonce + ".json";
  await writeFile(marker, JSON.stringify({ pid: process.pid, start: String(process.pid), nonce: envelope.nonce }));
  await assert.rejects(f.capture, /잠금/);
  assert.ok((await readdir(f.directory)).includes(".storage-write.lock"));
  await rm(marker);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
});

test("PID reuse with a different start identity does not block recovery", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const { file, envelope } = await f.journal();
  await writeFile(file + ".writer-" + envelope.nonce + ".json", JSON.stringify({ pid: process.pid, start: "different-start", nonce: envelope.nonce }));
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
});

test("recovery never deletes a lock replaced by another writer", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const lock = path.join(f.directory, ".storage-write.lock"); await rm(lock, { recursive: true }); await mkdir(lock);
  await assert.rejects(f.capture, /잠금/);
  assert.ok((await readdir(f.directory)).includes(".oauth_refresh.lock"));
  assert.ok((await readdir(f.directory)).includes(".storage-write.lock"));
});

test("normal write failures roll back a complete generation through the same journal", async t => {
  const f = await fixture(t, 4000, 6000), write = f.options.secure.write.bind(f.options.secure);
  let failed = false;
  f.options.secure.write = async (service, name, value) => {
    if (!failed && name === "claude-code-user#1") { failed = true; throw new Error("Synthetic storage failure"); }
    await write(service, name, value);
  };
  await assert.rejects(() => new ProviderCredentialSync(f.options).restore(f.input.providers, f.input.incoming, f.input.providers), /Synthetic storage failure/);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.previous);
  assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
});

test("simultaneous recovery attempts preserve one complete generation and never steal the winner's locks", async t => {
  const f = await fixture(t, 4000, 6000); await f.crash(2);
  const results = await Promise.allSettled([f.capture(), f.capture(), f.capture()]);
  const successes = results.filter(result => result.status === "fulfilled"); assert.ok(successes.length > 0);
  for (const result of successes) assert.deepEqual(result.value.credentials.records[0].credential, f.next);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
});

test("actual Windows Credential Manager and DPAPI recover after a real process exits between split writes", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, 4000, 6000, true); await f.crash(2);
  assert.deepEqual((await f.capture()).credentials.records[0].credential, f.next);
  assert.deepEqual(await readdir(path.join(f.root, "journal")), []);
});
