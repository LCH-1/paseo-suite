import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialSharing, registerCredentialSharing, renewalEnvironment, renewalProviders, renewWithCli } from "./credential-sharing";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CredentialState, SharedCredential } from "./credential-types";
const now = 1700000000000;
function record(): SharedCredential {
  return {
    id: "claude-" + "1".repeat(24),
    vendor: "claude",
    providerIds: ["claude"],
    identity: "a".repeat(64),
    expiresAt: now + 3600000,
    updatedAt: now,
    credential: {
      claudeAiOauth: {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: now + 3600000,
      },
    },
    metadata: { oauthAccount: { accountUuid: "account-1" } },
  };
}
function state(value: SharedCredential | null = record()): CredentialState {
  return {
    providers: {},
    accounts: [
      {
        identity: "a".repeat(64),
        providerIds: ["claude"],
        record: value,
        metadata: {},
        directory: "/test/profile",
      },
    ],
  };
}
test("credential envelope is private to its receiver and contains no plaintext credential", () => {
  const sender = new CredentialSharing(() => now),
    receiver = new CredentialSharing(() => now),
    other = new CredentialSharing(() => now);
  const envelope = sender.export(state(), receiver.publicKey, ["a".repeat(64)]);
  assert.ok(!JSON.stringify(envelope).includes("synthetic-access"));
  assert.ok(!JSON.stringify(envelope).includes("synthetic-refresh"));
  const delivered = receiver.open(envelope, state())[0].credential.claudeAiOauth as Record<string, unknown>;
  assert.equal(delivered.accessToken, "synthetic-access");
  assert.equal(delivered.refreshToken, undefined);
  assert.throws(() => other.open(envelope, state()));
  assert.throws(() =>
    receiver.open({ ...envelope, tag: Buffer.alloc(16).toString("base64") }, state()),
  );
});
test("expired, unknown and non-Claude credentials are not exported", () => {
  const sender = new CredentialSharing(() => now),
    receiver = new CredentialSharing(() => now),
    expired = record();
  expired.expiresAt = now;
  assert.throws(() => sender.export(state(expired), receiver.publicKey, [expired.identity]));
  assert.throws(() => sender.export(state(), receiver.publicKey, ["b".repeat(64)]));
  const foreign = { ...record(), vendor: "codex" } as unknown as SharedCredential;
  assert.throws(() => sender.export(state(foreign), receiver.publicKey, [foreign.identity]));
});
test("receiver requires existing ownership while permitting recovery of cleared tokens", () => {
  const sender = new CredentialSharing(() => now),
    receiver = new CredentialSharing(() => now),
    envelope = sender.export(state(), receiver.publicKey, [record().identity]);
  assert.equal(receiver.open(envelope, state(null)).length, 1);
  assert.throws(() => receiver.open(envelope, { providers: {}, accounts: [] }));
});
test("status exposes only account identity, expiry and a digest", () => {
  const source = new CredentialSharing(() => now),
    status = source.status(state());
  assert.equal(status.accounts.length, 1);
  assert.ok(!JSON.stringify(status).includes("synthetic"));
  assert.ok(!JSON.stringify(status).includes("account-1"));
  assert.equal(source.status(state(null)).accounts[0].revision, null);
});

test("duplicate aliases advertise one identity and export its newest credential", () => {
  const sender = new CredentialSharing(() => now),
    receiver = new CredentialSharing(() => now);
  const older = record(),
    latest = structuredClone(older);
  latest.expiresAt! += 500000;
  (latest.credential.claudeAiOauth as any).expiresAt = latest.expiresAt;
  (latest.credential.claudeAiOauth as any).accessToken = "synthetic-newest";
  const duplicated = state(older);
  duplicated.accounts.push({ ...duplicated.accounts[0], directory: "/test/alias", record: latest });
  assert.equal(sender.status(duplicated).accounts.length, 1);
  assert.equal(sender.status(duplicated).accounts[0].expiresAt, older.expiresAt);
  assert.equal(sender.status(duplicated).accounts[0].availableExpiresAt, latest.expiresAt);
  const exported = receiver.open(
    sender.export(duplicated, receiver.publicKey, [latest.identity]),
    state(),
  );
  assert.equal((exported[0].credential.claudeAiOauth as any).accessToken, "synthetic-newest");
});

