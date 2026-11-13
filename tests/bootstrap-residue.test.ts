import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mock, test } from "node:test";
import { prepare } from "../tools/bootstrap";

const DAY = 24 * 60 * 60 * 1000;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

// Every test owns a fake user profile so the default-home rule applies without
// touching the real %LOCALAPPDATA%\PaseoSuite or ~/.paseo.
async function sandbox() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-suite-residue-"));
  const user = path.join(root, "user");
  const home = path.join(user, ".paseo");
  const local = path.join(root, "local");
  const releases = path.join(local, "PaseoSuite", "releases");
  const resourcesPath = path.join(root, "resources");
  await fs.mkdir(path.join(resourcesPath, "suite"), { recursive: true });
  await fs.mkdir(home, { recursive: true });
  const lock = {
    schemaVersion: 1,
    plugins: ["ui", "aster", "settings-sync"].map((name) => ({
      name,
      id: name,
      files: [],
    })),
  };
  const treeHash = createHash("sha256")
    .update(JSON.stringify(lock))
    .digest("hex");
  await fs.writeFile(
    path.join(resourcesPath, "suite/suite-lock.json"),
    JSON.stringify({ ...lock, treeHash }),
  );
  const saved = {
    USERPROFILE: process.env.USERPROFILE,
    HOME: process.env.HOME,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  process.env.USERPROFILE = user;
  process.env.HOME = user;
  process.env.LOCALAPPDATA = local;
  assert.equal(path.resolve(os.homedir()), path.resolve(user));
  const age = async (target: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    await fs.utimes(target, at, at);
  };
  const release = async (name: string, ageMs: number) => {
    const target = path.join(releases, name);
    await fs.mkdir(path.join(target, "plugins/ui"), { recursive: true });
    await fs.writeFile(path.join(target, "plugins/ui/package.json"), "{}");
    await age(target, ageMs);
    return target;
  };
  const checkpoint = async (name: string, ageMs: number, config?: unknown) => {
    const target = path.join(home, "suite/checkpoints", name);
    await fs.mkdir(target, { recursive: true });
    if (config !== undefined)
      await fs.writeFile(
        path.join(target, "config.json"),
        JSON.stringify(config),
      );
    await age(target, ageMs);
    return target;
  };
  const exists = (target: string) =>
    fs.lstat(target).then(
      () => true,
      () => false,
    );
  return {
    root,
    home,
    releases,
    treeHash,
    release,
    checkpoint,
    exists,
    record: async () =>
      JSON.parse(
        await fs.readFile(
          path.join(home, "suite/residue-cleanup.json"),
          "utf8",
        ),
      ),
    resourcesPath,
    checkpoints: async () =>
      (await fs.readdir(path.join(home, "suite/checkpoints"))).sort(),
    context: (
      overrides: Partial<{
        home: string;
        running: boolean;
        executable: string;
        isDaemonRunning: () => Promise<boolean>;
      }> = {},
    ) => ({
      home: overrides.home ?? home,
      resourcesPath,
      executable: overrides.executable ?? "unused",
      isDaemonRunning:
        overrides.isDaemonRunning ?? (async () => overrides.running ?? false),
    }),
    async dispose() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("앱 시작(같은 treeHash)은 남긴 모든 체크포인트가 가리키는 release를 지키고 나머지 옛 release·체크포인트만 지운다", async () => {
  const box = await sandbox();
  try {
    const { releases, treeHash } = box;
    const current = await box.release(treeHash, 9 * DAY);
    const fromConfig = await box.release(hex("config"), 9 * DAY);
    const fromInstalledCheckpoint = await box.release(
      hex("installed"),
      9 * DAY,
    );
    const fromOlderKeptCheckpoint = await box.release(
      hex("older-kept"),
      9 * DAY,
    );
    const fromPrunedCheckpoint = await box.release(hex("pruned"), 9 * DAY);
    const orphanOld = await box.release(hex("orphan-old"), 3 * DAY);
    const orphanFresh = await box.release(hex("orphan-fresh"), 60 * 60 * 1000);
    const foreign = path.join(releases, "not-a-release");
    await fs.mkdir(foreign, { recursive: true });
    const interrupted = path.join(
      releases,
      `.${hex("interrupted")}.${"a".repeat(32)}.removing`,
    );
    await fs.mkdir(path.join(interrupted, "plugins"), { recursive: true });

    // The installed checkpoint is the oldest; it must survive besides the newest three.
    const installed = await box.checkpoint(uuid("1"), 10 * DAY, {
      plugins: {
        ui: { path: path.join(fromInstalledCheckpoint, "plugins/ui") },
      },
    });
    const newest = await box.checkpoint(uuid("2"), 1 * DAY, {});
    const second = await box.checkpoint(uuid("3"), 2 * DAY);
    // The audit's contradiction: an older retained checkpoint names a release
    // through a provider command only, never through installed.json.
    const third = await box.checkpoint(uuid("4"), 3 * DAY, {
      agents: {
        providers: {
          codex: {
            command: [
              "node",
              `${fromOlderKeptCheckpoint.replaceAll("\\", "/")}/plugins/aster/codex-proxy.mjs`,
            ],
          },
        },
      },
    });
    const pruned = await box.checkpoint(uuid("5"), 4 * DAY, {
      plugins: { ui: { path: path.join(fromPrunedCheckpoint, "plugins/ui") } },
    });
    const human = await box.checkpoint("nas-routing-20261108", 30 * DAY, {});

    await fs.writeFile(
      path.join(box.home, "config.json"),
      JSON.stringify({
        plugins: {
          // Mixed separators and upper-case hex still name the same release.
          ui: { path: fromConfig.replaceAll("\\", "/").toUpperCase() },
        },
      }),
    );
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash,
        release: current,
        checkpoint: installed,
        nativeUsagePending: false,
      }),
    );

    await prepare(box.context());

    for (const kept of [
      current,
      fromConfig,
      fromInstalledCheckpoint,
      fromOlderKeptCheckpoint,
      orphanFresh,
      foreign,
      installed,
      newest,
      second,
      third,
      human,
    ])
      assert.ok(await box.exists(kept), `kept: ${path.basename(kept)}`);
    for (const removed of [
      fromPrunedCheckpoint,
      orphanOld,
      interrupted,
      pruned,
    ])
      assert.equal(
        await box.exists(removed),
        false,
        `removed: ${path.basename(removed)}`,
      );
    assert.deepEqual(
      (await fs.readdir(releases)).filter((name) => name.endsWith(".removing")),
      [],
    );
  } finally {
    await box.dispose();
  }
});

