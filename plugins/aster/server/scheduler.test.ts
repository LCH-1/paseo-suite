import assert from "node:assert/strict";
import test from "node:test";
import { policy, rankAccounts, selectAccount, type AccountUsage } from "./scheduler.ts";
import { Controller } from "./controller.ts";

const now = Date.parse("2026-10-22T08:00:00Z");
const hour = 3_600_000;
function account(id: string, weeklyUsed = 20, weeklyHours = 100): AccountUsage {
  return { id, fiveHour: { used: 20, resetsAt: now + 4 * hour }, weekly: { used: weeklyUsed, resetsAt: now + weeklyHours * hour }, fetchedAt: now, capacity: 1 };
}

test("주간 잔여 1%인 계정보다 주간 여유가 있는 계정을 선택한다", () => {
  const low = { ...account("a", 99), fiveHour: { used: 0, resetsAt: now + hour } };
  assert.equal(selectAccount([low, account("b", 8)], now)?.id, "b");
});

test("잔여량이 같으면 주간 초기화가 가까운 계정을 먼저 사용한다", () => {
  assert.equal(selectAccount([account("a", 50, 100), account("b", 50, 10)], now)?.id, "b");
});

test("5시간 한도가 병목이면 5시간 초기화도 점수에 반영한다", () => {
  const a = { ...account("a", 0, 1), fiveHour: { used: 80, resetsAt: now + 4 * hour } };
  const b = { ...account("b", 0, 1), fiveHour: { used: 80, resetsAt: now + hour } };
  assert.equal(selectAccount([a, b], now)?.id, "b");
});

test("5시간 잔여가 적은 계정보다 여유가 있는 계정을 선택한다", () => {
  const a = { ...account("a"), fiveHour: { used: 96, resetsAt: now + hour } };
  assert.equal(selectAccount([a, account("b")], now)?.id, "b");
});

test("한도를 다 쓰지 않았으면 잔여가 적어도 선택하고 더 여유로운 계정을 우선한다", () => {
  const nearly = (id: string, used: number) => ({ ...account(id), fiveHour: { used: 0, resetsAt: now + hour }, weekly: { used, resetsAt: now + 100 * hour } });
  assert.equal(selectAccount([nearly("a", 99)], now)?.id, "a");
  assert.equal(selectAccount([nearly("a", 99), nearly("b", 98)], now)?.id, "b");
  assert.equal(selectAccount([nearly("a", 100)], now), null);
});

test("초기화 시각이 지나도 잔여량을 임의 복구하지 않는다", () => {
  const a = { ...account("a"), fiveHour: { used: 100, resetsAt: now - 1 } };
  assert.equal(selectAccount([a], now), null);
});

test("오래된 사용량을 선택하지 않는다", () => {
  assert.equal(selectAccount([{ ...account("a"), fetchedAt: now - policy.maxAge - 1 }], now), null);
});

test("미래의 사용량 시각과 잘못된 초기화 시각을 제외한다", () => {
  assert.equal(selectAccount([{ ...account("a"), fetchedAt: now + 1 }], now), null);
  assert.equal(selectAccount([{ ...account("a"), weekly: { used: 0, resetsAt: NaN } }], now), null);
});

test("미사용 창의 초기화가 null이면 전체 기간을 적용한다", () => {
  const a = { ...account("a"), fiveHour: { used: 0, resetsAt: null }, weekly: { used: 0, resetsAt: null } };
  assert.equal(selectAccount([a], now)?.id, "a");
});

test("사용했는데 초기화 정보가 없으면 제외한다", () => {
  assert.equal(selectAccount([{ ...account("a"), weekly: { used: 10, resetsAt: null } }], now), null);
});

test("작업 중인 세션 수를 반영해 부하를 분산한다", () => {
  assert.equal(selectAccount([account("a"), account("b")], now, new Map([["a", 1]]))?.id, "b");
});

test("플랜의 상대 용량을 반영한다", () => {
  const b = { ...account("b"), capacity: 4 };
  assert.equal(selectAccount([account("a"), b], now)?.id, "b");
});

test("10분 이내에는 사용 가능한 현재 계정을 유지한다", () => {
  assert.equal(selectAccount([account("a", 70), account("b", 10)], now, new Map(), { accountId: "a", switchedAt: now - 1 })?.id, "a");
});

test("유지 시간 내라도 현재 계정이 소진되면 전환한다", () => {
  assert.equal(selectAccount([account("a", 100), account("b")], now, new Map(), { accountId: "a", switchedAt: now - 1 })?.id, "b");
});

