import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { ensureProviderExecutable, readCodexArchive, type ProviderInstallOptions } from "../server/provider-install";
import { materializeProviders } from "../server/provider-paths";
import { projectProviders } from "../shared/provider-paths";

function tar(entries: { name: string; value?: Buffer; type?: string }[]) {
  const parts: Buffer[] = [];
  for (const { name, value = Buffer.from("synthetic"), type = "0" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write("0000700\0", 100); header.write(value.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    parts.push(header, value, Buffer.alloc((512 - value.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-provider-install-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.match(path.basename(root), /^paseo-provider-install-[a-zA-Z0-9]+$/);
    await rm(root, { recursive: true, force: true });
  });
  const options: ProviderInstallOptions = { home: path.join(root, "user home with ' quote $literal"), paseoHome: path.join(root, "paseo"), platform: "linux", arch: "x64", env: {}, resolveExecutable: async () => null, run: async () => { throw Error("real process execution forbidden"); }, fetch: async () => { throw Error("real network forbidden"); } };
  return { root, options, tools: path.join(root, "paseo", "settings-sync", "tools") };
}

test("existing executable returns immediately without network, processes or installation directories", async (t) => {
  const f = await fixture(t);
  assert.equal(await ensureProviderExecutable("claude", { ...f.options, resolveExecutable: async () => "/synthetic/existing/claude" }), "/synthetic/existing/claude");
  assert.deepEqual(await readdir(f.root), []);
});

test("only allowlisted CLI names can trigger an installer", async (t) => {
  const f = await fixture(t);
  for (const name of ["custom-wrapper", "claude; injected", "/tmp/claude", "npm"]) await assert.rejects(ensureProviderExecutable(name, f.options), /자동 설치를 지원하지/);
  assert.deepEqual(await readdir(f.root), []);
});

test("official Claude redirect is bounded and the script runs as a file argument without shell interpolation", async (t) => {
  const f = await fixture(t);
  const requests: string[] = []; let installed = false; let runCount = 0;
  const result = await ensureProviderExecutable("claude", { ...f.options,
    resolveExecutable: async () => installed ? "/home/synthetic/.local/bin/claude" : null,
    fetch: async (input, init) => {
      const url = String(input); requests.push(url); assert.equal(init?.redirect, "manual");
      return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "https://downloads.claude.ai/claude-code-releases/bootstrap.sh" } }) : new Response("#!/bin/bash\nprintf synthetic-installer");
    },
    run: async (executable, args, options) => {
      runCount++; assert.equal(executable, "/bin/bash"); assert.equal(args.length, 1);
      assert.ok(args[0].startsWith(f.tools)); assert.equal(await readFile(args[0], "utf8"), "#!/bin/bash\nprintf synthetic-installer");
      assert.equal(options.env.HOME, f.options.home); assert.equal(options.timeoutMs, 240_000); installed = true;
    },
  });
  assert.equal(result, "/home/synthetic/.local/bin/claude"); assert.equal(runCount, 1);
  assert.deepEqual(requests, ["https://claude.ai/install.sh", "https://downloads.claude.ai/claude-code-releases/bootstrap.sh"]);
  assert.deepEqual(await readdir(f.tools), []);
});

test("Cursor Windows uses only the official PowerShell script and static argument vector", async (t) => {
  const f = await fixture(t); let installed = false;
  const result = await ensureProviderExecutable("cursor-agent", { ...f.options, platform: "win32",
    resolveExecutable: async () => installed ? "C:\\Users\\synthetic\\AppData\\Local\\cursor-agent\\cursor-agent.cmd" : null,
    fetch: async (input) => { assert.equal(String(input), "https://cursor.com/install?win32=true"); return new Response("Write-Output 'synthetic installer'"); },
    run: async (executable, args) => {
      assert.ok(executable.endsWith("\\WindowsPowerShell\\v1.0\\powershell.exe"));
      assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
      assert.equal(await readFile(args.at(-1)!, "utf8"), "Write-Output 'synthetic installer'"); installed = true;
    },
  });
  assert.ok(result.endsWith("cursor-agent.cmd")); assert.deepEqual(await readdir(f.tools), []);
});

test("untrusted redirects and oversized script responses never execute an installer", async (t) => {
  const f = await fixture(t); let runs = 0;
  for (const response of [new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/installer.sh" } }), new Response("synthetic", { headers: { "content-length": String(3 * 1024 * 1024) } })]) {
    await assert.rejects(ensureProviderExecutable("claude", { ...f.options, fetch: async () => response, run: async () => { runs++; } }), /공식 CLI 자동 설치에 실패/);
  }
  assert.equal(runs, 0); assert.deepEqual(await readdir(f.tools), []);
});

function codexRelease(archive: Buffer, calls: string[], digest = `sha256:${createHash("sha256").update(archive).digest("hex")}`): typeof fetch {
  const name = "codex-package-x86_64-unknown-linux-musl.tar.gz";
  const url = `https://github.com/openai/codex/releases/download/rust-v9.8.7/${name}`;
  return async (input) => {
    calls.push(String(input));
    if (String(input) === "https://api.github.com/repos/openai/codex/releases/latest") return Response.json({ tag_name: "rust-v9.8.7", assets: [{ name, browser_download_url: url, digest }] });
    assert.equal(String(input), url);
    return new Response(new Uint8Array(archive));
  };
}

test("Codex verifies official release digests, preserves package helpers and reuses its installed native binary", async (t) => {
  const f = await fixture(t);
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4]);
  const archive = tar([{ name: "codex/bin/codex", value: binary }, { name: "codex/bin/helper", value: Buffer.from("synthetic-helper") }]);
  const calls: string[] = [];
  const options = { ...f.options, fetch: codexRelease(archive, calls) };
  const executable = await ensureProviderExecutable("codex", options);
  assert.deepEqual(await readFile(executable), binary);
  assert.equal(await readFile(path.join(path.dirname(executable), "helper"), "utf8"), "synthetic-helper");
  assert.deepEqual(projectProviders({ codex: { command: [executable] } }).codex.command, ["codex"]);
  const materialized = await materializeProviders({ codex: { command: ["codex", "--synthetic-flag"] } }, {}, { home: f.options.home, platform: "linux", resolveExecutable: async () => executable });
  assert.deepEqual(materialized.codex.command, [executable, "--synthetic-flag"]);
  assert.deepEqual(projectProviders(materialized).codex.command, ["codex", "--synthetic-flag"]);
  assert.equal(await ensureProviderExecutable("codex", options), executable);
  assert.equal(calls.length, 2);
  assert.ok((await readdir(f.tools)).every((entry) => !entry.startsWith("install-")));
});