test("업데이트 완료 경로도 정리하고 새 체크포인트를 남긴다", async () => {
  const box = await sandbox();
  try {
    const orphan = await box.release(hex("previous-update"), 3 * DAY);
    const stale = [];
    // Distinct configs: each one is a separate rollback point.
    for (const digit of ["5", "6", "7", "8"])
      stale.push(await box.checkpoint(uuid(digit), 5 * DAY, { digit }));
    await prepare(box.context());
    const state = JSON.parse(
      await fs.readFile(path.join(box.home, "suite/installed.json"), "utf8"),
    );
    assert.ok(await box.exists(state.checkpoint), "new checkpoint kept");
    assert.equal(await box.exists(orphan), false);
    const left = await fs.readdir(path.join(box.home, "suite/checkpoints"));
    assert.equal(left.length, 3);
    assert.ok(left.includes(path.basename(state.checkpoint)));
  } finally {
    await box.dispose();
  }
});

test("다른 PASEO_HOME·실행 중인 옛 호스트 대기 상태에서는 아무것도 지우지 않는다", async () => {
  const box = await sandbox();
  try {
    const orphan = await box.release(hex("shared"), 3 * DAY);
    const other = path.join(box.root, "other-home");
    await fs.mkdir(other);
    await prepare(box.context({ home: other }));
    assert.ok(
      await box.exists(orphan),
      "non-default home removed a shared release",
    );

    const old = await box.checkpoint(uuid("9"), 9 * DAY, {});
    for (const digit of ["a", "b", "c"])
      await box.checkpoint(uuid(digit), 1 * DAY, {});
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        checkpoint: path.join(box.home, "suite/checkpoints", uuid("a")),
        nativeUsagePending: true,
      }),
    );
    await prepare(box.context({ running: true }));
    assert.ok(
      await box.exists(orphan),
      "pending native switch removed a release",
    );
    assert.ok(
      await box.exists(old),
      "pending native switch removed a checkpoint",
    );
  } finally {
    await box.dispose();
  }
});