test("현재 계정 조회에 실패했으면 유지 시간 제한을 적용하지 않는다", () => {
  assert.equal(selectAccount([account("b")], now, new Map(), { accountId: "a", switchedAt: now - 1 })?.id, "b");
});

test("점수가 비슷하면 유지 시간 이후에도 현재 계정을 유지한다", () => {
  assert.equal(selectAccount([account("a", 20), account("b", 15)], now, new Map(), { accountId: "a", switchedAt: now - hour })?.id, "a");
});

test("충분히 유리하면 유지 시간 이후 다른 계정으로 전환한다", () => {
  assert.equal(selectAccount([account("a", 60), account("b", 10)], now, new Map(), { accountId: "a", switchedAt: now - hour })?.id, "b");
});

test("잘못된 수치와 용량은 제외한다", () => {
  assert.deepEqual(rankAccounts([{ ...account("a"), capacity: 0 }, { ...account("b"), weekly: { used: NaN, resetsAt: now + hour } }], now), []);
});

test("모든 계정 소진 시 선택 가능한 계정이 없다", () => {
  assert.equal(selectAccount([account("a", 100), account("b", 100)], now), null);
});

test("동시 생성 요청은 순서대로 예약하여 다른 계정에 배분한다", async () => {
  const controller = new Controller();
  const readings = [account("a"), account("b")];
  const choose = (id: string) => controller.serialize(async () => {
    const selected = controller.choose(id, readings, now)!;
    await Promise.resolve();
    controller.bind(id, selected.id, now);
    return selected.id;
  });
  assert.deepEqual(await Promise.all([choose("s1"), choose("s2")]), ["a", "b"]);
});

test("큐 작업이 실패해도 다음 세션을 처리한다", async () => {
  const controller = new Controller();
  await assert.rejects(controller.serialize(async () => { throw new Error("failure"); }));
  assert.equal(await controller.serialize(async () => "ok"), "ok");
});

test("한도 오류 직후 현재 계정을 재선택하지 않는다", () => {
  const controller = new Controller();
  controller.bind("s1", "a", now);
  controller.limited("s1", now);
  assert.equal(controller.choose("s1", [account("a"), account("b")], now)?.id, "b");
});

test("세션 종료 시 부하·권한·바인딩을 해제한다", () => {
  const controller = new Controller();
  controller.bind("s1", "a", now);
  controller.busy.add("s1");
  controller.pendingPermission.add("s1");
  controller.close("s1");
  assert.equal(controller.bindings.size, 0);
  assert.equal(controller.busy.size, 0);
  assert.equal(controller.pendingPermission.size, 0);
});

/** An account the way Claude reports it since the five-hour limit went away. */
function weeklyOnly(id: string, weeklyUsed: number, fable?: number | null): AccountUsage {
  return {
    id,
    fiveHour: null,
    weekly: { used: weeklyUsed, resetsAt: now + 100 * hour },
    models: fable === undefined ? {} : { fable: fable === null ? null : { used: fable, resetsAt: now + 100 * hour } },
    fetchedAt: now,
    capacity: 1,
  };
}

test("5시간 한도가 없는 계정은 주간 잔여만으로 점수를 매긴다", () => {
  assert.deepEqual(rankAccounts([weeklyOnly("a", 60), weeklyOnly("b", 10)], now).map((entry) => entry.account.id), ["b", "a"]);
  // A spent weekly limit still rules the account out.
  assert.equal(selectAccount([weeklyOnly("a", 100)], now), null);
  // A five-hour limit that binds lowers the score of the account that has it.
  const limited = { ...weeklyOnly("c", 10), fiveHour: { used: 99, resetsAt: now + 2 * hour } };
  assert.equal(selectAccount([limited, weeklyOnly("d", 10)], now)?.id, "d");
});

test("세션 모델의 주간 한도가 소진된 계정은 그 세션 후보에서 빠지고 다른 모델과 모델 미상 세션에는 남는다", () => {
  const accounts = [weeklyOnly("a", 0, 100), weeklyOnly("b", 50, 0)];
  assert.equal(selectAccount(accounts, now, new Map(), undefined, "fable")?.id, "b");
  assert.equal(selectAccount(accounts, now, new Map(), undefined, "sonnet")?.id, "a");
  assert.equal(selectAccount(accounts, now)?.id, "a");
  assert.equal(selectAccount([weeklyOnly("a", 0, 100)], now, new Map(), undefined, "fable"), null);
});

