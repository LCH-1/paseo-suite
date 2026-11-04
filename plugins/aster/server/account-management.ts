import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  symlink,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import { accountsRpc } from "../shared/accounts-rpc";
import { paseoHome as defaultPaseoHome } from "./accounts";
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
  async function finish(paseo: PaseoApi) {
    for (const flow of await flows()) {
      lifetime.signal.throwIfAborted();
      if (flow.status !== "pending") continue;
      const result = z
        .object({ success: z.boolean() })
        .nullable()
        .parse(await json(join(flowsDirectory, `${flow.id}.done`), null));
      if (!result) continue;
      if (!result.success) {
        await writeJson(flowFile(flow.id), {
          ...flow,
          status: "로그인 실패 · 다시 추가하세요",
        });
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
      await writeJson(flowFile(flow.id), {
        ...flow,
        status: "등록 완료 · 구독과 한도에 따라 자동 분배",
      });
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
      const workspace = await paseo.workspaces.ref(input.workspaceId).refresh();
      if (!workspace?.workspaceDirectory)
        throw Error("로그인 터미널을 열 워크스페이스를 선택하세요.");
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
      const claudeExe = join(userHome, ".local", "bin", "claude.exe");
      const command =
        input.base === "codex"
          ? codexOriginalCommand(providers.codex?.command)
          : (providers.claude?.command ?? [
              process.platform === "win32" && existsSync(claudeExe)
                ? claudeExe
                : "claude",
            ]);
      const launcher = join(await pluginPath(), "server/account-login.mjs");
      if (!(await lstat(launcher)).isFile())
        throw Error("계정 로그인 모듈이 설치되지 않았습니다.");
      const flow: Flow = {
        id,
        base: input.base,
        home,
        workspaceId: input.workspaceId,
        status: "pending",
      };
      await writeJson(flowFile(id), flow);
      const terminal = await paseo.terminals.create({
        workspaceId: workspace.id,
        name: `${input.base} 계정 추가`,
        command: /^node(?:\.exe)?$/i.test(basename(process.execPath))
          ? process.execPath
          : "node",
        args: [
          launcher,
          JSON.stringify({
            base: input.base,
            home,
            command,
            done: join(flowsDirectory, `${id}.done`),
          }),
        ],
      });
      await writeJson(flowFile(id), { ...flow, terminalId: terminal.id });
      return { id, workspaceId: workspace.id };
    }),
  );
  server.handle(accountsRpc.status, async (_, { paseo }) => {
    api = paseo;
    await serialize(() => finish(paseo));
    const { config } = await paseo.config.get();
    const [accounts, workspaces, pending] = await Promise.all([
      status(config.providers ?? {}, lifetime.signal),
      paseo.workspaces.list(),
      flows(),
    ]);
    return {
      accounts,
      workspaces: workspaces.entries.map((workspace) => ({
        id: workspace.id,
        label: workspace.name ?? workspace.workspaceDirectory,
      })),
      flows: pending.slice(-8).map((flow) => ({
        id: flow.id,
        base: flow.base,
        workspaceId: flow.workspaceId,
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