test("사용 중이거나 읽을 수 없는 잔여물은 건너뛰고 앱 시작을 막지 않는다", async () => {
  const box = await sandbox();
  try {
    const busy = await box.release(hex("busy"), 3 * DAY);
    await fs.writeFile(path.join(busy, "a-sibling.json"), "{}");
    await fs.utimes(
      busy,
      new Date(Date.now() - 3 * DAY),
      new Date(Date.now() - 3 * DAY),
    );
    const free = await box.release(hex("free"), 3 * DAY);
    await fs.mkdir(path.join(box.home, "suite"), { recursive: true });
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        nativeUsagePending: false,
      }),
    );
    const holder = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 20000)"],
      {
        cwd: path.join(busy, "plugins"),
        stdio: "ignore",
        windowsHide: true,
      },
    );
    await new Promise((resolve) => holder.once("spawn", resolve));
    try {
      await prepare(box.context());
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
    }
    if (process.platform === "win32")
      // Rename-first leaves a used release whole instead of half deleted.
      for (const file of ["a-sibling.json", "plugins/ui/package.json"])
        assert.ok(
          await box.exists(path.join(busy, file)),
          `a release in use was partially deleted: ${file}`,
        );
    assert.equal(await box.exists(free), false);
    // The packaged main process console reaches no log file; the record does.
    const first = (await box.record()).runs.at(-1);
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(first.treeHash, box.treeHash);
    assert.deepEqual(first.removed, [`releases/${hex("free")}`]);
    if (process.platform === "win32")
      assert.deepEqual(
        first.failed.map((entry: { name: string }) => entry.name),
        [`releases/${hex("busy")}`],
      );
    for (const entry of first.failed) assert.match(entry.code, /^E[A-Z]+$/);

    // An unreadable checkpoint root stops this cleanup; startup still succeeds.
    const orphan = await box.release(hex("orphan"), 3 * DAY);
    await fs.rm(path.join(box.home, "suite/checkpoints"), {
      recursive: true,
      force: true,
    });
    await fs.writeFile(
      path.join(box.home, "suite/checkpoints"),
      "not a folder",
    );
    await prepare(box.context());
    assert.ok(
      await box.exists(orphan),
      "cleanup continued after an unreadable checkpoint root",
    );
    const { runs } = await box.record();
    assert.equal(runs.length, 2);
    assert.match(runs[1].error, /checkpoints/);
    assert.deepEqual(runs[1].removed, []);
  } finally {
    await box.dispose();
  }
});

test("정리 기록은 할 일이 없으면 쓰지 않고 손상돼도 새로 쓰며 최근 20회만 남긴다", async () => {
  const box = await sandbox();
  try {
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    await box.checkpoint(uuid("1"), 1 * DAY, {});
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        checkpoint: path.join(box.home, "suite/checkpoints", uuid("1")),
        nativeUsagePending: false,
      }),
    );
    const file = path.join(box.home, "suite/residue-cleanup.json");
    await prepare(box.context());
    assert.equal(await box.exists(file), false, "idle start wrote a record");

    await fs.writeFile(file, "{ damaged");
    await box.release(hex("first"), 3 * DAY);
    await prepare(box.context());
    assert.deepEqual(
      (await box.record()).runs.map(
        (run: { removed: string[] }) => run.removed,
      ),
      [[`releases/${hex("first")}`]],
    );

    const old = Array.from({ length: 25 }, (_, index) => ({
      at: `old-${index}`,
      removed: [],
      failed: [],
    }));
    await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, runs: old }));
    await box.release(hex("second"), 3 * DAY);
    await prepare(box.context());
    const { runs } = await box.record();
    assert.equal(runs.length, 20);
    assert.equal(runs[0].at, "old-6");
    assert.deepEqual(runs.at(-1).removed, [`releases/${hex("second")}`]);
  } finally {
    await box.dispose();
  }
});

test("config.json 이 없으면 release 를 쓰이지 않는다고 판정하지 않는다", async () => {
  const box = await sandbox();
  try {
    const orphan = await box.release(hex("only-in-config"), 3 * DAY);
    await box.checkpoint(uuid("1"), 1 * DAY, {});
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        checkpoint: path.join(box.home, "suite/checkpoints", uuid("1")),
        nativeUsagePending: false,
      }),
    );
    await prepare(box.context());
    assert.ok(await box.exists(orphan), "release removed without a config");

    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    await prepare(box.context());
    assert.equal(await box.exists(orphan), false);
  } finally {
    await box.dispose();
  }
});

