import type {
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  accountSecureDirectory,
  bootstrapAccounts,
  exhaustedUntil,
  exhaustedAccountsResetAt,
  hasPreviousAccount,
  needsLogin,
  discoverAccounts,
  mapReports,
  paseoHome,
  readSettings,
  stateDirectory,
  UsageReader,
  type Account,
} from "./server/accounts";
import { join } from "node:path";
import { accountKey, RoutingCache } from "./server/routing-cache";
import {
  needsAuthenticationRecovery,
  needsLimitRecovery,
} from "./server/auth-recovery";
import { Controller } from "./server/controller";
import { runPaseo } from "./server/paseo";
import { profileDiscovery } from "./server/profile-discovery";
import * as profileUsage from "./server/profile-usage-runtime.js";
import {
  needsSubscriptionRecovery,
  SubscriptionGuard,
} from "./server/subscription";
import { usageRevision } from "./server/usage-revision";
import { registerLegacyCredentialRpc } from "./server/legacy-credential-rpc";
import { registerCodexRouting } from "./server/codex";
import { keepAliasesHidden } from "./server/hidden-aliases";
import { registerAccountManagement } from "./server/account-management";
import { providerFamily, type ProviderEntries } from "./server/provider-policy";
import { rankAccounts } from "./server/scheduler";

const NO_USAGE_READINGS =
  "Aster: Claude 계정의 사용량 정보를 확인할 수 없습니다. Paseo 사용량 화면과 각 계정의 실제 로그인 상태를 확인하세요. 이전 로그인 표시는 현재 인증 상태를 보장하지 않습니다.";
const NO_SELECTABLE_ACCOUNT =
  "Aster: Claude 계정의 잔여 한도 또는 최신 초기화 정보를 확인하세요. 현재 자동 선택 가능한 계정이 없습니다.";

class AccountUnavailable extends Error {}