test("Codex checksum mismatch or an absent digest prevents extraction and cleans staging", async (t) => {
  const f = await fixture(t);
  const archive = tar([{ name: "codex", value: Buffer.from([0x7f, 0x45, 0x4c, 0x46]) }]);
  for (const digest of [`sha256:${"0".repeat(64)}`, ""]) {
    await assert.rejects(ensureProviderExecutable("codex", { ...f.options, fetch: codexRelease(archive, [], digest) }), /공식 CLI 자동 설치에 실패/);
    assert.deepEqual(await readdir(f.tools), []);
  }
});

test("Codex extraction rejects traversal, links, duplicates and damaged archive headers", () => {
  for (const entries of [[{ name: "../outside" }], [{ name: "/outside" }], [{ name: "link", type: "2" }], [{ name: "duplicate" }, { name: "duplicate" }]]) assert.throws(() => readCodexArchive(tar(entries)), /Codex 압축파일/);
  assert.throws(() => readCodexArchive(Buffer.from("not-gzip")));
});

test("concurrent CLI preparation shares a single installation and failure output remains private", async (t) => {
  const f = await fixture(t); let installed = false; let runs = 0;
  const options = { ...f.options, resolveExecutable: async () => installed ? "/synthetic/claude" : null, fetch: async () => new Response("#!/bin/bash\ntrue"), run: async () => { runs++; await new Promise((resolve) => setTimeout(resolve, 10)); installed = true; } };
  assert.deepEqual(await Promise.all([ensureProviderExecutable("claude", options), ensureProviderExecutable("claude", options)]), ["/synthetic/claude", "/synthetic/claude"]);
  assert.equal(runs, 1);
  const secret = "synthetic-secret-installer-output";
  try { await ensureProviderExecutable("cursor-agent", { ...f.options, fetch: async () => new Response("#!/bin/bash\ntrue"), run: async () => { throw Error(secret); } }); assert.fail("expected installation failure"); }
  catch (error) { assert.equal(String(error).includes(secret), false); }
});
