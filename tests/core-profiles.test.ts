import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { coreProfileReader } from "../plugins/aster/server/core-profiles";
import { SubscriptionGuard } from "../plugins/aster/server/subscription";

test("core reader falls back only for an explicitly unsupported old host and closes every connection", async () => {
  let closed = 0;
  let failure =
    "Plugin claude-usage-source does not contribute RPC claude.profiles.read.request";
  const read = coreProfileReader("synthetic", async () => ({
    connect: async () => {},
    close: () => {
      closed++;
    },
    invokePluginRpc: async () => {
      throw Error(failure);
    },
  }));
  assert.equal(await read(["claude"], new AbortController().signal), null);
  failure = "connection closed";
  await assert.rejects(
    read(["claude"], new AbortController().signal),
    /connection closed/,
  );
  assert.equal(closed, 2);
});

test("two accounts use one core profile batch; authentication is never re-read and a failure retains known denials", async (context) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "paseo-core-subscription-"),
  );
  context.after(() => rm(home, { recursive: true, force: true }));
  const accounts = ["a", "b"].map((id) => ({
    id,
    home: path.join(home, id),
    identity: `org|${id}@example.invalid`,
    email: `${id}@example.invalid`,
  }));
  let now = 1000000,
    batches = 0,
    fail = false;
  const guard = new SubscriptionGuard(path.join(home, "observations"), home, {
    now: () => now,
    capture: async () => {
      throw Error("Core must own credential reads");
    },
    readProfiles: async (ids) => {
      batches++;
      assert.deepEqual(ids, ["a", "b"]);
      if (fail) throw Error("synthetic network failure");
      return accounts.map((account) => ({
        providerId: account.id,
        status: "ready" as const,
        identity: createHash("sha256")
          .update(JSON.stringify(["claude", account.id, "org"]))
          .digest("hex"),
        profile: {
          account: {
            uuid: account.id,
            email: account.email!,
            has_claude_max: account.id === "a",
            has_claude_pro: false,
          },
          organization: {
            uuid: "org",
            organization_type: "personal",
            subscription_status: account.id === "a" ? "active" : "expired",
          },
        },
      }));
    },
  });
  context.after(() => guard.dispose());
  const check = () =>
    guard.filter(accounts, async () => ({}), new AbortController().signal);
  assert.deepEqual(
    (await check()).map((account) => account.id),
    ["a"],
  );
  assert.equal(batches, 1);
  await check();
  assert.equal(batches, 1);
  now += 60001;
  fail = true;
  assert.deepEqual(
    (await check()).map((account) => account.id),
    ["a"],
  );
  assert.equal(batches, 2);
});