export default function contribute(server: PluginServerContext) {
  const discoverProfiles = profileDiscovery(
    profileUsage.discover,
    profileUsage.configuredClaudeProviders,
  );
  server.registerUsageSource({
    id: "claude-profiles",
    label: "Claude",
    input: profileUsage.inputSchema,
    discover: async (scope) =>
      (await readSettings()).profileUsageFallback
        ? discoverProfiles(scope)
        : [],
    fetch: profileUsage.fetchUsage,
  });
  const reader = new UsageReader();
  const checkUsageRevision = usageRevision(paseoHome, () =>
    reader.invalidate(),
  );
  const readUsage: UsageReader["read"] = async (command, signal) => {
    for (;;) {
      signal.throwIfAborted();
      await checkUsageRevision();
      const reports = await reader.read(command, signal);
      if (!(await checkUsageRevision())) return reports;
    }
  };
  const controller = new Controller();
  const subscriptions = new SubscriptionGuard(
    join(stateDirectory, "subscription-access"),
    paseoHome,
  );
  const routes = new RoutingCache(join(stateDirectory, "routing-cache"));
  const refreshing = new Set<string>();
  const excluded = new Set<string>();
  const authenticationRecovery = new Set<string>();
  const startedTurns = new Map<string, string | null>();
  const turnRevisions = new Map<string, number>();
  let turnSequence = 0;
  const bootstrapping = new Set<string>();
  const authenticationOverrides = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
  ];
  const couldBeClaude = (provider: string, providers: ProviderEntries) =>
    providerFamily(provider, providers) === "claude";
  const withAccount = (
    request: PluginSessionOpenRequest,
    account: Account,
  ) => ({
    ...request,
    env: {
      ...request.env,
      CLAUDE_CONFIG_DIR: account.home,
      CLAUDE_SECURESTORAGE_CONFIG_DIR: accountSecureDirectory(account),
      ...(process.platform === "win32"
        ? { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" }
        : {}),
      ASTER_ACCOUNT_ID: account.id,
    },
  });
  const restoreRoute = async (
    agentId: string,
    accounts: Account[],
    includeExcluded: boolean,
  ) => {
    if (controller.bindings.has(agentId)) return;
    const cached = await routes.load(agentId, accounts);
    if (cached?.kind === "managed") controller.restore(agentId, cached.binding);
    else if (includeExcluded && cached?.kind === "excluded")
      excluded.add(agentId);
  };
  const limitRoute = (
    agentId: string,
    provider: string,
    accounts: Account[],
  ) => {
    const id =
      controller.bindings.get(agentId)?.accountId ??
      (provider !== "claude" ? provider : null);
    const failed = accounts.find((account) => account.id === id);
    if (failed)
      for (const account of accounts.filter(
        (account) => accountKey(account) === accountKey(failed),
      ))
        controller.limitAccount(account.id, Date.now());
  };

  const codex = registerCodexRouting(server);
  const stopHidingAliases = keepAliasesHidden(paseoHome);
  const unregister = [
    codex.dispose,
    stopHidingAliases,
    registerAccountManagement(
      server,
      async (providers, signal) => {
        const claudeStatus = async () => {
          const accounts = await discoverAccounts();
          const eligible = await subscriptions.filter(
            accounts,
            async () => providers,
            signal,
          );
          const settings = await readSettings();
          const reports = await readUsage(settings.command, signal);
          const ranked = new Set(
            rankAccounts(
              mapReports(eligible, reports, settings.capacities),
              Date.now(),
            ).map((entry) => entry.account.id),
          );
          const startable = new Set(
            bootstrapAccounts(eligible, reports).map((entry) => entry.id),
          );
          return accounts.map((account) => {
            const loginLost = needsLogin(account, reports);
            const resumesAt = exhaustedUntil(account, reports);
            const subscribed = eligible.some(
              (entry) => entry.id === account.id,
            );
            return {
              id: account.id,
              base: "claude" as const,
              label: account.email ?? account.id,
              loginLost,
              status: !subscribed
                ? loginLost
                  ? "구독 종료 · 로그인 풀림 · 자동 제외"
                  : "구독 종료 · 자동 제외"
                : ranked.has(account.id)
                  ? "자동 분배 중"
                  : loginLost
                    ? "로그인 풀림 · 다시 로그인 필요"
                    : startable.has(account.id)
                      ? "사용 가능 · 첫 사용 후 사용량 표시"
                      : resumesAt
                        ? `한도 소진 · ${new Date(resumesAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 이후 자동 복귀`
                        : "구독·잔여 한도 확인 필요 · 자동 선택 보류",
            };
          });
        };
        const results = await Promise.allSettled([
          claudeStatus(),
          codex.status(providers),
        ]);
        signal.throwIfAborted();
        return results.flatMap((result, index) =>
          result.status === "fulfilled"
            ? result.value
            : [
                {
                  id: `${index}-unavailable`,
                  base: index === 0 ? ("claude" as const) : ("codex" as const),
                  label: "상태 확인 보류",
                  status:
                    "호스트 연결·공식 로그인 상태를 확인하세요. 다른 프로바이더의 계정 분배는 유지됩니다.",
                },
              ],
        );
      },
      { onRelogin: () => reader.invalidate() },
    ),
    registerLegacyCredentialRpc(server, paseoHome),
    server.before(
      "agent.session_open",
      async ({ request }, { signal, paseo }) => {
        if (
          request.purpose !== "interactive" ||
          !couldBeClaude(
            request.provider,
            (await paseo.config.get()).config.providers ?? {},
          )
        )
          return;
        // A dry run has no session behind it: decide only, and keep every route and binding as is.
        const preflight =
          (request as { preflight?: boolean }).preflight === true;
        if (
          preflight &&
          (request.env.ASTER_DISABLED === "1" ||
            authenticationOverrides.some(
              (key) => request.env[key] || process.env[key],
            ))
        )
          return;
        if (
          request.env.ASTER_DISABLED === "1" ||
          authenticationOverrides.some(
            (key) => request.env[key] || process.env[key],
          )
        ) {
          excluded.add(request.agentId);
          await routes.exclude(request.agentId);
          return;
        }
        try {
          return await controller.serialize(async () => {
            signal.throwIfAborted();
            const settings = await readSettings();
            const accounts = await discoverAccounts();
            if (!preflight)
              await restoreRoute(request.agentId, accounts, false);
            const eligible = await subscriptions.filter(
              accounts,
              async () => (await paseo.config.get()).config.providers ?? {},
              signal,
            );
            if (!eligible.length && accounts.length)
              throw new AccountUnavailable(
                "Aster: 현재 Claude Code 구독을 사용할 수 있는 계정이 없습니다. 기존 대화와 로그인은 유지됩니다.",
              );
            const preserveAccount = () => {
              const id =
                controller.bindings.get(request.agentId)?.accountId ??
                request.env.ASTER_ACCOUNT_ID ??
                (request.provider !== "claude" ? request.provider : null);
              const account = eligible.find((entry) => entry.id === id);
              if (!account && id && accounts.some((entry) => entry.id === id))
                throw new AccountUnavailable(
                  "Aster: 기존 계정의 구독을 사용할 수 없고 전환할 계정의 한도를 확인하지 못했습니다. 잠시 후 다시 시도하세요.",
                );
              return account ? withAccount(request, account) : undefined;
            };
            let reports;
            try {
              reports = await readUsage(settings.command, signal);
            } catch (error) {
              signal.throwIfAborted();
              if (request.reason === "create") throw error;
              console.warn(
                `[aster] session ${request.agentId}: 사용량 조회 실패, 기존 환경으로 재개`,
              );
              return preserveAccount();
            }
            const readings = mapReports(eligible, reports, settings.capacities);
            const unavailableMessage = () => {
              const resetAt = exhaustedAccountsResetAt(eligible, reports);
              if (resetAt !== null) {
                const when = new Date(resetAt).toLocaleString("ko-KR", {
                  timeZone: "Asia/Seoul",
                  month: "numeric",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return `Aster: 모든 Claude 계정의 사용 한도가 소진되었습니다. 가장 빠른 초기화는 ${when}(한국시간)입니다. 초기화 후 자동으로 다시 선택됩니다.`;
              }
              return readings.length === 0
                ? NO_USAGE_READINGS
                : NO_SELECTABLE_ACCOUNT;
            };
            if (preflight) {
              if (
                controller.choose(request.agentId, readings, Date.now()) ||
                controller.canBootstrap(
                  bootstrapAccounts(eligible, reports, Date.now(), (id) =>
                    controller.isBlocked(id, Date.now()),
                  ).map((account) => account.id),
                  Date.now(),
                )
              )
                return;
              throw new Error(unavailableMessage());
            }
            let selectedId =
              controller.choose(request.agentId, readings, Date.now())?.id ??
              null;
            const previousId =
              controller.bindings.get(request.agentId)?.accountId ??
              request.env.ASTER_ACCOUNT_ID ??
              (request.provider !== "claude" ? request.provider : null);
            const previousAccount = eligible.find(
              (entry) => entry.id === previousId,
            );
            const previousExhausted =
              previousAccount !== undefined &&
              exhaustedUntil(previousAccount, reports) !== null;
            if (
              !selectedId &&
              (request.reason === "create" ||
                authenticationRecovery.has(request.agentId) ||
                refreshing.has(request.agentId) ||
                previousExhausted ||
                !hasPreviousAccount(
                  request,
                  controller.bindings.has(request.agentId),
                ))
            ) {
              selectedId = controller.bootstrap(
                request.agentId,
                bootstrapAccounts(eligible, reports, Date.now(), (id) =>
                  controller.isBlocked(id, Date.now()),
                ).map((account) => account.id),
                Date.now(),
              );
              if (selectedId) {
                bootstrapping.add(request.agentId);
                console.info(
                  `[aster] session ${request.agentId}: 불완전하거나 만료된 사용량을 CLI 정상 확인 경로로 재개`,
                );
              }
            }
            signal.throwIfAborted();
            if (!selectedId) {
              if (exhaustedAccountsResetAt(eligible, reports) !== null)
                throw new AccountUnavailable(unavailableMessage());
              if (request.reason !== "create") {
                console.warn(
                  `[aster] session ${request.agentId}: 선택 가능한 사용량 정보 없음, 기존 환경으로 재개`,
                );
                return preserveAccount();
              }
              throw new Error(unavailableMessage());
            }
            const account = accounts.find((entry) => entry.id === selectedId)!;
            controller.bind(request.agentId, account.id, Date.now());
            await routes.save(
              request.agentId,
              account,
              controller.bindings.get(request.agentId)!,
            );
            signal.throwIfAborted();
            excluded.delete(request.agentId);
            console.info(`[aster] session ${request.agentId}: ${account.id}`);
            return withAccount(request, account);
          });
        } catch (error) {
          signal.throwIfAborted();
          if (
            request.reason === "create" ||
            error instanceof AccountUnavailable
          )
            throw error;
          console.warn(
            `[aster] session ${request.agentId}: 자동 계정 설정 오류, 기존 실행 환경으로 재개`,
          );
          return;
        }
      },
    ),
    server.on("agent.turn_started", ({ agent, turnId }) => {
      const currentTurn = turnId ?? null;
      if (
        currentTurn !== null
          ? startedTurns.get(agent.id) !== currentTurn
          : !controller.busy.has(agent.id)
      )
        authenticationRecovery.delete(agent.id);
      startedTurns.set(agent.id, currentTurn);
      turnRevisions.set(agent.id, ++turnSequence);
      controller.busy.add(agent.id);
    }),
    server.on("agent.permission_requested", ({ agent }) => {
      controller.pendingPermission.add(agent.id);
    }),
    server.on("agent.permission_resolved", ({ agent }) => {
      controller.pendingPermission.delete(agent.id);
    }),
    server.on("agent.closed", ({ agent }) => {
      if (!refreshing.has(agent.id)) {
        controller.close(agent.id);
        excluded.delete(agent.id);
        authenticationRecovery.delete(agent.id);
        startedTurns.delete(agent.id);
        turnRevisions.delete(agent.id);
        bootstrapping.delete(agent.id);
      }
    }),
    server.on("agent.archived", ({ agent }) => {
      controller.close(agent.id);
      excluded.delete(agent.id);
      authenticationRecovery.delete(agent.id);
      startedTurns.delete(agent.id);
      turnRevisions.delete(agent.id);
      bootstrapping.delete(agent.id);
      void routes.forget(agent.id);
    }),
    server.on(
      "agent.turn_ended",
      async ({ agent, turnId, outcome, timeline }, { paseo, signal }) => {
        const activeTurn = startedTurns.get(agent.id);
        const revision = turnRevisions.get(agent.id);
        if (turnId != null && activeTurn != null && turnId !== activeTurn)
          return;
        controller.end(agent.id);
        const stillCurrent = () =>
          turnRevisions.get(agent.id) === revision &&
          startedTurns.get(agent.id) === activeTurn &&
          !controller.busy.has(agent.id);
        if (
          outcome.kind === "canceled" ||
          excluded.has(agent.id) ||
          refreshing.has(agent.id)
        )
          return;
        if (
          !controller.bindings.has(agent.id) &&
          !couldBeClaude(
            agent.provider,
            (await paseo.config.get()).config.providers ?? {},
          )
        )
          return;
        const subscriptionFailed = needsSubscriptionRecovery(outcome, timeline);
        const authenticationFailed =
          !subscriptionFailed && needsAuthenticationRecovery(outcome, timeline);
        if (bootstrapping.delete(agent.id)) reader.invalidate();
        if (
          (authenticationFailed || subscriptionFailed) &&
          authenticationRecovery.has(agent.id)
        )
          return;
        if (
          !authenticationFailed &&
          !subscriptionFailed &&
          outcome.kind === "completed"
        )
          authenticationRecovery.delete(agent.id);
        const limited =
          !authenticationFailed &&
          !subscriptionFailed &&
          needsLimitRecovery(outcome, timeline);
        if (
          outcome.kind === "failed" &&
          !authenticationFailed &&
          !subscriptionFailed &&
          !limited
        )
          return;
        if (authenticationFailed || subscriptionFailed || limited)
          reader.invalidate();
        const settings = await readSettings();
        const accounts = await discoverAccounts();
        if (!stillCurrent()) return;
        await restoreRoute(agent.id, accounts, true);
        if (excluded.has(agent.id) || !stillCurrent()) return;
        const binding = controller.bindings.get(agent.id);
        if (subscriptionFailed) {
          const failed = accounts.find(
            (account) =>
              account.id ===
              (binding?.accountId ??
                (agent.provider !== "claude" ? agent.provider : null)),
          );
          if (failed) await subscriptions.deny(failed, stillCurrent);
        }
        const eligible = await subscriptions.filter(
          accounts,
          async () => (await paseo.config.get()).config.providers ?? {},
          signal,
        );
        let readings: ReturnType<typeof mapReports>;
        let reports: Awaited<ReturnType<typeof readUsage>> = [];
        try {
          reports = await readUsage(settings.command, signal);
          readings = mapReports(eligible, reports, settings.capacities);
        } catch (error) {
          signal.throwIfAborted();
          if (!authenticationFailed && !subscriptionFailed) throw error;
          readings = [];
        }
        signal.throwIfAborted();
        if (!stillCurrent()) return;
        if (authenticationFailed || subscriptionFailed || limited)
          limitRoute(agent.id, agent.provider, accounts);
        const selectedId =
          controller.choose(agent.id, readings, Date.now())?.id ??
          (authenticationFailed || subscriptionFailed || limited
            ? bootstrapAccounts(eligible, reports, Date.now(), (id) =>
                controller.isBlocked(id, Date.now()),
              )[0]?.id
            : undefined);
        if (
          (!authenticationFailed &&
            (!selectedId || selectedId === binding?.accountId)) ||
          controller.busy.has(agent.id) ||
          controller.pendingPermission.has(agent.id)
        )
          return;
        const snapshot = await paseo.agents.ref(agent.id).refresh();
        signal.throwIfAborted();
        if (
          !snapshot ||
          !["idle", "error"].includes(snapshot.agent.status) ||
          snapshot.agent.pendingPermissions.length > 0 ||
          !stillCurrent()
        )
          return;
        refreshing.add(agent.id);
        if (authenticationFailed || subscriptionFailed)
          authenticationRecovery.add(agent.id);
        try {
          if (limited)
            console.info(
              `[aster] session ${agent.id}: 한도에 걸린 계정을 제외하고 연결 전환 (요청 재전송 없음)`,
            );
          if (authenticationFailed)
            console.info(
              `[aster] session ${agent.id}: 인증 실행 환경 새로고침 (요청 재전송 없음)`,
            );
          if (subscriptionFailed)
            console.info(
              `[aster] session ${agent.id}: 구독을 사용할 수 없는 계정을 제외하고 연결 전환 (요청 재전송 없음)`,
            );
          await runPaseo(
            settings.command,
            ["agent", "reload", agent.id, "--json", "--home", paseoHome],
            signal,
            10_000,
          );
        } finally {
          refreshing.delete(agent.id);
        }
      },
    ),
  ];
  return () => {
    reader.dispose();
    subscriptions.dispose();
    unregister.forEach((remove) => remove());
  };
}
