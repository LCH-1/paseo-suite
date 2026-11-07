import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  symlink,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { accountsRpc } from "../shared/accounts-rpc";
import {
  accountSecureDirectory,
  paseoHome as defaultPaseoHome,
} from "./accounts";
import { codexOriginalCommand } from "./codex";
import { codexTokens } from "./codex-runtime.mjs";
import { createLocalPluginConnection } from "./legacy-credential-rpc";
import {
  providerFamily,
  providerPolicy,
  type ProviderEntries,
} from "./provider-policy";

const flowSchema = z.object({
  id: z.string().uuid(),
  base: z.enum(["claude", "codex"]),
  home: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  terminalId: z.string().optional(),
  accountId: z.string().optional(),
  email: z.string().nullable().optional(),
  expiresAt: z.number().optional(),
});
// A finished login is only a notice; a failure stays longer because it needs action.
const successNoticeMs = 60_000;
const failureNoticeMs = 60 * 60_000;
// A closed terminal or a daemon restart never reports back, so a login cannot wait forever.
const pendingLimitMs = 60 * 60_000;
const registeredAccountsSchema = z.object({
  accounts: z.array(
    z
      .object({
        id: z.string(),
        base: z.string(),
        home: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
});
const providersSchema = z.record(
  z.string(),
  z
    .object({
      extends: z.string().optional(),
      enabled: z.boolean().optional(),
      selectable: z.boolean().optional(),
      command: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
);
type Flow = z.output<typeof flowSchema>;
export interface AccountStatus {
  id: string;
  base: "claude" | "codex";
  label: string;
  status: string;
  loginLost?: boolean;
}

async function json(file: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
async function writeJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, file);
}

export function registerAccountManagement(
  server: PluginServerContext,
  status: (
    providers: ProviderEntries,
    signal: AbortSignal,
  ) => Promise<AccountStatus[]>,
  options: {
    home?: string;
    userHome?: string;
    pluginPath?: () => Promise<string>;
    onRelogin?: () => void;
  } = {},
) {
  const paseoHome = options.home ?? defaultPaseoHome,
    stateDirectory = join(paseoHome, "aster"),
    userHome = options.userHome ?? homedir();
  const flowsDirectory = join(stateDirectory, "logins");
  const lifetime = new AbortController();
  let serial: Promise<unknown> = Promise.resolve(),
    api: PaseoApi | undefined;
  const serialize = <T>(work: () => Promise<T>) => {
    const task = serial.then(work);
    serial = task.catch(() => undefined);
    return task;
  };
  const flowFile = (id: string) => join(flowsDirectory, `${id}.json`);
  async function flows() {
    const names = await readdir(flowsDirectory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    return Promise.all(
      names
        .filter((name) => /^[\da-f-]{36}\.json$/.test(name))
        .map(async (name) =>
          flowSchema.parse(await json(join(flowsDirectory, name), null)),
        ),
    );
  }
  function closeFlow(flow: Flow, status: string, noticeMs: number) {
    return writeJson(flowFile(flow.id), {
      ...flow,
      status,
      expiresAt: Date.now() + noticeMs,
    });
  }
  async function removeFlow(id: string) {
    await rm(join(flowsDirectory, `${id}.done`), { force: true });
    await rm(flowFile(id), { force: true });
  }
  /** Pressing the button again replaces the waiting attempt instead of stacking another. */
  async function supersede(matches: (flow: Flow) => boolean) {
    for (const flow of await flows())
      if (flow.status === "pending" && matches(flow)) await removeFlow(flow.id);
  }
  async function registeredClaudeAccounts() {
    const registry = registeredAccountsSchema.parse(
      await json(join(paseoHome, "paseo-accounts", "accounts.json"), {
        accounts: [],
      }),
    );
    return registry.accounts.filter((account) => account.base === "claude");
  }
  async function finishRelogin(flow: Flow) {
    const profile = z
      .object({ oauthAccount: z.object({ emailAddress: z.string() }) })
      .safeParse(
        await json(join(flow.home, ".claude.json"), null).catch(() => null),
      );
    const email = profile.success
      ? profile.data.oauthAccount.emailAddress
      : null;
    const matches =
      !flow.email || email?.toLowerCase() === flow.email.toLowerCase();
    if (matches) options.onRelogin?.();
    await closeFlow(
      flow,
      matches
        ? "재로그인 완료 · 구독과 한도를 다시 확인합니다"
        : `${email ?? "알 수 없는 계정"}(으)로 로그인됨 · ${flow.email} 계정으로 다시 로그인하세요`,
      matches ? successNoticeMs : failureNoticeMs,
    );
  } // A terminal must belong to a workspace; the choice does not affect the login.
  async function loginWorkspace(paseo: PaseoApi) {
    const { entries } = await paseo.workspaces.list();
    const workspace = entries.find((entry) => entry.workspaceDirectory);
    if (!workspace)
      throw Error(
        "로그인 터미널을 열 워크스페이스가 없습니다. 프로젝트를 먼저 여세요.",
      );
    return workspace;
  }
  async function loginCommand(paseo: PaseoApi) {
    const { config } = await paseo.config.get();
    const claudeExe = join(userHome, ".local", "bin", "claude.exe");
    return (
      providersSchema.parse(config.providers ?? {}).claude?.command ?? [
        process.platform === "win32" && existsSync(claudeExe)
          ? claudeExe
          : "claude",
      ]
    );
  }
  async function loginLauncher() {
    const launcher = join(await pluginPath(), "server/account-login.mjs");
    if (!(await lstat(launcher)).isFile())
      throw Error("계정 로그인 모듈이 설치되지 않았습니다.");
    return launcher;
  }
  function loginTerminal(
    paseo: PaseoApi,
    workspaceId: string,
    name: string,
    launcher: string,
    login: Record<string, unknown>,
  ) {
    return paseo.terminals.create({
      workspaceId,
      name,
      command: /^node(?:\.exe)?$/i.test(basename(process.execPath))
        ? process.execPath
        : "node",
      args: [launcher, JSON.stringify(login)],
    });
  }
  async function finish(paseo: PaseoApi) {
    for (const flow of await flows()) {
      lifetime.signal.throwIfAborted();
      if (flow.status !== "pending") {
        if ((flow.expiresAt ?? 0) <= Date.now()) await removeFlow(flow.id);
        continue;
      }
      const result = z
        .object({ success: z.boolean() })
        .nullable()
        .parse(await json(join(flowsDirectory, `${flow.id}.done`), null));
      if (!result) {
        if (Date.now() - (await lstat(flowFile(flow.id))).mtimeMs >= pendingLimitMs)
          await closeFlow(
            flow,
            "로그인이 완료되지 않았습니다 · 필요하면 다시 시도하세요",
            failureNoticeMs,
          );
        continue;
      }
      if (!result.success) {
        await closeFlow(
          flow,
          flow.accountId
            ? "재로그인 실패 · 다시 시도하세요"
            : "로그인 실패 · 다시 추가하세요",
          failureNoticeMs,
        );
        continue;
      }
      if (flow.accountId) {
        await finishRelogin(flow);
        continue;
      }
      let email: string | null = null,
        identity: string;
      if (flow.base === "codex")
        identity = (await codexTokens(flow.home)).chatgptAccountId;
      else {
        const profile = z
          .object({
            oauthAccount: z.object({
              emailAddress: z.string(),
              accountUuid: z.string(),
              organizationUuid: z.string(),
            }),
          })
          .parse(await json(join(flow.home, ".claude.json"), null));
        email = profile.oauthAccount.emailAddress;
        identity = `${profile.oauthAccount.organizationUuid}|${profile.oauthAccount.accountUuid}`;
      }
      const directory = join(paseoHome, "paseo-accounts"),
        file = join(directory, "accounts.json");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const schema = z
        .object({
          accounts: z.array(
            z
              .object({
                id: z.string(),
                base: z.string(),
                identity: z.string().nullable().optional(),
              })
              .passthrough(),
          ),
        })
        .passthrough();
      const before = await readFile(file, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return '{"version":1,"accounts":[]}';
          throw error;
        },
      );
      const registry = schema.parse(JSON.parse(before));
      const existing = registry.accounts.find(
        (account) =>
          account.base === flow.base && account.identity === identity,
      );
      const id = existing?.id ?? `${flow.base}-${flow.id.slice(0, 12)}`;
      const env =
        flow.base === "codex"
          ? { CODEX_HOME: flow.home }
          : {
              CLAUDE_CONFIG_DIR: flow.home,
              CLAUDE_SECURESTORAGE_CONFIG_DIR: flow.home,
              ...(process.platform === "win32"
                ? { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" }
                : {}),
            };
      lifetime.signal.throwIfAborted();
      await paseo.config.patch({
        providers: {
          [id]: {
            ...(id !== flow.base
              ? { extends: flow.base, label: `${flow.base} · ${email ?? id}` }
              : {}),
            enabled: true,
            selectable: id === flow.base,
            env,
          },
        },
      });
      // Read once more after the config RPC; preserve registry updates from other account writers.
      const current = schema.parse(await json(file, registry));
      lifetime.signal.throwIfAborted();
      const account = {
        ...current.accounts.find((entry) => entry.id === id),
        id,
        base: flow.base,
        home: flow.home,
        email,
        identity,
        signedIn: true,
      };
      await writeJson(file, {
        ...current,
        accounts: [
          ...current.accounts.filter((entry) => entry.id !== id),
          account,
        ],
      });
      await closeFlow(
        flow,
        "등록 완료 · 구독과 한도에 따라 자동 분배",
        successNoticeMs,
      );
    }
  }
  async function pluginPath() {
    if (options.pluginPath) return options.pluginPath();
    const client = await createLocalPluginConnection(paseoHome);
    try {
      await client.connect();
      const plugin = (await client.listPlugins()).find(
        (entry) => entry.id === "aster",
      );
      if (!plugin?.path) throw Error("Aster 설치 경로를 확인할 수 없습니다.");
      return plugin.path;
    } finally {
      client.close();
    }
  }
  server.handle(accountsRpc.add, async (input, { paseo }) =>
    serialize(async () => {
      api = paseo;
      const workspace = await loginWorkspace(paseo);
      await supersede((flow) => flow.base === input.base && !flow.accountId);
      const { config } = await paseo.config.get(),
        providers = providersSchema.parse(config.providers ?? {});
      const id = randomUUID(),
        home = join(
          paseoHome,
          "paseo-accounts",
          "homes",
          `${input.base}-${id}`,
        );
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(flowsDirectory, { recursive: true, mode: 0o700 });
      if (input.base === "claude") {
        const shared = join(userHome, ".claude", "projects");
        await mkdir(shared, { recursive: true, mode: 0o700 });
        await symlink(
          shared,
          join(home, "projects"),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const command =
        input.base === "codex"
          ? codexOriginalCommand(providers.codex?.command)
          : await loginCommand(paseo);
      const launcher = await loginLauncher();
      const flow: Flow = {
        id,
        base: input.base,
        home,
        workspaceId: workspace.id,
        status: "pending",
      };
      await writeJson(flowFile(id), flow);
      const terminal = await loginTerminal(
        paseo,
        workspace.id,
        `${input.base} 계정 추가`,
        launcher,
        {
          base: input.base,
          home,
          command,
          done: join(flowsDirectory, `${id}.done`),
        },
      );
      await writeJson(flowFile(id), { ...flow, terminalId: terminal.id });
      return { id, workspaceId: workspace.id, terminalId: terminal.id };
    }),
  );
  server.handle(accountsRpc.relogin, async (input, { paseo }) =>
    serialize(async () => {
      api = paseo;
      const workspace = await loginWorkspace(paseo);
      await supersede((flow) => flow.accountId === input.accountId);
      // The folder comes from the registry so the client can only name a known account.
      const account = (await registeredClaudeAccounts()).find(
        (entry) => entry.id === input.accountId,
      );
      if (!account) throw Error("다시 로그인할 Claude 계정을 찾지 못했습니다.");
      const home = account.home ?? join(userHome, ".claude");
      const command = await loginCommand(paseo);
      const launcher = await loginLauncher();
      await mkdir(flowsDirectory, { recursive: true, mode: 0o700 });
      const id = randomUUID();
      const flow: Flow = {
        id,
        base: "claude",
        home,
        workspaceId: workspace.id,
        status: "pending",
        accountId: account.id,
        email: account.email ?? null,
      };
      await writeJson(flowFile(id), flow);
      const terminal = await loginTerminal(
        paseo,
        workspace.id,
        `${account.email ?? account.id} 재로그인`,
        launcher,
        {
          base: "claude",
          home,
          // Same credential location sessions use, so the new login reaches them.
          secureDirectory: accountSecureDirectory(
            { home },
            process.platform,
            userHome,
          ),
          email: account.email ?? undefined,
          command,
          done: join(flowsDirectory, `${id}.done`),
        },
      );
      await writeJson(flowFile(id), { ...flow, terminalId: terminal.id });
      return { id, workspaceId: workspace.id, terminalId: terminal.id };
    }),
  );
  server.handle(accountsRpc.status, async (_, { paseo }) => {
    api = paseo;
    // Read inside the queue: a concurrent poll may be removing an expired flow.
    const pending = await serialize(async () => {
      await finish(paseo);
      return flows();
    });
    const { config } = await paseo.config.get();
    const [accounts, registered] = await Promise.all([
      status(config.providers ?? {}, lifetime.signal),
      registeredClaudeAccounts(),
    ]);
    return {
      accounts: accounts.map(({ loginLost, ...account }) => ({
        ...account,
        canRelogin:
          loginLost === true &&
          account.base === "claude" &&
          registered.some((entry) => entry.id === account.id),
      })),
      flows: pending.slice(-8).map((flow) => ({
        id: flow.id,
        base: flow.base,
        workspaceId: flow.workspaceId,
        label: flow.accountId
          ? `${flow.email ?? flow.accountId} 재로그인`
          : `${flow.base} 계정 추가`,
        status:
          flow.status === "pending"
            ? "터미널에서 공식 CLI 로그인을 완료하세요"
            : flow.status,
      })),
    };
  });
  server.handle(accountsRpc.policy, async (_, { paseo }) =>
    serialize(async () => {
      const { config } = await paseo.config.get();
      const providers = config.providers ?? {},
        patch = providerPolicy(providers);
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      await writeJson(
        join(stateDirectory, `provider-policy-before-${randomUUID()}.json`),
        providers,
      );
      const removeProviders = Object.keys(providers).filter(
        (id) =>
          providers[id].extends &&
          !["claude", "codex"].includes(providerFamily(id, providers)),
      );
      for (const id of removeProviders) delete patch[id];
      if (Object.keys(patch).length || removeProviders.length)
        await paseo.config.patch({ providers: patch, removeProviders });
      return { changed: [...Object.keys(patch), ...removeProviders] };
    }),
  );
  const timer = setInterval(() => {
    if (api && !lifetime.signal.aborted)
      void serialize(() => finish(api!)).catch(() =>
        console.warn(
          "[aster] 계정 등록을 마무리하지 못했습니다. Aster 설정에서 상태를 확인하세요.",
        ),
      );
  }, 5000);
  timer.unref();
  return () => {
    lifetime.abort();
    clearInterval(timer);
  };
}
