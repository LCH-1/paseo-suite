import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withClaudeRecoveryMutex } from "../server/claude-recovery-mutex";

test("Windows recovery is exclusive across independent helper processes and can be reacquired", { skip: process.platform !== "win32" }, async () => {
  const key = "synthetic-recovery-" + randomUUID();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const held = withClaudeRecoveryMutex(key, async verify => { entered(); await gate; verify(); return "first"; });
  try { await ready; await assert.rejects(() => withClaudeRecoveryMutex(key, async () => "must-not-enter"), /복구/); }
  finally { release(); }
  assert.equal(await held, "first");
  assert.equal(await withClaudeRecoveryMutex(key, async verify => { verify(); return "next"; }), "next");
});

test("a failed recovery action releases the Windows process mutex", { skip: process.platform !== "win32" }, async () => {
  const key = "synthetic-recovery-" + randomUUID();
  await assert.rejects(() => withClaudeRecoveryMutex(key, async () => { throw new Error("synthetic action error"); }), /synthetic action error/);
  assert.equal(await withClaudeRecoveryMutex(key, async () => true), true);
});
