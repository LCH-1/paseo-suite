import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { test } from "node:test";

const tool = path.resolve(import.meta.dirname, "../tools/dev/residue.cjs");
const residue = createRequire(import.meta.url)(tool);
const DAY = 24 * 60 * 60 * 1000;
const DEAD_PID = 2147483646;
// The daemon started after every synthetic hotfix was built.
const DAEMON_START = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const OTHER_START = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
const hex = (character: string) => character.repeat(64);
const uuid = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

interface SystemItem {
  src: string;
  text: string;
}
interface System {
  items: SystemItem[];
  errors: string[];
  processIds: number[];
}

// Every root points into a temporary tree; the real collector is replaced by a fixture.
function sandbox() {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "residue-test-"));
  const home = path.join(box, "home");
  const installs = path.join(box, "Programs", "Paseo");
  const releases = path.join(box, "PaseoSuite", "releases");
  const hotfixes = path.join(home, "suite", "hotfixes");
  const checkpoints = path.join(home, "suite", "checkpoints");
  const trash = path.join(box, "trash");
  const pins = path.join(box, "pins.json");
  const write = (file: string, body = "x") => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const age = (target: string, ms: number) => {
    const at = new Date(Date.now() - ms);
    fs.utimesSync(target, at, at);
  };
  const base = [
    "--home",
    home,
    "--root-installs",
    installs,
    "--root-releases",
    releases,
    "--root-tmp",
    path.join(box, "tmp"),
    "--trash",
    trash,
    "--pins",
    pins,
    "--min-age-hours",
    "0",
  ];
  let system: System = { items: [], errors: [], processIds: [1234] };
  const run = (...argv: string[]) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = residue.run([...argv, ...base], {
      platform: "win32",
      log: (line: string) => lines.push(line),
      error: (line: string) => errors.push(line),
      collectSystem: () => structuredClone(system),
    });
    return { code, output: lines.join("\n"), errors: errors.join("\n") };
  };
  const plan = (kinds: string, ...extra: string[]) => {
    const file = path.join(box, `plan-${kinds.replaceAll(",", "-")}.json`);
    const result = run("plan", "--kind", kinds, "--out", file, ...extra);
    assert.equal(result.code, 0, result.errors);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const action = (kind: string, name: string) =>
      saved.kinds[kind].items.find(
        (entry: { name: string }) => entry.name === name,
      )?.action;
    const reasons = (kind: string, name: string) =>
      saved.kinds[kind].items.find(
        (entry: { name: string }) => entry.name === name,
      )?.reasons ?? [];
    return { file, saved, action, reasons };
  };
  return {
    box,
    home,
    installs,
    releases,
    hotfixes,
    checkpoints,
    trash,
    pins,
    write,
    age,
    run,
    plan,
    setSystem(next: Partial<System>) {
      system = { items: [], errors: [], processIds: [1234], ...next };
    },
    dispose() {
      fs.rmSync(box, { recursive: true, force: true });
    },
  };
}

