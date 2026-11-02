import type { PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { accountSecureDirectory, bootstrapAccounts, discoverAccounts, mapReports, paseoHome, readSettings, stateDirectory, UsageReader, type Account } from "./server/accounts";
import { join } from "node:path";
import { accountKey, RoutingCache } from "./server/routing-cache";
import { needsAuthenticationRecovery } from "./server/auth-recovery";
import { Controller } from "./server/controller";
import { runPaseo } from "./server/paseo";
import {profileDiscovery} from "./server/profile-discovery";
import * as profileUsage from "./server/profile-usage-runtime.js";
import { needsSubscriptionRecovery, SubscriptionGuard } from "./server/subscription";
import { usageRevision } from "./server/usage-revision";
import { registerLegacyCredentialRpc } from "./server/legacy-credential-rpc";

export default function contribute(server: PluginServerContext) {
  const discoverProfiles = profileDiscovery(profileUsage.discover, profileUsage.configuredClaudeProviders);
  server.registerUsageSource({
    id: "claude-profiles", label: "Claude", input: profileUsage.inputSchema,
    discover: async scope => (await readSettings()).profileUsageFallback ? discoverProfiles(scope) : [],
    fetch: profileUsage.fetchUsage,
  });
  const reader = new UsageReader();
  const checkUsageRevision = usageRevision(paseoHome, () => reader.invalidate());
  const readUsage: UsageReader["read"] = async (command, signal) => {
    for (;;) {
      signal.throwIfAborted();
      await checkUsageRevision();
      const reports = await reader.read(command, signal);
      if (!await checkUsageRevision()) return reports;
    }
  };
  const controller = new Controller();
  const subscriptions = new SubscriptionGuard(join(stateDirectory,"subscription-access"),paseoHome);
  const routes = new RoutingCache(join(stateDirectory, "routing-cache"));
  const refreshing = new Set<string>();
  const excluded = new Set<string>();
  const authenticationRecovery = new Set<string>();
  const startedTurns = new Map<string, string | null>();
  const turnRevisions = new Map<string, number>();
  let turnSequence=0;
  const bootstrapping = new Set<string>();
  const authenticationOverrides = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_BASE_URL"];
  const couldBeClaude = (provider: string) => provider === "claude" || provider.startsWith("claude-");
  const withAccount = (request: PluginSessionOpenRequest, account: Account) => ({ ...request, env: { ...request.env, CLAUDE_CONFIG_DIR: account.home, CLAUDE_SECURESTORAGE_CONFIG_DIR: accountSecureDirectory(account), ...(process.platform === "win32" ? { CLAUDE_CODE_FORCE_WINDOWS_CREDMAN: "1" } : {}), ASTER_ACCOUNT_ID: account.id } });
  const restoreRoute = async (agentId: string, accounts: Account[], includeExcluded: boolean) => {
    if (controller.bindings.has(agentId)) return;
    const cached = await routes.load(agentId, accounts);
    if (cached?.kind === "managed") controller.restore(agentId, cached.binding);
    else if (includeExcluded && cached?.kind === "excluded") excluded.add(agentId);
  };
  const limitRoute = (agentId: string, provider: string, accounts: Account[]) => {
    const id = controller.bindings.get(agentId)?.accountId ?? (provider !== "claude" ? provider : null);
    const failed = accounts.find(account => account.id === id);
    if (failed) for (const account of accounts.filter(account => accountKey(account) === accountKey(failed))) controller.limitAccount(account.id, Date.now());
  };

  const unregister = [
    registerLegacyCredentialRpc(server, paseoHome),
    server.before("agent.session_open", async ({ request }, { signal, paseo }) => {
      if (!couldBeClaude(request.provider) || request.purpose !== "interactive") return;
      if (request.env.ASTER_DISABLED === "1" || authenticationOverrides.some((key) => request.env[key] || process.env[key])) {
        excluded.add(request.agentId);
        await routes.exclude(request.agentId);
        return;
      }
      try { return await controller.serialize(async () => {
        signal.throwIfAborted();
        const settings = await readSettings();
        const accounts = await discoverAccounts();
        if (request.provider !== "claude" && !accounts.some((account) => account.id === request.provider)) return;
        await restoreRoute(request.agentId, accounts, false);
        const eligible = await subscriptions.filter(accounts,async()=>(await paseo.config.get()).config.providers??{},signal);
        if(!eligible.length&&accounts.length&&request.reason==="create")throw Error("Aster: 현재 Claude Code 구독을 사용할 수 있는 계정이 없습니다. 구독 상태를 확인하세요. 기존 대화와 로그인은 유지됩니다.");
        const preserveAccount = () => {
          const id = controller.bindings.get(request.agentId)?.accountId ?? request.env.ASTER_ACCOUNT_ID ?? (request.provider !== "claude" ? request.provider : null);
          const account = accounts.find((entry) => entry.id === id);
          return account ? withAccount(request, account) : undefined;
        };
        let reports;
        try {
          reports = await readUsage(settings.command, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (request.reason === "create") throw error;
          console.warn(`[aster] session ${request.agentId}: 사용량 조회 실패, 기존 환경으로 재개`);
          return preserveAccount();
        }
        const readings = mapReports(eligible, reports, settings.capacities);
        let selectedId = controller.choose(request.agentId, readings, Date.now())?.id ?? null;
        if (!selectedId && (request.reason === "create" || authenticationRecovery.has(request.agentId))) {
          selectedId = controller.bootstrap(request.agentId, bootstrapAccounts(eligible, reports).map(account => account.id), Date.now());
          if (selectedId) { bootstrapping.add(request.agentId); console.info(`[aster] session ${request.agentId}: 불완전하거나 만료된 사용량을 CLI 정상 확인 경로로 재개`); }
        }
        signal.throwIfAborted();
        if (!selectedId) {
          if (request.reason !== "create") {
            console.warn(`[aster] session ${request.agentId}: 선택 가능한 사용량 정보 없음, 기존 환경으로 재개`);
            return preserveAccount();
          }
          if (readings.length === 0) throw new Error("Aster: Claude 계정의 사용량 정보를 확인할 수 없습니다. Paseo 사용량 화면과 각 계정의 실제 로그인 상태를 확인하세요. 이전 로그인 표시는 현재 인증 상태를 보장하지 않습니다.");
          throw new Error("Aster: Claude 계정의 잔여 한도 또는 최신 초기화 정보를 확인하세요. 현재 자동 선택 가능한 계정이 없습니다.");
        }
        const account = accounts.find((entry) => entry.id === selectedId)!;
        controller.bind(request.agentId, account.id, Date.now());
        await routes.save(request.agentId, account, controller.bindings.get(request.agentId)!);
        signal.throwIfAborted();
        excluded.delete(request.agentId);
        console.info(`[aster] session ${request.agentId}: ${account.id}`);
        return withAccount(request, account);
      }); } catch (error) {
        signal.throwIfAborted();
        if (request.reason === "create") throw error;
        console.warn(`[aster] session ${request.agentId}: 자동 계정 설정 오류, 기존 실행 환경으로 재개`);
        return;
      }
    }),
    server.on("agent.turn_started", ({ agent, turnId }) => {
      const currentTurn = turnId ?? null;
      if (currentTurn !== null ? startedTurns.get(agent.id) !== currentTurn : !controller.busy.has(agent.id)) authenticationRecovery.delete(agent.id);
      startedTurns.set(agent.id, currentTurn);
      turnRevisions.set(agent.id,++turnSequence);
      controller.busy.add(agent.id);
    }),
    server.on("agent.permission_requested", ({ agent }) => { controller.pendingPermission.add(agent.id); }),
    server.on("agent.permission_resolved", ({ agent }) => { controller.pendingPermission.delete(agent.id); }),
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
    server.on("agent.turn_ended", async ({ agent, turnId, outcome, timeline }, { paseo, signal }) => {
      const activeTurn = startedTurns.get(agent.id);
      const revision = turnRevisions.get(agent.id);
      if (turnId != null && activeTurn != null && turnId !== activeTurn) return;
      controller.end(agent.id);
      const stillCurrent = () => turnRevisions.get(agent.id) === revision && startedTurns.get(agent.id) === activeTurn && !controller.busy.has(agent.id);
      if (outcome.kind === "canceled" || excluded.has(agent.id) || refreshing.has(agent.id)) return;
      if (!controller.bindings.has(agent.id) && !couldBeClaude(agent.provider)) return;
      const subscriptionFailed=needsSubscriptionRecovery(outcome,timeline);
      const authenticationFailed = !subscriptionFailed && needsAuthenticationRecovery(outcome, timeline);
      if (bootstrapping.delete(agent.id)) reader.invalidate();
      if ((authenticationFailed||subscriptionFailed) && authenticationRecovery.has(agent.id)) return;
      if (!authenticationFailed && !subscriptionFailed && outcome.kind === "completed") authenticationRecovery.delete(agent.id);
      const limited = outcome.kind === "failed" && !authenticationFailed && !subscriptionFailed && /rate.?limit|usage.?limit|quota|limit reached|429/i.test(outcome.error.message + " " + (outcome.error.code ?? ""));
      if (outcome.kind === "failed" && !authenticationFailed && !subscriptionFailed && !limited) return;
      if (authenticationFailed || subscriptionFailed || limited) reader.invalidate();
      const settings = await readSettings();
      const accounts = await discoverAccounts();
      if (!stillCurrent()) return;
      if (agent.provider !== "claude" && !accounts.some((account) => account.id === agent.provider)) return;
      await restoreRoute(agent.id, accounts, true);
      if (excluded.has(agent.id) || !stillCurrent()) return;
      const binding = controller.bindings.get(agent.id);
      if(subscriptionFailed){
        const failed=accounts.find(account=>account.id===(binding?.accountId??(agent.provider!=="claude"?agent.provider:null)));
        if(failed)await subscriptions.deny(failed,stillCurrent);
      }
      const eligible=await subscriptions.filter(accounts,async()=>(await paseo.config.get()).config.providers??{},signal);
      let readings: ReturnType<typeof mapReports>;
      try {
        readings = mapReports(eligible, await readUsage(settings.command, signal), settings.capacities);
      } catch (error) {
        signal.throwIfAborted();
        if (!authenticationFailed&&!subscriptionFailed) throw error;
        readings = [];
      }
      signal.throwIfAborted();
      if (!stillCurrent()) return;
      if (authenticationFailed || subscriptionFailed || limited) limitRoute(agent.id, agent.provider, accounts);
      const selected = controller.choose(agent.id, readings, Date.now());
      if ((!authenticationFailed && (!selected || selected.id === binding?.accountId)) || controller.busy.has(agent.id) || controller.pendingPermission.has(agent.id)) return;
      const snapshot = await paseo.agents.ref(agent.id).refresh();
      signal.throwIfAborted();
      if (!snapshot || !["idle", "error"].includes(snapshot.agent.status) || snapshot.agent.pendingPermissions.length > 0 || !stillCurrent()) return;
      refreshing.add(agent.id);
      if (authenticationFailed||subscriptionFailed) authenticationRecovery.add(agent.id);
      try {
        if (authenticationFailed) console.info(`[aster] session ${agent.id}: 인증 실행 환경 새로고침 (요청 재전송 없음)`);
        if (subscriptionFailed) console.info(`[aster] session ${agent.id}: 구독을 사용할 수 없는 계정을 제외하고 연결 전환 (요청 재전송 없음)`);
        await runPaseo(settings.command, ["agent", "reload", agent.id, "--json", "--home", paseoHome], signal, 10_000);
      } finally {
        refreshing.delete(agent.id);
      }
    }),
  ];
  return () => {subscriptions.dispose();unregister.forEach((remove) => remove());};
}