test("release 형식이 아닌 폴더·rolled-back.json 이 가리키는 release·release 이름의 링크·삭제에 실패한 체크포인트가 가리키는 release 는 남긴다", async () => {
  const box = await sandbox();
  let holder: ChildProcess | undefined;
  try {
    const { releases, treeHash } = box;
    const foreign = path.join(releases, "manual-backup");
    await fs.mkdir(foreign, { recursive: true });
    await fs.utimes(
      foreign,
      new Date(Date.now() - 9 * DAY),
      new Date(Date.now() - 9 * DAY),
    );
    const rolledBack = await box.release(hex("rolled-back"), 9 * DAY);
    // A link named like a release is neither followed nor removed.
    const outside = path.join(box.root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "keep.txt"), "not owned");
    const link = path.join(releases, hex("link"));
    await fs.symlink(outside, link, "junction");
    const at = new Date(Date.now() - 9 * DAY);
    await fs.lutimes(link, at, at);
    const fromLocked = await box.release(hex("locked-checkpoint"), 9 * DAY);

    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    const installed = await box.checkpoint(uuid("1"), 1 * DAY, {});
    for (const digit of ["2", "3"])
      await box.checkpoint(uuid(digit), 2 * DAY, { digit });
    const locked = await box.checkpoint(uuid("4"), 9 * DAY, {
      plugins: { ui: { path: path.join(fromLocked, "plugins/ui") } },
    });
    const pruned = await box.checkpoint(uuid("5"), 10 * DAY, {});
    await fs.writeFile(
      path.join(box.home, "suite/rolled-back.json"),
      JSON.stringify({ release: rolledBack }),
    );
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash,
        checkpoint: installed,
        nativeUsagePending: false,
      }),
    );
    holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      cwd: locked,
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => holder!.once("spawn", resolve));
    await prepare(box.context());

    for (const kept of [foreign, rolledBack, link])
      assert.ok(await box.exists(kept), `kept: ${path.basename(kept)}`);
    assert.ok(
      await box.exists(path.join(outside, "keep.txt")),
      "link was followed",
    );
    assert.equal(await box.exists(pruned), false);
    if (process.platform === "win32") {
      // Windows refuses to rename a checkpoint in use; it stays a rollback point.
      assert.ok(await box.exists(locked), "checkpoint in use was removed");
      assert.ok(
        await box.exists(fromLocked),
        "release of a checkpoint that failed removal was removed",
      );
    }
  } finally {
    holder?.kill();
    if (holder) await new Promise((resolve) => holder!.once("exit", resolve));
    await box.dispose();
  }
});

test("실패한 이전 시도는 체크포인트를 남기지 않아 정상 롤백 지점과 그 release 를 밀어내지 않는다", async () => {
  const box = await sandbox();
  try {
    const running = await box.release(hex("running-release"), 9 * DAY);
    const fromB = await box.release(hex("rollback-b"), 9 * DAY);
    const fromC = await box.release(hex("rollback-c"), 9 * DAY);
    const pointB = await box.checkpoint(uuid("b"), 5 * DAY, {
      plugins: { ui: { path: path.join(fromB, "plugins/ui") } },
    });
    const pointC = await box.checkpoint(uuid("c"), 4 * DAY, {
      plugins: { ui: { path: path.join(fromC, "plugins/ui") } },
    });
    const configPath = path.join(box.home, "config.json");
    const config = {
      plugins: { ui: { path: path.join(running, "plugins/ui") } },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: hex("previous-lock"),
        checkpoint: pointC,
        nativeUsagePending: false,
      }),
    );
    const before = await box.checkpoints();

    // The offline migration sees a daemon start, then a config edit, half way.
    let calls = 0;
    await assert.rejects(
      prepare(box.context({ isDaemonRunning: async () => ++calls === 2 })),
      /daemon started during offline migration/,
    );
    calls = 0;
    await assert.rejects(
      prepare(
        box.context({
          isDaemonRunning: async () => {
            if (++calls === 2)
              await fs.writeFile(
                configPath,
                JSON.stringify({ ...config, edited: true }),
              );
            return false;
          },
        }),
      ),
      /Config changed during Suite migration/,
    );
    assert.deepEqual(
      await box.checkpoints(),
      before,
      "a failed attempt left a checkpoint",
    );

    await prepare(box.context());
    const state = JSON.parse(
      await fs.readFile(path.join(box.home, "suite/installed.json"), "utf8"),
    );
    assert.deepEqual(
      await box.checkpoints(),
      [path.basename(state.checkpoint), ...before].sort(),
    );
    for (const kept of [pointB, pointC, fromB, fromC, running])
      assert.ok(await box.exists(kept), `kept: ${path.basename(kept)}`);
  } finally {
    await box.dispose();
  }
});

