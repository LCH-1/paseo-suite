import assert from "node:assert/strict";
import test from "node:test";
import { exhaustedUntil,
  accountSecureDirectory,
  bootstrapAccounts,
  expiredAccounts,
  hasPreviousAccount,
  mapReports,
  needsLogin,
  reportsSchema,
  UsageReader,
  type Account,
} from "./accounts.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { selectAccount } from "./scheduler.ts";

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

test("5시간 창이 빠진 정상 보고서는 사용량을 만들지 않고 CLI 확인 후보로 선택한다", () => {
  const partial = report();
  partial.report.windows = partial.report.windows.filter(
    (window) => window.id === "weekly",
  );
  assert.deepEqual(mapReports(accounts, [partial], {}, now), []);
  assert.deepEqual(
    bootstrapAccounts(accounts, [partial], now).map((account) => account.id),
    ["a"],
  );
  assert.equal(
    bootstrapAccounts(
      [...accounts, { ...accounts[0], id: "alias" }],
      [partial],
      now,
    ).length,
    1,
  );
  const shortOnly = report();
  shortOnly.report.windows = shortOnly.report.windows.filter(
    (window) => window.id === "five_hour",
  );
  assert.equal(bootstrapAccounts(accounts, [shortOnly], now).length, 1);
});

test("불완전한 창이라도 확인된 한도가 소진되거나 오래되면 시작하지 않는다", () => {
  const partial = report();
  partial.report.windows = partial.report.windows.filter(
    (window) => window.id === "weekly",
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
    (window) => window.id === "weekly",
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
        windows: [{ id: "weekly", usedPct: null, resetsAt: null }],
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
  const reader = new UsageReader(
    async () => {
      if (++calls === 1) throw new Error("usage unavailable");
      return JSON.stringify([report()]);
    },
    () => now,
  );
  const command = { file: "fixture-cli", args: [] };
  const signal = new AbortController().signal;
  const first = reader.read(command, signal);
  const second = reader.read(command, signal);
  await assert.rejects(first, /usage unavailable/);
  await assert.rejects(second, /usage unavailable/);
  assert.equal(calls, 1);
  assert.equal((await reader.read(command, signal)).length, 1);
  assert.equal(calls, 2);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(reader.read(command, canceled.signal), {
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
  const account = { id: "a", base: "claude", home: "h", email: "a@example.invalid", identity: null } as any;
  const report = (windows: any[]) => [{ id: "claude:a", sourceId: "claude", fetchedAt: new Date(1000).toISOString(), account: { label: "a@example.invalid" }, report: { status: "available", windows } }] as any;
  const reset = new Date(5000).toISOString();
  assert.equal(exhaustedUntil(account, report([{ id: "weekly", usedPct: 100, resetsAt: reset }]), 2000), 5000);
  assert.equal(exhaustedUntil(account, report([{ id: "weekly", usedPct: 40, resetsAt: reset }]), 2000), null);
  assert.equal(exhaustedUntil(account, report([{ id: "weekly", usedPct: 100, resetsAt: reset }]), 9000), null);
});

test("확인된 계정이 있으면 만료된 계정으로 세션을 보내지 않는다", () => {
  const now = Date.parse("2026-11-07T10:00:00Z");
  const account = (id: string, email: string) => ({ id, base: "claude", home: "/" + id, email, identity: id + "-org|" + id, signedIn: true }) as any;
  const reportFor = (email: string, value: object) => ({ id: "claude:" + email + "." + email.split("@")[0] + "-org", sourceId: "claude", sourceLabel: "Claude", fetchedAt: "2026-11-07T09:59:00Z", account: { label: email }, report: value }) as any;
  const healthy = account("main", "main@example.invalid");
  const lapsed = account("second", "second@example.invalid");
  const reports = [
    reportFor("main@example.invalid", { status: "available", windows: [{ id: "weekly", usedPct: 20, resetsAt: "2026-11-10T00:00:00Z" }] }),
    reportFor("second@example.invalid", { status: "unavailable", problem: { kind: "expired", expiresAt: "2026-11-07T09:30:00Z" } }),
  ];
  assert.deepEqual(bootstrapAccounts([lapsed, healthy], reports, now).map((entry: any) => entry.id), ["main"]);
  assert.deepEqual(bootstrapAccounts([lapsed], reports, now).map((entry: any) => entry.id), ["second"]);
});
