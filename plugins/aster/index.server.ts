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
  const turnStarts = new Map<string, number>();
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
              } else {
                // A block only ranks accounts. With nothing else left the CLI reports the limit
                // itself, so a block never becomes "no selectable account".
                selectedId =
                  controller.choose(
                    request.agentId,
                    readings,
                    Date.now(),
                    null,
                    true,
                  )?.id ?? null;
                if (!selectedId) {
                  selectedId = controller.bootstrap(
                    request.agentId,
                    bootstrapAccounts(eligible, reports).map(
                      (account) => account.id,
                    ),
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
                ? "이전 계정 한도 소진"
                : !previousAccount
                  ? "이전 계정 구독·등록 확인 불가"
                  : controller.isBlocked(previousAccount.id, Date.now())
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
        const limit =
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
        if (
          !family &&
          boundId &&
          controller.hasModelLimit(boundId, Date.now())
        ) {
          const current = await paseo.agents.ref(agent.id).refresh();
          signal.throwIfAborted();
          if (!stillCurrent()) return skip("새 턴 시작");
          family = modelFamily(
            current?.agent.runtimeInfo?.model ?? current?.agent.model,
          );
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
              }${limit.family ? `, ${limit.family} 모델 한정` : ""})`,
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
            ? bootstrapAccounts(eligible, reports, now, (id) =>
                controller.isBlocked(id, now, family),
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