test("점수는 전체 주간과 모델 주간 여유율 중 작은 값으로 계산한다", () => {
  const [a] = rankAccounts([weeklyOnly("a", 10, 80)], now, new Map(), "fable");
  assert.equal(a.score, Math.min(a.weeklyRate, a.modelRate));
  assert.equal(a.score, 20 / 100);
  assert.equal(selectAccount([weeklyOnly("a", 10, 80), weeklyOnly("b", 40, 40)], now, new Map(), undefined, "fable")?.id, "b");
});

test("모델 창 값이 비어 있으면 그 모델 세션에서만 점수를 만들지 않는다", () => {
  assert.deepEqual(rankAccounts([weeklyOnly("a", 10, null)], now, new Map(), "fable"), []);
  assert.equal(rankAccounts([weeklyOnly("a", 10, null)], now, new Map(), "opus").length, 1);
});

test("유지 시간 내라도 세션 모델의 한도가 소진된 현재 계정은 버린다", () => {
  const accounts = [weeklyOnly("a", 59, 100), weeklyOnly("b", 0, 0)];
  const current = { accountId: "a", switchedAt: now - 1 };
  assert.equal(selectAccount([weeklyOnly("a", 59, 0), weeklyOnly("b", 0, 0)], now, new Map(), current, "fable")?.id, "a");
  assert.equal(selectAccount(accounts, now, new Map(), current, "fable")?.id, "b");
  assert.equal(selectAccount(accounts, now, new Map(), current, "sonnet")?.id, "a");
});

/**
 * The scheduler of main (72d21a2), copied verbatim apart from names: every account then had a
 * five-hour and a weekly window. Reports of that shape must still score, rank and select alike.
 */
const mainScheduler = (() => {
  interface MainUsage { id: string; fiveHour: { used: number; resetsAt: number | null }; weekly: { used: number; resetsAt: number | null }; fetchedAt: number; capacity: number }
  function budget(window: MainUsage["weekly"], duration: number, now: number) {
    if (!Number.isFinite(window.used) || window.used < 0 || window.used > 100) return null;
    if (window.resetsAt !== null && (!Number.isFinite(window.resetsAt) || window.resetsAt <= now)) return null;
    if (window.resetsAt === null && window.used !== 0) return null;
    const hoursLeft = Math.max(((window.resetsAt ?? now + duration * hour) - now) / hour, 0.25);
    return Math.max(0, 100 - window.used) / hoursLeft;
  }
  function isCurrentUsage(account: MainUsage, now: number) {
    return Number.isFinite(account.fetchedAt) && now >= account.fetchedAt && now - account.fetchedAt <= policy.maxAge
      && Number.isFinite(account.capacity) && account.capacity > 0
      && budget(account.fiveHour, 5, now) !== null
      && budget(account.weekly, 168, now) !== null;
  }
  function rankAccounts(accounts: MainUsage[], now: number, loads = new Map<string, number>()) {
    return accounts.flatMap((account) => {
      if (!isCurrentUsage(account, now)) return [];
      const short = budget(account.fiveHour, 5, now);
      const weekly = budget(account.weekly, 168, now);
      if (short === null || weekly === null || short <= 0 || weekly <= 0) return [];
      const load = loads.get(account.id) ?? 0;
      const score = Math.min(short, weekly) * account.capacity / (load + 1);
      return [{ account, score, shortRate: short, weeklyRate: weekly, load }];
    }).sort((a, b) => b.score - a.score || b.shortRate - a.shortRate || a.account.id.localeCompare(b.account.id));
  }
  function selectAccount(accounts: MainUsage[], now: number, loads = new Map<string, number>(), current?: { accountId: string; switchedAt: number }) {
    const ranked = rankAccounts(accounts, now, loads);
    const best = ranked[0];
    if (!best) return null;
    const previous = ranked.find((entry) => entry.account.id === current?.accountId);
    if (previous && current && (now - current.switchedAt < policy.switchCooldown || best.score < previous.score * policy.switchGain)) {
      return previous.account;
    }
    return best.account;
  }
  return { rankAccounts, selectAccount };
})();