test("unloading rejects queued credential RPC work before it reads another profile", async () => {
  const handlers = new Map<string, Function>(),
    home = await mkdtemp(path.join(tmpdir(), "aster-share-lifecycle-"));
  const cleanups = registerCredentialSharing(
    {
      handle(contract: any, handler: any) {
        handlers.set(contract.name, handler);
      },
    } as any,
    home,
    () => {},
  );
  let entered!: () => void,
    release!: () => void,
    reads = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context = {
    paseo: {
      config: {
        async get() {
          reads++;
          entered();
          await pending;
          return { config: { providers: {} } };
        },
      },
    },
  };
  const first = handlers.get("sync.credentials.status.request")!({}, context);
  await started;
  const queued = handlers.get("sync.credentials.export.request")!(
    { publicKey: "unused", identities: ["a".repeat(64)] },
    context,
  );
  const rejected = assert.rejects(queued, /해제/);
  cleanups.forEach((dispose) => dispose());
  release();
  await first;
  await rejected;
  assert.equal(reads, 1);
});

test("갱신은 Windows .cmd와 공백 경로를 인용해서 셸로 실행한다", async () => {
  const calls: any[] = [];
  const run: any = (file: string, args: string[], options: any, done: (error: unknown) => void) => {
    calls.push({ file, args, shell: options.shell });
    done(null);
  };
  assert.equal(await renewWithCli(["C:\\Program Files\\nodejs\\claude.cmd"], {}, run, "win32"), null);
  assert.deepEqual(calls.at(-1), { file: '"C:\\Program Files\\nodejs\\claude.cmd" "auth" "status"', args: [], shell: true });
  await renewWithCli(["claude"], {}, run, "win32");
  assert.equal(calls.at(-1).shell, true);
  await renewWithCli(["C:\\tools\\claude.exe"], {}, run, "win32");
  assert.deepEqual(calls.at(-1), { file: "C:\\tools\\claude.exe", args: ["auth", "status"], shell: false });
  await renewWithCli(["claude"], {}, run, "linux");
  assert.deepEqual(calls.at(-1), { file: "claude", args: ["auth", "status"], shell: false });
});

test("갱신 실패는 오류 코드로 알려 주고 동기 예외도 삼키지 않는다", async () => {
  const failed: any = (_f: string, _a: string[], _o: any, done: (error: unknown) => void) => done(Object.assign(new Error("x"), { code: "ENOENT" }));
  assert.equal(await renewWithCli(["claude"], {}, failed, "linux"), "ENOENT");
  const thrown: any = () => { throw Object.assign(new Error("x"), { code: "EINVAL" }); };
  assert.equal(await renewWithCli(["claude"], {}, thrown, "linux"), "EINVAL");
});

test("갱신 환경은 세션과 같은 프로필 값을 쓰고 데몬에서 물려받은 인증 값을 버린다", () => {
  const env = renewalEnvironment(
    { PATH: "p", CLAUDE_CONFIG_DIR: "/daemon", CLAUDE_CODE_OAUTH_TOKEN: "synthetic", ANTHROPIC_API_KEY: "synthetic" },
    { env: { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } },
    { env: { CLAUDE_CONFIG_DIR: "/profile" } },
  );
  assert.deepEqual(env, { PATH: "p", CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1", CLAUDE_CONFIG_DIR: "/profile" });
  assert.equal(renewalEnvironment({ CLAUDE_CONFIG_DIR: "/daemon" }, undefined, undefined).CLAUDE_CONFIG_DIR, undefined);
});

test("앱 창이 연결되기 전에도 설정 파일로 갱신 대상을 찾는다", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "renew-"));
  await writeFile(path.join(home, "config.json"), JSON.stringify({ agents: { providers: { claude: { command: ["x"] } } } }));
  assert.deepEqual(await renewalProviders(home), { claude: { command: ["x"] } });
  const api = { config: { get: async () => ({ config: { providers: { other: {} } } }) } } as any;
  assert.deepEqual(await renewalProviders(home, api), { other: {} });
});
