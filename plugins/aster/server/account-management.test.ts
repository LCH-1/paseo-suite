import assert from "node:assert/strict";
import test from "node:test";
import { utimes,
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerAccountManagement } from "./account-management";
import { accountsRpc } from "../shared/accounts-rpc";

test("두 공식 로그인 흐름은 기존 계정·대화 폴더를 유지하며 내부 계정을 자동 등록", async () => {
  const root = await mkdtemp(join(tmpdir(), "aster-registration-"));
  const handlers = new Map<string, any>(),
    terminals: any[] = [];
  const config: any = {
    providers: {
      claude: { command: ["official-claude"] },
      codex: { command: ["official-codex"] },
    },
  };
  const paseo: any = {
    config: {
      get: async () => ({ config }),
      patch: async (patch: any) => {
        for (const [id, provider] of Object.entries(patch.providers ?? {}))
          config.providers[id] = {
            ...config.providers[id],
            ...(provider as any),
          };
      },
    },
    workspaces: {
      ref: () => ({
        refresh: async () => ({ id: "workspace", workspaceDirectory: root }),
      }),
      list: async () => ({
        entries: [
          { id: "workspace", name: "Fixture", workspaceDirectory: root },
        ],
      }),
    },
    terminals: {
      create: async (input: any) => {
        terminals.push(input);
        return { id: `terminal-${terminals.length}` };
      },
    },
  };
  await mkdir(join(root, "plugin", "server"), { recursive: true });
  await writeFile(
    join(root, "plugin", "server", "account-login.mjs"),
    "// fixture",
  );
  await mkdir(join(root, "paseo-accounts"));
  await writeFile(
    join(root, "paseo-accounts", "accounts.json"),
    JSON.stringify({
      version: 1,
      extra: "preserved",
      accounts: [
        { id: "old", base: "claude", identity: "other", signedIn: true },
      ],
    }),
  );
  const dispose = registerAccountManagement(
    {
      handle: (contract: any, handler: any) =>
        handlers.set(contract.name, handler),
    } as any,
    async () => [],
    {
      home: root,
      userHome: root,
      pluginPath: async () => join(root, "plugin"),
    },
  );
  const call = (contract: any, input = {}) =>
    handlers.get(contract.name)(input, { paseo });
  try {
    for (const base of ["claude", "codex"] as const) {
      const flow = await call(accountsRpc.add, {
        base,
      });
      const launcher = JSON.parse(terminals.at(-1).args[1]);
      assert.equal(launcher.command[0], `official-${base}`);
      if (base === "claude") {
        await writeFile(
          join(launcher.home, ".claude.json"),
          JSON.stringify({
            oauthAccount: {
              emailAddress: "fixture@example.invalid",
              accountUuid: "account",
              organizationUuid: "organization",
            },
          }),
        );
        assert.equal(
          await realpath(join(launcher.home, "projects")),
          await realpath(join(root, ".claude", "projects")),
        );
      } else
        await writeFile(
          join(launcher.home, "auth.json"),
          JSON.stringify({
            tokens: {
              access_token: "synthetic-token",
              account_id: "account-id",
            },
          }),
        );
      await writeFile(launcher.done, '{"success":true}');
      const state = await call(accountsRpc.status);
      assert.match(
        state.flows.find((entry: any) => entry.id === flow.id).status,
        /등록 완료/,
      );
    }
    const registry = JSON.parse(
      await readFile(join(root, "paseo-accounts", "accounts.json"), "utf8"),
    );
    assert.equal(registry.extra, "preserved");
    assert.equal(registry.accounts.length, 3);
    assert.equal(
      registry.accounts.find((entry: any) => entry.id === "old").identity,
      "other",
    );
    const added = Object.entries(config.providers).filter(
      ([id]) => !["claude", "codex"].includes(id),
    );
    assert.equal(added.length, 2);
    assert.ok(
      added.every(
        ([, provider]: any) =>
          provider.enabled && provider.selectable === false && provider.label,
      ),
    );
    assert.deepEqual(config.providers.codex.command, ["official-codex"]);
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true });
  }
});