test("같은 설정을 복사한 체크포인트(실패하거나 끊긴 이전 시도의 흔적)는 최근 3개 자리를 차지하지 않고 지워진다", async () => {
  const box = await sandbox();
  try {
    const fromA = await box.release(hex("rollback-a"), 9 * DAY);
    const fromB = await box.release(hex("rollback-b"), 9 * DAY);
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    const same = {
      plugins: {
        ui: { path: path.join(box.releases, box.treeHash, "plugins/ui") },
      },
    };
    const installed = await box.checkpoint(uuid("1"), 1 * DAY, same);
    const copies = [];
    for (const digit of ["2", "3", "4"])
      copies.push(await box.checkpoint(uuid(digit), 2 * DAY, same));
    const pointB = await box.checkpoint(uuid("5"), 5 * DAY, {
      plugins: { ui: { path: path.join(fromB, "plugins/ui") } },
    });
    const pointA = await box.checkpoint(uuid("6"), 6 * DAY, {
      plugins: { ui: { path: path.join(fromA, "plugins/ui") } },
    });
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        checkpoint: installed,
        nativeUsagePending: false,
      }),
    );

    await prepare(box.context());

    for (const kept of [installed, pointB, pointA, fromB, fromA])
      assert.ok(await box.exists(kept), `kept: ${path.basename(kept)}`);
    for (const copy of copies)
      assert.equal(
        await box.exists(copy),
        false,
        `duplicate kept: ${path.basename(copy)}`,
      );
  } finally {
    await box.dispose();
  }
});

test("실행 중 호스트에서 플러그인을 바꾸기 전에 실패한 시도는 체크포인트를 지우고 바꾸기 시작한 뒤 실패하면 남긴다", async () => {
  const box = await sandbox();
  try {
    const runner = path.join(
      box.resourcesPath,
      "app.asar.unpacked/dist/daemon/node-entrypoint-runner.js",
    );
    await fs.mkdir(path.dirname(runner), { recursive: true });
    // A fake CLI: argv is [node, runner, "node-script", entry, "--home", home, ...command].
    const cli = (list: boolean) =>
      fs.writeFile(
        runner,
        `const command = process.argv.slice(6);\n` +
          `if (${list} && command[0] === "plugin" && command[1] === "ls") console.log("[]");\n` +
          `else process.exit(3);\n`,
      );
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    await fs.mkdir(path.join(box.home, "suite/checkpoints"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: hex("previous-lock"),
        nativeUsagePending: false,
      }),
    );
    const context = box.context({
      running: true,
      executable: process.execPath,
    });

    await cli(false);
    await assert.rejects(prepare(context));
    assert.deepEqual(
      await box.checkpoints(),
      [],
      "nothing was changed, yet the checkpoint stayed",
    );

    await cli(true);
    await assert.rejects(prepare(context));
    assert.equal(
      (await box.checkpoints()).length,
      1,
      "a plugin change was attempted, but its checkpoint was removed",
    );
  } finally {
    await box.dispose();
  }
});

test("오프라인 이전이 설정을 쓴 뒤 실패하면 설정을 되돌리고 그 체크포인트도 지운다", async () => {
  const box = await sandbox();
  try {
    const configPath = path.join(box.home, "config.json");
    const raw = JSON.stringify({ custom: { preserved: true } });
    await fs.writeFile(configPath, raw);
    await fs.mkdir(path.join(box.home, "suite/checkpoints"), {
      recursive: true,
    });
    // Right before the config is written, installed.json turns into a folder,
    // so the state write after it fails.
    let calls = 0;
    const context = box.context({
      isDaemonRunning: async () => {
        if (++calls === 2)
          await fs.mkdir(path.join(box.home, "suite/installed.json/blocker"), {
            recursive: true,
          });
        return false;
      },
    });
    await assert.rejects(prepare(context));
    assert.equal(await fs.readFile(configPath, "utf8"), raw);
    assert.deepEqual(await box.checkpoints(), []);
  } finally {
    await box.dispose();
  }
});

