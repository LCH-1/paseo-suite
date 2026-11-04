import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import { createLocalPluginConnection } from "./legacy-credential-rpc";
import { codexTokens, inspectCodexAccount } from "./codex-runtime.mjs";
import { chooseCodexAccount, type CodexReading } from "./codex-policy";
import { paseoHome, readSettings } from "./accounts";
import { runPaseo } from "./paseo";

interface CodexAccount {
  id: string;
  home: string;
  identity: string;
}
interface CodexBinding {
  account: CodexAccount;
  switchedAt: number;
}
const providersSchema = z.record(
  z.string(),
  z
    .object({
      extends: z.string().optional(),
      enabled: z.boolean().optional(),
      command: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .passthrough(),
);
type Providers = z.output<typeof providersSchema>;
const registrySchema = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      base: z.string(),
      home: z.string().nullable(),
      signedIn: z.boolean(),
    }),
  ),
});
const commandSchema = z.array(z.string().min(1)).min(1);

export function codexOriginalCommand(command: string[] | undefined): string[] {
  const value = command ?? ["codex"];
  if (!value[1]?.replaceAll("\\", "/").endsWith("/codex-proxy.mjs"))
    return value;
  try {
    return commandSchema.parse(JSON.parse(value[2]));
  } catch {
    throw Error("Codex 계정 연결 실행 설정이 손상되었습니다.");
  }
}

export function codexProvider(id: string, providers: Providers): boolean {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    if (id === "codex") return true;
    seen.add(id);
    const parent = providers[id]?.extends;
    if (!parent) return false;
    id = parent;
  }
  return false;
}

export async function discoverCodexAccounts(
  providers: Providers,
  home = paseoHome,
  userHome = homedir(),
): Promise<CodexAccount[]> {
  const candidates: Array<{ id: string; home: string }> = [
    {
      id: "codex",
      home:
        providers.codex?.env?.CODEX_HOME ||
        process.env.CODEX_HOME ||
        join(userHome, ".codex"),
    },
  ];
  try {
    const registry = registrySchema.parse(
      JSON.parse(
        await readFile(join(home, "paseo-accounts/accounts.json"), "utf8"),
      ),
    );
    for (const account of registry.accounts)
      if (account.base === "codex" && account.signedIn)
        candidates.push({
          id: account.id,
          home: account.home || join(userHome, ".codex"),
        });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const [id, provider] of Object.entries(providers))
    if (
      provider.enabled !== false &&
      codexProvider(id, providers) &&
      provider.env?.CODEX_HOME
    )
      candidates.push({ id, home: provider.env.CODEX_HOME });
  const unique = new Map<string, CodexAccount>();
  for (const candidate of candidates) {
    const directory =
      candidate.home === "~"
        ? userHome
        : /^~[\\/]/.test(candidate.home)
          ? join(userHome, candidate.home.slice(2))
          : candidate.home;
    if (!isAbsolute(directory))
      throw Error("Codex 계정 폴더는 절대 경로로 등록하세요.");
    try {
      const auth = await codexTokens(resolve(directory));
      if (!unique.has(auth.chatgptAccountId))
        unique.set(auth.chatgptAccountId, {
          id: candidate.id,
          home: resolve(directory),
          identity: auth.chatgptAccountId,
        });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          `[aster] Codex 계정 ${candidate.id}: 인증을 사용할 수 없어 자동 분배에서 제외`,
        );
    }
  }
  return [...unique.values()];
}

export async function installCodexBridge(home = paseoHome) {
  const client = await createLocalPluginConnection(home);
  try {
    await client.connect();
    const plugin = (await client.listPlugins()).find(
      (entry) => entry.id === "aster",
    );
    if (!plugin?.path) throw Error("Aster 설치 경로를 확인할 수 없습니다.");
    const proxy = join(plugin.path, "server/codex-proxy.mjs");
    if (!(await lstat(proxy)).isFile())
      throw Error("Aster Codex 실행 모듈이 설치되지 않았습니다.");
    const { config } = await client.getDaemonConfig();
    const providers = providersSchema.parse(config.providers ?? {});
    const patch: Record<
      string,
      { command: string[]; env: Record<string, string> }
    > = {};
    for (const id of new Set([
      "codex",
      ...Object.keys(providers).filter((id) => codexProvider(id, providers)),
    ])) {
      const provider = providers[id];
      if (provider?.enabled === false) continue;
      const original = codexOriginalCommand(
        provider?.command ?? providers.codex?.command,
      );
      const command = [process.execPath, proxy, JSON.stringify(original)];
      if (
        JSON.stringify(command) !== JSON.stringify(provider?.command) ||
        provider?.env?.ELECTRON_RUN_AS_NODE !== "1"
      )
        patch[id] = { command, env: { ELECTRON_RUN_AS_NODE: "1" } };
    }
    if (Object.keys(patch).length)
      await client.patchDaemonConfig({ providers: patch });
  } finally {
    client.close();
  }
}

