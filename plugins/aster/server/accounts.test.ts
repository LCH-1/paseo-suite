import assert from "node:assert/strict";
import test from "node:test";
import {
  exhaustedUntil,
  exhaustedAccountsResetAt,
  accountSecureDirectory,
  bootstrapAccounts,
  expiredAccounts,
  hasPreviousAccount,
  mapReports,
  needsLogin,
  parseReports,
  reportsSchema,
  UsageReader,
  windowFamily,
  windowLimit,
  exhaustedModels,
  exhaustedSurfaces,
  spentAccounts,
  type Account,
} from "./accounts.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { rankAccounts, selectAccount } from "./scheduler.ts";

const accounts: Account[] = [
  {
    id: "a",
    home: "/fixture/a",
    email: "a@example.test",
    identity: "org-a|a@example.test",
  },
];
const now = Date.now();

test("프로필 사용량 보완 보고서도 선택에 반영하고 기본 보고서와 중복 계산하지 않는다", () => {
  const fallback = {
    ...report(),
    id: "claude-profiles:account.org-a",
    sourceId: "claude-profiles",
  };
  assert.equal(mapReports(accounts, [fallback], {})[0].id, "a");
  assert.equal(mapReports(accounts, [fallback, report()], {}).length, 1);
});

test("Claude가 5시간 한도를 없애 5시간 창이 아예 없는 보고서는 주간 창만으로 점수를 만들고 CLI 확인 경로로 보내지 않는다", () => {
  const weeklyOnly = report();
  weeklyOnly.report.windows = weeklyOnly.report.windows.filter(
    (window) => window.id === "weekly",
  );
  const readings = mapReports(accounts, [weeklyOnly], {}, now);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].fiveHour, null);
  assert.equal(readings[0].weekly.used, 40);
  assert.equal(selectAccount(readings, now)?.id, "a");
  assert.deepEqual(bootstrapAccounts(accounts, [weeklyOnly], now), []);
});

test("주간 창이 빠진 보고서만 불완전한 응답으로 보고 점수 없이 CLI 확인 후보로 선택한다", () => {
  const shortOnly = report();
  shortOnly.report.windows = shortOnly.report.windows.filter(
    (window) => window.id === "five_hour",
  );
  assert.deepEqual(mapReports(accounts, [shortOnly], {}, now), []);
  assert.deepEqual(
    bootstrapAccounts(accounts, [shortOnly], now).map((account) => account.id),
    ["a"],
  );
  assert.equal(
    bootstrapAccounts(
      [...accounts, { ...accounts[0], id: "alias" }],
      [shortOnly],
      now,
    ).length,
    1,
  );
});

test("5시간 창이 있는데 값이 비어 있으면 한도 폐지가 아닌 불완전한 응답이라 0으로 채우지 않고 주간 여유가 확인되면 CLI 확인 후보로 남긴다", () => {
  const blank = reportsSchema.parse([
    {
      ...report(),
      report: {
        ...report().report,
        windows: [
          { id: "five_hour", usedPct: null, resetsAt: null },
          report().report.windows[1],
        ],
      },
    },
  ]);
  assert.deepEqual(mapReports(accounts, blank, {}, now), []);
  assert.deepEqual(
    bootstrapAccounts(accounts, blank, now).map((account) => account.id),
    ["a"],
  );
  // Without a confirmed window of the account's own there is nothing to check through the CLI.
  const nothing = reportsSchema.parse([
    {
      ...report(),
      report: {
        ...report().report,
        windows: [
          { id: "five_hour", usedPct: null, resetsAt: null },
          { id: "weekly", usedPct: null, resetsAt: null },
        ],
      },
    },
  ]);
  assert.deepEqual(bootstrapAccounts(accounts, nothing, now), []);
});

test("불완전한 창이라도 확인된 한도가 소진되거나 오래되면 시작하지 않는다", () => {
  const partial = report();
  partial.report.windows = partial.report.windows.filter(
    (window) => window.id === "five_hour",
  );
  partial.report.windows[0].usedPct = 100;
  assert.deepEqual(bootstrapAccounts(accounts, [partial], now), []);
  partial.report.windows[0].usedPct = 99;
  assert.equal(bootstrapAccounts(accounts, [partial], now).length, 1);
  partial.report.windows[0].usedPct = 20;
  for (const fetchedAt of [
    new Date(now - 7 * 60_000).toISOString(),
    new Date(now + 1000).toISOString(),
    "invalid",
  ]) {
    assert.deepEqual(
      bootstrapAccounts(accounts, [{ ...partial, fetchedAt }], now),
      [],
    );
  }
  partial.report.windows[0].resetsAt = new Date(now - 1).toISOString();
  assert.deepEqual(bootstrapAccounts(accounts, [partial], now), []);
});

test("오류·인증거부·빈 창과 최신 소진은 오래된 일부 여유 보고서로 우회하지 않는다", () => {
  const partial = report();
  partial.report.windows = partial.report.windows.filter(
    (window) => window.id === "five_hour",
  );
  const rejected = {
    ...partial,
    report: { status: "unavailable", problem: { kind: "rejected" } },
  };
  for (const reports of [
    [partial, rejected],
    [rejected, partial],
    [{ ...partial, report: { status: "error" } }],
    [{ ...partial, report: { status: "available", windows: [] } }],
  ]) {
    assert.deepEqual(bootstrapAccounts(accounts, reports, now), []);
  }
  const newest = report();
  newest.report.windows[0].usedPct = 100;
  assert.deepEqual(
    bootstrapAccounts(
      accounts,
      [{ ...partial, fetchedAt: new Date(now - 1000).toISOString() }, newest],
      now,
    ),
    [],
  );
  assert.deepEqual(bootstrapAccounts(accounts, [partial, newest], now), []);
  assert.deepEqual(bootstrapAccounts(accounts, [newest, partial], now), []);
  const unknown = reportsSchema.parse([
    {
      ...partial,
      report: {
        status: "available",
        windows: [{ id: "five_hour", usedPct: null, resetsAt: null }],
      },
    },
  ]);
  assert.deepEqual(bootstrapAccounts(accounts, unknown, now), []);
});

test("기본 ID라도 이식된 프로필은 자체 저장소를 사용하고 기본 폴더 별칭은 기본 저장소를 사용한다", () => {
  assert.equal(
    accountSecureDirectory(
      { home: "C:/Users/test/.paseo/profiles/primary" },
      "win32",
      "C:/Users/test",
    ),
    "C:/Users/test/.paseo/profiles/primary",
  );
  assert.equal(
    accountSecureDirectory(
      { home: "c:/users/TEST/.claude" },
      "win32",
      "C:/Users/test",
    ),
    "",
  );
  assert.equal(
    accountSecureDirectory(
      { home: "/home/test/.paseo/profiles/primary" },
      "linux",
      "/home/test",
    ),
    "/home/test/.paseo/profiles/primary",
  );
  assert.equal(
    accountSecureDirectory(
      { home: "/home/test/.claude" },
      "linux",
      "/home/test",
    ),
    "",
  );
});
function report(label = "a@example.test", id = "claude:account.org-a") {
  return {
    id,
    sourceId: "claude",
    account: { label },
    fetchedAt: new Date(now).toISOString(),
    report: {
      status: "available",
      planLabel: "Max 20x",
      windows: [
        {
          id: "five_hour",
          usedPct: 20,
          resetsAt: new Date(now + 4 * 3_600_000).toISOString(),
        },
        {
          id: "weekly",
          usedPct: 40,
          resetsAt: new Date(now + 100 * 3_600_000).toISOString(),
        },
      ],
    },
  };
}

test("5시간 한도가 없어진 두 계정은 주간 창만으로 소진을 판정하고 가장 빠른 복귀 시각을 구분한다", () => {
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const first = report();
  first.report.windows = [
    {
      id: "weekly",
      usedPct: 100,
      resetsAt: new Date(now + 3600000).toISOString(),
    },
  ];
  const second = report(other.email!, "claude:account.org-b");
  second.report.windows = [
    {
      id: "weekly",
      usedPct: 100,
      resetsAt: new Date(now + 7200000).toISOString(),
    },
  ];
  const readings = reportsSchema.parse([first, second]);
  const usage = mapReports([...accounts, other], readings, {}, now);
  assert.deepEqual(
    usage.map((entry) => [entry.id, entry.fiveHour, entry.weekly.used]),
    [
      ["a", null, 100],
      ["b", null, 100],
    ],
  );
  assert.deepEqual(rankAccounts(usage, now), []);
  assert.deepEqual(bootstrapAccounts([...accounts, other], readings, now), []);
  assert.equal(
    exhaustedAccountsResetAt([...accounts, other], readings, now),
    now + 3600000,
  );
  assert.equal(
    exhaustedAccountsResetAt([...accounts, other], [readings[0]], now),
    null,
  );
});

