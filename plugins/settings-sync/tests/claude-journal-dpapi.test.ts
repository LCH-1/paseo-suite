import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lockClaudeAuthentication } from "../server/claude-auth-lock";
import { ClaudeSecureJournal, type JournalIO } from "../server/claude-secure-journal";

test("a fresh journal instance decrypts the complete generation with actual Windows DPAPI CurrentUser", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-journal-dpapi-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "profile"), journalDirectory = path.join(root, "journal"); await mkdir(directory);
  const lock = await lockClaudeAuthentication(directory); t.after(() => lock.release());
  const profile = { directory, service: "Synthetic-DPAPI-Journal-Only" }, previous = '{"synthetic":"previous"}', next = '{"synthetic":"next"}';
  let value = previous, fail = true;
  const io: JournalIO = {
    readEntry: async name => name === "claude-code-user" ? value : null, readComplete: async () => value,
    writeComplete: async (raw, beforeMutation) => { beforeMutation?.(); value = raw!; if (fail) { fail = false; throw new Error("Synthetic interrupted operation"); } },
    context: async () => "synthetic-account", verify: lock.verify, locks: lock.snapshot,
  };
  await assert.rejects(() => new ClaudeSecureJournal(journalDirectory).write(profile, io, next, previous), /Synthetic interrupted operation/);
  const files = await readdir(journalDirectory), encrypted = await readFile(path.join(journalDirectory, files[0]), "utf8");
  assert.equal(JSON.parse(encrypted).key.kind, "dpapi"); assert.equal(encrypted.includes("synthetic-account"), false); assert.equal(encrypted.includes("previous"), false);
  assert.equal(await new ClaudeSecureJournal(journalDirectory).recover(profile, io), true);
  assert.equal(value, next); assert.deepEqual(await readdir(journalDirectory), []);
});
