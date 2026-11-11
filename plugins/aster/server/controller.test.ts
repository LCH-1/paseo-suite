import assert from "node:assert/strict";
import test from "node:test";
import { Controller } from "./controller";
import type { AccountUsage } from "./scheduler";

test("시작 가능 여부 확인은 부트스트랩 순환을 진행하지 않는다", () => {
  const controller = new Controller();
  const now = 1800000000000;
  assert.equal(controller.canBootstrap([], now), false);
  assert.equal(controller.canBootstrap(["a", "b"], now), true);
  const first = controller.bootstrap("agent", ["a", "b"], now);
  controller.canBootstrap(["a", "b"], now);
  assert.notEqual(controller.bootstrap("agent", ["a", "b"], now), first);
  controller.limitAccount("a", now);
  controller.limitAccount("b", now);
  assert.equal(controller.canBootstrap(["a", "b"], now), false);
});

const minute = 60_000;
const start = 1800000000000;
const usage = (id: string, at = start): AccountUsage => ({
  id,
  capacity: 1,
  fetchedAt: at,
  fiveHour: { used: 10, resetsAt: at + 2 * 60 * minute },
  weekly: { used: 10, resetsAt: at + 3 * 24 * 60 * minute },
});

test("한도 안내가 알려 준 초기화 시각까지 차단하고 60초 뒤에 풀지 않는다", () => {
  const controller = new Controller();
  const resetsAt = start + 90 * minute;
  assert.equal(controller.limitAccount("a", start, { resetsAt }), resetsAt);
  for (const now of [start + 61_000, resetsAt - 1]) {
    assert.equal(controller.isBlocked("a", now), true);
    assert.equal(
      controller.choose("s", [usage("a", now), usage("b", now)], now)?.id,
      "b",
    );
  }
  assert.equal(controller.isBlocked("a", resetsAt), false);
  // An authentication or subscription hold keeps its one minute.
  assert.equal(controller.limitAccount("b", start), start + minute);
  assert.equal(controller.isBlocked("b", start + minute), false);
});

test("초기화 시각이 없으면 연속 실패에만 5분·15분·60분으로 늘려 차단한다", () => {
  const controller = new Controller();
  assert.equal(
    controller.limitAccount("a", start, { startedAt: start - 1 }),
    start + 5 * minute,
  );
  // Turns already running when the block began report the same incident.
  assert.equal(
    controller.limitAccount("a", start + 1000, { startedAt: start - 5000 }),
    start + 1000 + 5 * minute,
  );
  assert.equal(
    controller.limitAccount("a", start + 2000, {}),
    start + 2000 + 5 * minute,
  );
  const second = start + 6 * minute;
  assert.equal(
    controller.limitAccount("a", second + 1000, { startedAt: second }),
    second + 1000 + 15 * minute,
  );
  const third = second + 20 * minute;
  assert.equal(
    controller.limitAccount("a", third + 1000, { startedAt: third }),
    third + 1000 + 60 * minute,
  );
  const fourth = third + 70 * minute;
  assert.equal(
    controller.limitAccount("a", fourth + 1000, { startedAt: fourth }),
    fourth + 1000 + 60 * minute,
  );
  // A limit that returns long after the last block ended starts over.
  const later = fourth + 1000 + 60 * minute + 61 * minute;
  assert.equal(
    controller.limitAccount("a", later, { startedAt: later - 1000 }),
    later + 5 * minute,
  );
  // A notice without a time never shortens a reset the CLI already named.
  const named = later + 10 * minute + 4 * 60 * minute;
  assert.equal(controller.limitAccount("b", later, { resetsAt: named }), named);
  assert.equal(controller.limitAccount("b", later + 1000, {}), named);
});

test("차단된 계정뿐이면 마지막 수단으로 다시 고를 수 있다", () => {
  const controller = new Controller();
  controller.limitAccount("a", start, { resetsAt: start + 90 * minute });
  controller.limitAccount("b", start, {});
  const readings = [usage("a"), usage("b")];
  assert.equal(controller.choose("s", readings, start), null);
  assert.ok(controller.choose("s", readings, start, null, true));
  assert.equal(controller.bootstrap("s", ["a", "b"], start), null);
  assert.equal(controller.canBootstrap(["a", "b"], start), false);
  assert.equal(controller.canBootstrap(["a", "b"], start, true), true);
  assert.equal(controller.bootstrap("s", ["a", "b"], start, true), "a");
  assert.equal(controller.canBootstrap([], start, true), false);
});