test("한도 소진 안내는 최신 보고서와 확인된 초기화만 사용하고 정상·미확인 계정을 소진으로 오인하지 않는다", () => {
  const exhausted = report();
  exhausted.report.windows = [
    {
      id: "weekly",
      usedPct: 100,
      resetsAt: new Date(now + 3600000).toISOString(),
    },
  ];
  for (const fetchedAt of [
    new Date(now - 7 * 60000).toISOString(),
    new Date(now + 1000).toISOString(),
  ]) {
    assert.equal(
      exhaustedAccountsResetAt(
        accounts,
        reportsSchema.parse([{ ...exhausted, fetchedAt }]),
        now,
      ),
      null,
    );
  }
  const newer = { ...report(), fetchedAt: new Date(now + 1).toISOString() };
  assert.equal(
    exhaustedAccountsResetAt(
      accounts,
      reportsSchema.parse([exhausted, newer]),
      now + 1,
    ),
    null,
  );
  for (const resetsAt of [null, "invalid", new Date(now - 1).toISOString()]) {
    const unknown = {
      ...exhausted,
      report: {
        ...exhausted.report,
        windows: [{ id: "weekly", usedPct: 100, resetsAt }],
      },
    };
    assert.equal(
      exhaustedAccountsResetAt(accounts, reportsSchema.parse([unknown]), now),
      null,
    );
  }
  assert.equal(exhaustedAccountsResetAt([], [], now), null);
});

test("한 계정의 두 소진 창이 모두 풀리는 시각을 복귀 시각으로 사용한다", () => {
  const exhausted = report();
  exhausted.report.windows.forEach((window) => {
    window.usedPct = 100;
  });
  assert.equal(
    exhaustedAccountsResetAt(accounts, reportsSchema.parse([exhausted]), now),
    now + 100 * 3600000,
  );
});

test("사용량 API의 일시적 조회 제한은 공식 CLI 확인을 통한 새 세션 시작을 막지 않는다", () => {
  const limited = reportsSchema.parse([
    {
      ...report(),
      report: {
        status: "error",
        error: "Rate limited by Claude. Try again in 5m.",
      },
    },
  ]);
  assert.deepEqual(mapReports(accounts, limited, {}, now), []);
  assert.deepEqual(bootstrapAccounts(accounts, limited, now), accounts);
});

test("조회 제한으로 확인하지 못한 계정보다 한도 여유가 확인된 계정을 먼저 쓴다", () => {
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const partial = report(other.email!, "claude:account.org-b");
  partial.report.windows = partial.report.windows.filter(
    (window) => window.id === "five_hour",
  );
  const limited = reportsSchema.parse([
    {
      ...report(),
      report: {
        status: "error",
        error: "Rate limited by Claude. Try again later.",
      },
    },
    partial,
  ]);
  assert.deepEqual(bootstrapAccounts([...accounts, other], limited, now), [
    other,
  ]);
});

test("조회 제한이 있어도 확인된 무료·인증거부·한도 소진과 실행 차단은 우회하지 않는다", () => {
  const limited = {
    ...report(),
    report: {
      status: "error",
      error: "Rate limited by Claude. Try again in 1h.",
    },
  };
  const older = { ...report(), fetchedAt: new Date(now - 1000).toISOString() };
  for (const denial of [
    { ...older, report: { status: "available", planLabel: "Free" } },
    {
      ...older,
      report: { status: "unavailable", problem: { kind: "rejected" } },
    },
    {
      ...older,
      report: {
        status: "unavailable",
        problem: { kind: "subscription_expired" },
      },
    },
    {
      ...older,
      report: {
        status: "available",
        windows: [
          {
            id: "weekly",
            usedPct: 100,
            resetsAt: new Date(now + 1000).toISOString(),
          },
        ],
      },
    },
    {
      ...older,
      report: {
        status: "available",
        windows: [{ id: "five_hour", usedPct: 100, resetsAt: null }],
      },
    },
  ]) {
    assert.deepEqual(
      bootstrapAccounts(accounts, reportsSchema.parse([denial, limited]), now),
      [],
    );
  }
  assert.deepEqual(
    bootstrapAccounts(
      accounts,
      reportsSchema.parse([limited]),
      now,
      () => true,
    ),
    [],
  );
});

test("오래되거나 미래인 조회 제한과 다른 로그인 오류를 새 시작 후보로 추정하지 않는다", () => {
  const limited = {
    ...report(),
    report: {
      status: "error",
      error: "Rate limited by Claude. Try again in 5m.",
    },
  };
  for (const fetchedAt of [
    new Date(now - 7 * 60000).toISOString(),
    new Date(now + 1000).toISOString(),
  ]) {
    assert.deepEqual(
      bootstrapAccounts(
        accounts,
        reportsSchema.parse([{ ...limited, fetchedAt }]),
        now,
      ),
      [],
    );
  }
  for (const error of [
    "Claude login store no longer exists",
    "Authentication rate limited",
    "Claude usage API returned 500",
  ]) {
    assert.deepEqual(
      bootstrapAccounts(
        accounts,
        reportsSchema.parse([
          { ...report(), report: { status: "error", error } },
        ]),
        now,
      ),
      [],
    );
  }
  const reset = {
    ...report(),
    fetchedAt: new Date(now - 1000).toISOString(),
    report: {
      status: "available",
      windows: [
        {
          id: "weekly",
          usedPct: 100,
          resetsAt: new Date(now - 1).toISOString(),
        },
      ],
    },
  };
  assert.deepEqual(
    bootstrapAccounts(accounts, reportsSchema.parse([reset, limited]), now),
    accounts,
  );
});

test("Paseo 내장 보고서를 로컬 계정에 매칭한다", () => {
  const readings = mapReports(accounts, [report()], {});
  assert.equal(readings[0].id, "a");
  assert.equal(readings[0].fiveHour.used, 20);
  assert.equal(readings[0].weekly.used, 40);
  assert.equal(readings[0].capacity, 20);
  assert.equal("email" in readings[0], false);
});

test("Windows 보조 사용량을 매칭하고 같은 실제 계정을 중복 계산하지 않는다", () => {
  const windows = {
    ...report(),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
  };
  assert.equal(mapReports(accounts, [windows], {})[0].id, "a");
  const unknownOrganization = { ...accounts[0], identity: null };
  assert.equal(
    mapReports([unknownOrganization], [report(), windows], {}).length,
    1,
  );
  const failedNative = { ...report(), report: { status: "error" } };
  assert.equal(
    mapReports(accounts, [failedNative, windows], {})[0].fiveHour.used,
    20,
  );
  assert.equal(
    mapReports(
      [...accounts, { ...accounts[0], id: "duplicate" }],
      [report(), windows],
      {},
    ).length,
    1,
  );
});

test("같은 이메일에 조직이 여러 개면 조직 ID까지 매칭한다", () => {
  const wrong = report("a@example.test", "claude:account.org-b");
  wrong.report.windows[0].usedPct = 99;
  assert.equal(
    mapReports(accounts, [wrong, report()], {})[0].fiveHour.used,
    20,
  );
});

test("계정이 불분명하면 임의로 선택하지 않는다", () => {
  assert.deepEqual(
    mapReports(accounts, [report("different@example.test")], {}),
    [],
  );
});

test("이메일이 같아도 조직이 다르면 매칭하지 않는다", () => {
  assert.deepEqual(
    mapReports(
      accounts,
      [report("a@example.test", "claude:account.org-b")],
      {},
    ),
    [],
  );
});

test("같은 실제 계정을 두 개의 별도 한도로 계산하지 않는다", () => {
  const duplicate = {
    ...accounts[0],
    id: "duplicate",
    home: "/fixture/duplicate",
  };
  assert.equal(mapReports([...accounts, duplicate], [report()], {}).length, 1);
});

test("오류·누락 창·알 수 없는 사용량은 제외한다", () => {
  const error = { ...report(), report: { status: "error" } };
  assert.deepEqual(mapReports(accounts, [error], {}), []);
  assert.deepEqual(
    mapReports(
      accounts,
      [{ ...report(), report: { status: "available", windows: [] } }],
      {},
    ),
    [],
  );
  const unknown = reportsSchema.parse([
    {
      ...report(),
      report: {
        status: "available",
        windows: [{ id: "five_hour", usedPct: null, resetsAt: null }],
      },
    },
  ]);
  assert.deepEqual(mapReports(accounts, unknown, {}), []);
});

test("사용자가 지정한 플랜 용량을 우선한다", () => {
  assert.equal(mapReports(accounts, [report()], { a: 7 })[0].capacity, 7);
});

