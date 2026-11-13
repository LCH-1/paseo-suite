import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const rollback = (home: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/tsx/dist/cli.mjs"),
      path.join(root, "tools/rollback-install.mjs"),
      ...args,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, PASEO_HOME: home },
    },
  );

test("롤백 도구는 인자가 없으면 사용법을 알리고 아무것도 바꾸지 않는다", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "suite-rollback-"));
  try {
    const result = rollback(home);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: node tools\/rollback-install\.mjs/);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("롤백 도구는 체크포인트의 플러그인 폴더가 없으면 CLI를 부르기 전에 멈추고 GitHub 릴리즈 재설치를 안내한다", async () => {
  const box = await fs.mkdtemp(path.join(os.tmpdir(), "suite-rollback-"));
  const home = path.join(box, "home");
  const checkpoint = path.join(
    home,
    "suite/checkpoints/0f0f0f0f-0000-4000-8000-000000000000",
  );
  const present = path.join(box, "releases", "a".repeat(64), "plugins/ui");
  const cleaned = path.join(box, "releases", "b".repeat(64), "plugins/aster");
  // The executable does not exist: reaching the CLI would fail differently.
  const executable = path.join(box, "missing-app", "Paseo.exe");
  try {
    await fs.mkdir(checkpoint, { recursive: true });
    await fs.mkdir(present, { recursive: true });
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ plugins: {} }),
    );
    await fs.writeFile(path.join(home, "suite/installed.json"), "{}");
    await fs.writeFile(
      path.join(checkpoint, "config.json"),
      JSON.stringify({
        plugins: {
          "terminal-tabs": { source: "directory", path: present },
          aster: { source: "directory", path: cleaned },
          "not-suite": { source: "directory", path: path.join(box, "absent") },
        },
      }),
    );
    let result = rollback(home, executable, checkpoint);
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /Checkpoint plugin sources are missing; nothing was changed/,
    );
    assert.match(result.stderr, /aster: /);
    assert.doesNotMatch(result.stderr, /terminal-tabs:|not-suite/);
    assert.match(result.stderr, /install\.ps1 -Action Rollback -Version/);
    assert.equal(
      await fs.readFile(path.join(home, "suite/installed.json"), "utf8"),
      "{}",
    );

    // With every source present the tool proceeds to the CLI (absent here).
    await fs.mkdir(cleaned, { recursive: true });
    result = rollback(home, executable, checkpoint);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /sources are missing/);
  } finally {
    await fs.rm(box, { recursive: true, force: true });
  }
});
