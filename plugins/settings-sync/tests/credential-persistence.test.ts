import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const worker = `
import { AutoSync } from ${JSON.stringify(new URL("../server/automation.ts", import.meta.url).href)};
import { Environment } from ${JSON.stringify(new URL("../server/environment.ts", import.meta.url).href)};
import { CredentialStore } from ${JSON.stringify(new URL("../server/credential-store.ts", import.meta.url).href)};
import { GitHubVault } from ${JSON.stringify(new URL("../server/github.ts", import.meta.url).href)};
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw);
const vault = new GitHubVault("synthetic token");
const auto = new AutoSync(new Environment(input.home), new CredentialStore(), () => vault, async () => "synthetic token", async () => "example");
try {
  if (input.action === "enable") await auto.enable({ login: "example", password: input.password, vault }, { config: true, plugins: true });
  if (input.action === "disable") await auto.disable();
  console.log(JSON.stringify(await auto.status()));
} finally { auto.dispose(); }
`;

function run(input: { home: string; action: string; password?: string }) {
  return new Promise<{ enabled: boolean; state: string; login: string | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", worker], { windowsHide: true, stdio: "pipe" });
    let output = "";
    let error = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Persistence worker timed out")); }, 30_000);
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { error += chunk.toString(); });
    child.on("error", reason => { clearTimeout(timer); reject(reason); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(error || "Persistence worker failed")); return; }
      try { resolve(JSON.parse(output)); } catch (reason) { reject(reason); }
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(input));
  });
}

test("Windows remembers the backup password across process exit until explicit disconnect", { skip: process.platform !== "win32" }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "paseo-dpapi-restart-"));
  const password = "synthetic persistence password";
  try {
    assert.equal((await run({ home, action: "enable", password })).enabled, true);
    const record = await readFile(path.join(home, "settings-sync", "automation.json"), "utf8");
    assert.equal(JSON.parse(record).secret.kind, "dpapi");
    assert.equal(record.includes(password), false);
    assert.equal(record.includes("synthetic token"), false);
    const resumed = await run({ home, action: "status" });
    assert.equal(resumed.enabled, true);
    assert.equal(resumed.state, "ready");
    assert.equal(resumed.login, "example");
    assert.equal((await run({ home, action: "disable" })).enabled, false);
    assert.equal((await run({ home, action: "status" })).state, "off");
  } finally {
    const resolved = path.resolve(home);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.ok(path.basename(resolved).startsWith("paseo-dpapi-restart-"));
    await rm(resolved, { recursive: true, force: true });
  }
});