test("다른 provider의 보고서를 Claude 계정에 섞지 않는다", () => {
  assert.deepEqual(
    mapReports(accounts, [{ ...report(), sourceId: "codex" }], {}),
    [],
  );
});

test("불완전하거나 오래된 기본 보고서 대신 정상 Windows 보고서를 선택한다", () => {
  const windows = {
    ...report(),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
  };
  const incomplete = reportsSchema.parse([
    {
      ...report(),
      report: {
        status: "available",
        windows: [{ id: "five_hour", usedPct: null, resetsAt: null }],
      },
    },
  ])[0];
  const stale = {
    ...report(),
    fetchedAt: new Date(now - 7 * 60_000).toISOString(),
  };
  const invalid = { ...report(), fetchedAt: "invalid" };
  const reset = report();
  reset.report.windows[0].resetsAt = new Date(now - 1).toISOString();
  for (const first of [incomplete, stale, invalid, reset]) {
    assert.equal(
      mapReports(accounts, [first, windows], {}, now)[0].fiveHour.used,
      20,
    );
    assert.equal(mapReports(accounts, [windows, first], {}, now).length, 1);
  }
});

test("같은 계정의 최신 소진 보고서를 오래된 여유 보고서로 대체하지 않는다", () => {
  const old = { ...report(), fetchedAt: new Date(now - 1000).toISOString() };
  const newest = {
    ...report(),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
  };
  newest.report.windows[0].usedPct = 100;
  for (const sources of [
    [old, newest],
    [newest, old],
  ]) {
    const readings = mapReports(accounts, sources, {}, now);
    assert.equal(readings.length, 1);
    assert.equal(readings[0].fiveHour.used, 100);
    assert.equal(selectAccount(readings, now), null);
  }
});

