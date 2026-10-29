import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { identifyProcess } from "../server/claude-secure-journal";
import { runProviderSecret, WindowsProviderSecureStore } from "../server/provider-credentials";

test("Windows child publishes its real identity before a credential mutation and removes only its own marker", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-writer-test-")); t.after(() => rm(root, { recursive: true, force: true }));
  const service = "Paseo-Synthetic-Writer-" + randomUUID(), file = path.join(root, "writer.json"), nonce = randomUUID();
  const start = await identifyProcess(process.pid); assert.ok(start);
  assert.equal(await identifyProcess(2147483647), null);
  const store = new WindowsProviderSecureStore(async (executable, args, input) => {
    // Delay only this synthetic test child after its durable marker has been published.
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le").replace("$parent=[Diagnostics.Process]", "[Threading.Thread]::Sleep(1500); $parent=[Diagnostics.Process]");
    const result = runProviderSecret(executable, [...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")], input);
    if (JSON.parse(input).writer) {
      let observed: { pid: number; start: string; nonce: string } | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        try { observed = JSON.parse(await readFile(file, "utf8")); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      assert.ok(observed); assert.notEqual(observed.pid, process.pid); assert.equal(observed.nonce, nonce);
      assert.equal(await identifyProcess(observed.pid), observed.start);
    }
    return result;
  });
  try {
    store.setWriterTracker(() => ({ file, nonce, owner: { pid: process.pid, start } }));
    await store.write(service, "claude-code-user", "synthetic-only");
    assert.equal((await store.read(service, "claude-code-user"))?.value, "synthetic-only");
    await assert.rejects(readFile(file), { code: "ENOENT" });
    store.setWriterTracker(() => undefined);
    await writeFile(file, "foreign-marker");
    const ordinary = new WindowsProviderSecureStore(); ordinary.setWriterTracker(() => ({ file, nonce, owner: { pid: process.pid, start } }));
    await assert.rejects(ordinary.write(service, "claude-code-user", "must-not-write"));
    assert.equal(await readFile(file, "utf8"), "foreign-marker");
    assert.equal((await store.read(service, "claude-code-user"))?.value, "synthetic-only");
    await rm(file);
    ordinary.setWriterTracker(() => ({ file, nonce, owner: { pid: 2147483647, start: "absent" } }));
    await assert.rejects(ordinary.write(service, "claude-code-user", "orphan-must-not-write"));
    assert.equal((await store.read(service, "claude-code-user"))?.value, "synthetic-only");
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally { store.setWriterTracker(() => undefined); await store.remove(service, "claude-code-user"); }
});
