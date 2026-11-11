import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { randomUUID } from "node:crypto";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { LIMIT_CONTINUATION } from "./auth-recovery.ts";

const fixtureAccount = {
  id: "fixture",
  home: "/fixture",
  email: "fixture@example.invalid",
  identity: "org-fixture|fixture",
};
const actual = (file: string) =>
  JSON.stringify(new URL(file, import.meta.url).href);

/** Execute the actual before-hook with account/RPC dependencies replaced before import. */
async function openFixture(
  usage:
    | "exhausted"
    | "available"
    | "unknown"
    | "partial-reset"
    | "two-available"
    | "fable",
) {
  const now = Date.now();
  const recovered = {
    id: "recovered",
    home: "/recovered",
    email: "recovered@example.invalid",
    identity: "org-recovered|recovered",
  };
  const accounts =
    usage === "partial-reset" || usage === "two-available" || usage === "fable"
      ? [fixtureAccount, recovered]
      : [fixtureAccount];
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
  if (usage === "partial-reset") {
    // A report without a five-hour window is complete (that limit is gone), so the incomplete
    // answer left is one missing its weekly window: it scores nothing and only the CLI can check it.
    reports[0].report.windows = [
      {
        id: "weekly",
        usedPct: 100,
        resetsAt: new Date(now + 86400000).toISOString(),
      },
    ];
    reports.push({
      ...reports[0],
      id: "claude:recovered.org-recovered",
      account: { label: recovered.email },
      report: {
        status: "available",
        windows: [
          {
            id: "five_hour",
            usedPct: 0,
            resetsAt: new Date(now + 3600000).toISOString(),
          },
        ],
      },
    });
  }
  if (usage === "two-available")
    reports.push({
      ...structuredClone(reports[0]),
      id: "claude:recovered.org-recovered",
      account: { label: recovered.email },
    });
  if (usage === "fable") {
    // As measured on 2026-11-11: no five-hour window any more, weekly plus a Fable weekly limit.
    const weekly = (used: number, fable: number) => [
      {
        id: "weekly",
        usedPct: used,
        resetsAt: new Date(now + 6 * 86_400_000).toISOString(),
      },
      {
        id: "weekly_model_fable",
        usedPct: fable,
        resetsAt: new Date(now + 6 * 86_400_000).toISOString(),
      },
    ];
    reports[0].report.windows = weekly(59, 100);
    reports.push({
      ...structuredClone(reports[0]),
      id: "claude:recovered.org-recovered",
      account: { label: recovered.email },
      report: { status: "available", windows: weekly(0, 0) },
    });
  }
  const initialReports = structuredClone(reports);
  const key = "__asterTest_" + randomUUID().replaceAll("-", "");
  const sent: { agentId: string; text: string }[] = [];
  const shared = {
    reports: reports as typeof reports | null,
    settings: {} as Record<string, unknown>,
    snapshot: (_agentId: string): Record<string, unknown> => ({}),
    /** How many times an agent was looked up, and what holds a lookup's answer back. */
    lookups: 0,
    gate: null as null | ((agentId: string) => Promise<void> | undefined),
    /** What the host adds to the refresh request of a reload, such as the `model` it opens with. */
    reloadRequest: {} as Record<string, unknown>,
    reload: async (..._args: unknown[]) => "",
    status: null as
      | null
      | ((
          providers: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<{ id: string; status: string }[]>),
  };
  (globalThis as any)[key] = shared;
  const noOp = "() => {}";
  const mock = new Map([
    [
      "./server/accounts",
      `
      export * from ${actual("./accounts.ts")};
      export const paseoHome="/fixture", stateDirectory="/fixture";
      export async function discoverAccounts(){return ${JSON.stringify(accounts)}}
      export async function readSettings(){return {command:{file:"mock-only",args:[]},capacities:{},...globalThis[${JSON.stringify(key)}].settings}}
      export class UsageReader{async read(){const reports=globalThis[${JSON.stringify(key)}].reports; if(reports===null) throw Error("usage unavailable"); return reports} invalidate(){} dispose(){}}
    `,
    ],
    [
      "./server/controller",
      `export {Controller} from ${actual("./controller.ts")}`,
    ],
    ["./server/scheduler", `export * from ${actual("./scheduler.ts")}`],
    [
      "./server/routing-cache",
      "export const accountKey=account=>account.id; export class RoutingCache{async load(){return null} async save(){} async exclude(){} async forget(){}}",
    ],
    [
      "./server/subscription",
      "export class SubscriptionGuard{async filter(accounts){return accounts} dispose(){}} export const needsSubscriptionRecovery=()=>false",
    ],
    ["./server/auth-recovery", `export * from ${actual("./auth-recovery.ts")}`],
    [
      "./server/paseo",
      `export const runPaseo=(...args)=>globalThis[${JSON.stringify(key)}].reload(...args)`,
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
      `export const registerAccountManagement=(_server,status)=>{globalThis[${JSON.stringify(key)}].status=status; return ${noOp}}`,
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
      agents: {
        ref: (agentId: string) => ({
          refresh: async () => {
            shared.lookups++;
            await shared.gate?.(agentId);
            return {
              agent: {
                status: "idle",
                pendingPermissions: [],
                model: null,
                lastUserMessageAt: null,
                ...shared.snapshot(agentId),
              },
            };
          },
          send: async (text: string) => {
            sent.push({ agentId, text });
          },
        }),
      },
    },
  };
  type OpenHook = (
    input: { request: PluginSessionOpenRequest },
    hookContext: typeof context,
  ) => Promise<PluginSessionOpenRequest | undefined>;
  let hook: OpenHook = async () => {
    throw Error("Missing session-open hook");
  };
  const events = new Map<string, (...args: any[]) => unknown>();
  const dispose = module.default({
    registerUsageSource() {},
    before(_name: string, handler: OpenHook) {
      hook = handler;
      return () => {};
    },
    on(name: string, handler: (...args: any[]) => unknown) {
      events.set(name, handler);
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
  const reloads: PluginSessionOpenRequest[] = [];
  shared.reload = async (_command, args: any) => {
    assert.deepEqual(args.slice(0, 2), ["agent", "reload"]);
    const opened = await hook(
      {
        request: {
          ...request,
          ...shared.reloadRequest,
          agentId: args[2],
          reason: "refresh",
        },
      },
      context,
    );
    if (opened) reloads.push(opened);
    return "{}";
  };
  const logs: string[] = [];
  const info = console.info;
  console.info = (message: string) => void logs.push(message);
  return {
    open: (overrides: Partial<PluginSessionOpenRequest> = {}) =>
      hook({ request: { ...request, ...overrides } }, context),
    initialReports,
    /** Fresh copies of the starting reports, as a usage lookup at the current time would return. */
    refreshReports: () => {
      shared.reports = structuredClone(initialReports).map((entry) => ({
        ...entry,
        fetchedAt: new Date().toISOString(),
        report: {
          ...entry.report,
          windows: entry.report.windows.map((window) => ({
            ...window,
            resetsAt: new Date(
              Date.parse(window.resetsAt) + Date.now() - now,
            ).toISOString(),
          })),
        },
      }));
    },
    setReports: (next: typeof reports | null) => {
      shared.reports = next;
    },
    setSettings: (next: Record<string, unknown>) => {
      shared.settings = next;
    },
    setSnapshot: (next: (agentId: string) => Record<string, unknown>) => {
      shared.snapshot = next;
    },
    setReloadRequest: (next: Record<string, unknown>) => {
      shared.reloadRequest = next;
    },
    lookups: () => shared.lookups,
    setGate: (next: typeof shared.gate) => {
      shared.gate = next;
    },
    emit: async (name: string, payload: unknown) =>
      events.get(name)?.(payload, context),
    /** The Claude rows of the account status screen. */
    status: async () =>
      (
        await shared.status!({ claude: {} }, new AbortController().signal)
      ).filter((row) => !row.id.endsWith("-unavailable")),
    /** One whole turn of `agentId` ending with `text` as the assistant's last message. */
    turn: async (agentId: string, turnId: string, text: string) => {
      const agent = { id: agentId, provider: "claude" };
      await events.get("agent.turn_started")?.({ agent, turnId }, context);
      await events.get("agent.turn_ended")?.(
        {
          agent,
          turnId,
          outcome: { kind: "completed" },
          timeline: [
            { type: "user_message", text: "요청" },
            { type: "assistant_message", text },
          ],
        },
        context,
      );
    },
    reloads,
    sent,
    logs,
    dispose: () => {
      console.info = info;
      dispose();
      delete (globalThis as any)[key];
    },
  };
}

/** A reset time the way the CLI prints one that is less than a day away. */
function resetsIn(milliseconds: number) {
  return new Date(Date.now() + milliseconds)
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Seoul",
    })
    .replace(/[  ]([AP]M)/i, (_, meridiem: string) => meridiem.toLowerCase());
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

const logged = (fixture: { logs: string[] }, pattern: RegExp) =>
  assert.ok(
    fixture.logs.some((line) => pattern.test(line)),
    `${pattern} not in\n${fixture.logs.join("\n")}`,
  );
const throughCli = /불완전하거나 만료된 사용량을 CLI 정상 확인 경로로 재개/;

test("주간 창이 빠진 불완전한 사용량뿐인 계정으로도 기존 소진 대화를 CLI 정상 확인 경로로 재개한다", async () => {
  const fixture = await openFixture("partial-reset");
  try {
    const opened = await fixture.open();
    assert.equal(opened?.env.ASTER_ACCOUNT_ID, "recovered");
    assert.equal(opened?.env.CLAUDE_CONFIG_DIR, "/recovered");
    assert.equal(await fixture.open({ purpose: "history" }), undefined);
    logged(fixture, throughCli);
    logged(
      fixture,
      /session fixture-agent: recovered \(이전 fixture, 사유: 이전 계정 한도 소진\)/,
    );
  } finally {
    fixture.dispose();
  }
});

test("Claude가 5시간 한도를 없애 주간 창만 남은 보고서는 불완전한 응답이 아니라서 CLI 확인 경로 없이 점수로 기존 소진 대화를 주간 여유 계정에 재개한다", async () => {
  const fixture = await openFixture("partial-reset");
  try {
    const weeklyOnly = structuredClone(fixture.initialReports);
    weeklyOnly[1].report.windows = [
      {
        id: "weekly",
        usedPct: 0,
        resetsAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ];
    fixture.setReports(weeklyOnly);
    const opened = await fixture.open();
    assert.equal(opened?.env.ASTER_ACCOUNT_ID, "recovered");
    logged(
      fixture,
      /session fixture-agent: recovered \(이전 fixture, 사유: 이전 계정 한도 소진\)/,
    );
    assert.ok(!fixture.logs.some((line) => throughCli.test(line)));
  } finally {
    fixture.dispose();
  }
});

test("실제 CLI 한도 응답 뒤 주간 창이 빠진 부분 사용량 계정으로 CLI 확인 경로를 거쳐 연결만 바꾸고 사용자 요청을 재전송하지 않는다", async () => {
  const fixture = await openFixture("partial-reset");
  try {
    const seeded = structuredClone(fixture.initialReports[0]);
    seeded.report.windows = ["five_hour", "weekly"].map((id) => ({
      id,
      usedPct: 0,
      resetsAt: new Date(Date.now() + 3600000).toISOString(),
    }));
    fixture.setReports([seeded]);
    assert.equal(
      (await fixture.open())?.env.ASTER_ACCOUNT_ID,
      fixtureAccount.id,
    );
    fixture.setReports(fixture.initialReports);
    const agent = { id: "fixture-agent", provider: "claude" };
    await fixture.emit("agent.turn_started", { agent, turnId: "turn-1" });
    await fixture.emit("agent.turn_ended", {
      agent,
      turnId: "turn-1",
      outcome: { kind: "completed" },
      timeline: [
        {
          type: "assistant_message",
          text: "You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)",
        },
      ],
    });
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    assert.equal(fixture.sent.length, 0);
    logged(fixture, throughCli);
  } finally {
    fixture.dispose();
  }
});

test("한도 안내를 받은 계정은 60초가 지나도 안내된 초기화 시각까지 다시 배정하지 않는다", async (t) => {
  const fixture = await openFixture("two-available");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    await fixture.turn(
      "fixture-agent",
      "turn-1",
      `You've hit your weekly limit · resets ${resetsIn(2 * 3_600_000)} (Asia/Seoul)`,
    );
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    assert.equal(fixture.sent.length, 0);
    for (const wait of [61_000, 3_600_000]) {
      t.mock.timers.tick(wait);
      fixture.refreshReports();
      const opened = await fixture.open({
        agentId: `later-${wait}`,
        reason: "create",
        env: {},
      });
      assert.equal(opened?.env.ASTER_ACCOUNT_ID, "recovered");
    }
    t.mock.timers.tick(3_600_000);
    fixture.refreshReports();
    const opened = await fixture.open({
      agentId: "after-reset",
      reason: "create",
      env: {},
    });
    assert.equal(opened?.env.ASTER_ACCOUNT_ID, "fixture");
    logged(fixture, /account fixture: 한도 차단 .*안내된 초기화 시각/);
    logged(fixture, /연결 전환 fixture → recovered \(요청 재전송 없음\)/);
    logged(
      fixture,
      /session fixture-agent: recovered \(이전 fixture, 사유: 이전 계정 한도·인증 차단 중\)/,
    );
  } finally {
    fixture.dispose();
  }
});

test("차단된 계정뿐이면 새 세션과 사전 점검을 막지 않고 CLI 확인 경로로 연다", async () => {
  const fixture = await openFixture("available");
  try {
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    await fixture.turn("fixture-agent", "turn-1", "Claude usage limit reached");
    assert.equal(fixture.reloads.length, 0);
    const created = await fixture.open({
      agentId: "new-agent",
      reason: "create",
      env: {},
    });
    assert.equal(created?.env.ASTER_ACCOUNT_ID, "fixture");
    assert.equal(
      await fixture.open({
        agentId: "probe",
        reason: "create",
        env: {},
        preflight: true,
      } as Partial<PluginSessionOpenRequest>),
      undefined,
    );
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    logged(fixture, /account fixture: 한도 차단 .*초기화 시각 없음, 점증 대기/);
    logged(
      fixture,
      /session fixture-agent: 한도 감지, 전환 건너뜀 \(후보 없음\)/,
    );
    logged(
      fixture,
      /session new-agent: fixture \(차단 중인 계정뿐이라 CLI 확인 경로\)/,
    );
  } finally {
    fixture.dispose();
  }
});

test("사용량 조회가 실패해도 CLI 한도 안내는 계정을 차단한다", async () => {
  const fixture = await openFixture("two-available");
  try {
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    fixture.setReports(null);
    await fixture.turn("fixture-agent", "turn-1", "Claude usage limit reached");
    assert.equal(fixture.reloads.length, 0);
    fixture.setReports(fixture.initialReports);
    const created = await fixture.open({
      agentId: "new-agent",
      reason: "create",
      env: {},
    });
    assert.equal(created?.env.ASTER_ACCOUNT_ID, "recovered");
    logged(fixture, /account fixture: 한도 차단/);
    logged(fixture, /한도 감지, 전환 건너뜀 \(후보 없음\)/);
  } finally {
    fixture.dispose();
  }
});

test("모델 계열 한도는 같은 계정의 다른 모델 세션을 옮기지 않는다", async () => {
  const fixture = await openFixture("two-available");
  try {
    fixture.setSnapshot((agentId) => ({
      model: agentId === "sonnet-agent" ? "claude-sonnet-5" : "claude-opus-4-8",
    }));
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    await fixture.turn("fixture-agent", "turn-0", "완료했습니다.");
    const sonnet = await fixture.open({
      agentId: "sonnet-agent",
      reason: "create",
      env: {},
    });
    assert.equal(sonnet?.env.ASTER_ACCOUNT_ID, "fixture");
    await fixture.turn(
      "fixture-agent",
      "turn-1",
      `You've hit your Opus limit · resets ${resetsIn(2 * 3_600_000)} (Asia/Seoul)`,
    );
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    await fixture.turn("sonnet-agent", "turn-2", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
    // A session whose model is not known yet stays off the limited account.
    const created = await fixture.open({
      agentId: "new-agent",
      reason: "create",
      env: {},
    });
    assert.equal(created?.env.ASTER_ACCOUNT_ID, "recovered");
    logged(fixture, /account fixture: 한도 차단 .*opus 모델 한정/);
  } finally {
    fixture.dispose();
  }
});

test("이어가기 설정을 켠 경우에만 한도 전환 뒤 이어가기 메시지를 한 번 보낸다", async (t) => {
  const fixture = await openFixture("two-available");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    fixture.setSettings({ continueAfterLimitSwitch: true });
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    await fixture.turn("fixture-agent", "turn-1", "Claude usage limit reached");
    assert.equal(fixture.reloads.at(-1)?.env.ASTER_ACCOUNT_ID, "recovered");
    assert.deepEqual(fixture.sent, [
      { agentId: "fixture-agent", text: LIMIT_CONTINUATION },
    ]);
    logged(fixture, /연결 전환 fixture → recovered \(전환 뒤 이어가기 예정\)/);
    logged(fixture, /이어가기 메시지 전송 \(fixture → recovered\)/);
    // The continuation's own turn runs into the next limit: the session may move, nothing more is sent.
    t.mock.timers.tick(6 * 60_000);
    fixture.refreshReports();
    const agent = { id: "fixture-agent", provider: "claude" };
    await fixture.emit("agent.turn_started", { agent, turnId: "turn-2" });
    await fixture.emit("agent.turn_ended", {
      agent,
      turnId: "turn-2",
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "요청" },
        { type: "assistant_message", text: "Claude usage limit reached" },
        { type: "user_message", text: LIMIT_CONTINUATION },
        { type: "assistant_message", text: "Claude usage limit reached" },
      ],
    });
    assert.equal(fixture.reloads.length, 2);
    assert.equal(fixture.reloads[1].env.ASTER_ACCOUNT_ID, "fixture");
    assert.equal(fixture.sent.length, 1);
    logged(fixture, /이어가기 생략 \(이미 한 번 이어감\)/);
  } finally {
    fixture.dispose();
  }
});

test("전환 사이에 사용자가 새 메시지를 보냈거나 취소된 턴이면 이어가기를 보내지 않는다", async () => {
  const fixture = await openFixture("two-available");
  try {
    fixture.setSettings({ continueAfterLimitSwitch: true });
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    const agent = { id: "fixture-agent", provider: "claude" };
    await fixture.emit("agent.turn_started", { agent, turnId: "turn-0" });
    await fixture.emit("agent.turn_ended", {
      agent,
      turnId: "turn-0",
      outcome: { kind: "canceled", reason: "interrupted" },
      timeline: [
        { type: "assistant_message", text: "Claude usage limit reached" },
      ],
    });
    assert.equal(fixture.reloads.length, 0);
    let refreshes = 0;
    fixture.setSnapshot(() => ({
      lastUserMessageAt: refreshes++ === 0 ? "before" : "after",
    }));
    await fixture.turn("fixture-agent", "turn-1", "Claude usage limit reached");
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.sent.length, 0);
    logged(fixture, /이어가기 생략 \(새 사용자 메시지\)/);
  } finally {
    fixture.dispose();
  }
});

test("주간 창이 빠진 부분 사용량의 기존 정상 계정은 유지하고 권한 대기 중인 대화는 전환하지 않는다", async () => {
  const fixture = await openFixture("partial-reset");
  try {
    const healthy = structuredClone(fixture.initialReports);
    healthy[0].report.windows = [
      {
        id: "five_hour",
        usedPct: 0,
        resetsAt: new Date(Date.now() + 3600000).toISOString(),
      },
    ];
    fixture.setReports(healthy);
    assert.equal(
      (await fixture.open())?.env.ASTER_ACCOUNT_ID,
      fixtureAccount.id,
    );
    // Neither account scores, and an existing conversation is not moved through the CLI check.
    assert.ok(
      !fixture.logs.some((line) => /session fixture-agent:/.test(line)),
      fixture.logs.join("\n"),
    );
    const seeded = structuredClone(healthy[0]);
    seeded.report.windows.push({
      id: "weekly",
      usedPct: 0,
      resetsAt: new Date(Date.now() + 86400000).toISOString(),
    });
    fixture.setReports([seeded]);
    await fixture.open();
    fixture.setReports(fixture.initialReports);
    const agent = { id: "fixture-agent", provider: "claude" };
    await fixture.emit("agent.turn_started", { agent, turnId: "turn-1" });
    await fixture.emit("agent.permission_requested", { agent });
    await fixture.emit("agent.turn_ended", {
      agent,
      turnId: "turn-1",
      outcome: { kind: "completed" },
      timeline: [
        {
          type: "assistant_message",
          text: "You've hit your weekly limit · resets Nov 14, 1pm (Asia/Seoul)",
        },
      ],
    });
    assert.equal(fixture.reloads.length, 0);
    logged(fixture, /한도 감지, 전환 건너뜀 \(권한 대기\)/);
  } finally {
    fixture.dispose();
  }
});

const withModel = (
  overrides: Partial<PluginSessionOpenRequest>,
  model: string | null,
) => ({ ...overrides, model }) as Partial<PluginSessionOpenRequest>;
const koreanClock = (at: string) =>
  new Date(at).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

test("5시간 창이 없어진 실측 보고서로도 계정 상태를 자동 분배로 보이고 Fable만 소진된 계정은 복귀 시각과 함께 사용 가능으로 보인다", async () => {
  const fixture = await openFixture("fable");
  try {
    const when = koreanClock(
      fixture.initialReports[0].report.windows[1].resetsAt,
    );
    assert.deepEqual(
      (await fixture.status()).map((row) => [row.id, row.status]),
      [
        [
          "fixture",
          `사용 가능 · 주간 59% · Fable 한도 소진 · ${when} 이후 복귀`,
        ],
        ["recovered", "자동 분배 중 · 주간 0%"],
      ],
    );
    const created = await fixture.open({
      agentId: "new-agent",
      reason: "create",
      env: {},
    });
    assert.equal(created?.env.ASTER_ACCOUNT_ID, "recovered");
    assert.ok(!fixture.logs.some((line) => /CLI 정상 확인 경로/.test(line)));
  } finally {
    fixture.dispose();
  }
});

test("Fable 소진 계정 A에 묶인 세션의 모델 변경 refresh(model=claude-fable-5-2)는 10분 유지·20% 우위보다 소진 제외를 우선해 B를 고른다", async () => {
  const fixture = await openFixture("fable");
  try {
    // The conversation sits on A, chosen while A was the only account with a reading.
    fixture.setReports([fixture.initialReports[0]]);
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    fixture.setReports(fixture.initialReports);
    // Inside the 10-minute hold another model keeps the account.
    assert.equal(
      (await fixture.open(withModel({ reason: "refresh" }, "claude-sonnet-5")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    const opened = await fixture.open(
      withModel({ reason: "refresh" }, "claude-fable-5-2"),
    );
    assert.equal(opened?.env.ASTER_ACCOUNT_ID, "recovered");
    assert.equal(opened?.env.CLAUDE_CONFIG_DIR, "/recovered");
    logged(
      fixture,
      /session fixture-agent: recovered \(이전 fixture, 사유: 이전 계정 Fable 한도 소진\)/,
    );
  } finally {
    fixture.dispose();
  }
});

test("요청에 모델이 없으면 저장된 에이전트 모델로 Fable 소진 계정을 피한다", async () => {
  const fixture = await openFixture("fable");
  try {
    fixture.setReports([fixture.initialReports[0]]);
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    fixture.setReports(fixture.initialReports);
    fixture.setSnapshot(() => ({ model: "claude-fable-5-2" }));
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "recovered");
  } finally {
    fixture.dispose();
  }
});

test("모든 계정의 Fable 한도가 소진되면 새 Fable 대화만 복귀 시각과 함께 거절하고 다른 모델과 기존 대화는 연다", async () => {
  const fixture = await openFixture("fable");
  try {
    const spent = structuredClone(fixture.initialReports);
    spent[1].report.windows[1].usedPct = 100;
    fixture.setReports(spent);
    await assert.rejects(
      fixture.open(
        withModel(
          { agentId: "fable-agent", reason: "create", env: {} },
          "claude-fable-5-2",
        ),
      ),
      new RegExp(
        `모든 Claude 계정의 Fable 한도가 소진되었습니다. 가장 빠른 초기화는 ${koreanClock(spent[0].report.windows[1].resetsAt)}`,
      ),
    );
    assert.equal(
      (
        await fixture.open(
          withModel(
            { agentId: "sonnet-agent", reason: "create", env: {} },
            "claude-sonnet-5",
          ),
        )
      )?.env.ASTER_ACCOUNT_ID,
      "recovered",
    );
    assert.equal(
      (await fixture.open(withModel({ reason: "refresh" }, "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
  } finally {
    fixture.dispose();
  }
});

test("모델을 밝히지 않은 한도 오류도 최신 사용량이 그 모델 창의 소진을 보이면 그 모델 세션만 옮긴다", async () => {
  const fixture = await openFixture("fable");
  try {
    fixture.setSnapshot((agentId) => ({
      model:
        agentId === "sonnet-agent" ? "claude-sonnet-5" : "claude-fable-5-2",
    }));
    // Both sessions start on A before its Fable limit shows spent.
    const before = structuredClone(fixture.initialReports[0]);
    before.report.windows[1].usedPct = 90;
    fixture.setReports([before]);
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    assert.equal(
      (
        await fixture.open({
          agentId: "sonnet-agent",
          reason: "create",
          env: {},
        })
      )?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    fixture.setReports(fixture.initialReports);
    const agent = { id: "fixture-agent", provider: "claude" };
    await fixture.emit("agent.turn_started", { agent, turnId: "turn-1" });
    await fixture.emit("agent.turn_ended", {
      agent,
      turnId: "turn-1",
      outcome: {
        kind: "failed",
        error: {
          message:
            "API Error: 429 This request would exceed your account's rate limit. Please try again later.",
        },
      },
      timeline: [],
    });
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    logged(
      fixture,
      /account fixture: 한도 차단 .*fable 모델 한정\(사용량 확인\)/,
    );
    await fixture.turn("sonnet-agent", "turn-2", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
  } finally {
    fixture.dispose();
  }
});

test("기본 모델 세션(model=null)의 재개는 본체가 모델을 모르므로 실행 중 모델로 Fable 소진 계정을 피한다", async () => {
  const fixture = await openFixture("fable");
  try {
    fixture.setReports([fixture.initialReports[0]]);
    assert.equal(
      (await fixture.open(withModel({}, null)))?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    fixture.setReports(fixture.initialReports);
    fixture.setSnapshot(() => ({
      model: null,
      runtimeInfo: { model: "claude-fable-5-2" },
    }));
    assert.equal(
      (await fixture.open(withModel({}, null)))?.env.ASTER_ACCOUNT_ID,
      "recovered",
    );
  } finally {
    fixture.dispose();
  }
});

test("기본 모델 세션은 본체가 reload 요청에 model=null을 넣어도 턴 종료가 고른 Fable 계열로 다시 열려 정상 턴마다 reload를 반복하지 않는다", async () => {
  const fixture = await openFixture("fable");
  try {
    // No model in the session's config: the provider default runs, and only the runtime names it.
    fixture.setSnapshot(() => ({
      model: null,
      runtimeInfo: { model: "claude-fable-5-2" },
    }));
    // The host's refresh request carries the stored model, which is null for the default.
    fixture.setReloadRequest({ model: null });
    // The session sits on A, opened before A's Fable limit showed spent.
    const before = structuredClone(fixture.initialReports[0]);
    before.report.windows[1].usedPct = 90;
    fixture.setReports([before]);
    assert.equal(
      (await fixture.open(withModel({}, null)))?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    fixture.setReports(fixture.initialReports);
    await fixture.turn("fixture-agent", "turn-1", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
    assert.equal((fixture.reloads[0] as { model?: string | null }).model, null);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    await fixture.turn("fixture-agent", "turn-2", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
    logged(fixture, /여유 계정으로 연결 전환 fixture → recovered/);
  } finally {
    fixture.dispose();
  }
});

/** A reopen the host makes after an account limit refused a model change (`setAgentModel`). */
const changeModel = (
  from: string | null,
  to: string | null,
  overrides: Partial<PluginSessionOpenRequest> = {},
) =>
  ({
    reason: "refresh",
    ...overrides,
    model: to,
    modelChange: { from, to },
  }) as Partial<PluginSessionOpenRequest>;
/** Windows of a fixture report, values as the host may send them. */
const windowsOf = (entry: { report: { windows: unknown[] } }) =>
  entry.report.windows as {
    id: string;
    label?: string;
    usedPct: number | null;
    resetsAt: string | null;
  }[];

test("계정 한도로 거절된 모델 변경을 다시 여는 요청(modelChange)은 10분 유지·20% 우위 없이 새 모델 여유가 큰 계정을 고르고 이전 본체 요청은 기존 유지 규칙을 따른다", async () => {
  const fixture = await openFixture("fable");
  try {
    const reports = structuredClone(fixture.initialReports);
    reports[0].report.windows[0].usedPct = 20;
    reports[0].report.windows[1].usedPct = 90;
    reports[1].report.windows[0].usedPct = 60;
    fixture.setReports([reports[0]]);
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    fixture.setReports(reports);
    // Without the field, as from an older host, the hold keeps the account: its Fable limit has room.
    assert.equal(
      (await fixture.open(withModel({ reason: "refresh" }, "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    const changed = await fixture.open(
      changeModel("claude-sonnet-5", "claude-fable-5-2"),
    );
    assert.equal(changed?.env.ASTER_ACCOUNT_ID, "recovered");
    assert.deepEqual((changed as { modelChange?: unknown }).modelChange, {
      from: "claude-sonnet-5",
      to: "claude-fable-5-2",
    });
    logged(
      fixture,
      /session fixture-agent: recovered \(이전 fixture, 사유: Fable 모델 변경이 계정 한도로 거절됨\)/,
    );
  } finally {
    fixture.dispose();
  }
});

test("모든 계정에서 새 모델 한도나 계정 전체 한도가 사용량으로 확인된 소진이면 모델 변경 다시 열기를 가장 빠른 초기화 시각과 함께 거절한다", async () => {
  const fixture = await openFixture("fable");
  try {
    const spent = structuredClone(fixture.initialReports);
    spent[1].report.windows[1].usedPct = 100;
    fixture.setReports(spent);
    await assert.rejects(
      fixture.open(changeModel("claude-sonnet-5", "claude-fable-5-2")),
      {
        message: `Aster: 모든 Claude 계정의 Fable 한도가 소진되었습니다. 가장 빠른 초기화는 ${koreanClock(spent[0].report.windows[1].resetsAt)}(한국시간)입니다.`,
      },
    );
    // The same reopen from an older host, without the field, still opens the conversation.
    assert.equal(
      (await fixture.open(withModel({ reason: "refresh" }, "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    // One account spent its Fable limit, the other its weekly one: the earliest return is named.
    const mixed = structuredClone(fixture.initialReports);
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    mixed[1].report.windows[0] = { id: "weekly", usedPct: 100, resetsAt: soon };
    fixture.setReports(mixed);
    await assert.rejects(
      fixture.open(changeModel("claude-sonnet-5", "claude-fable-5-2")),
      {
        message: `Aster: 모든 Claude 계정의 Fable 한도가 소진되었습니다. 가장 빠른 초기화는 ${koreanClock(soon)}(한국시간)입니다.`,
      },
    );
    logged(
      fixture,
      /세션 열기 거절 \(refresh\) · Aster: 모든 Claude 계정의 Fable 한도가 소진/,
    );
  } finally {
    fixture.dispose();
  }
});

test("사용량을 모르거나 불완전하면 모델 변경 다시 열기를 거절하지 않고 기존 규칙과 CLI 확인 경로로 연다", async () => {
  const fixture = await openFixture("fable");
  try {
    fixture.setReports(null);
    assert.equal(
      (await fixture.open(changeModel("claude-sonnet-5", "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    const blank = structuredClone(fixture.initialReports);
    for (const entry of blank) windowsOf(entry)[1].usedPct = null;
    fixture.setReports(blank);
    assert.ok(
      (await fixture.open(changeModel("claude-sonnet-5", "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
    );
    logged(fixture, throughCli);
  } finally {
    fixture.dispose();
  }
});

test("기본 모델로 바꾸는 모델 변경 다시 열기도 유지 규칙 없이 계정 전체 여유로 고른다", async () => {
  const fixture = await openFixture("fable");
  try {
    fixture.setReports([fixture.initialReports[0]]);
    assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
    fixture.setReports(fixture.initialReports);
    assert.equal(
      (await fixture.open(withModel({ reason: "refresh" }, null)))?.env
        .ASTER_ACCOUNT_ID,
      "fixture",
    );
    assert.equal(
      (await fixture.open(changeModel("claude-fable-5-2", null)))?.env
        .ASTER_ACCOUNT_ID,
      "recovered",
    );
  } finally {
    fixture.dispose();
  }
});

test("사전 점검도 요청한 모델의 계열로 판정해 모든 계정의 그 모델 한도가 소진되면 거절하고 다른 모델과 기본 모델은 통과시킨다", async () => {
  const fixture = await openFixture("fable");
  try {
    const spent = structuredClone(fixture.initialReports);
    spent[1].report.windows[1].usedPct = 100;
    fixture.setReports(spent);
    const probe = (model: string | null) =>
      fixture.open(
        withModel(
          {
            agentId: "probe",
            reason: "create",
            env: {},
            preflight: true,
          } as Partial<PluginSessionOpenRequest>,
          model,
        ),
      );
    await assert.rejects(
      probe("claude-fable-5-2"),
      /모든 Claude 계정의 Fable 한도가 소진되었습니다/,
    );
    assert.equal(await probe("claude-sonnet-5"), undefined);
    assert.equal(await probe(null), undefined);
  } finally {
    fixture.dispose();
  }
});

test("세션 모델이 계정 선택을 바꾸지 않는 세션 열기와 턴 종료는 에이전트를 조회하지 않고 바꿀 때만 조회한다", async () => {
  const fixture = await openFixture("fable");
  try {
    const clean = structuredClone(fixture.initialReports);
    clean[0].report.windows[1].usedPct = 0;
    fixture.setReports(clean);
    fixture.setSnapshot(() => ({ model: "claude-fable-5-2" }));
    // Every model lands on the same account, so the model the host leaves out is not needed.
    assert.equal(
      (await fixture.open(withModel({}, null)))?.env.ASTER_ACCOUNT_ID,
      "recovered",
    );
    await fixture.turn("fixture-agent", "turn-1", "완료했습니다.");
    assert.equal(fixture.lookups(), 0);
    // The account's Fable limit runs out: now the model decides, and is looked up once.
    const spent = structuredClone(clean);
    spent[1].report.windows[1].usedPct = 100;
    fixture.setReports(spent);
    await fixture.turn("fixture-agent", "turn-2", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "fixture");
    // The model lookup, and the status check before the reload.
    assert.equal(fixture.lookups(), 2);
  } finally {
    fixture.dispose();
  }
});

test("에이전트 조회가 2초 안에 답하지 않으면 잠시 다음 세션 열기는 기다리지 않고 마지막으로 알려진 모델로 판정해 재개가 몰려도 대기가 쌓이지 않는다", async (t) => {
  const fixture = await openFixture("fable");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  try {
    const before = structuredClone(fixture.initialReports);
    before[0].report.windows[0].usedPct = 0;
    before[0].report.windows[1].usedPct = 90;
    before[1].report.windows[0].usedPct = 95;
    fixture.setReports(before);
    fixture.setSnapshot(() => ({ model: "claude-fable-5-2" }));
    // The host names the model of this one: Fable, with room on A for now.
    assert.equal(
      (await fixture.open(withModel({ agentId: "named" }, "claude-fable-5-2")))
        ?.env.ASTER_ACCOUNT_ID,
      "fixture",
    );
    const after = structuredClone(before);
    after[0].report.windows[1].usedPct = 100;
    fixture.setReports(after);
    fixture.setGate((agentId) =>
      agentId.startsWith("resume-") ? new Promise(() => {}) : undefined,
    );
    const settled = async (task: Promise<unknown>) => {
      let done = false;
      task.then(
        () => (done = true),
        () => (done = true),
      );
      for (let turn = 0; turn < 5; turn++)
        await new Promise((resolve) => setImmediate(resolve));
      return done;
    };
    const first = fixture.open({ agentId: "resume-1" });
    assert.equal(await settled(first), false);
    t.mock.timers.tick(2_000);
    // Unanswered, the model stays unknown.
    assert.equal((await first)?.env.ASTER_ACCOUNT_ID, "fixture");
    const second = fixture.open({ agentId: "resume-2" });
    assert.equal(await settled(second), true);
    assert.equal(fixture.lookups(), 2);
    // Meanwhile a turn end uses the model the host named for the session.
    await fixture.turn("named", "turn-1", "완료했습니다.");
    assert.equal(fixture.reloads.length, 1);
    assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
    // A while later lookups wait again.
    t.mock.timers.tick(15_000);
    const third = fixture.open({ agentId: "resume-3" });
    assert.equal(await settled(third), false);
    t.mock.timers.tick(2_000);
    await third;
  } finally {
    fixture.dispose();
  }
});

test("계정 상태는 5시간 창이 있으면 5시간·주간 사용률을, 없으면 주간 사용률만 두 자리 시각과 함께 보이고 주간 정보가 있으면 첫 사용 안내를 내지 않는다", async () => {
  const fixture = await openFixture("two-available");
  try {
    const at = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000).toISOString();
    const shortReset = at(2);
    const status = async (...windows: unknown[][]) => {
      fixture.setReports(
        fixture.initialReports.map((entry, index) => ({
          ...structuredClone(entry),
          report: {
            status: "available",
            windows: windows[index] as typeof entry.report.windows,
          },
        })),
      );
      return (await fixture.status()).map((row) => [row.id, row.status]);
    };
    assert.deepEqual(
      await status(
        [
          { id: "five_hour", usedPct: 31, resetsAt: at(3) },
          { id: "weekly", usedPct: 59, resetsAt: at(100) },
        ],
        [
          { id: "five_hour", usedPct: 100, resetsAt: shortReset },
          { id: "weekly", usedPct: 40, resetsAt: at(100) },
        ],
      ),
      [
        ["fixture", "자동 분배 중 · 5시간 31% · 주간 59%"],
        [
          "recovered",
          `한도 소진 · 5시간 100% · 주간 40% · ${koreanClock(shortReset)} 이후 자동 복귀`,
        ],
      ],
    );
    assert.match(
      koreanClock(shortReset),
      /^\d{1,2}\. \d{1,2}\. 오[전후] \d{2}:\d{2}$/,
    );
    // Usage the CLI still has to confirm.
    assert.deepEqual(
      await status(
        [
          { id: "five_hour", usedPct: null, resetsAt: null },
          { id: "weekly", usedPct: 40, resetsAt: at(100) },
        ],
        [{ id: "five_hour", usedPct: 20, resetsAt: at(3) }],
      ),
      [
        ["fixture", "사용 가능 · 주간 40%"],
        ["recovered", "사용 가능 · 5시간 20% · 첫 사용 후 사용량 표시"],
      ],
    );
    const chatReset = at(50);
    const codeReset = at(30);
    assert.deepEqual(
      await status(
        [
          { id: "weekly", usedPct: 59, resetsAt: at(100) },
          {
            id: "weekly_surface_chat",
            label: "Weekly · Chat",
            usedPct: 100,
            resetsAt: chatReset,
          },
        ],
        [
          { id: "weekly", usedPct: 10, resetsAt: at(100) },
          {
            id: "weekly_surface_code",
            label: "Weekly · Code",
            usedPct: 100,
            resetsAt: codeReset,
          },
        ],
      ),
      [
        [
          "fixture",
          `자동 분배 중 · 주간 59% · Chat 한도 소진(자동 분배 미반영) · ${koreanClock(chatReset)} 이후 복귀`,
        ],
        [
          "recovered",
          `한도 소진 · 주간 10% · ${koreanClock(codeReset)} 이후 자동 복귀`,
        ],
      ],
    );
  } finally {
    fixture.dispose();
  }
});

test("5시간 한도 안내는 보고서에 5시간 창이 없어도 계정 전체를 안내 시각까지 차단하고 모델 한도로 추정하지 않는다", async () => {
  for (const [notice, accountWide] of [
    [
      `You've hit your 5-hour limit · resets ${resetsIn(2 * 3_600_000)} (Asia/Seoul)`,
      true,
    ],
    [
      "API Error: 429 This request would exceed your account's rate limit. Please try again later.",
      false,
    ],
  ] as const) {
    const fixture = await openFixture("fable");
    try {
      fixture.setSnapshot(() => ({ model: "claude-fable-5-2" }));
      const reports = structuredClone(fixture.initialReports);
      reports[0].report.windows[0].usedPct = 30;
      reports[1].report.windows[0].usedPct = 80;
      const before = structuredClone(reports[0]);
      before.report.windows[1].usedPct = 90;
      fixture.setReports([before]);
      assert.equal((await fixture.open())?.env.ASTER_ACCOUNT_ID, "fixture");
      fixture.setReports(reports);
      const agent = { id: "fixture-agent", provider: "claude" };
      await fixture.emit("agent.turn_started", { agent, turnId: "turn-1" });
      await fixture.emit("agent.turn_ended", {
        agent,
        turnId: "turn-1",
        outcome: { kind: "failed", error: { message: notice } },
        timeline: [],
      });
      assert.equal(fixture.reloads.length, 1);
      assert.equal(fixture.reloads[0].env.ASTER_ACCOUNT_ID, "recovered");
      assert.equal(
        fixture.logs.some((line) => /fable 모델 한정/.test(line)),
        !accountWide,
        notice,
      );
      // A Sonnet session would sit on A, which has more weekly room, unless the whole account is blocked.
      const sonnet = await fixture.open(
        withModel(
          { agentId: "sonnet-agent", reason: "create", env: {} },
          "claude-sonnet-5",
        ),
      );
      assert.equal(
        sonnet?.env.ASTER_ACCOUNT_ID,
        accountWide ? "recovered" : "fixture",
        notice,
      );
    } finally {
      fixture.dispose();
    }
  }
});
