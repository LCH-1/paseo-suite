import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFile(path.join(root, file), "utf8");

test(
  "Windows 빌드의 중간 명령 실패는 뒤의 성공 명령으로 가려지지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const workflow = await read(".github/workflows/windows-release.yml");
    const execute = promisify(execFile);
    for (const name of [
      "Core dependencies and patched runtime",
      "Desktop main",
      "Suite verification and package",
    ]) {
      const step = workflow
        .split("      - name: ")
        .find(
          (section) =>
            section.startsWith(name + "\n") ||
            section.startsWith(name + "\r\n"),
        );
      assert.ok(step, `Missing Windows build step: ${name}`);
      const body = step.match(
        /        run: \|\r?\n((?:          .*\r?\n)+)/,
      )?.[1];
      assert.ok(body, `Missing build script: ${name}`);
      const lines = body.split(/\r?\n/).map((line) => line.trim());
      const firstCommand = lines.findIndex((line) =>
        /^(?:npm|npx|git)\b/.test(line),
      );
      assert.ok(firstCommand >= 0, `Missing native command: ${name}`);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        ...lines.slice(0, firstCommand),
        '& node -e "process.exit(17)"',
        "Write-Output 'CONTINUED_AFTER_FAILURE'",
        '& node -e "process.exit(0)"',
        "exit $LASTEXITCODE",
      ].join("\n");
      await assert.rejects(
        execute(
          "pwsh",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { windowsHide: true, timeout: 10000 },
        ),
        (error: unknown) => {
          const failure = error as Error & { code: unknown; stdout: string };
          assert.equal(failure.code, 1, name);
          assert.doesNotMatch(failure.stdout, /CONTINUED_AFTER_FAILURE/, name);
          return true;
        },
      );
    }
  },
);

test("Windows 설치본은 검증된 Core의 보관 탭 연동과 사이드바 아이콘을 포함한다", async () => {
  const workflow = await read(".github/workflows/windows-release.yml");
  const ref = workflow.match(
    /repository: LCH-1\/paseo\s+ref: ([a-f0-9]{40})\b/,
  )?.[1];
  assert.ok(ref, "Core must be pinned to a complete immutable commit");
  const git = promisify(execFile);
  const coreFile = async (file: string) =>
    (
      await git(
        "git",
        [
          "-C",
          path.resolve(root, "../paseo-core"),
          "show",
          `${ref}:packages/app/src/${file}`,
        ],
        { windowsHide: true },
      )
    ).stdout;
  const archive = await coreFile("workspace/workspace-archive.ts");
  const presence = await coreFile("workspace-tabs/agent-tab-presence.ts");
  const icon = await coreFile("components/sidebar/sidebar-provider-icon.tsx");
  assert.match(
    archive,
    /agentTabPresenceBridge\.closeWorkspace\(input\.workspace\)/,
  );
  assert.match(presence, /closeWorkspace\(workspace: WorkspaceTabScope\)/);
  assert.match(icon, /export function SidebarProviderIcon/);
});

test("릴리스 버전은 패키지·잠금 파일·빌드 기록·설치 파일 이름에서 모두 같다", async () => {
  const { version } = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("package-lock.json"));
  assert.equal(lock.version, version);
  assert.equal(lock.packages[""].version, version);

  const build = await read("tools/build.mjs");
  assert.equal(build.match(/suiteVersion: "([^"]+)"/)?.[1], version);

  // The updater compares this value, so a stale one hides the release from installed apps.
  const builder = await read("tools/electron-builder.cjs");
  assert.equal(
    builder.match(/extraMetadata: \{ version: "([^"]+)" \}/)?.[1],
    version,
  );
  const names = [...builder.matchAll(/Paseo-Suite-([\d.]+)-\$\{arch\}/g)].map(
    (match) => match[1],
  );
  assert.ok(names.length > 0);
  assert.deepEqual([...new Set(names)], [version]);
});

async function runInstallerProbe(body: string) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "suite-updater-test-"),
  );
  const file = path.join(directory, "probe.ps1");
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  await writeFile(
    file,
    `\uFEFF$ErrorActionPreference = 'Stop'\n. ${quote(path.join(root, "tools/install.ps1"))}\n$script:UpdaterRoot = ${quote(directory)}\nfunction Assert($condition, $message) { if (-not $condition) { throw $message } }\n${body}\n`,
  );
  try {
    return await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        file,
      ],
      { windowsHide: true, timeout: 20000 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test(
  "Windows 업데이트는 NSIS DisplayIcon 경로에서 기존 Suite 버전을 읽고 일반 Core 설치는 제외한다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
$folder = Join-Path $script:UpdaterRoot 'registered app'
New-Item -ItemType Directory -Path (Join-Path $folder 'resources/suite') -Force | Out-Null
Set-Content (Join-Path $folder 'resources/suite/suite-lock.json') '{"suiteVersion":"1.0.7"}'
function Get-ItemProperty {
  [pscustomobject]@{DisplayName='Paseo 1.0.7';DisplayIcon=(Join-Path $folder 'Paseo.exe')+',0'}
  [pscustomobject]@{DisplayName='Paseo';InstallLocation=(Join-Path $script:UpdaterRoot 'not-suite')}
}
Assert ((Get-InstalledSuiteVersion) -eq [version]'1.0.7') 'registered NSIS version was lost'
`);
  },
);

test(
  "Windows 업데이트는 SHA 검증 후에만 캐시하고 대기 중인 설치본을 다시 내려받지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
$script:downloads = 0
function Invoke-SuiteGh($Arguments) {
  $script:downloads++
  $dir = $Arguments[-1]
  Set-Content (Join-Path $dir 'Paseo-Suite-1.2.3-x64.exe') 'owned installer'
  Set-Content (Join-Path $dir 'install.ps1') 'owned helper'
  @('${createHash("sha256").update("owned installer\r\n").digest("hex")}  Paseo-Suite-1.2.3-x64.exe', '${createHash("sha256").update("owned helper\r\n").digest("hex")}  install.ps1') | Set-Content (Join-Path $dir 'SHA256SUMS')
}
$release = [pscustomobject]@{ Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' }
$file = Save-SuiteRelease $release
Assert (Test-Path $file) 'missing verified installer'
$again = Save-SuiteRelease $release
Assert ($again -eq $file -and $script:downloads -eq 1) 'download repeated'
Set-Content $file 'tampered'
$caught = $false
try { Save-SuiteRelease $release } catch { $caught = $_.Exception.Message -like '*SHA256 verification failed*' }
Assert $caught 'tampered cached installer accepted'
`);
  },
);