// Rollback state of the audit: an older retained checkpoint names a release and a
// hotfix only through a provider command; a pruned checkpoint names another release.
function seed(t: ReturnType<typeof sandbox>) {
  for (const name of [
    "current",
    "rollback",
    "old-a",
    "old-b",
    "busy",
    "icon-only",
    "env-cli",
    "env-path",
    "guid-location",
  ])
    t.write(path.join(t.installs, name, "Paseo.exe"));
  // Creation order decides "newest per plugin": f is the oldest settings-sync build.
  for (const [character, plugin] of [
    ["f", "settings-sync"],
    ["c", "aster"],
    ["b", "aster"],
    ["a", "aster"],
    ["e", "settings-sync"],
  ])
    t.write(
      path.join(t.hotfixes, hex(character), "plugins", plugin, "package.json"),
      "{}",
    );
  for (const character of ["1", "2", "3", "4", "5"])
    t.write(
      path.join(t.releases, hex(character), "plugins", "ui", "package.json"),
      "{}",
    );
  const checkpoint = (digit: string, ageMs: number, config?: unknown) => {
    const target = path.join(t.checkpoints, uuid(digit));
    fs.mkdirSync(target, { recursive: true });
    if (config !== undefined)
      fs.writeFileSync(
        path.join(target, "config.json"),
        JSON.stringify(config),
      );
    t.age(target, ageMs);
    return target;
  };
  const installed = checkpoint("1", 10 * DAY, {
    plugins: {
      aster: { path: path.join(t.hotfixes, hex("b"), "plugins", "aster") },
      "terminal-tabs": {
        path: path.join(t.releases, hex("2"), "plugins", "ui"),
      },
    },
  });
  checkpoint("2", 1 * DAY, {});
  checkpoint("3", 2 * DAY);
  checkpoint("4", 3 * DAY, {
    agents: {
      providers: {
        codex: {
          command: [
            "node",
            `${t.hotfixes}/${hex("f")}/plugins/settings-sync/proxy.mjs`.replaceAll(
              "\\",
              "/",
            ),
            `--plugins=${path.join(t.releases, hex("4"), "plugins")}`,
          ],
        },
      },
    },
  });
  checkpoint("5", 4 * DAY, {
    plugins: { ui: { path: path.join(t.releases, hex("5"), "plugins", "ui") } },
  });
  t.write(
    path.join(t.checkpoints, "nas-routing-20261108", "config.json"),
    "{}",
  );
  t.write(
    path.join(t.home, "suite", "installed.json"),
    JSON.stringify({
      treeHash: hex("1"),
      release: path.join(t.releases, hex("1")),
      checkpoint: installed,
    }),
  );
  t.write(
    path.join(t.home, "config.json"),
    JSON.stringify({
      // Mixed separators and an upper-case path still name the same hotfix.
      plugins: {
        aster: {
          path: path
            .join(t.hotfixes, hex("a"), "plugins", "aster")
            .replaceAll("\\", "/")
            .toUpperCase()
            .replace(hex("a").toUpperCase(), hex("a")),
        },
      },
      agents: {
        providers: {
          codex: {
            command: [
              `C:/Users/x/AppData/Local/Programs/Paseo/current/Paseo.exe`,
              "--flag",
            ],
          },
        },
      },
    }),
  );
  t.write(
    path.join(t.home, "paseo.pid"),
    JSON.stringify({ pid: DEAD_PID, startedAt: DAEMON_START }),
  );
  const local = path.join(
    "C:",
    "Users",
    "x",
    "AppData",
    "Local",
    "Programs",
    "Paseo",
  );
  t.setSystem({
    items: [
      {
        src: "shortcut:Paseo.lnk",
        text: `${local}\\current\\Paseo.exe|||${local}\\icon-only\\Paseo.exe,0`,
      },
      {
        src: "process:Usage-Viewer.exe#69412:env:PASEO_CLI",
        text: `${local}\\env-cli\\resources\\paseo.cmd`,
      },
      {
        src: "process:node.exe#1:env:PATH",
        text: `C:\\bin;${local}\\env-path;C:\\Windows`,
      },
      {
        src: "app-key:ca8eee31-0000-4000-8000-000000000000:InstallLocation",
        text: `${local}\\guid-location`,
      },
    ],
  });
}

test("plan 은 설정·provider 명령·남긴 모든 체크포인트·바로가기 아이콘·프로세스 환경 변수·앱 GUID 설치 위치가 가리키는 것을 지킨다", () => {
  const t = sandbox();
  try {
    seed(t);
    const { action, reasons } = t.plan(
      "installs,hotfixes,releases,checkpoints",
      "--keep-per-plugin",
      "1",
      "--keep-install",
      "rollback",
    );
    for (const name of [
      "current",
      "rollback",
      "icon-only",
      "env-cli",
      "env-path",
      "guid-location",
    ])
      assert.equal(action("installs", name), "KEEP", name);
    for (const name of ["old-a", "old-b"])
      assert.equal(
        action("installs", name),
        "PRUNE",
        reasons("installs", name).join("; "),
      );
    assert.ok(
      reasons("installs", "env-path").some((reason: string) =>
        reason.endsWith(":env:PATH"),
      ),
    );
    assert.equal(
      action("hotfixes", hex("a")),
      "KEEP",
      "config (mixed separators)",
    );
    assert.equal(action("hotfixes", hex("b")), "KEEP", "installed checkpoint");
    assert.equal(
      action("hotfixes", hex("f")),
      "KEEP",
      "older retained checkpoint provider command",
    );
    assert.ok(
      !reasons("hotfixes", hex("f")).some((reason: string) =>
        reason.includes("최신"),
      ),
      "kept only as newest",
    );
    assert.equal(
      action("hotfixes", hex("c")),
      "PRUNE",
      reasons("hotfixes", hex("c")).join("; "),
    );
    assert.equal(action("releases", hex("1")), "KEEP", "current treeHash");
    assert.equal(action("releases", hex("2")), "KEEP", "installed checkpoint");
    assert.equal(
      action("releases", hex("4")),
      "KEEP",
      "older retained checkpoint",
    );
    assert.equal(action("releases", hex("3")), "PRUNE");
    // A pruned checkpoint still protects its release until the checkpoint itself is gone.
    assert.equal(action("releases", hex("5")), "KEEP");
    assert.ok(
      reasons("releases", hex("5")).some((reason: string) =>
        reason.startsWith("checkpoint(정리 후보)"),
      ),
    );
    for (const digit of ["1", "2", "3", "4"])
      assert.equal(action("checkpoints", uuid(digit)), "KEEP", digit);
    assert.equal(action("checkpoints", uuid("5")), "PRUNE");
    assert.equal(
      action("checkpoints", "nas-routing-20261108"),
      undefined,
      "non-UUID folder is out of scope",
    );
  } finally {
    t.dispose();
  }
});

