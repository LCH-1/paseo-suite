import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lockClaudeAuthentication } from "../server/claude-auth-lock";

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-claude-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = path.join(root, "profile");
  await mkdir(profile);
  return { root, profile };
}

test("holds the CLI's three locks until release and allows a subsequent writer", async (t) => {
  const { profile } = await fixture(t);
  const lock = await lockClaudeAuthentication(profile);
  assert.deepEqual((await readdir(profile)).sort(), [".oauth_refresh.lock", ".storage-write.lock"]);
  await assert.rejects(lockClaudeAuthentication(profile), /잠금/);
  lock.check();
  await lock.release();
  assert.deepEqual(await readdir(profile), []);
  await lock.release();
  await (await lockClaudeAuthentication(profile)).release();
});

test("a busy later lock releases only locks acquired by this operation", async (t) => {
  const { profile, root } = await fixture(t);
  await mkdir(path.join(profile, ".storage-write.lock"));
  await assert.rejects(lockClaudeAuthentication(profile), /잠금/);
  assert.deepEqual(await readdir(profile), [".storage-write.lock"]);
  assert.deepEqual(await readdir(root), ["profile"]);
});

test("release preserves a lock replaced by another writer", async (t) => {
  const { profile } = await fixture(t);
  const lock = await lockClaudeAuthentication(profile);
  const refreshLock = path.join(profile, ".oauth_refresh.lock");
  await rm(refreshLock, { recursive: true });
  await mkdir(refreshLock);
  await lock.release();
  assert.deepEqual(await readdir(profile), [".oauth_refresh.lock"]);
  assert.throws(lock.check, /잠금/);
});

test("ownership verification detects replacement before the next heartbeat", async (t) => {
  const { profile } = await fixture(t);
  const lock = await lockClaudeAuthentication(profile);
  await rm(path.join(profile, ".storage-write.lock"), { recursive: true });
  await mkdir(path.join(profile, ".storage-write.lock"));
  await assert.rejects(() => lock.verify(), /잠금/);
  await lock.release();
  assert.deepEqual(await readdir(profile), [".storage-write.lock"]);
});