export function registerCodexRouting(server: PluginServerContext) {
  const lifetime = new AbortController(),
    bindings = new Map<string, CodexBinding>(),
    busy = new Set<string>(),
    permissions = new Set<string>();
  const readings = new Map<string, { value: CodexReading; expires: number }>(),
    pending = new Map<string, Promise<CodexReading | null>>(),
    revisions = new Map<string, number>();
  const turnIds = new Map<string, string | null>(),
    turns = new Map<string, number>(),
    reloading = new Set<string>(),
    blocked = new Map<string, number>(),
    reservations = new Map<string, number>();
  const excluded = new Set<string>();
  let serial: Promise<unknown> = Promise.resolve(),
    sequence = 0,
    bridgeError: unknown;
  const bridgeReady = installCodexBridge().catch((error) => {
    bridgeError = error;
    console.error("[aster] Codex 자동 계정 실행 모듈을 초기화하지 못했습니다.");
  });
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = serial.then(action);
    serial = result.catch(() => undefined);
    return result;
  };
  const invalidate = (identity: string) => {
    readings.delete(identity);
    revisions.set(identity, (revisions.get(identity) ?? 0) + 1);
  };
  async function inspect(
    account: CodexAccount,
    providers: Providers,
  ): Promise<CodexReading | null> {
    const cached = readings.get(account.identity);
    if (cached && cached.expires > Date.now()) return cached.value;
    const version = revisions.get(account.identity) ?? 0,
      key = `${account.identity}:${version}`;
    const running = pending.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const result = await inspectCodexAccount(
          codexOriginalCommand(providers.codex?.command),
          account.home,
          account.identity,
        );
        const value: CodexReading = {
          id: account.id,
          identity: account.identity,
          at: Date.now(),
          plan: result.plan,
          allowed: result.allowed,
          windows: result.windows,
          blocked: result.blocked,
        };
        if (
          (revisions.get(account.identity) ?? 0) !== version ||
          lifetime.signal.aborted
        )
          return null;
        readings.set(account.identity, { value, expires: Date.now() + 60000 });
        return value;
      } catch {
        console.warn(
          `[aster] Codex 계정 ${account.id}: 구독·한도를 확인할 수 없어 자동 선택에서 제외`,
        );
        return null;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  }
  async function choose(agentId: string, providers: Providers) {
    const accounts = await discoverCodexAccounts(providers),
      now = Date.now();
    const available = (
      await Promise.all(accounts.map((account) => inspect(account, providers)))
    ).filter(
      (reading): reading is CodexReading =>
        reading !== null && (blocked.get(reading.identity) ?? 0) <= now,
    );
    const loads = new Map<string, number>();
    for (const [id, binding] of bindings)
      if (id !== agentId && (busy.has(id) || (reservations.get(id) ?? 0) > now))
        loads.set(
          binding.account.identity,
          (loads.get(binding.account.identity) ?? 0) + 1,
        );
    const current = bindings.get(agentId),
      settings = await readSettings();
    const selected = chooseCodexAccount({
      readings: available,
      now: Date.now(),
      loads,
      current: current
        ? { identity: current.account.identity, switchedAt: current.switchedAt }
        : undefined,
      capacities: settings.capacities,
    });
    return selected
      ? (accounts.find((account) => account.identity === selected.identity) ??
          null)
      : null;
  }
  const cleanup = (id: string) => {
    bindings.delete(id);
    busy.delete(id);
    permissions.delete(id);
    turns.delete(id);
    turnIds.delete(id);
    reservations.delete(id);
  };
  const removals = [
    server.before(
      "agent.session_open",
      async ({ request }, { paseo, signal }) => {
        if (request.purpose !== "interactive") return;
        const { config } = await paseo.config.get(),
          providers = providersSchema.parse(config.providers ?? {});
        if (!codexProvider(request.provider, providers)) return;
        if (
          request.env.ASTER_DISABLED === "1" ||
          ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].some(
            (key) => request.env[key] || process.env[key],
          )
        ) {
          excluded.add(request.agentId);
          return;
        }
        excluded.delete(request.agentId);
        await bridgeReady;
        if (bridgeError)
          throw Error(
            "Aster Codex 계정 실행 모듈을 확인하세요. 기존 대화 기록은 유지됩니다.",
          );
        return serialize(async () => {
          signal.throwIfAborted();
          const account = await choose(request.agentId, providers);
          signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
          if (!account)
            throw Error(
              "Aster: 현재 사용할 수 있는 Codex 구독 계정이 없습니다. 구독·로그인·사용 한도를 확인하세요. 기존 대화 기록은 유지됩니다.",
            );
          const previous = bindings.get(request.agentId);
          bindings.set(request.agentId, {
            account,
            switchedAt:
              previous?.account.identity === account.identity
                ? previous.switchedAt
                : Date.now(),
          });
          reservations.set(request.agentId, Date.now() + 30000);
          return {
            ...request,
            env: {
              ...request.env,
              ASTER_CODEX_ACCOUNT_HOME: account.home,
              ASTER_CODEX_ACCOUNT_ID: account.identity,
            },
          } satisfies PluginSessionOpenRequest;
        });
      },
    ),
    server.on("agent.turn_started", ({ agent, turnId }) => {
      if (bindings.has(agent.id) || agent.provider === "codex") {
        busy.add(agent.id);
        turns.set(agent.id, ++sequence);
        turnIds.set(agent.id, turnId);
      }
    }),
    server.on("agent.permission_requested", ({ agent }) => {
      permissions.add(agent.id);
    }),
    server.on("agent.permission_resolved", ({ agent }) => {
      permissions.delete(agent.id);
    }),
    server.on("agent.closed", ({ agent }) => {
      if (!reloading.has(agent.id)) cleanup(agent.id);
    }),
    server.on("agent.archived", ({ agent }) => cleanup(agent.id)),
    server.on(
      "agent.turn_ended",
      async ({ agent, turnId, outcome }, { paseo, signal }) => {
        if (turnId && turnIds.get(agent.id) && turnId !== turnIds.get(agent.id))
          return;
        const version = turns.get(agent.id);
        busy.delete(agent.id);
        reservations.delete(agent.id);
        if (
          outcome.kind === "canceled" ||
          reloading.has(agent.id) ||
          excluded.has(agent.id)
        )
          return;
        const { config } = await paseo.config.get(),
          providers = providersSchema.parse(config.providers ?? {});
        if (!codexProvider(agent.provider, providers)) return;
        const previous = bindings.get(agent.id);
        const accessFailure =
          outcome.kind === "failed" &&
          /401|402|403|429|authentication|unauthorized|quota|rate.?limit|usage.?limit|subscription|billing/i.test(
            outcome.error.message,
          );
        if (accessFailure && previous) {
          invalidate(previous.account.identity);
          blocked.set(previous.account.identity, Date.now() + 60000);
        }
        const selected = await choose(agent.id, providers);
        if (
          !selected ||
          selected.identity === previous?.account.identity ||
          busy.has(agent.id) ||
          permissions.has(agent.id) ||
          version !== turns.get(agent.id)
        )
          return;
        const snapshot = await paseo.agents.ref(agent.id).refresh();
        signal.throwIfAborted();
        if (
          !snapshot ||
          !["idle", "error"].includes(snapshot.agent.status) ||
          snapshot.agent.pendingPermissions.length ||
          busy.has(agent.id) ||
          version !== turns.get(agent.id)
        )
          return;
        const settings = await readSettings();
        reloading.add(agent.id);
        try {
          await runPaseo(
            settings.command,
            ["agent", "reload", agent.id, "--json", "--home", paseoHome],
            signal,
            20000,
          );
        } finally {
          reloading.delete(agent.id);
        }
      },
    ),
  ];
  return {
    dispose: () => {
      lifetime.abort();
      removals.forEach((remove) => remove());
    },
    status: async (providers: Providers) =>
      Promise.all(
        (await discoverCodexAccounts(providers)).map(async (account) => {
          const reading = await inspect(account, providers);
          const eligible =
            reading &&
            chooseCodexAccount({
              readings: [reading],
              now: Date.now(),
              loads: new Map(),
            });
          return {
            id: account.id,
            base: "codex" as const,
            label: account.id,
            status: !reading
              ? "로그인·구독 확인 필요 · 자동 제외"
              : !eligible
                ? `${reading.plan} · 구독 또는 잔여 한도 없음 · 자동 제외`
                : `${reading.plan} · 자동 분배 중 · 최대 사용률 ${Math.max(...reading.windows.map((window) => window.usedPercent))}%`,
          };
        }),
      ),
  };
}