test("격리는 미리보기가 기본이고 실행 직전 다시 판정해 사용 중·나중에 pin 된 폴더를 건너뛰며 되돌리기와 7일 유예를 지킨다", async () => {
  const t = sandbox();
  let holder: ChildProcess | undefined;
  try {
    seed(t);
    const { file } = t.plan(
      "installs,hotfixes,releases,checkpoints",
      "--keep-per-plugin",
      "1",
      "--keep-install",
      "rollback",
    );
    t.run("quarantine", "--plan", file, "--kind", "installs");
    assert.ok(
      fs.existsSync(path.join(t.installs, "old-a")) && !fs.existsSync(t.trash),
      "preview moved files",
    );

    holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      cwd: path.join(t.installs, "busy"),
      stdio: "ignore",
      windowsHide: true,
    });
    await new Promise((resolve) => holder!.once("spawn", resolve));
    fs.writeFileSync(
      t.pins,
      JSON.stringify([{ path: "C:/x/Programs/Paseo/old-b", owner: "test" }]),
    );
    const moved = t.run(
      "quarantine",
      "--plan",
      file,
      "--kind",
      "installs",
      "--execute",
    );
    assert.equal(moved.code, 0, moved.errors);
    assert.ok(
      !fs.existsSync(path.join(t.installs, "old-a")),
      "orphan not quarantined",
    );
    assert.ok(
      fs.existsSync(path.join(t.installs, "old-b")),
      "folder pinned after the plan was moved",
    );
    if (process.platform === "win32") {
      assert.ok(
        fs.existsSync(path.join(t.installs, "busy", "Paseo.exe")),
        "folder in use was moved",
      );
      assert.match(moved.output, /busy: rename 실패/);
    }
    for (const name of [
      "current",
      "rollback",
      "icon-only",
      "env-cli",
      "env-path",
      "guid-location",
    ])
      assert.ok(fs.existsSync(path.join(t.installs, name)), name);

    const batch = fs.readdirSync(t.trash)[0];
    t.run(
      "restore",
      "--manifest",
      path.join(t.trash, batch, "manifest-installs.json"),
      "--execute",
    );
    assert.ok(
      fs.existsSync(path.join(t.installs, "old-a", "Paseo.exe")),
      "restore failed",
    );

    t.run("quarantine", "--plan", file, "--kind", "hotfixes", "--execute");
    assert.ok(!fs.existsSync(path.join(t.hotfixes, hex("c"))));
    for (const character of ["a", "b", "e", "f"])
      assert.ok(
        fs.existsSync(path.join(t.hotfixes, hex(character))),
        character,
      );

    t.run("purge", "--execute");
    assert.ok(
      fs.readdirSync(t.trash).length > 0,
      "default grace (7 days) not kept",
    );
    t.run("purge", "--older-than-days", "7", "--execute");
    assert.ok(
      fs.readdirSync(t.trash).length > 0,
      "purged inside the grace period",
    );
    t.run("purge", "--older-than-days", "0", "--execute");
    assert.equal(
      fs.readdirSync(t.trash).length,
      0,
      "expired quarantine not purged",
    );
  } finally {
    holder?.kill();
    if (holder) await new Promise((resolve) => holder!.once("exit", resolve));
    t.dispose();
  }
});