/** A small deterministic generator, so the matrix is the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("5시간·주간 창이 모두 있는 예전 형식은 main(72d21a2)과 점수·순위·선택·유지 결과가 같다", () => {
  const next = random(72);
  const pick = <T,>(values: T[]) => values[Math.floor(next() * values.length)];
  let compared = 0;
  for (let round = 0; round < 3000; round++) {
    const accounts = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, index) => {
      const fiveUsed = pick([0, 0, 20, 50, 80, 99, 100]);
      const weeklyUsed = pick([0, 0, 10, 40, 59, 90, 100]);
      return {
        id: pick(["a", "b", "c", "d"]) + index,
        fiveHour: { used: fiveUsed, resetsAt: fiveUsed === 0 && next() < 0.3 ? null : now + pick([-1, 0.1, 1, 2, 4.5]) * hour },
        weekly: { used: weeklyUsed, resetsAt: weeklyUsed === 0 && next() < 0.3 ? null : now + pick([1, 24, 100, 160]) * hour },
        fetchedAt: now - pick([0, 60_000, policy.maxAge + 1]),
        capacity: pick([1, 1, 5, 20]),
      };
    });
    const loads = new Map(accounts.flatMap((entry) => (next() < 0.4 ? [[entry.id, pick([1, 2])] as [string, number]] : [])));
    const current = next() < 0.6 ? { accountId: pick(accounts).id, switchedAt: now - pick([1, policy.switchCooldown + 1]) } : undefined;
    const expected = mainScheduler.rankAccounts(accounts, now, loads).map((entry) => [entry.account.id, entry.score, entry.shortRate]);
    // A session's model changes nothing while no report names a model limit.
    for (const family of [undefined, null, "fable"]) {
      const actual = rankAccounts(accounts, now, loads, family).map((entry) => [entry.account.id, entry.score, entry.shortRate]);
      assert.deepEqual(actual, expected);
      assert.equal(selectAccount(accounts, now, loads, current, family)?.id, mainScheduler.selectAccount(accounts, now, loads, current)?.id);
      compared++;
    }
  }
  assert.equal(compared, 9000);
});

test("점수는 한도 창마다 남은 사용량 ÷ 초기화까지 남은 시간의 최솟값 × 용량 ÷ (동시 세션 수+1)이다", () => {
  const five = { id: "five", fiveHour: { used: 40, resetsAt: now + 2 * hour }, weekly: { used: 10, resetsAt: now + 90 * hour }, fetchedAt: now, capacity: 5 };
  const [withShort] = rankAccounts([five], now, new Map([["five", 1]]));
  // 60% over 2 h is faster than 90% over 90 h: the weekly window is the slower one.
  assert.equal(withShort.score, Math.min(60 / 2, 90 / 90) * 5 / 2);
  const [binding] = rankAccounts([{ ...five, fiveHour: { used: 99, resetsAt: now + 4 * hour } }], now);
  assert.equal(binding.score, Math.min(1 / 4, 90 / 90) * 5);
  // Weekly only, as now: the weekly window and the session model's window.
  const weekly: AccountUsage = { id: "weekly", fiveHour: null, weekly: { used: 41, resetsAt: now + 59 * hour }, models: { fable: { used: 70, resetsAt: now + 10 * hour } }, fetchedAt: now, capacity: 20 };
  const [fable] = rankAccounts([weekly], now, new Map([["weekly", 3]]), "fable");
  assert.equal(fable.score, Math.min(59 / 59, 30 / 10) * 20 / 4);
  const [tight] = rankAccounts([{ ...weekly, models: { fable: { used: 95, resetsAt: now + 10 * hour } } }], now, new Map(), "fable");
  assert.equal(tight.score, Math.min(59 / 59, 5 / 10) * 20);
  const [unknown] = rankAccounts([weekly], now);
  assert.equal(unknown.score, (59 / 59) * 20);
});

test("5시간 창이 있는 계정과 없는 계정이 섞이면 있는 계정만 그 창을 최솟값에 넣고 없다는 이유만으로 동점에서 유리해지지 않는다", () => {
  const withShort = (id: string, used: number, hours: number): AccountUsage => ({ id, fiveHour: { used, resetsAt: now + hours * hour }, weekly: { used: 0, resetsAt: now + 100 * hour }, fetchedAt: now, capacity: 1 });
  const without = (id: string): AccountUsage => ({ id, fiveHour: null, weekly: { used: 0, resetsAt: now + 100 * hour }, fetchedAt: now, capacity: 1 });
  // The five-hour window binds: 2% over 4 h is slower than 100% over 100 h.
  assert.deepEqual(rankAccounts([withShort("a", 98, 4), without("b")], now).map((entry) => entry.account.id), ["b", "a"]);
  // A five-hour window with room does not bind, so both score the weekly 1%/h and the tie falls to the id.
  for (const [first, second] of [["a", "b"], ["b", "a"]]) {
    const ranked = rankAccounts([withShort(first, 0, 1), without(second)], now);
    assert.equal(ranked[0].score, ranked[1].score);
    assert.deepEqual(ranked.map((entry) => entry.account.id), ["a", "b"]);
  }
  // Between accounts that all have the window, more five-hour room still breaks the tie as before.
  assert.deepEqual(rankAccounts([withShort("a", 50, 1), withShort("b", 0, 1)], now).map((entry) => entry.account.id), ["b", "a"]);
});

test("모델 미상 세션은 점수가 20% 안쪽으로 비슷하면 모델 창이 소진되지 않은 계정을 앞세우고 유지 규칙과 점수는 그대로 둔다", () => {
  const spent = weeklyOnly("a", 50, 100);
  const close = weeklyOnly("b", 55, 0);
  const far = weeklyOnly("c", 60, 0);
  assert.equal(selectAccount([spent, close], now)?.id, "b");
  // Outside the margin the higher score stands: no reserve is kept for an unknown model.
  assert.equal(selectAccount([spent, far], now)?.id, "a");
  assert.deepEqual(rankAccounts([spent, close], now).map((entry) => [entry.account.id, entry.score]), [["b", 0.45], ["a", 0.5]]);
  // A session already on the account keeps it within the hold, and a known model is unaffected.
  assert.equal(selectAccount([spent, close], now, new Map(), { accountId: "a", switchedAt: now - 1 })?.id, "a");
  assert.equal(selectAccount([spent, close], now, new Map(), undefined, "sonnet")?.id, "a");
  assert.equal(selectAccount([spent, close], now, new Map(), undefined, "fable")?.id, "b");
});

test("모델 5시간 창과 Claude Code 표면 창도 기간 길이에 맞는 속도로 최솟값에 들어간다", () => {
  const base = weeklyOnly("a", 0);
  const model = (used: number, resetsAt: number | null): AccountUsage => ({ ...base, limits: [{ family: "fable", hours: 5, usage: { used, resetsAt } }] });
  // A fresh five-hour window runs for five hours: 100% over 5 h is faster than the weekly 1%/h.
  assert.equal(rankAccounts([model(0, null)], now, new Map(), "fable")[0].score, 1);
  assert.equal(rankAccounts([model(99, now + 4 * hour)], now, new Map(), "fable")[0].score, 1 / 4);
  assert.equal(rankAccounts([model(100, now + 4 * hour)], now, new Map(), "fable").length, 0);
  assert.equal(rankAccounts([model(100, now + 4 * hour)], now, new Map(), "sonnet")[0].score, 1);
  // The Claude Code surface's own limit binds every session on the account, whatever its model.
  const surface = (usage: { used: number; resetsAt: number } | null): AccountUsage => ({ ...base, limits: [{ family: null, hours: 168, usage }] });
  for (const family of [undefined, "sonnet"]) assert.equal(rankAccounts([surface({ used: 80, resetsAt: now + 40 * hour })], now, new Map(), family)[0].score, 20 / 40);
  assert.equal(rankAccounts([surface({ used: 100, resetsAt: now + 40 * hour })], now).length, 0);
  assert.equal(rankAccounts([surface(null)], now).length, 0);
});

test("5시간 창이 다음 보고서에서 사라지거나 다시 나타나도 현재 계정과 점수는 그 보고서만 따른다", () => {
  const current = { accountId: "a", switchedAt: now - hour };
  const shortSpent: AccountUsage = { ...weeklyOnly("a", 10), fiveHour: { used: 100, resetsAt: now + hour } };
  // A spent five-hour window: the hold gives way.
  assert.equal(selectAccount([shortSpent, weeklyOnly("b", 30)], now, new Map(), current)?.id, "b");
  // The next report has no five-hour window: nothing remembers the spent one.
  assert.equal(selectAccount([weeklyOnly("a", 10), weeklyOnly("b", 30)], now, new Map(), current)?.id, "a");
  // It comes back nearly used up: it binds again.
  const back: AccountUsage = { ...weeklyOnly("a", 10), fiveHour: { used: 99.9, resetsAt: now + hour } };
  assert.equal(selectAccount([back, weeklyOnly("b", 30)], now, new Map(), current)?.id, "b");
});
