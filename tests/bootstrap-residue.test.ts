import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
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
    context: (overrides: Partial<{ home: string; running: boolean }> = {}) => ({
      home: overrides.home ?? home,
      resourcesPath,
      executable: "unused",
      isDaemonRunning: async () => overrides.running ?? false,
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
    for (const digit of ["5", "6", "7", "8"])
      stale.push(await box.checkpoint(uuid(digit), 5 * DAY, {}));
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
    for (const digit of ["2", "3"]) await box.checkpoint(uuid(digit), 2 * DAY);
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
