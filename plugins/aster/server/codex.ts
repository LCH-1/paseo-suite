import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { z } from "zod";
import { createLocalPluginConnection } from "./legacy-credential-rpc";
import {
  CodexAccountClient,
  codexTokens,
  inspectCodexAccount,
} from "./codex-runtime.mjs";
import {
  chooseCodexAccount,
  hasCodexSubscription,
  type CodexReading,
} from "./codex-policy";
import { paseoHome, readSettings } from "./accounts";
import { codexAccessFailure } from "./auth-recovery";
import { runPaseo } from "./paseo";
import { pruneCodexHistory, retentionSummary } from "./codex-retention";

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
  const proxy = value.findIndex((part) =>
    part.replaceAll("\\", "/").endsWith("/codex-proxy.mjs"),
  );
  if (proxy < 1) return value;
  try {
    return commandSchema.parse(JSON.parse(value[proxy + 1]));
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
  const freshness = new Map<string, { expiry: number; modified: number }>();
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
      const modified = (await lstat(join(directory, "auth.json"))).mtimeMs;
      const expiry = auth.expiresAt ?? 0,
        previous = freshness.get(auth.chatgptAccountId);
      if (
        !previous ||
        modified > previous.modified ||
        (modified === previous.modified && expiry > previous.expiry)
      ) {
        freshness.set(auth.chatgptAccountId, { expiry, modified });
        unique.set(auth.chatgptAccountId, {
          id: candidate.id,
          home: resolve(directory),
          identity: auth.chatgptAccountId,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        console.warn(
          `[aster] Codex 계정 ${candidate.id}: 인증을 사용할 수 없어 자동 분배에서 제외`,
        );
    }
  }
  return [...unique.values()];
}

/**
 * The daemon strips ELECTRON_RUN_AS_NODE from every external process, including
 * provider env, so an Electron host needs a launcher that sets it after the spawn.
 */
export function codexNodeLauncher(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform === "win32") {
    return {
      file: "codex-node.ps1",
      // A batch file can outlive Codex at the Ctrl+C Y/N prompt and consume RPC stdin.
      // The child inherits this process's own pipes, so PowerShell never reads, re-encodes
      // or buffers the RPC stream. Redirect* or CreateNoWindow would detach those handles:
      // the daemon already hides this console and the Electron host opens none of its own.
      content: `\uFEFF$ErrorActionPreference = "Stop"
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = '${execPath.replaceAll("'", "''")}'
$start.UseShellExecute = $false
$start.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1"
$start.Arguments = [string]::Join(" ", @($args | ForEach-Object { '"' + ($_ -replace '(\\\\*)"', '$1$1\\"' -replace '(\\\\+)$', '$1$1') + '"' }))
$child = [System.Diagnostics.Process]::Start($start)
$child.WaitForExit()
exit $child.ExitCode
`.replaceAll("\n", "\r\n"),
    };
  }
  return {
    file: "codex-node.sh",
    content: `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec '${execPath.replaceAll("'", "'\\''")}' "$@"\n`,
  };
}

async function codexNodeCommand(home: string) {
  if (!process.versions.electron) return [process.execPath];
  const launcher = codexNodeLauncher(process.execPath),
    directory = join(home, "aster"),
    file = join(directory, launcher.file);
  const current = await readFile(file, "utf8").catch(() => null);
  if (current !== launcher.content) {
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, launcher.content);
    await chmod(temporary, 0o755);
    await rename(temporary, file);
  }
  return codexLauncherCommand(file);
}

export function codexLauncherCommand(
  file: string,
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32"
    ? [
        join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
      ]
    : [file];
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
    const node = await codexNodeCommand(home);
    const patch: Record<string, { command: string[] }> = {};
    for (const id of new Set([
      "codex",
      ...Object.keys(providers).filter((id) => codexProvider(id, providers)),
    ])) {
      const provider = providers[id];
      if (provider?.enabled === false) continue;
      const original = codexOriginalCommand(
        provider?.command ?? providers.codex?.command,
      );
      const command = [...node, proxy, JSON.stringify(original)];
      if (JSON.stringify(command) !== JSON.stringify(provider?.command))
        patch[id] = { command };
    }
    if (Object.keys(patch).length)
      await client.patchDaemonConfig({ providers: patch });
  } finally {
    client.close();
  }
}