test("설치 기록이 가리키는 체크포인트는 더 새 체크포인트와 설정이 같아도 지우지 않는다", async () => {
  const box = await sandbox();
  try {
    const fromInstalled = await box.release(hex("installed-point"), 9 * DAY);
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    const same = {
      plugins: { ui: { path: path.join(fromInstalled, "plugins/ui") } },
    };
    // A rollback named the older point; a later attempt copied the same config.
    const installed = await box.checkpoint(uuid("1"), 5 * DAY, same);
    const newer = await box.checkpoint(uuid("2"), 1 * DAY, same);
    await fs.writeFile(
      path.join(box.home, "suite/installed.json"),
      JSON.stringify({
        schemaVersion: 1,
        treeHash: box.treeHash,
        checkpoint: installed,
        nativeUsagePending: false,
      }),
    );

    await prepare(box.context());

    assert.ok(await box.exists(installed), "installed checkpoint removed");
    assert.equal(
      await fs.readFile(path.join(installed, "config.json"), "utf8"),
      JSON.stringify(same),
    );
    for (const kept of [newer, fromInstalled])
      assert.ok(await box.exists(kept), `kept: ${path.basename(kept)}`);
  } finally {
    await box.dispose();
  }
});

test("오프라인 이전이 쓴 설정을 다른 쪽이 다시 바꾼 뒤 실패하면 그 설정과 이전 설정의 유일한 사본인 체크포인트를 남긴다", async () => {
  const box = await sandbox();
  const configPath = path.join(box.home, "config.json");
  const statePath = path.join(box.home, "suite/installed.json");
  const raw = JSON.stringify({ custom: { preserved: true } });
  const edited = JSON.stringify({ custom: { edited: "elsewhere" } });
  // Between the migration's config write and its state write, another
  // session replaces the config; then the state write fails.
  const rename = fs.rename;
  const replaced = mock.method(
    fs,
    "rename",
    async (from: string, to: string) => {
      if (path.resolve(to) === path.resolve(statePath)) {
        await fs.writeFile(configPath, edited);
        throw Object.assign(Error("injected state write failure"), {
          code: "EIO",
        });
      }
      return rename(from, to);
    },
  );
  try {
    await fs.writeFile(configPath, raw);
    await fs.mkdir(path.join(box.home, "suite/checkpoints"), {
      recursive: true,
    });
    await assert.rejects(prepare(box.context()), /injected state write/);
    assert.ok(replaced.mock.callCount() > 0);
    assert.equal(await fs.readFile(configPath, "utf8"), edited);
    const left = await box.checkpoints();
    assert.equal(left.length, 1, "the only copy of the old config was removed");
    assert.equal(
      await fs.readFile(
        path.join(box.home, "suite/checkpoints", left[0], "config.json"),
        "utf8",
      ),
      raw,
    );
  } finally {
    replaced.mock.restore();
    await box.dispose();
  }
});

test("실패한 시도의 체크포인트를 지우다 멈춰도 유효한 이름의 반쯤 지운 체크포인트를 남기지 않고 다음 정리가 마저 지운다", async () => {
  const box = await sandbox();
  const checkpoints = path.join(box.home, "suite/checkpoints");
  // A locked file (or a crash) stops the removal half way.
  const remove = fs.rm;
  const stopped = mock.method(
    fs,
    "rm",
    async (target: string, options?: Parameters<typeof fs.rm>[1]) => {
      if (path.dirname(path.resolve(target)) === path.resolve(checkpoints)) {
        await fs.unlink(path.join(target, "config.json")).catch(() => {});
        throw Object.assign(Error("injected busy file"), { code: "EBUSY" });
      }
      return remove(target, options);
    },
  );
  try {
    await fs.writeFile(path.join(box.home, "config.json"), "{}");
    await fs.mkdir(checkpoints, { recursive: true });
    let calls = 0;
    await assert.rejects(
      prepare(box.context({ isDaemonRunning: async () => ++calls === 2 })),
      /daemon started during offline migration/,
    );
    assert.ok(stopped.mock.callCount() > 0);
    const valid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.deepEqual(
      (await box.checkpoints()).filter((name) => valid.test(name)),
      [],
      "a half-removed checkpoint kept a valid name",
    );
    stopped.mock.restore();

    await prepare(box.context());
    const state = JSON.parse(
      await fs.readFile(path.join(box.home, "suite/installed.json"), "utf8"),
    );
    assert.deepEqual(await box.checkpoints(), [
      path.basename(state.checkpoint),
    ]);
  } finally {
    stopped.mock.restore();
    await box.dispose();
  }
});
