import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SubscriptionGuard,
  subscriptionAccess,
  needsSubscriptionRecovery,
} from "./subscription";
import type { CoreProfiles } from "./core-profiles";

const identity = createHash("sha256")
  .update(JSON.stringify(["claude", "account", "organization"]))
  .digest("hex");
const profile = (
  paid: boolean,
  subscription_status = "active",
  organization_type = "personal",
) => ({
  account: {
    uuid: "account",
    email: "synthetic@example.invalid",
    has_claude_pro: paid,
    has_claude_max: false,
  },
  organization: {
    uuid: "organization",
    subscription_status,
    organization_type,
  },
});

test("Claude는 실제 종료·무료 전환과 해지 예약 후 남은 이용 기간을 구분", () => {
  assert.equal(
    subscriptionAccess(profile(true, "canceled"), identity, Date.now()),
    true,
  );
  assert.equal(
    subscriptionAccess(profile(false, "canceled"), identity, Date.now()),
    false,
  );
  assert.equal(
    subscriptionAccess(profile(true, "expired"), identity, Date.now()),
    false,
  );
  assert.equal(subscriptionAccess(profile(false), identity, Date.now()), false);
  assert.equal(
    subscriptionAccess(profile(false, "active", "team"), identity, Date.now()),
    true,
  );
  assert.equal(
    subscriptionAccess(
      profile(false, "canceled", "team"),
      identity,
      Date.now(),
    ),
    false,
  );
  assert.equal(
    subscriptionAccess(profile(true), "wrong-identity", Date.now()),
    null,
  );
});

test("Claude 구독 종료는 재로드·통신 실패에도 유지하고 재구독 확인 뒤에만 자동 복귀", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-subscription-"));
  const account = {
    id: "claude",
    home: directory,
    email: "synthetic@example.invalid",
    identity: "organization|account",
  };
  let now = 1800000000000,
    paid = false,
    failed = false;
  const readProfiles = async (): Promise<CoreProfiles> => {
    if (failed) throw Error("offline");
    return [
      {
        providerId: "claude",
        status: "ready",
        identity,
        profile: profile(paid),
      },
    ];
  };
  let guard = new SubscriptionGuard(directory, directory, {
    now: () => now,
    readProfiles,
  });
  try {
    assert.deepEqual(
      await guard.filter(
        [account],
        async () => ({}),
        new AbortController().signal,
      ),
      [],
    );
    guard.dispose();
    failed = true;
    now += 61000;
    guard = new SubscriptionGuard(directory, directory, {
      now: () => now,
      readProfiles,
    });
    assert.deepEqual(
      await guard.filter(
        [account],
        async () => ({}),
        new AbortController().signal,
      ),
      [],
    );
    failed = false;
    paid = true;
    now += 61000;
    assert.deepEqual(
      await guard.filter(
        [account],
        async () => ({}),
        new AbortController().signal,
      ),
      [account],
    );
  } finally {
    guard.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("정상 모델 설명·인용은 구독 종료로 판정하지 않고 실제 실패는 감지한다", () => {
  const completed = { kind: "completed" };
  for (const text of [
    "Claude Code requires an active Pro or Max subscription. Team seats may also provide access.",
    "402 subscription_required is an example API response.",
    'API Error: 402 {"error":{"type":"billing_error"}}',
  ])
    assert.equal(
      needsSubscriptionRecovery(completed, [
        { type: "assistant_message", text },
      ]),
      false,
    );
  assert.equal(
    needsSubscriptionRecovery({
      kind: "failed",
      error: {
        message: "Claude Code requires an active Pro or Max subscription",
      },
    }),
    true,
  );
  assert.equal(
    needsSubscriptionRecovery({
      kind: "failed",
      error: { message: "Provider failed", code: "subscription_expired" },
    }),
    true,
  );
  assert.equal(needsSubscriptionRecovery({ kind: "canceled" }), false);
});

test("같은 계정의 동시 호출은 진행 중인 구독 거부 확인을 함께 기다린다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-subscription-owned-"));
  const account = {
    id: "claude",
    home: directory,
    email: "synthetic@example.invalid",
    identity: "organization|account",
  };
  let resolve!: (value: CoreProfiles) => void;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const response = new Promise<CoreProfiles>((done) => {
    resolve = done;
  });
  let calls = 0;
  const guard = new SubscriptionGuard(join(directory, "cache"), directory, {
    now: () => 1800000000000,
    readProfiles: async () => {
      calls++;
      started();
      return await response;
    },
  });
  const pending: Promise<unknown>[] = [];
  try {
    const first = guard.filter(
      [account],
      async () => ({}),
      new AbortController().signal,
    );
    pending.push(first);
    await began;
    let settled = false;
    const second = guard
      .filter([account], async () => ({}), new AbortController().signal)
      .then((result) => {
        settled = true;
        return result;
      });
    pending.push(second);
    await new Promise((done) => setImmediate(done));
    assert.equal(settled, false);
    resolve([{ providerId: "claude", status: 402 }]);
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, []);
    assert.equal(calls, 1);
  } finally {
    resolve([]);
    await Promise.allSettled(pending);
    guard.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("구독 조회의 최초 호출 취소가 다른 대기자의 공식 확인을 취소하지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-subscription-owned-"));
  const account = {
    id: "claude",
    home: directory,
    email: "synthetic@example.invalid",
    identity: "organization|account",
  };
  let resolve!: (value: CoreProfiles) => void;
  let started!: () => void;
  let sharedSignal!: AbortSignal;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const response = new Promise<CoreProfiles>((done) => {
    resolve = done;
  });
  const guard = new SubscriptionGuard(join(directory, "cache"), directory, {
    readProfiles: async (_ids, signal) => {
      sharedSignal = signal;
      started();
      return await response;
    },
  });
  const first = new AbortController();
  const pending: Promise<unknown>[] = [];
  try {
    const abandoned = guard.filter([account], async () => ({}), first.signal);
    pending.push(abandoned);
    const canceled = assert.rejects(abandoned, { name: "AbortError" });
    await began;
    const active = guard.filter(
      [account],
      async () => ({}),
      new AbortController().signal,
    );
    pending.push(active);
    first.abort();
    await canceled;
    assert.equal(sharedSignal.aborted, false);
    resolve([{ providerId: "claude", status: 402 }]);
    assert.deepEqual(await active, []);
  } finally {
    resolve([]);
    await Promise.allSettled(pending);
    guard.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("구독 검증 해제는 대기자를 종료하고 늦은 응답으로 캐시를 쓰지 않는다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aster-subscription-owned-"));
  const account = {
    id: "claude",
    home: directory,
    email: "synthetic@example.invalid",
    identity: "organization|account",
  };
  let resolve!: (value: CoreProfiles) => void;
  let started!: () => void;
  const began = new Promise<void>((done) => {
    started = done;
  });
  const response = new Promise<CoreProfiles>((done) => {
    resolve = done;
  });
  const guard = new SubscriptionGuard(join(directory, "cache"), directory, {
    readProfiles: async () => {
      started();
      return await response;
    },
  });
  try {
    const canceled = assert.rejects(
      guard.filter([account], async () => ({}), new AbortController().signal),
      { name: "AbortError" },
    );
    await began;
    guard.dispose();
    await canceled;
    resolve([{ providerId: "claude", status: 402 }]);
    await new Promise((done) => setImmediate(done));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    resolve([]);
    guard.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
