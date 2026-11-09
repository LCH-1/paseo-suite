import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";

const fixtureAccount = {
  id: "fixture",
  home: "/fixture",
  email: "fixture@example.invalid",
  identity: "org-fixture|fixture",
};
const actual = (file: string) =>
  JSON.stringify(new URL(file, import.meta.url).href);

/** Execute the actual before-hook with account/RPC dependencies replaced before import. */
async function openFixture(usage: "exhausted" | "available" | "unknown") {
  const now = Date.now();
  const reports =
    usage === "unknown"
      ? []
      : [
          {
            id: "claude:fixture@example.invalid.org-fixture",
            sourceId: "claude",
            fetchedAt: new Date(now).toISOString(),
            account: { label: fixtureAccount.email },
            report: {
              status: "available",
              windows: [
                {
                  id: "five_hour",
                  usedPct: usage === "exhausted" ? 100 : 0,
                  resetsAt: new Date(now + 3_600_000).toISOString(),
                },
                {
                  id: "weekly",
                  usedPct: usage === "exhausted" ? 100 : 0,
                  resetsAt: new Date(now + 86_400_000).toISOString(),
                },
              ],
            },
          },
        ];
  const noOp = "() => {}";
  const mock = new Map([
    [
      "./server/accounts",
      `
      export * from ${actual("./accounts.ts")};
      export const paseoHome="/fixture", stateDirectory="/fixture";
      export async function discoverAccounts(){return ${JSON.stringify([fixtureAccount])}}
      export async function readSettings(){return {command:{file:"mock-only",args:[]},capacities:{}}}
      export class UsageReader{async read(){return ${JSON.stringify(reports)}} invalidate(){} dispose(){}}
    `,
    ],
    [
      "./server/controller",
      `export {Controller} from ${actual("./controller.ts")}`,
    ],
    [
      "./server/scheduler",
      `export {rankAccounts} from ${actual("./scheduler.ts")}`,
    ],
    [
      "./server/routing-cache",
      "export const accountKey=account=>account.id; export class RoutingCache{async load(){return null} async save(){} async exclude(){} async forget(){}}",
    ],
    [
      "./server/subscription",
      "export class SubscriptionGuard{async filter(accounts){return accounts} dispose(){}} export const needsSubscriptionRecovery=()=>false",
    ],
    [
      "./server/auth-recovery",
      "export const needsAuthenticationRecovery=()=>false, needsLimitRecovery=()=>false",
    ],
    [
      "./server/paseo",
      "export const runPaseo=()=>{throw Error('Unexpected CLI invocation')}",
    ],
    [
      "./server/profile-discovery",
      "export const profileDiscovery=()=>async()=>[]",
    ],
    [
      "./server/profile-usage-runtime.js",
      "export const inputSchema={},discover=()=>[],configuredClaudeProviders=()=>[],fetchUsage=()=>[]",
    ],
    [
      "./server/usage-revision",
      "export const usageRevision=()=>async()=>false",
    ],
    [
      "./server/legacy-credential-rpc",
      `export const registerLegacyCredentialRpc=()=>${noOp}`,
    ],
    [
      "./server/codex",
      `export const registerCodexRouting=()=>({dispose:${noOp},status:async()=>[]})`,
    ],
    ["./server/hidden-aliases", `export const keepAliasesHidden=()=>${noOp}`],
    [
      "./server/account-management",
      `export const registerAccountManagement=()=>${noOp}`,
    ],
    ["./server/provider-policy", "export const providerFamily=id=>id"],
  ]);
  const bundled = await build({
    entryPoints: [
      fileURLToPath(new URL("../index.server.ts", import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "isolated-aster-session-open",
        setup(builder) {
          builder.onResolve({ filter: /^file:/ }, (args) => ({
            path: args.path,
            external: true,
          }));
          builder.onResolve({ filter: /^\.\/server\// }, (args) => {
            if (!mock.has(args.path))
              throw Error("Unmocked Aster dependency: " + args.path);
            return { path: args.path, namespace: "fixture" };
          });
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents: mock.get(args.path),
            loader: "ts",
          }));
        },
      },
    ],
  });
  const module = await import(
    "data:text/javascript;base64," +
      Buffer.from(bundled.outputFiles[0].contents).toString("base64")
  );
  const context = {
    signal: new AbortController().signal,
    paseo: {
      config: { get: async () => ({ config: { providers: { claude: {} } } }) },
    },
  };
  type OpenHook = (
    input: { request: PluginSessionOpenRequest },
    hookContext: typeof context,
  ) => Promise<PluginSessionOpenRequest | undefined>;
  let hook: OpenHook = async () => {
    throw Error("Missing session-open hook");
  };
  const dispose = module.default({
    registerUsageSource() {},
    before(_name: string, handler: OpenHook) {
      hook = handler;
      return () => {};
    },
    on() {
      return () => {};
    },
  });
  const request: PluginSessionOpenRequest = {
    agentId: "fixture-agent",
    workspaceId: null,
    provider: "claude",
    cwd: "/fixture",
    purpose: "interactive",
    reason: "resume",
    env: { ASTER_ACCOUNT_ID: fixtureAccount.id },
  };
  return {
    open: (overrides: Partial<PluginSessionOpenRequest> = {}) =>
      hook({ request: { ...request, ...overrides } }, context),
    dispose,
  };
}

test("확인된 전체 소진은 기존 Claude interactive 재개도 즉시 거절하고 history는 보존한다", async () => {
  const fixture = await openFixture("exhausted");
  try {
    await assert.rejects(fixture.open(), /모든 Claude 계정의 사용 한도가 소진/);
    await assert.rejects(
      fixture.open({ reason: "refresh" }),
      /모든 Claude 계정의 사용 한도가 소진/,
    );
    assert.equal(await fixture.open({ purpose: "history" }), undefined);
  } finally {
    fixture.dispose();
  }
});

test("한도가 남은 계정은 기존 Claude 재개와 새 대화 모두 정상 선택한다", async () => {
  const fixture = await openFixture("available");
  try {
    for (const reason of ["resume", "create"] as const) {
      const opened = await fixture.open({ reason });
      assert.equal(opened?.env.ASTER_ACCOUNT_ID, fixtureAccount.id);
      assert.equal(opened?.env.CLAUDE_CONFIG_DIR, fixtureAccount.home);
    }
  } finally {
    fixture.dispose();
  }
});

test("사용량이 미확인인 기존 계정은 전체 소진으로 오인하지 않는다", async () => {
  const fixture = await openFixture("unknown");
  try {
    assert.equal(
      (await fixture.open())?.env.ASTER_ACCOUNT_ID,
      fixtureAccount.id,
    );
  } finally {
    fixture.dispose();
  }
});