test("체크포인트를 먼저 격리하면 그 체크포인트만 가리키던 release 가 다음 plan 에서 후보가 된다", () => {
  const t = sandbox();
  try {
    seed(t);
    const first = t.plan("checkpoints");
    const result = t.run(
      "quarantine",
      "--plan",
      first.file,
      "--kind",
      "checkpoints",
      "--execute",
    );
    assert.equal(result.code, 0, result.errors);
    assert.ok(!fs.existsSync(path.join(t.checkpoints, uuid("5"))));
    const second = t.plan("releases");
    assert.equal(second.action("releases", hex("5")), "PRUNE");
    assert.equal(second.action("releases", hex("4")), "KEEP");
  } finally {
    t.dispose();
  }
});

test("참조 수집이 실패하거나 살아 있는 데몬이 목록에 없으면 모두 KEEP 이고 격리를 거부한다", () => {
  const t = sandbox();
  try {
    seed(t);
    t.setSystem({ errors: ["Process: Access is denied"], processIds: [1234] });
    const failed = t.plan("installs,releases");
    assert.equal(failed.saved.collection.ok, false);
    assert.equal(failed.action("installs", "old-a"), "KEEP");
    assert.equal(failed.action("releases", hex("3")), "KEEP");
    let refused = t.run(
      "quarantine",
      "--plan",
      failed.file,
      "--kind",
      "installs",
      "--execute",
    );
    assert.equal(refused.code, 1);
    assert.ok(fs.existsSync(path.join(t.installs, "old-a")));

    // A good plan is still re-checked: a collector that fails now refuses the move.
    t.setSystem({ processIds: [1234] });
    const good = t.plan("installs");
    assert.equal(good.action("installs", "old-a"), "PRUNE");
    t.setSystem({ processIds: [] });
    refused = t.run(
      "quarantine",
      "--plan",
      good.file,
      "--kind",
      "installs",
      "--execute",
    );
    assert.equal(refused.code, 1);
    assert.match(refused.errors, /참조 수집 실패/);

    // The daemon in paseo.pid is alive (this test process) but the collector missed it.
    t.write(
      path.join(t.home, "paseo.pid"),
      JSON.stringify({ pid: process.pid, startedAt: DAEMON_START }),
    );
    t.setSystem({ processIds: [1234] });
    const partial = t.plan("installs");
    assert.equal(partial.saved.collection.ok, false);
    assert.match(partial.saved.collection.errors.join(" "), /데몬 pid/);
    assert.equal(partial.action("installs", "old-a"), "KEEP");
  } finally {
    t.dispose();
  }
});

test("데몬이 바뀐 plan, 다른 호스트·home 의 plan, 60분 지난 plan, 제자리 설치는 거부한다", () => {
  const t = sandbox();
  try {
    seed(t);
    const { file, saved } = t.plan("installs,releases");
    t.write(
      path.join(t.home, "paseo.pid"),
      JSON.stringify({ pid: DEAD_PID, startedAt: OTHER_START }),
    );
    let result = t.run(
      "quarantine",
      "--plan",
      file,
      "--kind",
      "releases",
      "--execute",
    );
    assert.match(result.errors, /데몬이 재시작/);
    t.write(
      path.join(t.home, "paseo.pid"),
      JSON.stringify({ pid: DEAD_PID, startedAt: DAEMON_START }),
    );

    fs.writeFileSync(
      file,
      JSON.stringify({ ...saved, identity: "0".repeat(16) }),
    );
    result = t.run(
      "quarantine",
      "--plan",
      file,
      "--kind",
      "releases",
      "--execute",
    );
    assert.match(result.errors, /다른 호스트/);
    fs.writeFileSync(
      file,
      JSON.stringify({
        ...saved,
        at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      }),
    );
    result = t.run(
      "quarantine",
      "--plan",
      file,
      "--kind",
      "releases",
      "--execute",
    );
    assert.match(result.errors, /60분/);
    assert.ok(fs.existsSync(path.join(t.releases, hex("3"))));

    t.write(path.join(t.installs, "Paseo.exe"));
    const inPlace = t.plan("installs");
    assert.match(inPlace.saved.kinds.installs.blocked, /제자리 설치/);
    assert.equal(inPlace.saved.kinds.installs.items.length, 0);
  } finally {
    t.dispose();
  }
});