/** The first attempt can run before the daemon accepts connections, so a failure is not final. */
export function retryingBridge(
  install: () => Promise<void>,
  onError: (error: unknown) => void,
  options: { attempts?: number; retryMs?: number } = {},
) {
  let attempt: Promise<boolean> | null = null,
    remaining = options.attempts ?? 0,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const start = (): Promise<boolean> => {
    const current: Promise<boolean> = install().then(
      () => true,
      (error: unknown) => {
        // The daemon publishes its address after plugins load, so an early failure is expected.
        if (!stopped && remaining > 0) {
          remaining--;
          timer = setTimeout(() => {
            if (!stopped && attempt === current) start();
          }, options.retryMs ?? 5000);
          timer.unref?.();
        } else onError(error);
        return false;
      },
    );
    attempt = current;
    return current;
  };
  start();
  const ready = async () => {
    if (await attempt) return true;
    // Waiters of one failed attempt share a single retry.
    const failed = attempt;
    await Promise.resolve();
    return attempt === failed ? start() : attempt;
  };
  return Object.assign(ready, {
    dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
}

/** Opening an existing conversation must not depend on quota; only a new turn can spend it. */
export function resumableCodexAccount(
  request: { reason?: string; preflight?: boolean },
  previous: CodexAccount | undefined,
  accounts: CodexAccount[],
): CodexAccount | null {
  if (request.preflight === true) return null;
  if (request.reason !== "resume" && request.reason !== "refresh") return null;
  return previous ?? accounts[0] ?? null;
}

/** The Codex home the default `codex` provider runs with, where its conversations are kept. */
export function codexHomeOf(providers: Providers, userHome = homedir()) {
  const home =
    providers.codex?.env?.CODEX_HOME ||
    process.env.CODEX_HOME ||
    join(userHome, ".codex");
  const directory =
    home === "~"
      ? userHome
      : /^~[\\/]/.test(home)
        ? join(userHome, home.slice(2))
        : home;
  if (!isAbsolute(directory))
    throw Error("Codex 계정 폴더는 절대 경로로 등록하세요.");
  return resolve(directory);
}

/**
 * Deletes the given threads through the official app-server, one at a time, and keeps the first
 * reason Codex gave for one it refused. A thread another Codex process holds is refused.
 */
export async function deleteCodexThreads(
  command: string[],
  codexHome: string,
  threadIds: string[],
  signal: AbortSignal,
) {
  const client = new CodexAccountClient(command, codexHome, {
    timeout: 15_000,
  });
  let reason: string | undefined;
  try {
    await client.initialize();
    for (const threadId of threadIds) {
      if (signal.aborted) break;
      try {
        await client.request("thread/delete", { threadId });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        reason ??=
          typeof cause === "string" ? cause : String(error).slice(0, 200);
      }
    }
  } finally {
    client.close();
  }
  return { reason };
}

async function daemonProviders(home = paseoHome) {
  const client = await createLocalPluginConnection(home);
  try {
    await client.connect();
    const { config } = await client.getDaemonConfig();
    return providersSchema.parse(config.providers ?? {});
  } finally {
    client.close();
  }
}

/** A reading stands this long before it is renewed. */
const READING_FRESH = 60_000;
/**
 * How old a reading may be to choose an account with, without waiting for a new one.
 * `codexBudget` drops readings past six minutes, so a choice never rests on one about to go. With
 * more than one account an old reading could send a new conversation to an account another
 * client just spent, so it is kept shorter there.
 */
export function codexReadingReuse(accounts: number) {
  return accounts > 1 ? 120_000 : 300_000;
}
/** A bound account last seen this close to a limit is checked again before a resume goes to it. */
const NEAR_LIMIT = 90;

type CodexInspection = Pick<
  CodexReading,
  "plan" | "allowed" | "windows" | "blocked"
>;

/** Seams for tests: every default reaches the real host, Codex CLI and settings. */
export interface CodexRoutingOptions {
  inspect?: (
    command: string[],
    home: string,
    identity: string,
  ) => Promise<CodexInspection>;
  discover?: (providers: Providers) => Promise<CodexAccount[]>;
  installBridge?: () => Promise<void>;
  settings?: () => Promise<{ capacities: Record<string, number> }>;
  now?: () => number;
  /** Whether the opt-in Codex history retention runs (at start and daily). */
  retention?: boolean;
}

const DAY = 86_400_000;

export function registerCodexRouting(
  server: PluginServerContext,
  options: CodexRoutingOptions = {},
) {
  const inspectAccount = options.inspect ?? inspectCodexAccount,
    discover =
      options.discover ??
      ((providers: Providers) => discoverCodexAccounts(providers)),
    settingsOf = options.settings ?? readSettings,
    now = options.now ?? Date.now;
  const lifetime = new AbortController(),
    bindings = new Map<string, CodexBinding>(),
    busy = new Set<string>(),
    permissions = new Set<string>();
  /** The newest reading of each login folder, kept past its freshness so reuse can judge its age. */
  const readings = new Map<string, CodexReading>(),
    pending = new Map<string, Promise<CodexReading | null>>(),
    revisions = new Map<string, number>();
  const turnIds = new Map<string, string | null>(),
    turns = new Map<string, number>(),
    reloading = new Set<string>(),
    blocked = new Map<string, number>(),
    blockedHomes = new Map<string, number>(),
    reservations = new Map<string, number>();
  const excluded = new Set<string>();
  let serial: Promise<unknown> = Promise.resolve(),
    sequence = 0;
  const bridgeReady = retryingBridge(
    options.installBridge ?? (() => installCodexBridge()),
    (error) => {
      console.error(
        "[aster] Codex 자동 계정 실행 모듈을 초기화하지 못했습니다.",
        error instanceof Error ? error.message : String(error),
      );
    },
    { attempts: 24, retryMs: 5000 },
  );
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = serial.then(action);
    serial = result.catch(() => undefined);
    return result;
  };
  let pruning = false;
  /** The opt-in history retention: off unless `codexHistoryRetentionDays` is set. */
  const pruneHistory = async () => {
    if (pruning || lifetime.signal.aborted) return;
    pruning = true;
    try {
      const days = (await readSettings()).codexHistoryRetentionDays;
      if (!days) return;
      const providers = await daemonProviders();
      const codexHome = codexHomeOf(providers),
        command = codexOriginalCommand(providers.codex?.command);
      const result = await pruneCodexHistory({
        codexHome,
        paseoHome,
        days,
        now: Date.now(),
        remove: (threadIds) =>
          deleteCodexThreads(command, codexHome, threadIds, lifetime.signal),
      });
      console.info(retentionSummary(days, result));
    } catch (error) {
      console.warn(
        `[aster] Codex 대화 기록 정리 보류: ${String(error).slice(0, 200)}`,
      );
    } finally {
      pruning = false;
    }
  };
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  if (options.retention !== false) {
    // The daemon answers once the bridge is in place; after that, once a day.
    void bridgeReady().then(() => pruneHistory());
    retentionTimer = setInterval(() => void pruneHistory(), DAY);
    retentionTimer.unref?.();
  }
  const readingKey = (account: CodexAccount) =>
    `${account.identity}:${account.home}`;
  const invalidate = (identity: string) => {
    for (const [key, reading] of readings)
      if (reading.identity === identity) readings.delete(key);
    revisions.set(identity, (revisions.get(identity) ?? 0) + 1);
  };
  /** A new reading; callers at the same time share one official app-server lookup. */
  function renew(
    account: CodexAccount,
    providers: Providers,
  ): Promise<CodexReading | null> {
    const version = revisions.get(account.identity) ?? 0,
      key = `${readingKey(account)}:${version}`;
    const running = pending.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const result = await inspectAccount(
          codexOriginalCommand(providers.codex?.command),
          account.home,
          account.identity,
        );
        const value: CodexReading = {
          id: account.id,
          identity: account.identity,
          at: now(),
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
        readings.set(readingKey(account), value);
        return value;
      } catch {
        // A failed lookup leaves nothing to choose with, as before: the next choice asks again.
        if ((revisions.get(account.identity) ?? 0) === version)
          readings.delete(readingKey(account));
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
  /** The reading while it is younger than `maxAge`, else a new one. */
  async function inspect(
    account: CodexAccount,
    providers: Providers,
    maxAge = READING_FRESH,
  ): Promise<CodexReading | null> {
    const cached = readings.get(readingKey(account)),
      at = now();
    if (cached && at >= cached.at && at - cached.at < maxAge) return cached;
    return renew(account, providers);
  }
  const unblockedHomes = (accounts: CodexAccount[]) =>
    accounts.filter(
      (account) => (blockedHomes.get(account.home) ?? 0) <= now(),
    );
  async function select(
    agentId: string,
    accounts: CodexAccount[],
    found: Array<CodexReading | null>,
  ) {
    const at = now();
    const available = found.filter(
      (reading): reading is CodexReading =>
        reading !== null && (blocked.get(reading.identity) ?? 0) <= at,
    );
    const loads = new Map<string, number>();
    for (const [id, binding] of bindings)
      if (id !== agentId && (busy.has(id) || (reservations.get(id) ?? 0) > at))
        loads.set(
          binding.account.identity,
          (loads.get(binding.account.identity) ?? 0) + 1,
        );
    const current = bindings.get(agentId),
      settings = await settingsOf();
    const selected = chooseCodexAccount({
      readings: available,
      now: at,
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
  /** The choice from readings at most a minute old, waiting for new ones past that. */
  async function choose(
    agentId: string,
    providers: Providers,
    accounts?: CodexAccount[],
  ) {
    accounts ??= await discover(providers);
    return select(
      agentId,
      accounts,
      await Promise.all(
        unblockedHomes(accounts).map((account) => inspect(account, providers)),
      ),
    );
  }
  /** No block and no reading near a limit: nothing suggests the account would refuse a turn. */
  const roomLooksLeft = (account: CodexAccount, at: number) => {
    if (
      (blockedHomes.get(account.home) ?? 0) > at ||
      (blocked.get(account.identity) ?? 0) > at
    )
      return false;
    const last = readings.get(readingKey(account));
    return (
      !last ||
      (!last.blocked &&
        last.allowed !== false &&
        hasCodexSubscription(last.plan) &&
        last.windows.every(
          (window) =>
            window.usedPercent < NEAR_LIMIT ||
            (window.resetsAt !== null && window.resetsAt <= at),
        ))
    );
  };
  /**
   * The account a session opens on without waiting for a new reading, or null to wait as before:
   * every account has a reading recent enough to choose with, or an existing conversation goes
   * back to the only account, or to the one it is bound to unless that one was last seen near a
   * limit. Readings past a minute are renewed in the background, and a turn that hits a limit or a
   * failed login still blocks the account and moves the session when it ends.
   */
  async function chooseNow(
    agentId: string,
    providers: Providers,
    accounts: CodexAccount[],
    resuming: boolean,
  ): Promise<{ account: CodexAccount; how: string } | null> {
    const at = now(),
      reuse = codexReadingReuse(accounts.length),
      candidates = unblockedHomes(accounts);
    const renewOld = () => {
      for (const account of candidates) {
        const reading = readings.get(readingKey(account));
        if (!reading || at < reading.at || at - reading.at >= READING_FRESH)
          void renew(account, providers);
      }
    };
    const recent = candidates.map((account) => {
      const reading = readings.get(readingKey(account));
      return reading && at >= reading.at && at - reading.at <= reuse
        ? reading
        : null;
    });
    if (candidates.length && recent.every((reading) => reading !== null)) {
      const account = await select(agentId, accounts, recent);
      // Old readings never refuse a session: without a choice it waits for new ones.
      if (!account) return null;
      renewOld();
      return { account, how: "최근 판독" };
    }
    if (!resuming) return null;
    // Whatever the readings say, a resume on the only account goes back to it.
    if (accounts.length === 1) {
      renewOld();
      return { account: accounts[0], how: "유일 계정" };
    }
    const previous = bindings.get(agentId)?.account;
    const bound = previous
      ? accounts.find(
          (account) =>
            account.identity === previous.identity &&
            account.home === previous.home,
        )
      : undefined;
    if (!bound || !roomLooksLeft(bound, at)) return null;
    renewOld();
    return { account: bound, how: "기존 계정" };
  }
  const cleanup = (id: string) => {
    excluded.delete(id);
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
        // A dry run has no session behind it: decide only, and keep every binding as is.
        const preflight =
          (request as { preflight?: boolean }).preflight === true;
        if (
          request.env.ASTER_DISABLED === "1" ||
          ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].some(
            (key) => request.env[key] || process.env[key],
          )
        ) {
          if (!preflight) excluded.add(request.agentId);
          return;
        }
        if (!preflight) excluded.delete(request.agentId);
        if (!(await bridgeReady()))
          throw Error(
            "Aster Codex 계정 실행 모듈을 확인하세요. 기존 대화 기록은 유지됩니다.",
          );
        return serialize(async () => {
          const started = now();
          signal.throwIfAborted();
          const accounts = await discover(providers);
          const quick = await chooseNow(
            request.agentId,
            providers,
            accounts,
            !preflight &&
              (request.reason === "resume" || request.reason === "refresh"),
          );
          const chosen =
            quick?.account ??
            (await choose(request.agentId, providers, accounts));
          signal.throwIfAborted();
          lifetime.signal.throwIfAborted();
          const account =
            chosen ??
            resumableCodexAccount(
              { reason: request.reason, preflight },
              bindings.get(request.agentId)?.account,
              accounts,
            );
          // Where the open's time went, once it is decided.
          const note = (outcome: string) => {
            if (!preflight)
              console.info(
                `[aster] Codex 계정 확인 ${request.agentId} ${now() - started}ms (${request.reason} · ${quick?.how ?? "판독 대기"} · ${outcome})`,
              );
          };
          if (!account) {
            note("후보 없음");
            throw Error(
              "Aster: 현재 사용할 수 있는 Codex 구독 계정이 없습니다. 구독·로그인·사용 한도를 확인하세요. 기존 대화 기록은 유지됩니다.",
            );
          }
          if (preflight) return;
          const previous = bindings.get(request.agentId);
          bindings.set(request.agentId, {
            account,
            switchedAt:
              previous?.account.identity === account.identity
                ? previous.switchedAt
                : now(),
          });
          reservations.set(request.agentId, now() + 30000);
          note(account.id);
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
      // Track turns before async family discovery, including aliases opened before plugin reload.
      busy.add(agent.id);
      turns.set(agent.id, ++sequence);
      turnIds.set(agent.id, turnId);
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
          outcome.kind === "failed"
            ? codexAccessFailure(outcome.error.message)
            : null;
        if (accessFailure && previous) {
          invalidate(previous.account.identity);
          if (accessFailure === "authentication")
            blockedHomes.set(previous.account.home, now() + 60000);
          else blocked.set(previous.account.identity, now() + 60000);
        }
        const selected = await choose(agent.id, providers);
        if (
          !selected ||
          (selected.identity === previous?.account.identity &&
            selected.home === previous.account.home) ||
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
      bridgeReady.dispose();
      if (retentionTimer) clearInterval(retentionTimer);
      lifetime.abort();
      removals.forEach((remove) => remove());
    },
    status: async (providers: Providers) =>
      Promise.all(
        (await discover(providers)).map(async (account) => {
          const reading = await inspect(account, providers);
          const eligible =
            reading &&
            chooseCodexAccount({
              readings: [reading],
              now: now(),
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