test("차단 뒤에 시작해 정상 완료된 턴만 차단을 풀고 곧바로 되돌아온 한도는 풀지 않는다", () => {
  const controller = new Controller();
  const until = start + 90 * minute;
  controller.limitAccount("a", start, {
    resetsAt: until,
    startedAt: start - 1000,
  });
  // A turn that was already running proves nothing about the limit.
  assert.equal(controller.succeeded("a", start - 500, start + 1000), false);
  assert.equal(controller.isBlocked("a", start + 1000), true);
  assert.equal(controller.succeeded("a", start + 2000, start + 3000), true);
  assert.equal(controller.isBlocked("a", start + 3000), false);
  assert.equal(controller.succeeded("a", start + 2000, start + 3000), false);
  // The same limit straight after a release holds until its reset, whatever other turns do.
  controller.limitAccount("a", start + 10_000, {
    resetsAt: until,
    startedAt: start + 5000,
  });
  assert.equal(
    controller.succeeded("a", start + 20_000, start + 30_000),
    false,
  );
  assert.equal(controller.isBlocked("a", until - 1), true);
  assert.equal(controller.isBlocked("a", until), false);
});

test("모델 계열 한도는 그 계열 세션만 막고 다른 계열의 성공으로 풀리지 않는다", () => {
  const controller = new Controller();
  const until = start + 3 * 24 * 60 * minute;
  assert.equal(controller.hasModelLimit("a", start), false);
  controller.limitAccount("a", start, { resetsAt: until, family: "opus" });
  assert.equal(controller.hasModelLimit("a", start), true);
  assert.equal(controller.isBlocked("a", start, "opus"), true);
  assert.equal(controller.isBlocked("a", start, "sonnet"), false);
  // A session whose model is unknown is kept off the account.
  assert.equal(controller.isBlocked("a", start), true);
  assert.equal(controller.isBlocked("a", start, null), true);
  const readings = [usage("a"), usage("b")];
  controller.bind("sonnet-session", "a", start);
  controller.bind("opus-session", "a", start);
  assert.equal(
    controller.choose("sonnet-session", readings, start, "sonnet")?.id,
    "a",
  );
  assert.equal(
    controller.choose("opus-session", readings, start, "opus")?.id,
    "b",
  );
  assert.equal(
    controller.succeeded("a", start + 1000, start + 2000, "sonnet"),
    false,
  );
  assert.equal(controller.succeeded("a", start + 1000, start + 2000), false);
  assert.equal(controller.isBlocked("a", start + 2000, "opus"), true);
  assert.equal(
    controller.succeeded("a", start + 1000, start + 2000, "opus"),
    true,
  );
  assert.equal(controller.isBlocked("a", start + 2000, "opus"), false);
  assert.equal(controller.hasModelLimit("a", start + 2000), false);
});

test("차단 뒤 새로 시작된 사용량 창은 초기화 시각 없는 차단만 푼다", () => {
  const controller = new Controller();
  controller.limitAccount("a", start, {});
  controller.limitAccount("b", start, { resetsAt: start + 90 * minute });
  const later = start + 2 * minute;
  // The same windows as before the block say nothing new.
  controller.choose("s", [usage("a", later), usage("b", later)], later);
  assert.equal(controller.isBlocked("a", later), true);
  const fresh = (id: string): AccountUsage => ({
    ...usage(id, later),
    fiveHour: { used: 1, resetsAt: start + minute + 5 * 60 * minute },
  });
  assert.equal(
    controller.choose("s", [fresh("a"), fresh("b")], later)?.id,
    "a",
  );
  assert.equal(controller.isBlocked("a", later), false);
  assert.equal(controller.isBlocked("b", later), true);
  // The released block does not carry its backoff step into the next limit.
  assert.equal(
    controller.limitAccount("a", later + 1000, { startedAt: later }),
    later + 1000 + 5 * minute,
  );
});

test("시각 있는 차단은 사용량이 소진을 보인 뒤 100% 미만을 새로 보이면 예정보다 일찍 초기화된 것으로 풀린다", () => {
  const controller = new Controller();
  const resetsAt = start + 3 * 24 * 60 * minute;
  controller.limitAccount("a", start, { resetsAt });
  controller.limitAccount("c", start, { resetsAt });
  const at = (
    id: string,
    fetchedAt: number,
    weekly: number,
    fable = 0,
  ): AccountUsage => ({
    ...usage(id, fetchedAt),
    fiveHour: null,
    weekly: { used: weekly, resetsAt },
    models: { fable: { used: fable, resetsAt } },
  });
  // The lookup made right before the block shows the limit spent.
  controller.choose(
    "s",
    [at("a", start - minute, 100), at("c", start - minute, 100, 100)],
    start,
  );
  assert.equal(controller.isBlocked("a", start), true);
  // The same report again proves nothing new.
  controller.choose("s", [at("a", start - minute, 100)], start + minute);
  assert.equal(controller.isBlocked("a", start + minute), true);
  const later = start + 10 * minute;
  assert.equal(
    controller.choose("s", [at("a", later, 0), at("c", later, 0, 100)], later)
      ?.id,
    "a",
  );
  assert.equal(controller.isBlocked("a", later), false);
  // An account-wide block also waits for the model limit its notice may have meant.
  assert.equal(controller.isBlocked("c", later), true);
});