test(
  "Windows 업데이트는 완전한 안정 릴리스만 선택하고 사전 버전과 누락 자산은 거절한다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
$script:fixture = @{ tag_name='v1.2.3'; draft=$false; prerelease=$false; assets=@(@{name='Paseo-Suite-1.2.3-x64.exe'}, @{name='SHA256SUMS'}, @{name='install.ps1'}) }
function Invoke-SuiteGh($Arguments) { $script:fixture | ConvertTo-Json -Depth 5 }
$release = Get-SuiteRelease
Assert ($release.Version -eq [version]'1.2.3') 'wrong release version'
foreach ($field in @('draft', 'prerelease')) {
  $script:fixture[$field] = $true
  $caught = $false
  try { Get-SuiteRelease } catch { $caught = $true }
  Assert $caught 'non-stable accepted'
  $script:fixture[$field] = $false
}
$script:fixture.assets = @(@{name='Paseo-Suite-1.2.3-x64.exe'})
$caught = $false
try { Get-SuiteRelease } catch { $caught = $true }
Assert $caught 'incomplete release accepted'
`);
  },
);

test(
  "Windows 자동 갱신은 실행 중 앱·데몬을 종료하지 않고 설치를 보류하며 설치 경합도 처리한다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
function Get-Process { [pscustomobject]@{ Id=123 } }
function Start-Process { throw 'must not run installer while Paseo is running' }
Assert ((Invoke-SuiteInstaller 'unused.exe') -eq 'pending') 'running daemon was ignored'
function Get-Process { @() }
function Start-Process { [pscustomobject]@{ ExitCode=2 } }
Assert ((Invoke-SuiteInstaller 'unused.exe') -eq 'pending') 'NSIS startup race was ignored'
function Start-Process { [pscustomobject]@{ ExitCode=17 } }
$caught = $false
try { Invoke-SuiteInstaller 'unused.exe' } catch { $caught = $true }
Assert $caught 'failed installer reported success'
`);
  },
);

test(
  "Windows 업데이트는 다운그레이드·미설치 PC 자동설치·중복 실행을 차단하고 기본으로 예약 작업을 만들지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
function Get-SuiteRelease { [pscustomobject]@{ Version=[version]'1.2.3' } }
function Get-InstalledSuiteVersion { [version]'9.0.0' }
function Save-SuiteRelease { throw 'must not download a downgrade' }
function Set-SuiteAutoUpdate { throw 'automatic updates must be opt-in' }
$Action = 'Update'
Invoke-SuiteSetup
function Get-InstalledSuiteVersion { $null }
Invoke-SuiteSetup
$held = [IO.File]::Open((Join-Path $script:UpdaterRoot 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
  function Get-SuiteRelease { throw 'parallel update entered the critical section' }
  Invoke-SuiteSetup
} finally { $held.Dispose() }
`);
  },
);

test(
  "Windows 자동 갱신은 사용자 권한으로만 로그인·30분 예약을 등록하고 해제 가능하다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
function New-ScheduledTaskAction($Execute, $Argument) {
  Assert ($Argument -like '*-Action Update -Scheduled*') 'wrong scheduled command'
  Assert ($Argument -like '*-WindowStyle Hidden*') 'visible terminal'
  [pscustomobject]@{Execute=$Execute;Arguments=$Argument}
}
function New-ScheduledTaskTrigger([switch]$AtLogOn, $User, [switch]$Once, $At, $RepetitionInterval) {
  if ($RepetitionInterval) { Assert ($RepetitionInterval.TotalMinutes -eq 30) 'wrong interval' }
  [pscustomobject]@{Owned=$true}
}
function New-ScheduledTaskPrincipal($UserId, $LogonType, $RunLevel) {
  Assert ($LogonType -eq 'Interactive' -and $RunLevel -eq 'Limited') 'unexpected elevated task'
}
function New-ScheduledTaskSettingsSet { }
function Register-ScheduledTask($TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force) {
  Assert ($Trigger.Count -eq 2) 'missing task trigger'
  $script:registered = $true
}
function Get-ScheduledTask { 'owned' }
function Unregister-ScheduledTask($Confirm) { $script:removed = $true }
Set-SuiteAutoUpdate $true
Assert $script:registered 'task not registered'
Set-SuiteAutoUpdate $false
Assert $script:removed 'task not removed'
`);
  },
);
