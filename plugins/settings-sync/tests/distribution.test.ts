import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, stat } from "node:fs/promises";
import { isBuiltin, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import * as sdk from "@getpaseo/plugin";
import * as zod from "zod";
import { rpc } from "../shared/rpc";
import { manualRpc } from "../shared/manual-restore-rpc";

const root = fileURLToPath(new URL("..", import.meta.url).href);

test("committed distribution matches the current server source", async () => {
  await promisify(execFile)(process.execPath, [path.join(root, "scripts/build.mjs"), "--check"], { cwd: root });
});

test("downloaded plugin compiles and registers RPCs without installed packages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-sync-distribution-"));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  for (const file of [...manifest.files, "package.json"]) await cp(path.join(root, file), path.join(directory, file), { recursive: true });
  await assert.rejects(stat(path.join(directory, "node_modules")), { code: "ENOENT" });
  const hostModules = ["@getpaseo/plugin", "@getpaseo/plugin/*", "zod", "react", "react/*", "react-native"];
  const compile = (entry: string, platform: "node" | "neutral") => build({ absWorkingDir: directory, entryPoints: [entry], bundle: true, platform, format: "cjs", jsx: "automatic", external: hostModules, metafile: true, write: false, nodePaths: [path.join(root, "../../node_modules")] });
  const [server, client] = await Promise.all([compile("index.server.ts", "node"), compile("index.client.tsx", "neutral")]);
  for (const bundle of [server, client]) {
    for (const output of Object.values(bundle.metafile!.outputs)) {
      for (const item of output.imports) assert.ok(isBuiltin(item.path) || /^@getpaseo\/plugin(?:\/|$)|^(?:zod|react|react-native)(?:\/|$)/.test(item.path), `Unexpected dependency ${item.path}`);
    }
  }
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const module = { exports: {} as { default: (context: unknown) => () => void } };
  const nodeRequire = createRequire(import.meta.url);
  new Function("require", "module", "exports", server.outputFiles[0].text)((name: string) => name === "@getpaseo/plugin" ? sdk : name === "zod" ? zod : nodeRequire(name), module, module.exports);
  // The Suite entry also registers settings screens and hooks, which this test does not exercise.
  const host = { handle(contract: { name: string }, handler: (input: unknown, context: { paseo: unknown }) => Promise<unknown>) { handlers.set(contract.name, (input) => handler(input, { paseo: {} })); return () => {}; } };
  const dispose = module.exports.default(new Proxy(host, { get: (target, key) => (key in target ? target[key as keyof typeof target] : () => () => {}) }));
  try {
    for (const contract of [...Object.values(rpc), ...Object.values(manualRpc)]) assert.ok(handlers.has(contract.name), contract.name);
    assert.deepEqual(await handlers.get(rpc.disconnect.name)!({ sessionId: "test-disconnected-session" }), { ok: true });
    await assert.rejects(handlers.get(rpc.preview.name)!({ sessionId: "test-disconnected-session" }), /로그인이 만료/);
  } finally {
    dispose();
  }
});