test("모델 차단은 그 모델 창의 조기 초기화로만 풀리고 계정 전체 창의 여유로는 풀리지 않는다", () => {
  const controller = new Controller();
  const resetsAt = start + 3 * 24 * 60 * minute;
  controller.limitAccount("a", start, { resetsAt, family: "fable" });
  const fable = (fetchedAt: number, used: number): AccountUsage => ({
    ...usage("a", fetchedAt),
    fiveHour: null,
    models: { fable: { used, resetsAt } },
  });
  controller.choose("s", [fable(start - minute, 100)], start, "fable");
  const later = start + 10 * minute;
  controller.choose(
    "s",
    [{ ...usage("a", later), fiveHour: null }],
    later,
    "fable",
  );
  assert.equal(controller.isBlocked("a", later, "fable"), true);
  assert.equal(controller.isBlocked("a", later, "sonnet"), false);
  const reset = later + minute;
  assert.equal(
    controller.choose("s", [fable(reset, 0)], reset, "fable")?.id,
    "a",
  );
  assert.equal(controller.isBlocked("a", reset, "fable"), false);
});

test("5시간 한도 안내의 차단은 보고서에서 5시간 창이 사라져도 안내된 시각까지 유지하고 다시 나타난 창이 소진 뒤 여유를 보이면 일찍 풀린다", () => {
  const controller = new Controller();
  const resetsAt = start + 3 * 60 * minute;
  controller.limitAccount("a", start, { resetsAt, period: "five_hour" });
  const withShort = (at: number, used: number): AccountUsage => ({
    ...usage("a", at),
    fiveHour: { used, resetsAt },
  });
  controller.choose("s", [withShort(start - minute, 100)], start);
  // The window has gone from the report: room in the weekly window says nothing about it.
  const later = start + 10 * minute;
  controller.choose("s", [{ ...usage("a", later), fiveHour: null }], later);
  assert.equal(controller.isBlocked("a", later), true);
  // It is back with room after the report showed it spent: an early reset.
  const back = later + minute;
  controller.choose("s", [withShort(back, 0)], back);
  assert.equal(controller.isBlocked("a", back), false);
});

test("주간 한도 안내의 시각 없는 차단은 새로 시작된 5시간 창으로 풀리지 않고 새 주간 창으로만 풀린다", () => {
  const controller = new Controller();
  controller.limitAccount("a", start, { period: "weekly" });
  controller.limitAccount("b", start, { period: "five_hour" });
  const later = start + 2 * minute;
  const freshShort = (id: string): AccountUsage => ({
    ...usage(id, later),
    fiveHour: { used: 1, resetsAt: start + minute + 5 * 60 * minute },
  });
  controller.choose("s", [freshShort("a"), freshShort("b")], later);
  assert.equal(controller.isBlocked("a", later), true);
  assert.equal(controller.isBlocked("b", later), false);
  controller.choose(
    "s",
    [
      {
        ...usage("a", later),
        weekly: { used: 1, resetsAt: start + minute + 168 * 60 * minute },
      },
    ],
    later,
  );
  assert.equal(controller.isBlocked("a", later), false);
});

test("모델 5시간 창도 그 모델 차단의 조기 초기화를 판단한다", () => {
  const controller = new Controller();
  const resetsAt = start + 2 * 60 * minute;
  controller.limitAccount("a", start, {
    resetsAt,
    family: "fable",
    period: "five_hour",
  });
  const reading = (at: number, used: number): AccountUsage => ({
    ...usage("a", at),
    fiveHour: null,
    models: { fable: { used: 10, resetsAt: at + 3 * 24 * 60 * minute } },
    limits: [{ family: "fable", hours: 5, usage: { used, resetsAt } }],
  });
  controller.choose("s", [reading(start - minute, 100)], start, "fable");
  controller.choose(
    "s",
    [reading(start + minute, 100)],
    start + minute,
    "fable",
  );
  assert.equal(controller.isBlocked("a", start + minute, "fable"), true);
  controller.choose(
    "s",
    [reading(start + 2 * minute, 0)],
    start + 2 * minute,
    "fable",
  );
  assert.equal(controller.isBlocked("a", start + 2 * minute, "fable"), false);
});

test("현재 계정 유지를 끄면 10분 유지와 20% 우위 없이 가장 여유로운 계정을 고른다", () => {
  const controller = new Controller();
  controller.bind("s", "a", start);
  const readings = [
    { ...usage("a"), weekly: { used: 60, resetsAt: start + 72 * 60 * minute } },
    usage("b"),
  ];
  assert.equal(controller.choose("s", readings, start + minute)?.id, "a");
  assert.equal(
    controller.choose("s", readings, start + minute, null, false, false)?.id,
    "b",
  );
});