async function reloginFixture() {
  const killed: string[] = [];
  const root = await realpath(await mkdtemp(join(tmpdir(), "aster-relogin-")));
  const handlers = new Map<string, any>(),
    terminals: any[] = [],
    refreshed: string[] = [];
  const profile = join(root, "profile");
  await mkdir(profile);
  await mkdir(join(root, "plugin", "server"), { recursive: true });
  await writeFile(
    join(root, "plugin", "server", "account-login.mjs"),
    "// fixture",
  );
  await mkdir(join(root, "paseo-accounts"));
  const registry = {
    version: 2,
    accounts: [
      {
        id: "claude",
        base: "claude",
        home: join(root, ".claude"),
        email: "main@example.invalid",
      },
      {
        id: "profile",
        base: "claude",
        home: profile,
        email: "Second@example.invalid",
      },
      { id: "codex", base: "codex", home: join(root, ".codex"), email: null },
    ],
  };
  await writeFile(
    join(root, "paseo-accounts", "accounts.json"),
    JSON.stringify(registry),
  );
  const paseo: any = {
    config: {
      get: async () => ({
        config: { providers: { claude: { command: ["official-claude"] } } },
      }),
    },
    workspaces: {
      ref: () => ({
        refresh: async () => ({ id: "workspace", workspaceDirectory: root }),
      }),
      list: async () => ({
        entries: [
          { id: "workspace", name: "Fixture", workspaceDirectory: root },
        ],
      }),
    },
    terminals: {
      create: async (input: any) => {
        terminals.push(input);
        return { id: `terminal-${terminals.length}` };
      },
      ref: (id: string) => ({ kill: async () => void killed.push(id) }),
    },
  };
  const dispose = registerAccountManagement(
    {
      handle: (contract: any, handler: any) =>
        handlers.set(contract.name, handler),
    } as any,
    async () => [
      {
        id: "profile",
        base: "claude" as const,
        label: "second",
        status: "확인 필요",
        loginLost: true,
      },
      {
        id: "claude",
        base: "claude" as const,
        label: "main",
        status: "구독 종료",
        loginLost: false,
      },
      {
        id: "0-unavailable",
        base: "claude" as const,
        label: "보류",
        status: "보류",
      },
      { id: "codex", base: "codex" as const, label: "codex", status: "제외" },
    ],
    {
      home: root,
      userHome: root,
      pluginPath: async () => join(root, "plugin"),
      onRelogin: () => refreshed.push("usage"),
    },
  );
  const call = (contract: any, input = {}) =>
    handlers.get(contract.name)(input, { paseo });
  return {
    root,
    paseo,
    profile,
    terminals,
    killed,
    refreshed,
    registry,
    call,
    dispose,
  };
}