test(
  "Windows 수집기는 바로가기 아이콘·프로세스 환경 변수·작업 폴더·앱 GUID 설치 위치·제거 정보를 토큰으로만 읽는다",
  { skip: process.platform !== "win32" },
  async () => {
    const t = sandbox();
    const programs = path.join(t.box, "Programs", "Paseo");
    for (const name of [
      "target",
      "icon-only",
      "env-cli",
      "env-path",
      "cwd-dir",
      "guid-location",
      "uninstall-location",
      "orphan",
    ])
      t.write(path.join(programs, name, "Paseo.exe"));
    const sibling = path.join(t.box, "Programs", "Paseo-TitleSync");
    t.write(path.join(sibling, "0.12.0", "Paseo.exe"));
    t.write(
      path.join(t.box, "Programs", "Paseo-Orphan", "0.12.0", "Paseo.exe"),
    );
    // A minimal environment: only the variables under test reach the child.
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 30000)"],
      {
        cwd: path.join(programs, "cwd-dir"),
        stdio: "ignore",
        windowsHide: true,
        env: {
          SystemRoot: process.env.SystemRoot,
          PASEO_CLI: path.join(programs, "env-cli", "resources", "paseo.cmd"),
          PATH: `C:\\bin;${path.join(programs, "env-path")};C:\\Windows`,
        },
      },
    );
    await new Promise((resolve) => child.once("spawn", resolve));
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    const link = path.join(t.box, "파세오.lnk");
    const overrides = `
$shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(link)})
$shortcut.TargetPath = ${quote(path.join(programs, "target", "Paseo.exe"))}
$shortcut.IconLocation = ${quote(path.join(programs, "icon-only", "Paseo.exe"))} + ',0'
$shortcut.WorkingDirectory = ${quote(sibling)}
$shortcut.Save()
function Get-ResidueProcesses { @(Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}") }
function Get-ResidueShortcutFiles { @(${quote(link)}) }
function Get-ResidueRegistryValues([string]$Key) {
  if ($Key -like 'HKLM:\\Software\\Microsoft\\*\\Uninstall\\*') { @([pscustomobject]@{ DisplayName = 'Paseo 1.0.7'; InstallLocation = ${quote(path.join(programs, "uninstall-location"))} }) }
}
function Get-ResidueRegistryChildren([string]$Root) {
  if ($Root -ne 'HKLM:\\Software') { return @() }
  $app = [pscustomobject]@{ PSChildName = 'ca8eee31-0000-4000-8000-000000000000' }
  $app | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($Name) if ($Name -eq 'InstallLocation') { ${quote(path.join(programs, "guid-location"))} } }
  $vendor = [pscustomobject]@{ PSChildName = 'Microsoft' }
  $vendor | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($Name) ${quote(path.join(programs, "orphan"))} }
  @($app, $vendor)
}
function Get-ResidueEnvironmentVariables([string]$Scope) { @{} }
function Get-ResidueTasks { @() }
`;
    try {
      const collected = residue.collectWindows({ overrides });
      assert.deepEqual(collected.errors, []);
      assert.deepEqual(collected.processIds, [child.pid]);
      assert.equal(collected.environmentRead, 1);
      const sources = (fragment: string) =>
        collected.items
          .filter((item: { tokens: string[] }) =>
            item.tokens.some((token) => token.toLowerCase().includes(fragment)),
          )
          .map((item: { src: string }) => item.src);
      assert.ok(
        sources("icon-only").includes("shortcut:파세오.lnk"),
        "IconLocation ignored",
      );
      assert.ok(
        sources("env-cli").some((src: string) =>
          src.endsWith(":env:PASEO_CLI"),
        ),
        "process environment ignored",
      );
      assert.ok(
        sources("env-path").some((src: string) => src.endsWith(":env:PATH")),
        "PATH ignored",
      );
      assert.ok(
        sources("cwd-dir").some((src: string) => src.endsWith(":cwd")),
        "working directory ignored",
      );
      assert.deepEqual(sources("guid-location"), [
        "app-key:ca8eee31-0000-4000-8000-000000000000:InstallLocation",
      ]);
      assert.deepEqual(sources("uninstall-location"), [
        "uninstall:InstallLocation",
      ]);
      assert.deepEqual(sources("orphan"), [], "non-GUID registry key read");
      // Values never leave the collector: only path tokens, no other variable text.
      assert.ok(!JSON.stringify(collected).includes("SystemRoot"));

      const lines: string[] = [];
      const code = residue.run(
        [
          "plan",
          "--kind",
          "installs",
          "--json",
          "--home",
          t.home,
          "--root-installs",
          programs,
          "--pins",
          t.pins,
          "--min-age-hours",
          "0",
        ],
        {
          log: (line: string) => lines.push(line),
          collectSystem: () => collected,
        },
      );
      assert.equal(code, 0);
      const plan = JSON.parse(lines[0]);
      const action = (name: string) =>
        plan.kinds.installs.items.find(
          (entry: { name: string }) => entry.name === name,
        )?.action;
      for (const name of [
        "target",
        "icon-only",
        "env-cli",
        "env-path",
        "cwd-dir",
        "guid-location",
        "uninstall-location",
      ])
        assert.equal(action(name), "KEEP", name);
      assert.equal(action("orphan"), "PRUNE");
      // A bare sibling folder (no file after it) is still a reference.
      assert.equal(action("../Paseo-TitleSync"), "KEEP");
      assert.equal(action("../Paseo-Orphan"), "PRUNE");
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      t.dispose();
    }
  },
);

