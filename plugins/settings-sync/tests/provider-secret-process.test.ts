import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runProviderSecret } from "../server/provider-credentials";

test("a failed credential subprocess has exited before a rollback may start", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-secret-process-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "pid");
  const source = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.stdout.write('x'.repeat(2200000)); setInterval(() => {}, 1000);`;
  await assert.rejects(runProviderSecret(process.execPath, ["-e", source, pidFile], ""), /자격증명 저장소/);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
});