test("다시 로그인은 기존 인증 폴더를 그대로 쓰고 계정을 새로 등록하지 않는다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, {
      accountId: "profile",
    });
    const launcher = JSON.parse(f.terminals[0].args[1]);
    assert.equal(launcher.home, f.profile);
    assert.equal(launcher.secureDirectory, f.profile);
    assert.equal(launcher.email, "Second@example.invalid");
    await writeFile(
      join(f.profile, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "second@example.invalid" },
      }),
    );
    await writeFile(launcher.done, '{"success":true}');
    const state = await f.call(accountsRpc.status);
    assert.match(state.flows[0].status, /재로그인 완료/);
    assert.match(state.flows[0].label, /재로그인/);
    assert.deepEqual(f.refreshed, ["usage"]);
    assert.deepEqual(
      JSON.parse(
        await readFile(join(f.root, "paseo-accounts", "accounts.json"), "utf8"),
      ),
      f.registry,
    );
    assert.deepEqual(
      state.accounts.map((account: any) => account.canRelogin),
      [true, false, false, false],
    );
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("메인 계정 다시 로그인은 세션과 같은 기본 자격 증명 위치를 쓴다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, {
      accountId: "claude",
    });
    assert.equal(JSON.parse(f.terminals[0].args[1]).secureDirectory, "");
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("다른 계정으로 로그인하면 완료로 처리하지 않고 알린다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, {
      accountId: "profile",
    });
    const launcher = JSON.parse(f.terminals[0].args[1]);
    await writeFile(
      join(f.profile, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "other@example.invalid" },
      }),
    );
    await writeFile(launcher.done, '{"success":true}');
    const state = await f.call(accountsRpc.status);
    assert.match(
      state.flows[0].status,
      /other@example\.invalid.*다시 로그인하세요/,
    );
    assert.deepEqual(f.refreshed, []);
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("등록되지 않은 계정이나 Codex 계정은 다시 로그인을 거부한다", async () => {
  const f = await reloginFixture();
  try {
    for (const accountId of ["missing", "codex"])
      await assert.rejects(
        f.call(accountsRpc.relogin, { accountId }),
        /찾지 못했습니다/,
      );
    assert.equal(f.terminals.length, 0);
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("로그인 실행기는 지정된 자격 증명 위치와 이메일로 공식 CLI를 호출한다", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "aster-login-run-")),
  );
  try {
    const fake = join(root, "fake-cli.mjs"),
      captured = join(root, "captured.json");
    await writeFile(
      fake,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ args: process.argv.slice(2), config: process.env.CLAUDE_CONFIG_DIR, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, force: process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN, token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }));`,
    );
    const done = join(root, "done.json");
    await promisify(execFile)(
      process.execPath,
      [
        join(import.meta.dirname, "account-login.mjs"),
        JSON.stringify({
          base: "claude",
          home: "profile-home",
          secureDirectory: "",
          email: "second@example.invalid",
          command: [process.execPath, fake],
          done,
        }),
      ],
      { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "synthetic" } },
    );
    const seen = JSON.parse(await readFile(captured, "utf8"));
    assert.deepEqual(seen.args, [
      "auth",
      "login",
      "--email",
      "second@example.invalid",
    ]);
    assert.equal(seen.config, "profile-home");
    assert.equal(seen.secure ?? "", "");
    assert.equal(seen.token, null);
    if (process.platform === "win32") assert.equal(seen.force, "1");
    assert.deepEqual(JSON.parse(await readFile(done, "utf8")), {
      success: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("열린 워크스페이스가 없으면 로그인 터미널을 만들지 않고 알린다", async () => {
  const f = await reloginFixture();
  try {
    f.paseo.workspaces.list = async () => ({ entries: [] });
    await assert.rejects(
      f.call(accountsRpc.relogin, { accountId: "profile" }),
      /워크스페이스가 없습니다/,
    );
    assert.equal(f.terminals.length, 0);
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

async function finishedRelogin(
  f: Awaited<ReturnType<typeof reloginFixture>>,
  email: string,
) {
  await f.call(accountsRpc.relogin, { accountId: "profile" });
  const done: string = JSON.parse(f.terminals.at(-1).args[1]).done;
  await writeFile(
    join(f.profile, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: email } }),
  );
  await writeFile(done, '{"success":true}');
  return { done, file: done.replace(/\.done$/, ".json") };
}

test("끝나지 않은 로그인은 한 시간 뒤 대기 목록에서 내려온다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    const done: string = JSON.parse(f.terminals.at(-1).args[1]).done;
    const file = done.replace(/\.done$/, ".json");
    assert.match((await f.call(accountsRpc.status)).flows[0].status, /공식 CLI 로그인/);
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(file, past, past);
    assert.match((await f.call(accountsRpc.status)).flows[0].status, /완료되지 않았습니다/);
  } finally {
    await f.cleanup?.();
  }
});

test("완료 안내는 잠시 보인 뒤 파일과 함께 사라진다", async () => {
  const f = await reloginFixture();
  try {
    const { done, file } = await finishedRelogin(f, "second@example.invalid");
    const shown = await f.call(accountsRpc.status);
    assert.match(shown.flows[0].status, /재로그인 완료/);
    assert.match(
      (await f.call(accountsRpc.status)).flows[0].status,
      /재로그인 완료/,
    );
    const flow = JSON.parse(await readFile(file, "utf8"));
    assert.ok(flow.expiresAt - Date.now() <= 60_000);
    await writeFile(
      file,
      JSON.stringify({ ...flow, expiresAt: Date.now() - 1 }),
    );
    assert.deepEqual((await f.call(accountsRpc.status)).flows, []);
    await assert.rejects(readFile(file), { code: "ENOENT" });
    await assert.rejects(readFile(done), { code: "ENOENT" });
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("이전 버전이 남긴 완료 안내는 바로 지운다", async () => {
  const f = await reloginFixture();
  try {
    const { file } = await finishedRelogin(f, "second@example.invalid");
    await f.call(accountsRpc.status);
    const { expiresAt: _, ...legacy } = JSON.parse(
      await readFile(file, "utf8"),
    );
    await writeFile(file, JSON.stringify(legacy));
    assert.deepEqual((await f.call(accountsRpc.status)).flows, []);
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("조치가 필요한 안내는 성공 안내보다 오래 남고 진행 중인 로그인은 지우지 않는다", async () => {
  const f = await reloginFixture();
  try {
    const { file } = await finishedRelogin(f, "other@example.invalid");
    await f.call(accountsRpc.status);
    const flow = JSON.parse(await readFile(file, "utf8"));
    assert.ok(flow.expiresAt - Date.now() > 30 * 60_000);
    await rm(file);

    await f.call(accountsRpc.relogin, { accountId: "profile" });
    const state = await f.call(accountsRpc.status);
    assert.match(
      state.flows[0].status,
      /터미널에서 공식 CLI 로그인을 완료하세요/,
    );
  } finally {
    f.dispose();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Windows의 .cmd CLI도 실행하고 시작 실패는 완료 기록으로 남긴다", { skip: process.platform !== "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aster-login-cmd-")));
  try {
    const script = join(root, "fake cli.cmd"), captured = join(root, "captured.txt"), done = join(root, "done.json");
    await writeFile(script, `@echo off\r\necho %* > "${captured}"\r\n`);
    const launcher = join(import.meta.dirname, "account-login.mjs");
    await promisify(execFile)(process.execPath, [launcher, JSON.stringify({ base: "claude", home: "profile-home", email: "second@example.invalid", command: [script], done })]);
    assert.match(await readFile(captured, "utf8"), /auth.*login.*--email.*second@example\.invalid/);
    assert.deepEqual(JSON.parse(await readFile(done, "utf8")), { success: true });
    const missing = join(root, "missing.json");
    await promisify(execFile)(process.execPath, [launcher, JSON.stringify({ base: "claude", home: "profile-home", command: [join(root, "absent.exe")], done: missing })]).catch(() => {});
    assert.deepEqual(JSON.parse(await readFile(missing, "utf8")), { success: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("같은 계정의 로그인을 다시 시작하면 대기 항목이 쌓이지 않고 터미널을 돌려준다", async () => {
  const f = await reloginFixture();
  try {
    const first = await f.call(accountsRpc.relogin, { accountId: "profile" });
    const second = await f.call(accountsRpc.relogin, { accountId: "profile" });
    assert.ok(second.terminalId);
    assert.notEqual(first.id, second.id);
    assert.equal((await f.call(accountsRpc.status)).flows.length, 1);
  } finally {
    await f.cleanup?.();
  }
});

test("계정 정보 없이 끝난 로그인은 실패로 표시되고 화면 전체를 깨지 않는다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.add, { base: "claude" });
    const launcher = JSON.parse(f.terminals.at(-1).args[1]);
    await writeFile(launcher.done, '{"success":true}');
    const state = await f.call(accountsRpc.status);
    assert.ok(state.accounts.length > 0);
    assert.match(state.flows.at(-1).status, /확인하지 못했습니다/);
  } finally {
    await f.cleanup?.();
  }
});

test("다시 누르면 이전 로그인 터미널을 닫는다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    assert.deepEqual(f.killed, ["terminal-1"]);
  } finally {
    await f.cleanup?.();
  }
});

test("한 시간이 지나 내려간 로그인은 터미널도 닫아 늦은 성공이 유실되지 않게 한다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    const done: string = JSON.parse(f.terminals.at(-1).args[1]).done;
    const past = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(done.replace(/\.done$/, ".json"), past, past);
    await f.call(accountsRpc.status);
    assert.deepEqual(f.killed, ["terminal-1"]);
  } finally {
    await f.cleanup?.();
  }
});

test("일시적 오류는 성공한 로그인을 버리지 않고 다음 확인에서 등록한다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.add, { base: "claude" });
    const launcher = JSON.parse(f.terminals.at(-1).args[1]);
    await writeFile(
      join(launcher.home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "new@example.invalid", accountUuid: "a", organizationUuid: "o" } }),
    );
    await writeFile(launcher.done, '{"success":true}');
    (f.paseo.config as any).patch = async () => {
      throw new Error("socket dropped");
    };
    assert.match((await f.call(accountsRpc.status)).flows.at(-1).status, /공식 CLI 로그인/);
    (f.paseo.config as any).patch = async () => ({});
    assert.match((await f.call(accountsRpc.status)).flows.at(-1).status, /등록 완료/);
  } finally {
    await f.cleanup?.();
  }
});

test("손상된 로그인 파일이 있어도 상태 화면이 열린다", async () => {
  const f = await reloginFixture();
  try {
    const flow = await f.call(accountsRpc.relogin, { accountId: "profile" });
    const done: string = JSON.parse(f.terminals.at(-1).args[1]).done;
    await writeFile(done.replace(flow.id + ".done", "00000000-0000-0000-0000-000000000000.json"), "{broken");
    assert.equal((await f.call(accountsRpc.status)).flows.length, 1);
  } finally {
    await f.cleanup?.();
  }
});

test("새 터미널을 열 수 없으면 기존 로그인 터미널을 닫지 않는다", async () => {
  const f = await reloginFixture();
  try {
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    await assert.rejects(f.call(accountsRpc.relogin, { accountId: "missing-account" }));
    assert.deepEqual(f.killed, []);
    assert.equal((await f.call(accountsRpc.status)).flows.length, 1);
  } finally {
    await f.cleanup?.();
  }
});

test("방금 끝난 로그인은 다시 눌러도 유실되지 않는다", async () => {
  const f = await reloginFixture();
  try {
    const { done } = await finishedRelogin(f, "second@example.invalid").catch(() => ({ done: "" }));
    assert.ok(done);
    await f.call(accountsRpc.relogin, { accountId: "profile" });
    assert.ok(f.refreshed.includes("usage"));
  } finally {
    await f.cleanup?.();
  }
});
