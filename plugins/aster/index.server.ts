import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  accountSecureDirectory,
  bootstrapAccounts,
  exhaustedModels,
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
  continuedAfterLimit,
  LIMIT_CONTINUATION,
  limitSignal,
  modelFamily,
  needsAuthenticationRecovery,
} from "./server/auth-recovery";
import { Controller, type AccountLimit } from "./server/controller";
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
import { modelUsage, rankAccounts } from "./server/scheduler";

const NO_USAGE_READINGS =
  "Aster: Claude 계정의 사용량 정보를 확인할 수 없습니다. Paseo 사용량 화면과 각 계정의 실제 로그인 상태를 확인하세요. 이전 로그인 표시는 현재 인증 상태를 보장하지 않습니다.";
const NO_SELECTABLE_ACCOUNT =
  "Aster: Claude 계정의 잔여 한도 또는 최신 초기화 정보를 확인하세요. 현재 자동 선택 가능한 계정이 없습니다.";

class AccountUnavailable extends Error {}

const familyName = (family: string) =>
  family.charAt(0).toUpperCase() + family.slice(1);

/** The lookup's answer, or null when it fails or does not answer within `ms`. */
function settleWithin<T>(task: Promise<T>, ms: number) {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    task.then(resolve, () => resolve(null)).finally(() => clearTimeout(timer));
  });
}

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
  const turnStarts = new Map<string, number>();
  let turnSequence = 0;
  const bootstrapping = new Set<string>();
  /** The model family a reload Aster started itself decided for, so the reopen agrees with it. */
  const reloadFamilies = new Map<string, string | null>();
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
  /** Every alias of the real account behind `id`. */
  const sameAccount = (accounts: Account[], id: string | null) => {
    const target = accounts.find((account) => account.id === id);
    return target
      ? accounts.filter((account) => accountKey(account) === accountKey(target))
      : [];
  };
  const limitRoute = (
    agentId: string,
    provider: string,
    accounts: Account[],
    limit?: AccountLimit,
  ) => {
    const id =
      controller.bindings.get(agentId)?.accountId ??
      (provider !== "claude" ? provider : null);
    let until: number | null = null;
    for (const account of sameAccount(accounts, id))
      until = controller.limitAccount(account.id, Date.now(), limit);
    return until;
  };
  const hasModelLimits = (readings: ReturnType<typeof mapReports>) =>
    readings.some((reading) => Object.keys(reading.models ?? {}).length > 0);
  /**
   * The model family a session opens on: the host's request names the model when it can, a reload
   * Aster started itself carries the family it chose for, and otherwise the running agent tells,
   * read in the same order as at the end of a turn so both choose for the same model.
   * Without any of them the model's own limits are left out of the choice.
   */
  const sessionFamily = async (
    request: PluginSessionOpenRequest,
    paseo: PluginHookContext["paseo"],
    readings: ReturnType<typeof mapReports>,
    accounts: Account[],
  ) => {
    // A null model is the provider's default, which only the running session can name.
    const requested = (request as { model?: string | null }).model;
    const named = typeof requested === "string" ? modelFamily(requested) : null;
    if (named) return named;
    if (reloadFamilies.has(request.agentId))
      return reloadFamilies.get(request.agentId) ?? null;
    const now = Date.now();
    if (
      request.reason === "create" ||
      (!hasModelLimits(readings) &&
        !accounts.some((account) => controller.hasModelLimit(account.id, now)))
    )
      return null;
    const current = await settleWithin(
      Promise.resolve().then(() => paseo.agents.ref(request.agentId).refresh()),
      2_000,
    );
    return (
      modelFamily(current?.agent.runtimeInfo?.model) ??
      modelFamily(current?.agent.model)
    );
  };
  const clock = (at: number) =>
    new Date(at).toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

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
            // A spent model limit leaves the account usable for every other model.
            const spentModels = exhaustedModels(account, reports)
              .map(
                ({ family, resetsAt }) =>
                  `${familyName(family)} 한도 소진${resetsAt === null ? "" : `(${clock(resetsAt)} 이후 복귀)`}`,
              )
              .join(" · ");
            const withModels = (status: string) =>
              spentModels ? `${status} · ${spentModels}` : status;
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
                  ? spentModels
                    ? `사용 가능 · ${spentModels}`
                    : "자동 분배 중"
                  : loginLost
                    ? "로그인 풀림 · 다시 로그인 필요"
                    : startable.has(account.id)
                      ? withModels("사용 가능 · 첫 사용 후 사용량 표시")
                      : resumesAt
                        ? `한도 소진 · ${clock(resumesAt)} 이후 자동 복귀`
                        : withModels(
                            "구독·잔여 한도 확인 필요 · 자동 선택 보류",
                          ),
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
              // A block only ranks accounts, so a blocked one still counts as startable.
              if (
                controller.choose(
                  request.agentId,
                  readings,
                  Date.now(),
                  null,
                  true,
                ) ||
                controller.canBootstrap(
                  bootstrapAccounts(eligible, reports).map(
                    (account) => account.id,
                  ),
                  Date.now(),
                  true,
                )
              )
                return;
              throw new Error(unavailableMessage());
            }
            const family = await sessionFamily(
              request,
              paseo,
              readings,
              eligible,
            );
            signal.throwIfAborted();
            // A spent limit of the session's model rules an account out before the current account
            // is kept for its cooldown, so a model change can leave the account that refused it.
            let selectedId =
              controller.choose(request.agentId, readings, Date.now(), family)
                ?.id ?? null;
            const previousId =
              controller.bindings.get(request.agentId)?.accountId ??
              request.env.ASTER_ACCOUNT_ID ??
              (request.provider !== "claude" ? request.provider : null);
            const previousAccount = eligible.find(
              (entry) => entry.id === previousId,
            );
            const previousExhausted =
              previousAccount !== undefined &&
              exhaustedUntil(previousAccount, reports, Date.now(), family) !==
                null;
            const mayBootstrap =
              request.reason === "create" ||
              authenticationRecovery.has(request.agentId) ||
              refreshing.has(request.agentId) ||
              previousExhausted ||
              !hasPreviousAccount(
                request,
                controller.bindings.has(request.agentId),
              );
            let blockedOnly = false;
            if (!selectedId && mayBootstrap) {
              selectedId = controller.bootstrap(
                request.agentId,
                bootstrapAccounts(
                  eligible,
                  reports,
                  Date.now(),
                  (id) => controller.isBlocked(id, Date.now(), family),
                  family,
                ).map((account) => account.id),
                Date.now(),
              );
              if (selectedId) {
                bootstrapping.add(request.agentId);
                console.info(
                  `[aster] session ${request.agentId}: 불완전하거나 만료된 사용량을 CLI 정상 확인 경로로 재개`,
                );
              } else {
                // A block only ranks accounts. With nothing else left the CLI reports the limit
                // itself, so a block never becomes "no selectable account".
                selectedId =
                  controller.choose(
                    request.agentId,
                    readings,
                    Date.now(),
                    family,
                    true,
                  )?.id ?? null;
                if (!selectedId) {
                  selectedId = controller.bootstrap(
                    request.agentId,
                    bootstrapAccounts(
                      eligible,
                      reports,
                      Date.now(),
                      () => false,
                      family,
                    ).map((account) => account.id),
                    Date.now(),
                    true,
                  );
                  if (selectedId) bootstrapping.add(request.agentId);
                }
                blockedOnly = selectedId !== null;
              }
            }
            const switchReason = blockedOnly
              ? "차단 중인 계정뿐이라 CLI 확인 경로"
              : previousExhausted
                ? family && exhaustedUntil(previousAccount, reports) === null
                  ? `이전 계정 ${familyName(family)} 한도 소진`
                  : "이전 계정 한도 소진"
                : !previousAccount
                  ? "이전 계정 구독·등록 확인 불가"
                  : controller.isBlocked(previousAccount.id, Date.now(), family)
                    ? "이전 계정 한도·인증 차단 중"
                    : !readings.some(
                          (reading) => reading.id === previousAccount.id,
                        )
                      ? "이전 계정 사용량 미확인"
                      : "여유 계정 우선";
            signal.throwIfAborted();
            if (!selectedId) {
              if (exhaustedAccountsResetAt(eligible, reports) !== null)
                throw new AccountUnavailable(unavailableMessage());
              // Every account spent only this model's limit: the accounts still serve other models,
              // so an existing conversation keeps opening and a new one is told what to change.
              const modelResetAt = family
                ? exhaustedAccountsResetAt(
                    eligible,
                    reports,
                    Date.now(),
                    family,
                  )
                : null;
              if (
                family &&
                modelResetAt !== null &&
                request.reason === "create"
              )
                throw new AccountUnavailable(
                  `Aster: 모든 Claude 계정의 ${familyName(family)} 한도가 소진되었습니다. 가장 빠른 초기화는 ${clock(modelResetAt)}(한국시간)입니다. 다른 모델을 선택하거나 초기화 후 다시 시도하세요.`,
                );
              if (request.reason !== "create") {
                console.warn(
                  modelResetAt !== null
                    ? `[aster] session ${request.agentId}: 모든 계정의 ${family} 한도 소진, 기존 환경으로 재개`
                    : `[aster] session ${request.agentId}: 선택 가능한 사용량 정보 없음, 기존 환경으로 재개`,
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
            console.info(
              `[aster] session ${request.agentId}: ${account.id}` +
                (blockedOnly
                  ? ` (${switchReason})`
                  : previousId && previousId !== account.id
                    ? ` (이전 ${previousId}, 사유: ${switchReason})`
                    : ""),
            );
            return withAccount(request, account);
          });
        } catch (error) {
          signal.throwIfAborted();
          if (
            request.reason === "create" ||
            error instanceof AccountUnavailable
          ) {
            if (!preflight)
              console.info(
                `[aster] session ${request.agentId}: 세션 열기 거절 (${request.reason}) · ${
                  error instanceof Error && error.message.startsWith("Aster:")
                    ? error.message.slice(0, 120)
                    : "계정 선택 중 오류"
                }`,
              );
            throw error;
          }
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
      turnStarts.set(agent.id, Date.now());
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
        turnStarts.delete(agent.id);
        bootstrapping.delete(agent.id);
      }
    }),
    server.on("agent.archived", ({ agent }) => {
      controller.close(agent.id);
      excluded.delete(agent.id);
      authenticationRecovery.delete(agent.id);
      startedTurns.delete(agent.id);
      turnRevisions.delete(agent.id);
      turnStarts.delete(agent.id);
      bootstrapping.delete(agent.id);
      void routes.forget(agent.id);
    }),
    server.on(
      "agent.turn_ended",
      async ({ agent, turnId, outcome, timeline }, { paseo, signal }) => {
        const activeTurn = startedTurns.get(agent.id);
        const revision = turnRevisions.get(agent.id);
        const startedAt = turnStarts.get(agent.id);
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
        let limit =
          authenticationFailed || subscriptionFailed
            ? null
            : limitSignal(outcome, timeline);
        const limited = limit !== null;
        if (
          outcome.kind === "failed" &&
          !authenticationFailed &&
          !subscriptionFailed &&
          !limited
        )
          return;
        const trouble = limited
          ? "한도"
          : authenticationFailed
            ? "인증 오류"
            : subscriptionFailed
              ? "구독 오류"
              : null;
        // An ordinary turn stays silent; only a detected failure says why no switch followed.
        const skip = (why: string) => {
          if (trouble)
            console.info(
              `[aster] session ${agent.id}: ${trouble} 감지, 전환 건너뜀 (${why})`,
            );
        };
        if (trouble) reader.invalidate();
        const settings = await readSettings();
        const accounts = await discoverAccounts();
        if (!stillCurrent()) return skip("새 턴 시작");
        await restoreRoute(agent.id, accounts, true);
        if (excluded.has(agent.id)) return;
        if (!stillCurrent()) return skip("새 턴 시작");
        const binding = controller.bindings.get(agent.id);
        const boundId =
          binding?.accountId ??
          (agent.provider !== "claude" ? agent.provider : null);
        if (subscriptionFailed) {
          const failed = accounts.find((account) => account.id === boundId);
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
          // The CLI's own notice still blocks the account while the usage lookup is down.
          if (!trouble) throw error;
          readings = [];
        }
        signal.throwIfAborted();
        if (!stillCurrent()) return skip("새 턴 시작");
        let family = limit?.family ?? null;
        let inferred = false;
        if (
          !family &&
          boundId &&
          (hasModelLimits(readings) ||
            controller.hasModelLimit(boundId, Date.now()))
        ) {
          // Every Claude report names a model limit now, so a failed lookup only leaves the model unknown.
          const current = await settleWithin(
            Promise.resolve().then(() => paseo.agents.ref(agent.id).refresh()),
            2_000,
          );
          signal.throwIfAborted();
          if (!stillCurrent()) return skip("새 턴 시작");
          family =
            modelFamily(current?.agent.runtimeInfo?.model) ??
            modelFamily(current?.agent.model);
          // A notice that names no model, from a session whose model the fresh usage shows spent
          // while the account itself still has room, is that model's limit and not the account's.
          const reading = readings.find((entry) =>
            sameAccount(accounts, boundId).some(
              (account) => account.id === entry.id,
            ),
          );
          const model = reading && modelUsage(reading, family);
          if (
            limit &&
            family &&
            reading &&
            model &&
            model.used >= 100 &&
            reading.weekly.used < 100 &&
            (reading.fiveHour === null || reading.fiveHour.used < 100)
          ) {
            limit = { ...limit, family };
            inferred = true;
          }
        }
        if (trouble) {
          const until = limitRoute(
            agent.id,
            agent.provider,
            accounts,
            limit ? { ...limit, startedAt } : undefined,
          );
          if (limit && until !== null)
            console.info(
              `[aster] account ${boundId}: 한도 차단 ${clock(until)}까지 (${
                limit.resetsAt
                  ? "안내된 초기화 시각"
                  : "초기화 시각 없음, 점증 대기"
              }${limit.family ? `, ${limit.family} 모델 한정${inferred ? "(사용량 확인)" : ""}` : ""})`,
            );
        } else if (
          startedAt !== undefined &&
          sameAccount(accounts, boundId).filter((account) =>
            controller.succeeded(account.id, startedAt, Date.now(), family),
          ).length
        )
          console.info(
            `[aster] account ${boundId}: 정상 응답 확인, 한도 차단 해제`,
          );
        const now = Date.now();
        const selectedId =
          controller.choose(agent.id, readings, now, family)?.id ??
          (trouble
            ? bootstrapAccounts(
                eligible,
                reports,
                now,
                (id) => controller.isBlocked(id, now, family),
                family,
              ).find(
                (account) => !controller.isBlocked(account.id, now, family),
              )?.id
            : undefined);
        if (!authenticationFailed && !selectedId) return skip("후보 없음");
        if (!authenticationFailed && selectedId === binding?.accountId)
          return skip("같은 계정");
        if (controller.busy.has(agent.id)) return skip("작업 중");
        if (controller.pendingPermission.has(agent.id))
          return skip("권한 대기");
        const snapshot = await paseo.agents.ref(agent.id).refresh();
        signal.throwIfAborted();
        if (!snapshot) return skip("세션 없음");
        if (!["idle", "error"].includes(snapshot.agent.status))
          return skip("작업 중");
        if (snapshot.agent.pendingPermissions.length > 0)
          return skip("권한 대기");
        if (!stillCurrent()) return skip("새 턴 시작");
        refreshing.add(agent.id);
        reloadFamilies.set(agent.id, family);
        if (authenticationFailed || subscriptionFailed)
          authenticationRecovery.add(agent.id);
        const resume = limited && settings.continueAfterLimitSwitch === true;
        try {
          const route = `${binding?.accountId ?? "미지정"} → ${selectedId ?? binding?.accountId ?? "현재 계정"}`;
          if (limited)
            console.info(
              `[aster] session ${agent.id}: 한도에 걸린 계정을 제외하고 연결 전환 ${route} (${resume ? "전환 뒤 이어가기 예정" : "요청 재전송 없음"})`,
            );
          else if (authenticationFailed)
            console.info(
              `[aster] session ${agent.id}: 인증 실행 환경 새로고침 ${route} (요청 재전송 없음)`,
            );
          else if (subscriptionFailed)
            console.info(
              `[aster] session ${agent.id}: 구독을 사용할 수 없는 계정을 제외하고 연결 전환 ${route} (요청 재전송 없음)`,
            );
          else
            console.info(
              `[aster] session ${agent.id}: 여유 계정으로 연결 전환 ${route}`,
            );
          await runPaseo(
            settings.command,
            ["agent", "reload", agent.id, "--json", "--home", paseoHome],
            signal,
            10_000,
          );
        } finally {
          refreshing.delete(agent.id);
          reloadFamilies.delete(agent.id);
        }
        if (!resume) return;
        const pause = (why: string) =>
          console.info(`[aster] session ${agent.id}: 이어가기 생략 (${why})`);
        // The continuation's own turn can hit a limit too; one real request gets one continuation.
        if (continuedAfterLimit(timeline)) return pause("이미 한 번 이어감");
        const previous = sameAccount(accounts, boundId);
        const next = controller.bindings.get(agent.id)?.accountId;
        if (
          !next ||
          !previous.length ||
          previous.some((account) => account.id === next)
        )
          return pause("다른 계정으로 전환되지 않음");
        signal.throwIfAborted();
        if (!stillCurrent()) return pause("새 턴 시작");
        if (controller.pendingPermission.has(agent.id))
          return pause("권한 대기");
        const reloaded = await paseo.agents.ref(agent.id).refresh();
        signal.throwIfAborted();
        if (!reloaded) return pause("세션 없음");
        if (!["idle", "error"].includes(reloaded.agent.status))
          return pause("작업 중");
        if (reloaded.agent.pendingPermissions.length > 0)
          return pause("권한 대기");
        if (
          reloaded.agent.lastUserMessageAt !== snapshot.agent.lastUserMessageAt
        )
          return pause("새 사용자 메시지");
        if (!stillCurrent()) return pause("새 턴 시작");
        await paseo.agents.ref(agent.id).send(LIMIT_CONTINUATION);
        console.info(
          `[aster] session ${agent.id}: 한도 전환 뒤 이어가기 메시지 전송 (${boundId} → ${next})`,
        );
      },
    ),
  ];
  return () => {
    reader.dispose();
    subscriptions.dispose();
    unregister.forEach((remove) => remove());
  };
}
