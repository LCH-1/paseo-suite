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
  // Without a five-hour limit nothing caps the weekly rate.
  const limited = { ...weeklyOnly("c", 10), fiveHour: { used: 99, resetsAt: now + hour } };
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