test("무효화 이전의 진행 중 조회가 최신 결과를 덮거나 다음 요청을 공유하지 않는다", async () => {
  const resolve: Array<(result: string) => void> = [];
  const reader = new UsageReader(
    async () =>
      new Promise((done) => {
        resolve.push(done);
      }),
    () => now,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  const first = reader.read(command, signal);
  reader.invalidate();
  const second = reader.read(command, signal);
  assert.equal(resolve.length, 2);
  resolve[0](JSON.stringify([{ ...report(), id: "obsolete" }]));
  await new Promise((done) => setImmediate(done));
  const third = reader.read(command, signal);
  assert.equal(resolve.length, 2);
  resolve[1](JSON.stringify([{ ...report(), id: "current" }]));
  for (const pending of [first, second, third])
    assert.equal((await pending)[0].id, "current");
  assert.equal((await reader.read(command, signal))[0].id, "current");
  assert.equal(resolve.length, 2);
});

test("동일 세대는 조회를 공유하고 실패 뒤 재시도하며 취소된 호출은 캐시를 읽지 않는다", async () => {
  let calls = 0;
  let clock = now;
  const reader = new UsageReader(
    async () => {
      if (++calls === 1) throw new Error("usage unavailable");
      return JSON.stringify([report()]);
    },
    () => clock,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  const first = reader.read(command, signal);
  const second = reader.read(command, signal);
  await assert.rejects(first, /usage unavailable/);
  await assert.rejects(second, /usage unavailable/);
  assert.equal(calls, 1);
  clock += 15_000;
  assert.equal((await reader.read(command, signal)).length, 1);
  assert.equal(calls, 2);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(reader.read(command, canceled.signal), {
    name: "AbortError",
  });
});

test("실패한 조회는 잠시 그대로 돌려줘 줄 선 세션 열기가 각자 다시 기다리지 않는다", async () => {
  let calls = 0;
  let clock = now;
  const reader = new UsageReader(
    async () => {
      calls++;
      throw new Error("usage unavailable");
    },
    () => clock,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  // Session opens are serialized, so each one reads only after the previous one failed.
  for (const wait of [0, 1_000, 13_999]) {
    clock = now + wait;
    await assert.rejects(reader.read(command, signal), /usage unavailable/);
  }
  assert.equal(calls, 1);
  clock = now + 15_000;
  await assert.rejects(reader.read(command, signal), /usage unavailable/);
  assert.equal(calls, 2);
  // A login or limit change must not wait out an old failure.
  reader.invalidate();
  await assert.rejects(reader.read(command, signal), /usage unavailable/);
  assert.equal(calls, 3);
});

test("무효화된 이전 조회의 실패는 새 조회를 막지 않는다", async () => {
  const pending: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  const reader = new UsageReader(
    async () =>
      new Promise<string>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    () => now,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  const obsolete = assert.rejects(
    reader.read(command, signal),
    /usage unavailable/,
  );
  reader.invalidate();
  pending[0].reject(new Error("usage unavailable"));
  await obsolete;
  const current = reader.read(command, signal);
  assert.equal(pending.length, 2);
  pending[1].resolve(JSON.stringify([report()]));
  assert.equal((await current).length, 1);
});

test("형식이 어긋난 보고서 하나가 다른 계정의 조회를 막지 않는다", async () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    const malformed = [
      {
        ...report(),
        report: {
          status: "available",
          windows: [{ id: "weekly", usedPct: "many", resetsAt: null }],
        },
      },
      {
        id: "other:source",
        sourceId: "other",
        fetchedAt: 42,
        account: {},
        report: { status: "available" },
      },
      "not a report",
    ];
    const good = report("b@example.test", "claude:account.org-b");
    const parsed = parseReports([
      malformed[0],
      good,
      malformed[1],
      malformed[2],
    ]);
    assert.deepEqual(
      parsed.map((entry) => entry.id),
      ["claude:account.org-b"],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /3건을 제외하고 1건/);
    warnings.length = 0;
    assert.equal(parseReports([good]).length, 1);
    assert.equal(warnings.length, 0);
    const reader = new UsageReader(
      async () => JSON.stringify([malformed[0], good]),
      () => now,
    );
    const reports = await reader.read(
      { file: "fixture-cli", args: [] },
      new AbortController().signal,
    );
    assert.equal(reports.length, 1);
    assert.throws(() => parseReports({ reports: [] }));
  } finally {
    console.warn = warn;
  }
});

test("한도를 넘긴 사용률은 버리지 않고 소진으로 읽는다", () => {
  const over = report();
  over.report.windows[1].usedPct = 104.5;
  const parsed = parseReports([over]);
  assert.equal(parsed[0].report.windows?.[1].usedPct, 100);
  assert.deepEqual(
    mapReports(accounts, parsed, {}, now).map((entry) => entry.weekly.used),
    [100],
  );
  assert.equal(selectAccount(mapReports(accounts, parsed, {}, now), now), null);
  assert.equal(exhaustedUntil(accounts[0], parsed, now), now + 100 * 3_600_000);
  assert.deepEqual(bootstrapAccounts(accounts, parsed, now), []);
});

test("공유 사용량 조회의 첫 대기자 취소는 다른 요청과 캐시를 취소하지 않는다", async () => {
  let resolve!: (value: string) => void;
  let sharedSignal!: AbortSignal;
  let calls = 0;
  const reader = new UsageReader(async (_command, _args, signal) => {
    sharedSignal = signal;
    calls++;
    return await new Promise<string>((done, reject) => {
      resolve = done;
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const first = new AbortController();
  const command = { file: "fixture-only", args: [] };
  const abandoned = reader.read(command, first.signal);
  const canceled = assert.rejects(abandoned, { name: "AbortError" });
  const active = reader.read(command, new AbortController().signal);
  first.abort();
  try {
    await canceled;
    assert.equal(sharedSignal.aborted, false);
    resolve(JSON.stringify([report()]));
    assert.equal((await active).length, 1);
    assert.equal(
      (await reader.read(command, new AbortController().signal)).length,
      1,
    );
    assert.equal(calls, 1);
  } finally {
    resolve("[]");
    await active.catch(() => undefined);
  }
});

test("공유 사용량 조회의 추가 대기자는 조회 정산을 기다리지 않고 취소된다", async () => {
  let resolve!: (value: string) => void;
  const reader = new UsageReader(
    async () =>
      await new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const command = { file: "fixture-only", args: [] };
  const active = reader.read(command, new AbortController().signal);
  const second = new AbortController();
  const canceled = assert.rejects(reader.read(command, second.signal), {
    name: "AbortError",
  });
  second.abort();
  try {
    await canceled;
  } finally {
    resolve("[]");
    await active;
  }
});

test("UsageReader 해제는 실제 공유 조회와 모든 대기자를 종료한다", async () => {
  let sharedSignal!: AbortSignal;
  const reader = new UsageReader(async (_command, _args, signal) => {
    sharedSignal = signal;
    return await new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  });
  const command = { file: "fixture-only", args: [] };
  const pending = assert.rejects(
    reader.read(command, new AbortController().signal),
    { name: "AbortError" },
  );
  reader.dispose();
  await pending;
  assert.equal(sharedSignal.aborted, true);
  await assert.rejects(reader.read(command, new AbortController().signal), {
    name: "AbortError",
  });
});

test("만료만 확인된 로그인은 정상 CLI 갱신을 위해 식별하고 거부·오류는 포함하지 않는다", () => {
  const expired = {
    ...report(),
    report: {
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(now - 1000).toISOString(),
      },
    },
  };
  assert.deepEqual(
    expiredAccounts(accounts, [expired], now).map((account) => account.id),
    ["a"],
  );
  for (const kind of ["rejected", "missing", "unknown"])
    assert.deepEqual(
      expiredAccounts(
        accounts,
        [
          {
            ...expired,
            report: {
              ...expired.report,
              problem: { ...expired.report.problem, kind },
            },
          },
        ],
        now,
      ),
      [],
    );
  for (const expiresAt of ["invalid", new Date(now + 1000).toISOString()])
    assert.deepEqual(
      expiredAccounts(
        accounts,
        [
          {
            ...expired,
            report: {
              ...expired.report,
              problem: { kind: "expired", expiresAt },
            },
          },
        ],
        now,
      ),
      [],
    );
  assert.deepEqual(
    expiredAccounts(
      accounts,
      [expired, { ...report(), fetchedAt: new Date(now + 1).toISOString() }],
      now,
    ).map((account) => account.id),
    ["a"],
  );
  assert.deepEqual(
    expiredAccounts(
      accounts,
      [
        expired,
        {
          ...report(),
          fetchedAt: new Date(now).toISOString(),
          report: { status: "unavailable", problem: { kind: "rejected" } },
        },
      ],
      now,
    ),
    [],
  );
});

test("이메일 없는 Windows 만료 보고서도 해당 로컬 저장소에만 연결한다", () => {
  const account = {
    ...accounts[0],
    id: "claude",
    home: join(homedir(), ".claude"),
  };
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const route = {
    store: "windows-credman",
    service: "Claude Code-credentials",
  };
  const expired = {
    ...report(),
    id: "claude-windows:" + hash(JSON.stringify(route)),
    sourceId: "claude-windows",
    account: {},
    report: {
      status: "unavailable",
      problem: {
        kind: "expired",
        expiresAt: new Date(now - 1000).toISOString(),
      },
    },
  };
  assert.deepEqual(
    expiredAccounts([account], [expired], now).map((account) => account.id),
    ["claude"],
  );
  assert.deepEqual(
    expiredAccounts(
      [account],
      [{ ...expired, account: { label: "different@example.test" } }],
      now,
    ),
    [],
  );
  assert.deepEqual(
    expiredAccounts(
      [{ ...account, id: "other", home: "C:/different" }],
      [expired],
      now,
    ),
    [],
  );
  const file = {
    ...expired,
    id:
      "claude:" +
      hash(
        JSON.stringify({
          store: "claude",
          path: join(account.home, ".credentials.json"),
        }),
      ),
    sourceId: "claude",
  };
  assert.equal(
    expiredAccounts([account, { ...account, id: "duplicate" }], [file], now)
      .length,
    1,
  );
});

test("인증 갱신 뒤 무효화는 호스트의 5분 사용량 캐시도 강제로 새로 읽는다", async () => {
  const args: string[][] = [];
  let clock = now;
  const reader = new UsageReader(
    async (_command, request) => {
      args.push(request);
      return JSON.stringify([report()]);
    },
    () => clock,
  );
  const command = { file: "fixture-cli", args: [] },
    signal = new AbortController().signal;
  await reader.read(command, signal);
  assert.equal(args[0].includes("--refresh"), false);
  reader.invalidate();
  await reader.read(command, signal);
  assert.equal(args[1].includes("--refresh"), true);
  clock += 61_000;
  await reader.read(command, signal);
  assert.equal(args[2].includes("--refresh"), false);
});

test("다시 로그인은 로그인이 풀린 계정에만 필요하다", () => {
  const route = createHash("sha256")
    .update(
      JSON.stringify({
        store: "claude",
        path: join("/fixture/a", ".credentials.json"),
      }),
    )
    .digest("hex");
  const routed = (body: object) =>
    reportsSchema.parse([
      { ...report(undefined, "claude:" + route), account: {}, report: body },
    ]);
  assert.equal(needsLogin(accounts[0], [report()]), false);
  assert.equal(
    needsLogin(
      accounts[0],
      routed({ status: "error", error: "Claude login store no longer exists" }),
    ),
    true,
  );
  for (const kind of ["expired", "rejected", "missing"])
    assert.equal(
      needsLogin(
        accounts[0],
        routed({ status: "unavailable", problem: { kind } }),
      ),
      true,
    );
  assert.equal(
    needsLogin(
      accounts[0],
      routed({
        status: "unavailable",
        problem: { kind: "subscription_expired" },
      }),
    ),
    false,
  );
  assert.equal(
    needsLogin(
      accounts[0],
      routed({ status: "error", error: "Claude usage API returned 500" }),
    ),
    false,
  );
  assert.equal(needsLogin(accounts[0], []), true);
  assert.equal(
    needsLogin(accounts[0], [
      ...routed({
        status: "error",
        error: "Claude login store no longer exists",
      }),
      report(),
    ]),
    false,
  );
});

test("계정 기록이 없는 기본 Claude 세션만 유지할 이전 계정이 없다", () => {
  assert.equal(
    hasPreviousAccount({ provider: "claude", env: {} }, false),
    false,
  );
  assert.equal(hasPreviousAccount({ provider: "claude", env: {} }, true), true);
  assert.equal(
    hasPreviousAccount(
      { provider: "claude", env: { ASTER_ACCOUNT_ID: "a" } },
      false,
    ),
    true,
  );
  assert.equal(
    hasPreviousAccount({ provider: "claude-profile", env: {} }, false),
    true,
  );
});

test("소진된 한도의 복귀 시각을 알려 준다", () => {
  const account = {
    id: "a",
    base: "claude",
    home: "h",
    email: "a@example.invalid",
    identity: null,
  } as any;
  const report = (windows: any[]) =>
    [
      {
        id: "claude:a",
        sourceId: "claude",
        fetchedAt: new Date(1000).toISOString(),
        account: { label: "a@example.invalid" },
        report: { status: "available", windows },
      },
    ] as any;
  const reset = new Date(5000).toISOString();
  assert.equal(
    exhaustedUntil(
      account,
      report([{ id: "weekly", usedPct: 100, resetsAt: reset }]),
      2000,
    ),
    5000,
  );
  assert.equal(
    exhaustedUntil(
      account,
      report([{ id: "weekly", usedPct: 40, resetsAt: reset }]),
      2000,
    ),
    null,
  );
  assert.equal(
    exhaustedUntil(
      account,
      report([{ id: "weekly", usedPct: 100, resetsAt: reset }]),
      9000,
    ),
    null,
  );
});

test("확인된 계정이 있으면 만료된 계정으로 세션을 보내지 않는다", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const account = (id: string, email: string) =>
    ({
      id,
      base: "claude",
      home: "/" + id,
      email,
      identity: id + "-org|" + id,
      signedIn: true,
    }) as any;
  const reportFor = (email: string, value: object) =>
    ({
      id: "claude:" + email + "." + email.split("@")[0] + "-org",
      sourceId: "claude",
      sourceLabel: "Claude",
      fetchedAt: "2026-11-07T09:59:00Z",
      account: { label: email },
      report: value,
    }) as any;
  const healthy = account("main", "main@example.invalid");
  const lapsed = account("second", "second@example.invalid");
  const reports = [
    reportFor("main@example.invalid", {
      status: "available",
      windows: [
        { id: "five_hour", usedPct: 20, resetsAt: "2026-11-07T12:00:00Z" },
      ],
    }),
    reportFor("second@example.invalid", {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-11-07T09:30:00Z" },
    }),
  ];
  assert.deepEqual(
    bootstrapAccounts([lapsed, healthy], reports, now).map(
      (entry: any) => entry.id,
    ),
    ["main"],
  );
  assert.deepEqual(
    bootstrapAccounts([lapsed], reports, now).map((entry: any) => entry.id),
    ["second"],
  );
});

test("확인된 계정이 잠시 막혀 있으면 만료된 계정을 대안으로 남긴다", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const account = (id: string, email: string) =>
    ({
      id,
      base: "claude",
      home: "/" + id,
      email,
      identity: id + "-org|" + id,
      signedIn: true,
    }) as any;
  const reportFor = (email: string, value: object) =>
    ({
      id: "claude:" + email + "." + email.split("@")[0] + "-org",
      sourceId: "claude",
      sourceLabel: "Claude",
      fetchedAt: "2026-11-07T09:59:00Z",
      account: { label: email },
      report: value,
    }) as any;
  const reports = [
    reportFor("main@example.invalid", {
      status: "available",
      windows: [
        { id: "five_hour", usedPct: 20, resetsAt: "2026-11-07T12:00:00Z" },
      ],
    }),
    reportFor("second@example.invalid", {
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "2026-11-07T09:30:00Z" },
    }),
  ];
  const all = [
    account("main", "main@example.invalid"),
    account("second", "second@example.invalid"),
  ];
  assert.deepEqual(
    bootstrapAccounts(all, reports, now, (id) => id === "main")
      .map((entry: any) => entry.id)
      .sort(),
    ["main", "second"],
  );
});

/** The shape the host reports since Claude dropped the five-hour limit: weekly plus per-model weekly. */
function modelReport(
  fable: number | null,
  weekly = 59,
  label = "a@example.test",
  id = "claude:account.org-a",
) {
  const resetsAt = new Date(now + 6 * 24 * 3_600_000).toISOString();
  return reportsSchema.parse([
    {
      ...report(label, id),
      report: {
        status: "available",
        planLabel: "Max 20x",
        windows: [
          { id: "weekly", usedPct: weekly, resetsAt },
          { id: "weekly_model_fable", usedPct: fable, resetsAt },
        ],
      },
    },
  ])[0];
}

test("모델 주간 창은 모델 ID의 계열로만 읽고 모델과 묶을 수 없는 창은 무시한다", () => {
  assert.equal(windowFamily("weekly_model_fable"), "fable");
  assert.equal(windowFamily("weekly_model_Opus"), "opus");
  assert.equal(windowFamily("weekly_model_claude-sonnet-5"), "sonnet");
  assert.equal(windowFamily("weekly_model_fable_pro"), null);
  assert.equal(windowFamily("weekly_surface_claude_code"), null);
  assert.equal(windowFamily("weekly"), null);
  const [reading] = mapReports(accounts, [modelReport(100)], {}, now);
  assert.equal(reading.fiveHour, null);
  assert.deepEqual(reading.models, {
    fable: { used: 100, resetsAt: now + 6 * 24 * 3_600_000 },
  });
  // The model limit only constrains sessions on that model; an unknown model only sees the account's own.
  assert.equal(
    selectAccount([reading], now, new Map(), undefined, "fable"),
    null,
  );
  assert.equal(
    selectAccount([reading], now, new Map(), undefined, "opus")?.id,
    "a",
  );
  assert.equal(selectAccount([reading], now)?.id, "a");
});

test("모델 창 값이 비어 있으면 그 모델 세션에만 점수를 만들지 않는다", () => {
  const [reading] = mapReports(accounts, [modelReport(null)], {}, now);
  assert.equal(reading.models?.fable, null);
  assert.deepEqual(rankAccounts([reading], now, new Map(), "fable"), []);
  assert.equal(rankAccounts([reading], now, new Map(), "sonnet").length, 1);
});

test("모델 한도 소진은 그 모델의 복귀 시각만 알리고 계정 전체 소진으로 보지 않는다", () => {
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const resetsAt = now + 6 * 24 * 3_600_000;
  const spent = [
    modelReport(100),
    modelReport(100, 0, other.email!, "claude:account.org-b"),
  ];
  assert.equal(exhaustedUntil(accounts[0], spent, now), null);
  assert.equal(exhaustedUntil(accounts[0], spent, now, "fable"), resetsAt);
  assert.equal(exhaustedUntil(accounts[0], spent, now, "sonnet"), null);
  assert.deepEqual(exhaustedModels(accounts[0], spent, now), [
    { family: "fable", resetsAt },
  ]);
  assert.deepEqual(exhaustedModels(accounts[0], [modelReport(99)], now), []);
  assert.equal(
    exhaustedAccountsResetAt([...accounts, other], spent, now),
    null,
  );
  assert.equal(
    exhaustedAccountsResetAt([...accounts, other], spent, now, "fable"),
    resetsAt,
  );
  const mixed = [
    modelReport(100),
    modelReport(0, 0, other.email!, "claude:account.org-b"),
  ];
  assert.equal(
    exhaustedAccountsResetAt([...accounts, other], mixed, now, "fable"),
    null,
  );
});

test("주간 창이 빠진 부분 보고서도 세션 모델의 소진된 한도는 우회하지 않는다", () => {
  const partial = modelReport(100);
  partial.report.windows = [
    {
      id: "five_hour",
      usedPct: 10,
      resetsAt: new Date(now + 3_600_000).toISOString(),
    },
    ...(partial.report.windows ?? []).filter(
      (window) => window.id !== "weekly",
    ),
  ];
  assert.deepEqual(
    bootstrapAccounts(accounts, [partial], now, undefined, "fable"),
    [],
  );
  assert.deepEqual(
    bootstrapAccounts(accounts, [partial], now, undefined, "sonnet").map(
      (account) => account.id,
    ),
    ["a"],
  );
});

test("예정보다 일찍 초기화된 최신 보고서가 같은 계정의 이전 소진 보고서보다 우선한다", () => {
  const before = {
    ...modelReport(100, 100),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
    fetchedAt: new Date(now - 60_000).toISOString(),
  };
  const early = modelReport(0, 0);
  assert.equal(exhaustedUntil(accounts[0], [before], now) !== null, true);
  for (const order of [
    [before, early],
    [early, before],
  ]) {
    assert.equal(exhaustedUntil(accounts[0], order, now), null);
    assert.equal(exhaustedUntil(accounts[0], order, now, "fable"), null);
    assert.deepEqual(exhaustedModels(accounts[0], order, now), []);
  }
});

test("창 ID를 <기간>_(model|surface)_<대상>으로 읽어 기간과 모델 계열을 정하고 Claude Code 표면만 모든 세션의 한도로 본다", () => {
  assert.deepEqual(windowLimit("five_hour"), {
    period: "five_hour",
    family: null,
  });
  assert.deepEqual(windowLimit("weekly"), { period: "weekly", family: null });
  assert.deepEqual(windowLimit("weekly_model_fable"), {
    period: "weekly",
    family: "fable",
  });
  assert.deepEqual(windowLimit("five_hour_model_fable"), {
    period: "five_hour",
    family: "fable",
  });
  assert.deepEqual(windowLimit("weekly_model_claude-opus-4-8"), {
    period: "weekly",
    family: "opus",
  });
  // The host suffixes an id that would collide with another.
  assert.deepEqual(windowLimit("weekly_model_fable_2"), {
    period: "weekly",
    family: "fable",
  });
  for (const id of [
    "weekly_surface_code",
    "weekly_surface_claude_code",
    "weekly_surface_claude-code",
  ])
    assert.deepEqual(windowLimit(id), { period: "weekly", family: null }, id);
  assert.deepEqual(windowLimit("five_hour_surface_code"), {
    period: "five_hour",
    family: null,
  });
  for (const id of [
    "weekly_surface_chat",
    "weekly_surface_cowork",
    "weekly_model_fable_pro",
    "monthly_model_fable",
    "seven_day",
    "weekly_scoped",
  ])
    assert.equal(windowLimit(id), null, id);
  assert.equal(windowFamily("five_hour_model_fable"), "fable");
  assert.equal(windowFamily("weekly_surface_code"), null);
});

test("모델 5시간 창은 5시간 기간으로 그 모델 세션의 점수에 들어가고 소진되면 그 모델 세션만 그 초기화까지 제외한다", () => {
  const resetsAt = now + 2 * 3_600_000;
  const entry = modelReport(10, 10);
  entry.report.windows!.push({
    id: "five_hour_model_fable",
    usedPct: 100,
    resetsAt: new Date(resetsAt).toISOString(),
  });
  const [reading] = mapReports(accounts, [entry], {}, now);
  assert.deepEqual(reading.limits, [
    { family: "fable", hours: 5, usage: { used: 100, resetsAt } },
  ]);
  assert.equal(
    selectAccount([reading], now, new Map(), undefined, "fable"),
    null,
  );
  assert.equal(
    selectAccount([reading], now, new Map(), undefined, "sonnet")?.id,
    "a",
  );
  assert.equal(exhaustedUntil(accounts[0], [entry], now), null);
  assert.equal(exhaustedUntil(accounts[0], [entry], now, "fable"), resetsAt);
  assert.equal(
    exhaustedAccountsResetAt(accounts, [entry], now, "fable"),
    resetsAt,
  );
  assert.deepEqual(exhaustedModels(accounts[0], [entry], now), [
    { family: "fable", resetsAt },
  ]);
});

test("Claude Code 표면 한도는 모든 세션의 한도로 반영하고 다른 표면 한도는 분배에서 무시하되 상태 표시용으로 알린다", () => {
  const resetsAt = now + 3 * 24 * 3_600_000;
  const surface = (id: string, label: string) => {
    const entry = modelReport(0, 10);
    entry.report.windows!.push({
      id,
      label,
      usedPct: 100,
      resetsAt: new Date(resetsAt).toISOString(),
    });
    return entry;
  };
  const code = surface("weekly_surface_code", "Weekly · Code");
  assert.deepEqual(
    rankAccounts(mapReports(accounts, [code], {}, now), now),
    [],
  );
  assert.equal(exhaustedUntil(accounts[0], [code], now), resetsAt);
  assert.equal(exhaustedAccountsResetAt(accounts, [code], now), resetsAt);
  assert.deepEqual(bootstrapAccounts(accounts, [code], now), []);
  assert.deepEqual(exhaustedSurfaces(accounts[0], [code], now), []);
  const chat = surface("weekly_surface_chat", "Weekly · Chat");
  assert.equal(
    rankAccounts(mapReports(accounts, [chat], {}, now), now).length,
    1,
  );
  assert.equal(exhaustedUntil(accounts[0], [chat], now), null);
  assert.equal(exhaustedAccountsResetAt(accounts, [chat], now), null);
  assert.deepEqual(exhaustedSurfaces(accounts[0], [chat], now), [
    { name: "Chat", resetsAt },
  ]);
});

test("같은 계정의 더 최신 보고서에 모델 창이 없거나 값이 비어도 다른 출처에서 확인된 소진을 가리지 않고 새 값이 있으면 조기 초기화로 본다", () => {
  const resetsAt = now + 6 * 24 * 3_600_000;
  const older = {
    ...modelReport(100, 30),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
    fetchedAt: new Date(now - 60_000).toISOString(),
  };
  const lacking = modelReport(0, 30);
  lacking.report.windows = lacking.report.windows!.filter(
    (window) => window.id === "weekly",
  );
  const blank = modelReport(null, 30);
  for (const newest of [lacking, blank])
    for (const order of [
      [older, newest],
      [newest, older],
    ]) {
      assert.equal(exhaustedUntil(accounts[0], order, now, "fable"), resetsAt);
      assert.deepEqual(exhaustedModels(accounts[0], order, now), [
        { family: "fable", resetsAt },
      ]);
      const [reading] = mapReports(accounts, order, {}, now);
      assert.equal(reading.fetchedAt, now);
      assert.deepEqual(reading.models, { fable: { used: 100, resetsAt } });
      assert.equal(
        selectAccount([reading], now, new Map(), undefined, "fable"),
        null,
      );
      assert.equal(
        exhaustedAccountsResetAt(accounts, order, now, "fable"),
        resetsAt,
      );
      assert.deepEqual(
        bootstrapAccounts(accounts, order, now, undefined, "fable"),
        [],
      );
    }
  // A newer value below 100% is an early reset.
  const reset = modelReport(20, 30);
  for (const order of [
    [older, reset],
    [reset, older],
  ]) {
    assert.equal(exhaustedUntil(accounts[0], order, now, "fable"), null);
    assert.deepEqual(exhaustedModels(accounts[0], order, now), []);
    assert.equal(
      mapReports(accounts, order, {}, now)[0].models?.fable?.used,
      20,
    );
  }
  // The account's own window too: a newer report naming it without a value does not hide it.
  const spentWeekly = {
    ...older,
    report: {
      ...older.report,
      windows: [
        {
          id: "weekly",
          usedPct: 100,
          resetsAt: new Date(resetsAt).toISOString(),
        },
      ],
    },
  };
  const blankWeekly = reportsSchema.parse([
    {
      ...report(),
      report: {
        status: "available",
        windows: [{ id: "weekly", usedPct: null, resetsAt: null }],
      },
    },
  ])[0];
  assert.equal(
    exhaustedUntil(accounts[0], [spentWeekly, blankWeekly], now),
    resetsAt,
  );
  assert.equal(
    exhaustedAccountsResetAt(accounts, [spentWeekly, blankWeekly], now),
    resetsAt,
  );
});

test("5시간 창이 없는 최신 보고서는 그 한도가 없어진 것이라 이전 보고서의 5시간 소진을 되살리지 않고 값만 빈 5시간 창은 이전 값으로 채운다", () => {
  const shortReset = now + 2 * 3_600_000;
  const older = {
    ...report(),
    id: "claude-windows:account.org-a",
    sourceId: "claude-windows",
    fetchedAt: new Date(now - 60_000).toISOString(),
  };
  older.report.windows[0] = {
    id: "five_hour",
    usedPct: 100,
    resetsAt: new Date(shortReset).toISOString(),
  };
  const lifted = report();
  lifted.report.windows = lifted.report.windows.filter(
    (window) => window.id === "weekly",
  );
  for (const order of [
    [older, lifted],
    [lifted, older],
  ]) {
    assert.equal(exhaustedUntil(accounts[0], order, now), null);
    assert.equal(exhaustedAccountsResetAt(accounts, order, now), null);
    const [reading] = mapReports(accounts, order, {}, now);
    assert.equal(reading.fiveHour, null);
    assert.equal(selectAccount([reading], now)?.id, "a");
  }
  const blank = reportsSchema.parse([
    {
      ...report(),
      report: {
        ...report().report,
        windows: [
          { id: "five_hour", usedPct: null, resetsAt: null },
          report().report.windows[1],
        ],
      },
    },
  ])[0];
  assert.equal(exhaustedUntil(accounts[0], [older, blank], now), shortReset);
  assert.equal(
    exhaustedAccountsResetAt(accounts, [older, blank], now),
    shortReset,
  );
  // The incomplete newer report scores nothing; the older complete one shows the limit spent.
  assert.equal(
    selectAccount(mapReports(accounts, [older, blank], {}, now), now),
    null,
  );
});

test("5시간만 소진되면 5시간 초기화까지, 주간만 소진되면 주간 초기화까지, 모델 창만 소진되면 그 모델 세션만 제외한다", () => {
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const shortReset = now + 2 * 3_600_000;
  const weeklyReset = now + 100 * 3_600_000;
  const shortSpent = report();
  shortSpent.report.windows[0] = {
    id: "five_hour",
    usedPct: 100,
    resetsAt: new Date(shortReset).toISOString(),
  };
  assert.equal(exhaustedUntil(accounts[0], [shortSpent], now), shortReset);
  assert.equal(
    exhaustedAccountsResetAt(accounts, [shortSpent], now),
    shortReset,
  );
  assert.deepEqual(
    rankAccounts(mapReports(accounts, [shortSpent], {}, now), now),
    [],
  );
  const weeklySpent = report();
  weeklySpent.report.windows[1].usedPct = 100;
  assert.equal(exhaustedUntil(accounts[0], [weeklySpent], now), weeklyReset);
  assert.equal(
    exhaustedAccountsResetAt(accounts, [weeklySpent], now),
    weeklyReset,
  );
  assert.deepEqual(
    rankAccounts(mapReports(accounts, [weeklySpent], {}, now), now),
    [],
  );
  // Across accounts the earliest return counts.
  const otherSpent = report(other.email!, "claude:account.org-b");
  otherSpent.report.windows[1].usedPct = 100;
  assert.equal(
    exhaustedAccountsResetAt(
      [...accounts, other],
      [shortSpent, otherSpent],
      now,
    ),
    shortReset,
  );
  const fable = modelReport(100, 10);
  const fableReset = now + 6 * 24 * 3_600_000;
  assert.equal(exhaustedUntil(accounts[0], [fable], now), null);
  assert.equal(exhaustedUntil(accounts[0], [fable], now, "fable"), fableReset);
  assert.equal(exhaustedAccountsResetAt(accounts, [fable], now), null);
  const readings = mapReports(accounts, [fable], {}, now);
  assert.equal(rankAccounts(readings, now).length, 1);
  assert.equal(rankAccounts(readings, now, new Map(), "fable").length, 0);
});

test("모든 계정이 소진이면 계정마다 막는 한도를 모델·5시간·주간으로 나누고 그 한도들이 모두 풀리는 시각을 그 계정의 복귀 시각으로 본다", () => {
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const both = [...accounts, other];
  const hours = (count: number) => now + count * 3_600_000;
  const window = (id: string, usedPct: number, resetsAt: number | null) => ({
    id,
    usedPct,
    resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
  });
  const entry = (
    windows: ReturnType<typeof window>[],
    label?: string,
    id?: string,
  ) =>
    reportsSchema.parse([
      { ...report(label, id), report: { status: "available", windows } },
    ])[0];
  // A spent its five-hour and Fable limits and has weekly room; B spent its weekly limit.
  const first = entry([
    window("five_hour", 100, hours(2)),
    window("weekly", 40, hours(100)),
    window("weekly_model_fable", 100, hours(140)),
  ]);
  const second = entry(
    [
      window("weekly", 100, hours(30)),
      window("weekly_model_fable", 0, hours(140)),
    ],
    other.email!,
    "claude:account.org-b",
  );
  const heldByOwn = [
    { resetAt: hours(2), model: false, fiveHour: true, weekly: false },
    { resetAt: hours(30), model: false, fiveHour: false, weekly: true },
  ];
  // A Fable session waits for A's Fable limit, so B returns first.
  assert.deepEqual(spentAccounts(both, [first, second], now, "fable"), [
    { resetAt: hours(140), model: true, fiveHour: true, weekly: false },
    heldByOwn[1],
  ]);
  assert.equal(
    exhaustedAccountsResetAt(both, [first, second], now, "fable"),
    hours(30),
  );
  // Another model's session, or one of an unknown model, is held by the accounts' own limits only.
  assert.deepEqual(spentAccounts(both, [first, second], now), heldByOwn);
  assert.deepEqual(
    spentAccounts(both, [first, second], now, "sonnet"),
    heldByOwn,
  );
  assert.equal(exhaustedAccountsResetAt(both, [first, second], now), hours(2));
  // The Claude Code surface's limit is the account's own, by its window; a model's five-hour
  // limit is the model's.
  const scoped = entry([
    window("weekly", 10, hours(100)),
    window("weekly_surface_code", 100, hours(50)),
    window("five_hour_model_fable", 100, hours(3)),
  ]);
  assert.deepEqual(spentAccounts(accounts, [scoped], now, "fable"), [
    { resetAt: hours(50), model: true, fiveHour: false, weekly: true },
  ]);
  assert.deepEqual(spentAccounts(accounts, [scoped], now), [
    { resetAt: hours(50), model: false, fiveHour: false, weekly: true },
  ]);
  // One account with room, or a spent limit that names no reset ahead, confirms nothing.
  const roomy = entry(
    [window("weekly", 99, hours(30))],
    other.email!,
    "claude:account.org-b",
  );
  assert.equal(spentAccounts(both, [first, roomy], now, "fable"), null);
  for (const resetsAt of [null, now - 1]) {
    const unknown = entry([
      window("weekly", 100, hours(30)),
      window("weekly_model_fable", 100, resetsAt),
    ]);
    assert.equal(spentAccounts(accounts, [unknown], now, "fable"), null);
    assert.deepEqual(spentAccounts(accounts, [unknown], now), [
      { resetAt: hours(30), model: false, fiveHour: false, weekly: true },
    ]);
  }
  assert.equal(spentAccounts([], [], now), null);
});

test("세션 모델 창의 값이 비었거나 초기화가 지났거나 시각 없이 사용 중이면 그 모델 세션은 점수 대신 CLI 확인 후보가 되고 다른 모델은 점수로 고른다", () => {
  for (const window of [
    { usedPct: null, resetsAt: null },
    { usedPct: 30, resetsAt: new Date(now - 1).toISOString() },
    { usedPct: 100, resetsAt: new Date(now - 1).toISOString() },
    { usedPct: 30, resetsAt: null },
    { usedPct: 30, resetsAt: "invalid" },
  ]) {
    const entry = modelReport(0, 10);
    entry.report.windows![1] = { id: "weekly_model_fable", ...window };
    const readings = mapReports(accounts, [entry], {}, now);
    assert.equal(readings.length, 1);
    assert.deepEqual(rankAccounts(readings, now, new Map(), "fable"), []);
    assert.equal(rankAccounts(readings, now, new Map(), "sonnet").length, 1);
    assert.deepEqual(
      bootstrapAccounts(accounts, [entry], now, undefined, "fable").map(
        (account) => account.id,
      ),
      ["a"],
      JSON.stringify(window),
    );
    assert.deepEqual(
      bootstrapAccounts(accounts, [entry], now, undefined, "sonnet"),
      [],
    );
    assert.equal(
      exhaustedAccountsResetAt(accounts, [entry], now, "fable"),
      null,
    );
  }
  // A spent limit is not an incomplete one.
  assert.deepEqual(
    bootstrapAccounts(
      accounts,
      [modelReport(100, 10)],
      now,
      undefined,
      "fable",
    ),
    [],
  );
});

test("주간 창의 초기화가 지났으면 사용량을 0으로 지어내지 않고 5시간 여유가 확인되면 CLI 확인 후보로 남긴다", () => {
  const passed = report();
  passed.report.windows[1].resetsAt = new Date(now - 1).toISOString();
  assert.deepEqual(mapReports(accounts, [passed], {}, now), []);
  assert.deepEqual(
    bootstrapAccounts(accounts, [passed], now).map((account) => account.id),
    ["a"],
  );
  // The five-hour window spent: confirmed, so the CLI path does not go around it.
  passed.report.windows[0].usedPct = 100;
  assert.deepEqual(bootstrapAccounts(accounts, [passed], now), []);
});

test("점수에 쓰는 보고서보다 새 부분 보고서의 모델 창 값이 이겨 소진·조기 초기화가 점수와 상태 화면에 똑같이 보이고 그 보고서만 값 없이 밝힌 모델 창은 미확인으로 남는다", () => {
  const resetsAt = now + 6 * 24 * 3_600_000;
  const scored = (fable: number | null) => ({
    ...modelReport(fable, 30),
    id: "claude-profiles:account.org-a",
    sourceId: "claude-profiles",
    fetchedAt: new Date(now - 2 * 60_000).toISOString(),
  });
  // The newest report cannot be scored, its weekly window has no value, but names Fable's.
  const partial = (fable: number) => {
    const entry = modelReport(fable, 30);
    entry.report.windows![0].usedPct = null;
    return entry;
  };
  for (const order of [
    [scored(40), partial(100)],
    [partial(100), scored(40)],
  ]) {
    const [reading] = mapReports(accounts, order, {}, now);
    assert.equal(reading.fetchedAt, now - 2 * 60_000);
    assert.equal(reading.weekly.used, 30);
    assert.deepEqual(reading.models, { fable: { used: 100, resetsAt } });
    assert.equal(
      selectAccount([reading], now, new Map(), undefined, "fable"),
      null,
    );
    assert.equal(
      selectAccount([reading], now, new Map(), undefined, "sonnet")?.id,
      "a",
    );
    assert.deepEqual(exhaustedModels(accounts[0], order, now), [
      { family: "fable", resetsAt },
    ]);
  }
  // The other way round the newer value is an early reset.
  const [reset] = mapReports(accounts, [scored(100), partial(40)], {}, now);
  assert.deepEqual(reset.models, { fable: { used: 40, resetsAt } });
  assert.equal(
    selectAccount([reset], now, new Map(), undefined, "fable")?.id,
    "a",
  );
  assert.deepEqual(
    exhaustedModels(accounts[0], [scored(100), partial(40)], now),
    [],
  );
  // A newer report that leaves the window out does not turn the scored one's unknown into no limit.
  const lacking = partial(0);
  lacking.report.windows = lacking.report.windows!.filter(
    (window) => window.id === "weekly",
  );
  const [unknown] = mapReports(accounts, [scored(null), lacking], {}, now);
  assert.deepEqual(unknown.models, { fable: null });
  assert.deepEqual(rankAccounts([unknown], now, new Map(), "fable"), []);
});

test("소진된 창의 복귀 시각은 같은 시각 보고서 중 늦은 초기화를 쓰고 최신 보고서가 시각 없이 소진만 보이면 그 전 소진 보고서의 시각을 이어 쓰되 그 사이 여유나 지난 초기화가 보였으면 잇지 않는다", () => {
  const hours = (count: number) => now + count * 3_600_000;
  const entry = (
    source: string,
    ago: number,
    windows: { id: string; usedPct: number | null; resetsAt: number | null }[],
  ) =>
    reportsSchema.parse([
      {
        ...report(),
        id: `${source}:account.org-a`,
        sourceId: source,
        fetchedAt: new Date(now - ago).toISOString(),
        report: {
          status: "available",
          windows: windows.map((window) => ({
            ...window,
            resetsAt:
              window.resetsAt === null
                ? null
                : new Date(window.resetsAt).toISOString(),
          })),
        },
      },
    ])[0];
  const weekly = (usedPct: number | null, resetsAt: number | null) => [
    { id: "weekly", usedPct, resetsAt },
  ];
  // Two sources at the same time, both spent: the later reset, as before window merging.
  const early = entry("claude", 0, weekly(100, hours(10)));
  const late = entry("claude-windows", 0, weekly(100, hours(20)));
  for (const order of [
    [early, late],
    [late, early],
  ])
    assert.equal(exhaustedUntil(accounts[0], order, now), hours(20));
  // The newest report shows the limit spent without a reset: the older confirmed reset still holds.
  const blind = entry("claude", 0, weekly(100, null));
  const known = entry("claude-windows", 60_000, weekly(100, hours(30)));
  for (const order of [
    [blind, known],
    [known, blind],
  ])
    assert.equal(exhaustedUntil(accounts[0], order, now), hours(30));
  const fable = (usedPct: number, resetsAt: number | null) => [
    { id: "weekly", usedPct: 20, resetsAt: hours(50) },
    { id: "weekly_model_fable", usedPct, resetsAt },
  ];
  const models = [
    entry("claude", 0, fable(100, null)),
    entry("claude-windows", 60_000, fable(100, hours(40))),
  ];
  assert.deepEqual(exhaustedModels(accounts[0], models, now), [
    { family: "fable", resetsAt: hours(40) },
  ]);
  assert.equal(exhaustedUntil(accounts[0], models, now, "fable"), hours(40));
  // Room in between means the limit reset since, so that older reset belongs to an earlier one.
  const between = entry("claude-profiles", 30_000, weekly(40, hours(5)));
  assert.equal(exhaustedUntil(accounts[0], [blind, between, known], now), null);
  // A spent window whose reset passed is most likely lifted; an older reset does not stretch it.
  const passed = entry("claude", 0, weekly(100, hours(-1)));
  assert.equal(exhaustedUntil(accounts[0], [passed, known], now), null);
});

test("다른 곳의 로그인 변경 뒤에는 직전 보고서로 바로 답하고 강제 조회는 배경에서 한 번만 실행", async () => {
  const runs: Array<{ args: string[]; resolve: (value: string) => void }> = [];
  let clock = now;
  const reader = new UsageReader(
    async (_command, args) =>
      new Promise<string>((resolve) => {
        runs.push({ args, resolve });
      }),
    () => clock,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  const answered = async <T>(promise: Promise<T>) =>
    Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
  const first = reader.read(command, signal);
  runs[0].resolve(JSON.stringify([{ ...report(), id: "before" }]));
  assert.equal((await first)[0].id, "before");

  clock = now + 30_000;
  reader.revalidate();
  const during = reader.read(command, signal);
  assert.equal(await answered(during), true);
  assert.equal((await during)[0].id, "before");
  assert.equal(runs.length, 2);
  assert.ok(runs[1].args.includes("--refresh"));
  // Another open while it runs shares that lookup and is not held either.
  assert.equal((await reader.read(command, signal))[0].id, "before");
  assert.equal(runs.length, 2);
  runs[1].resolve(
    JSON.stringify([
      { ...report(), id: "after", fetchedAt: new Date(clock).toISOString() },
    ]),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reader.read(command, signal))[0].id, "after");
  assert.equal(runs.length, 2);

  // Reports the scheduler would soon drop do not stand in: the open waits for the new lookup.
  clock = now + 30_000 + 5 * 60_000 + 1;
  reader.revalidate();
  const stale = reader.read(command, signal);
  assert.equal(await answered(stale), false);
  assert.equal(runs.length, 3);
  runs[2].resolve(JSON.stringify([{ ...report(), id: "renewed" }]));
  assert.equal((await stale)[0].id, "renewed");

  // A limit, authentication or relogin result still drops the reports and waits.
  reader.invalidate();
  const forced = reader.read(command, signal);
  assert.equal(await answered(forced), false);
  assert.ok(runs[3].args.includes("--refresh"));
  runs[3].resolve(JSON.stringify([{ ...report(), id: "forced" }]));
  assert.equal((await forced)[0].id, "forced");
});

/** A reader whose host lookups wait for the test to settle them, and a check for a held read. */
function heldReader(clock: () => number) {
  const runs: Array<{
    args: string[];
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  const reader = new UsageReader(
    async (_command, args) =>
      new Promise<string>((resolve, reject) => {
        runs.push({ args, resolve, reject });
      }),
    clock,
  );
  const answered = async <T>(promise: Promise<T>) =>
    Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
  return {
    runs,
    reader,
    answered,
    command: { file: "fixture-cli", args: [] },
    signal: new AbortController().signal,
  };
}

test("로그인 변경 뒤 직전 Claude 보고서가 로그인·구독 문제나 실패 응답이면 대신 쓰지 않고 강제 조회를 기다린다", async () => {
  const lost = {
    ...report(),
    report: { status: "unavailable", problem: { kind: "rejected" } },
  };
  const free = report();
  free.report.planLabel = "Free";
  const failed = {
    ...report(),
    report: { status: "error", error: "Usage fetch timed out" },
  };
  for (const previous of [lost, free, failed]) {
    let clock = now;
    const { runs, reader, answered, command, signal } = heldReader(() => clock);
    const first = reader.read(command, signal);
    runs[0].resolve(JSON.stringify([previous]));
    await first;
    // Settings Sync restored the login: the open waits for the forced lookup that sees it.
    clock = now + 30_000;
    reader.revalidate();
    const after = reader.read(command, signal);
    assert.equal(await answered(after), false, previous.report.status);
    assert.ok(runs[1].args.includes("--refresh"));
    runs[1].resolve(JSON.stringify([report()]));
    const reports = await after;
    assert.equal(needsLogin(accounts[0], reports), false);
    assert.equal(mapReports(accounts, reports, {}, now).length, 1);
  }

  // Another provider's report that answers nothing does not hold a Claude session open.
  let clock = now;
  const { runs, reader, answered, command, signal } = heldReader(() => clock);
  const first = reader.read(command, signal);
  const codex = {
    ...report("codex@example.test", "codex:account"),
    sourceId: "codex",
    report: { status: "unavailable", problem: { kind: "missing" } },
  };
  runs[0].resolve(JSON.stringify([report(), codex]));
  await first;
  clock = now + 30_000;
  reader.revalidate();
  assert.equal(await answered(reader.read(command, signal)), true);
  runs[1].resolve(JSON.stringify([report(), codex]));
});

test("로그인 변경 전 보고서가 세션이 열 수 있는 계정을 모두 담지 않으면 강제 조회를 기다린다", async () => {
  let clock = now;
  const { runs, reader, answered, command, signal } = heldReader(() => clock);
  const other: Account = {
    id: "b",
    home: "/fixture/b",
    email: "b@example.test",
    identity: "org-b|b@example.test",
  };
  const covers =
    (eligible: Account[]) => (previous: Parameters<typeof needsLogin>[1]) =>
      eligible.every((account) => !needsLogin(account, previous));
  const first = reader.read(command, signal);
  runs[0].resolve(JSON.stringify([report()]));
  const reports = await first;
  clock = now + 30_000;
  reader.revalidate();
  // A login the old reports never saw (a new account in a profile) waits for the lookup.
  const unseen = reader.read(command, signal, covers([...accounts, other]));
  assert.equal(await answered(unseen), false);
  assert.equal(
    await answered(reader.read(command, signal, covers(accounts))),
    true,
  );
  runs[1].resolve(
    JSON.stringify([
      report(),
      report("b@example.test", "claude:account.org-b"),
    ]),
  );
  assert.equal((await unseen).length, 2);
});

test("로그인 변경 뒤 배경 강제 조회가 실패해도 유효한 직전 보고서로 15초 안의 열기를 받고 실패 이유를 한 줄 남긴다", async () => {
  let clock = now;
  const { runs, reader, answered, command, signal } = heldReader(() => clock);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    const first = reader.read(command, signal);
    runs[0].resolve(JSON.stringify([report()]));
    await first;
    clock = now + 30_000;
    reader.revalidate();
    // The watch starts the forced lookup with nobody waiting, and it fails.
    assert.equal(await answered(reader.read(command, signal)), true);
    runs[1].reject(Error("loopback usage API closed"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, [
      "[aster] 사용량 강제 새로고침 실패: Error: loopback usage API closed",
    ]);

    // Within the pause after the failure an open still gets the reports from before the change.
    clock += 5_000;
    const during = await reader.read(command, signal);
    assert.equal(during[0].id, "claude:account.org-a");
    assert.equal(runs.length, 2);

    // Past the pause the next open asks again, forced, behind the same reports.
    clock += 11_000;
    assert.equal(await answered(reader.read(command, signal)), true);
    assert.equal(runs.length, 3);
    assert.ok(runs[2].args.includes("--refresh"));
    runs[2].resolve(JSON.stringify([report()]));
  } finally {
    console.warn = warn;
  }
});
