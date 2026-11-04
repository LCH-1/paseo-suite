import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubscriptionGuard, subscriptionAccess } from "./subscription";
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