test("Linux 수집기는 /proc 의 cwd·cmdline·maps·environ 에서 참조를 모은다", () => {
  const t = sandbox();
  try {
    const proc = path.join(t.box, "proc");
    const hotfix = `/home/ubuntu/.paseo/suite/hotfixes/${hex("e")}`;
    t.write(
      path.join(proc, "100", "cmdline"),
      `node\0${hotfix}/plugins/aster/codex-proxy.mjs\0`,
    );
    t.write(
      path.join(proc, "100", "maps"),
      `7f00-7f01 r-xp 0 0:0 0 /home/ubuntu/.local/lib/node_modules/@getpaseo/server/dist/server.js\n`,
    );
    t.write(
      path.join(proc, "100", "environ"),
      `HOME=/home/ubuntu\0PASEO_PLUGIN_ROOT=/x/releases/${hex("d")}/plugins\0`,
    );
    t.write(path.join(proc, "200", "cmdline"), "bash\0");
    const target = path.join(t.box, "work", "paseo-attachments-AbC123");
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, path.join(proc, "200", "cwd"), "junction");
    fs.mkdirSync(path.join(proc, "self"));
    const collected = residue.collectLinux({ procRoot: proc });
    assert.deepEqual(collected.errors, []);
    assert.deepEqual(collected.processIds.sort(), [100, 200]);
    assert.equal(collected.environmentRead, 1);
    assert.equal(collected.environmentUnreadable, 1);
    assert.equal(
      collected.serverRoot,
      "/home/ubuntu/.local/lib/node_modules/@getpaseo/server",
    );
    const refs = residue.newRefs();
    for (const item of collected.items)
      residue.addTokens(refs, item.text, item.src);
    assert.deepEqual([...refs.hotfixes.keys()], [hex("e")]);
    assert.deepEqual(
      [...refs.releases.get(hex("d"))],
      ["process#100:env:PASEO_PLUGIN_ROOT"],
    );
    assert.ok(refs.attachments.has("paseo-attachments-abc123"));
    assert.deepEqual(
      residue.collectLinux({ procRoot: path.join(t.box, "missing") }).errors
        .length,
      1,
    );
  } finally {
    t.dispose();
  }
});

test("표준 입력으로 실행해도(ssh … node - < residue.cjs) 원격에 파일 없이 plan 을 낸다", () => {
  const t = sandbox();
  try {
    seed(t);
    const result = spawnSync(
      process.execPath,
      [
        "-",
        "plan",
        "--kind",
        "checkpoints",
        "--json",
        "--home",
        t.home,
        "--pins",
        t.pins,
      ],
      {
        input: fs.readFileSync(tool),
        encoding: "utf8",
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.collection.ok, true);
    const action = (name: string) =>
      plan.kinds.checkpoints.items.find(
        (entry: { name: string }) => entry.name === name,
      )?.action;
    assert.equal(action(uuid("5")), "PRUNE");
    assert.equal(action(uuid("1")), "KEEP");
  } finally {
    t.dispose();
  }
});

test("표시 시각은 오전/오후 두 자리 시이고 초가 없다", () => {
  assert.equal(
    residue.localTime(new Date(2026, 10, 12, 15, 0, 59).getTime()),
    "11-12 오후 03:00",
  );
  assert.equal(
    residue.localTime(new Date(2026, 0, 2, 0, 5).getTime()),
    "01-02 오전 12:05",
  );
  assert.equal(
    residue.localTime(new Date(2026, 0, 2, 12, 30).getTime()),
    "01-02 오후 12:30",
  );
});

test("도움말은 아무것도 수집하지 않고 사용법만 출력한다", () => {
  for (const argv of [["--help"], ["help"], ["plan", "-h"]]) {
    const lines: string[] = [];
    const code = residue.run(argv, {
      log: (line: string) => lines.push(line),
      collectSystem: () => {
        throw new Error("help must not collect references");
      },
    });
    assert.equal(code, 0);
    assert.match(lines.join("\n"), /사용법/);
  }
});
