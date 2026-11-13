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
  // No uninstall entries unless a test defines them: the real registry is never read.
  // The per-user install folder is an empty temporary path, never the real one.
  await writeFile(
    file,
    `\uFEFF$ErrorActionPreference = 'Stop'\n. ${quote(path.join(root, "tools/install.ps1"))}\n$script:UpdaterRoot = ${quote(directory)}\n$script:UserInstallRoot = ${quote(path.join(directory, "Programs", "Paseo"))}\nfunction Assert($condition, $message) { if (-not $condition) { throw $message } }\nfunction Get-ItemProperty { }\n${body}\n`,
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
  "Windows exe 직접 설치 후 최신 버전이어도 명령 도우미를 만들고 이전 인증 도우미를 교체한다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
function Get-SuiteRelease { [pscustomobject]@{ Version=[version]'1.2.3' } }
function Get-InstalledSuiteVersion { [version]'1.2.3' }
function Save-SuiteRelease { throw 'must not download or install the same app again' }
function Set-SuiteAutoUpdate { throw 'automatic updates must stay opt-in' }
$Action = 'Install'
Invoke-SuiteSetup
$helper = Join-Path $script:UpdaterRoot 'install.ps1'
Assert ((Get-Content $helper -Raw) -like '*function Invoke-SuiteRequest*') 'helper not seeded for direct exe install'
Set-Content $helper 'legacy authenticated helper'
Invoke-SuiteSetup
Assert ((Get-Content $helper -Raw) -like '*function Invoke-SuiteRequest*') 'old helper not replaced'
Set-Content $helper 'legacy authenticated helper'
function Set-SuiteAutoUpdate {
  Assert ((Get-Content $helper -Raw) -like '*function Invoke-SuiteRequest*') 'scheduled helper still requires authentication'
  $script:enabled = $true
}
$Action = 'EnableAutoUpdate'
Invoke-SuiteSetup
Assert $script:enabled 'explicit task enable failed'
`);
  },
);

test(
  "Windows 공개 다운로드는 GitHub CLI·인증 헤더·REST API 없이 릴리즈 자산을 읽는다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
function Get-Command { throw 'GitHub CLI must not be used' }
function Invoke-RestMethod($Uri, [switch]$UseBasicParsing, $TimeoutSec, $MaximumRedirection, $Headers, $Credential, [switch]$UseDefaultCredentials) {
  Assert ($Uri -eq 'https://github.com/LCH-1/paseo-suite/releases/latest/download/suite-lock.json') 'wrong latest asset URL'
  Assert (-not $Headers -and -not $Credential -and -not $UseDefaultCredentials) 'credentials were sent'
  [pscustomobject]@{ schemaVersion=1; suiteVersion='1.2.3' }
}
function Invoke-WebRequest($Uri, [switch]$UseBasicParsing, $OutFile, $TimeoutSec, $MaximumRedirection, $Headers, $Credential, [switch]$UseDefaultCredentials) {
  Assert ($Uri -eq 'https://github.com/LCH-1/paseo-suite/releases/download/v1.2.3/SHA256SUMS') 'wrong pinned asset URL'
  Assert (-not $Headers -and -not $Credential -and -not $UseDefaultCredentials) 'credentials were sent'
  Set-Content $OutFile 'owned metadata'
}
Assert ((Get-SuiteRelease).Version -eq [version]'1.2.3') 'anonymous metadata failed'
$file = Join-Path $script:UpdaterRoot 'downloaded'
Invoke-SuiteRequest -Asset SHA256SUMS -Tag v1.2.3 -OutFile $file
Assert (Test-Path $file) 'anonymous asset download failed'
$caught = $false
try { Invoke-SuiteRequest -Asset '../private' } catch { $caught = $true }
Assert $caught 'invalid path accepted'
`);
  },
);

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
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) {
  $script:downloads++
  if ($Asset -eq 'Paseo-Suite-1.2.3-x64.exe') { Set-Content $OutFile 'owned installer'; return }
  if ($Asset -eq 'install.ps1') { Set-Content $OutFile 'owned helper'; return }
  @('${createHash("sha256").update("owned installer\r\n").digest("hex")}  Paseo-Suite-1.2.3-x64.exe', '${createHash("sha256").update("owned helper\r\n").digest("hex")}  install.ps1') | Set-Content $OutFile
}
$release = [pscustomobject]@{ Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' }
$file = Save-SuiteRelease $release
Assert (Test-Path $file) 'missing verified installer'
$again = Save-SuiteRelease $release
Assert ($again -eq $file -and $script:downloads -eq 3) 'download repeated'
Set-Content $file 'tampered'
$caught = $false
try { Save-SuiteRelease $release } catch { $caught = $_.Exception.Message -like '*SHA256 verification failed*' }
Assert $caught 'tampered cached installer accepted'
`);
  },
);

test(
  "Windows 업데이트는 안정 릴리스 메타데이터만 읽고 사전 버전과 미지원 형식은 거절한다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`
$script:fixture = [pscustomobject]@{ schemaVersion=1; suiteVersion='1.2.3' }
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) {
  Assert ($Asset -eq 'suite-lock.json') 'unexpected metadata asset'
  return $script:fixture
}
$release = Get-SuiteRelease
Assert ($release.Version -eq [version]'1.2.3') 'wrong release version'
$script:fixture.suiteVersion = '1.2.3-beta.1'
$caught = $false
try { Get-SuiteRelease } catch { $caught = $true }
Assert $caught 'non-stable accepted'
$script:fixture.suiteVersion = '1.2.3'
$script:fixture.schemaVersion = 99
$caught = $false
try { Get-SuiteRelease } catch { $caught = $true }
Assert $caught 'unsupported metadata accepted'
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

// Seeds updater\v<version> exactly as Save-SuiteRelease leaves it.
const downloadFixture = `
function New-Download([string]$Version) {
  $folder = Join-Path $script:UpdaterRoot "v$Version"
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  foreach ($name in @("Paseo-Suite-$Version-x64.exe", 'install.ps1', 'SHA256SUMS')) { Set-Content (Join-Path $folder $name) 'owned' }
  $folder
}
function Test-Download([string]$Version) { Test-Path (Join-Path $script:UpdaterRoot "v$Version/Paseo-Suite-$Version-x64.exe") }
`;

test(
  "Windows 업데이트는 이미 최신이면 예전 도우미가 남긴 설치 파일과 하루 지난 임시 폴더를 지우고 도우미·상태·링크 밖 파일은 남긴다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`${downloadFixture}
$old = New-Download '1.2.2'
$current = New-Download '1.2.3'
$stale = Join-Path $current ('a' * 32)
New-Item -ItemType Directory -Path $stale | Out-Null
Set-Content (Join-Path $stale 'Paseo-Suite-1.2.3-x64.exe') 'partial'
(Get-Item $stale).LastWriteTime = (Get-Date).AddDays(-2)
$fresh = Join-Path $old ('b' * 32)
New-Item -ItemType Directory -Path $fresh | Out-Null
Set-Content (Join-Path $fresh 'Paseo-Suite-1.2.2-x64.exe') 'another updater is downloading'
Set-Content (Join-Path $old 'notes.txt') 'not downloaded by the helper'
$outside = Join-Path $script:UpdaterRoot 'outside'
New-Item -ItemType Directory -Path $outside | Out-Null
Set-Content (Join-Path $outside 'Paseo-Suite-0.9.0-x64.exe') 'linked, never followed'
New-Item -ItemType Junction -Path (Join-Path $script:UpdaterRoot 'v0.9.0') -Target $outside | Out-Null
Set-Content (Join-Path $script:UpdaterRoot 'status.json') '{}'
function Get-SuiteRelease { [pscustomobject]@{ Version=[version]'1.2.3'; Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' } }
function Get-InstalledSuiteVersion { [version]'1.2.3' }
function Save-SuiteRelease { throw 'must not download the installed version' }
$Action = 'Update'
Invoke-SuiteSetup
Assert (-not (Test-Download '1.2.2') -and -not (Test-Download '1.2.3')) 'downloaded installers kept'
Assert (-not (Test-Path (Join-Path $old 'SHA256SUMS')) -and -not (Test-Path (Join-Path $old 'install.ps1'))) 'release metadata kept'
Assert (-not (Test-Path $current)) 'empty release folder kept'
Assert (Test-Path (Join-Path $old 'notes.txt')) 'unknown file removed'
Assert (Test-Path (Join-Path $fresh 'Paseo-Suite-1.2.2-x64.exe')) 'recent temporary download removed'
Assert (Test-Path (Join-Path $outside 'Paseo-Suite-0.9.0-x64.exe')) 'junction followed'
Assert (Test-Path (Join-Path $script:UpdaterRoot 'install.ps1')) 'command helper removed'
Assert (Test-Path (Join-Path $script:UpdaterRoot 'status.json')) 'status removed'
`);
  },
);

test(
  "Windows 업데이트는 설치·버전 확인 뒤 받은 설치 파일을 지우고 보류 중이면 최신 설치 파일만 남긴다",
  { skip: process.platform !== "win32" },
  async () => {
    await runInstallerProbe(`${downloadFixture}
New-Download '1.2.1' | Out-Null
$script:installed = [version]'1.2.2'
function Get-SuiteRelease { [pscustomobject]@{ Version=[version]'1.2.3'; Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' } }
function Get-InstalledSuiteVersion { $script:installed }
function Save-SuiteRelease($Release) { Join-Path (New-Download '1.2.3') $Release.Installer }
function Invoke-SuiteInstaller($Installer) { Assert (Test-Path $Installer) 'installer removed before install'; 'pending' }
$Action = 'Update'
Invoke-SuiteSetup
Assert (Test-Download '1.2.3') 'pending installer removed'
Assert (-not (Test-Download '1.2.1')) 'older pending installer kept'
$DownloadOnly = $true
Invoke-SuiteSetup
Assert (Test-Download '1.2.3') 'downloaded installer removed'
$DownloadOnly = $false
function Invoke-SuiteInstaller($Installer) { $script:installed = [version]'1.2.3'; 'installed' }
Invoke-SuiteSetup
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'v1.2.3'))) 'installed download kept'
Assert ((Get-Content (Join-Path $script:UpdaterRoot 'status.json') -Raw) -like '*"installed"*') 'status not written'
Assert (Test-Path (Join-Path $script:UpdaterRoot 'install.ps1')) 'command helper removed'
`);
  },
);

test(
  "Windows 업데이트는 정리에 실패해도 설치를 성공으로 기록하고 점검 모드는 아무것도 지우지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${downloadFixture}
New-Download '1.2.2' | Out-Null
function Get-SuiteRelease { [pscustomobject]@{ Version=[version]'1.2.3'; Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' } }
function Get-InstalledSuiteVersion { [version]'1.2.3' }
$Action = 'Check'
Invoke-SuiteSetup
Assert (Test-Download '1.2.2') 'check mode removed a download'
function Remove-Item { throw 'locked by antivirus' }
$Action = 'Update'
Invoke-SuiteSetup
Assert (Test-Download '1.2.2') 'locked file vanished'
`);
    assert.match(
      stdout,
      /cleanup skipped; it is retried on the next run: locked by antivirus/,
    );
    assert.match(stdout, /already up to date/);
  },
);

// Release v1.2.1 as published: installer + SHA256SUMS; older tags have no helper.
const olderReleaseAssets = `
$script:requests = @()
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) {
  $script:requests += "$Tag/$Asset"
  if ($Asset -eq 'suite-lock.json') { return [pscustomobject]@{ schemaVersion=1; suiteVersion=$Tag.Substring(1) } }
  if ($Asset -eq 'Paseo-Suite-1.2.1-x64.exe') { Set-Content $OutFile 'old installer'; return }
  if ($Asset -eq 'SHA256SUMS') { @('${createHash("sha256").update("old installer\r\n").digest("hex")}  Paseo-Suite-1.2.1-x64.exe') | Set-Content $OutFile; return }
  throw "missing release asset: $Tag/$Asset"
}
function Get-ScheduledTask { }
`;
// A per-user install of 1.2.3; the real registry is never read.
const olderReleaseFixture = `${olderReleaseAssets}
$script:installed = [version]'1.2.3'
function Get-InstalledSuiteVersion { $script:installed }
function Get-SuiteRegistrations { if ($script:installed) { [pscustomobject]@{ Version=$script:installed; Scope='User'; Location='per-user app' } } }
`;

test(
  "Windows 롤백은 공개 릴리즈 태그에서 설치 파일과 SHA256SUMS만 받아 이전 버전을 설치하고 현재 도우미·로컬 사본을 남기지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${olderReleaseFixture}
$helper = Join-Path $script:UpdaterRoot 'install.ps1'
Set-Content $helper 'current helper'
function Invoke-SuiteInstaller($Installer) {
  Assert ((Get-Content $Installer -Raw).Trim() -eq 'old installer') 'wrong installer'
  $script:installed = [version]'1.2.1'
  'installed'
}
$Action = 'Rollback'
$Version = '1.2.1'
Invoke-SuiteSetup
Assert ($script:installed -eq [version]'1.2.1') 'rollback not installed'
Assert ($script:requests -contains 'v1.2.1/suite-lock.json') 'tag metadata not checked'
Assert (-not ($script:requests | Where-Object { $_ -like '*install.ps1' })) 'older helper downloaded'
Assert ((Get-Content $helper -Raw).Trim() -eq 'current helper') 'current helper replaced'
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'v1.2.1'))) 'local installer copy kept'
$status = Get-Content (Join-Path $script:UpdaterRoot 'status.json') -Raw | ConvertFrom-Json
Assert ($status.action -eq 'rollback' -and $status.status -eq 'installed' -and $status.version -eq '1.2.1') 'status not recorded'
`);
    assert.match(stdout, /Rollback Suite: 1\.2\.1; installed: 1\.2\.3/);
  },
);

test(
  "Windows 롤백은 실행 중이면 보류하고 자동 업데이트·새 버전·잘못된 태그·미설치 PC에서는 내려받지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${olderReleaseFixture}
function Get-Process { [pscustomobject]@{ Id=123 } }
function Start-Process { throw 'must not install while Paseo is running' }
$Action = 'Rollback'
$Version = '1.2.1'
Invoke-SuiteSetup
Assert (Test-Path (Join-Path $script:UpdaterRoot 'v1.2.1/Paseo-Suite-1.2.1-x64.exe')) 'pending rollback installer removed'
Assert ($script:installed -eq [version]'1.2.3') 'installed while running'
function Save-SuiteRelease { throw 'must not download' }
function Expect-Refusal($Pattern) {
  $caught = $null
  try { Invoke-SuiteSetup } catch { $caught = $_.Exception.Message }
  Assert ($caught -like $Pattern) "expected refusal $Pattern, got $caught"
}
function Get-ScheduledTask { 'enabled' }
Expect-Refusal '*DisableAutoUpdate first*'
function Get-ScheduledTask { }
$Version = 'latest'
Expect-Refusal '*-Version <major.minor.patch>*'
$Version = '1.2.1'
$EnableAutoUpdate = $true
Expect-Refusal '*cannot enable automatic updates*'
$EnableAutoUpdate = $false
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) { [pscustomobject]@{ schemaVersion=1; suiteVersion='1.2.2' } }
Expect-Refusal '*does not describe Suite v1.2.1*'
# An unpublished version (1.0.6, 1.0.7) has no public tag to download from.
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) { throw "Cannot download public Suite release asset: $Asset. Check your internet connection and retry." }
$Version = '1.0.7'
Expect-Refusal '*Suite v1.0.7 for a rollback: Cannot download*Only versions listed at https://github.com/LCH-1/paseo-suite/releases can be restored.'
$Version = '1.2.4'
function Invoke-SuiteRequest($Asset, $Tag, $OutFile) { [pscustomobject]@{ schemaVersion=1; suiteVersion='1.2.4' } }
Invoke-SuiteSetup
$script:installed = $null
$Version = '1.2.1'
Invoke-SuiteSetup
`);
    assert.match(stdout, /Suite rollback pending/);
    assert.match(stdout, /Rollback installs an older release only/);
    assert.match(stdout, /No registered Suite installation found/);
  },
);

test(
  "Windows 롤백은 모든 사용자(HKLM) 설치가 있으면 내려받기 전에 거부해 사용자별 사본을 옆에 만들지 않는다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${olderReleaseAssets}
function New-App([string]$Name, [string]$Version) {
  $folder = Join-Path $script:UpdaterRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $folder 'resources/suite') -Force | Out-Null
  Set-Content (Join-Path $folder 'resources/suite/suite-lock.json') ('{"suiteVersion":"' + $Version + '"}')
  $folder
}
$script:hives = @{}
# Uninstall entries per registry view; real keys are never read.
function Get-ItemProperty {
  param([string]$Path)
  $hive = if ($Path -like 'HKCU:*') { 'user' } elseif ($Path -like '*WOW6432Node*') { 'wow' } else { 'machine' }
  Assert ($Path -like '*CurrentVersion?Uninstall?[*]') "unexpected registry path $Path"
  if ($script:hives[$hive]) { $script:hives[$hive] }
}
function Save-SuiteRelease { throw 'must not download next to an all-users install' }
function Start-Process { throw 'must not run the installer' }
function Expect-Refusal($Pattern) {
  $caught = $null
  try { Invoke-SuiteSetup } catch { $caught = $_.Exception.Message }
  Assert ($caught -like $Pattern) "expected refusal $Pattern, got $caught"
}
$Action = 'Rollback'
$Version = '1.2.1'
$script:hives['machine'] = [pscustomobject]@{ DisplayName='Paseo 1.2.3'; InstallLocation=(New-App 'all users' '1.2.3') }
Expect-Refusal '*per-user installs only*Suite 1.2.3 is installed for all users*releases/tag/v1.2.1*'
Assert ($script:requests.Count -eq 0) 'release metadata requested before refusing'
# A 32-bit registry view or an older all-users copy next to a per-user one is still all-users.
$script:hives = @{}
$script:hives['user'] = [pscustomobject]@{ DisplayName='Paseo 1.2.3'; DisplayIcon=(Join-Path (New-App 'per user' '1.2.3') 'Paseo.exe') + ',0' }
$script:hives['wow'] = [pscustomobject]@{ DisplayName='Paseo'; InstallLocation=(New-App 'wow all users' '1.2.0') }
Expect-Refusal '*Suite 1.2.0 is installed for all users*'
Assert ($script:requests.Count -eq 0) 'release metadata requested before refusing'
# Per-user only: the rollback proceeds to the public tag as before.
$script:hives.Remove('wow')
function Save-SuiteRelease($Release) { Join-Path $script:UpdaterRoot $Release.Installer }
function Get-Process { [pscustomobject]@{ Id=123 } }
Invoke-SuiteSetup
Assert ($script:requests -contains 'v1.2.1/suite-lock.json') 'per-user rollback refused'
`);
    assert.match(stdout, /Suite rollback pending/);
  },
);

test(
  "Windows 설치·업데이트·자동 업데이트 켜기·롤백은 모든 사용자(HKLM) 설치가 있으면 아무것도 받거나 바꾸기 전에 거부한다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${olderReleaseAssets}
function New-App([string]$Name, [string]$Version) {
  $folder = Join-Path $script:UpdaterRoot $Name
  New-Item -ItemType Directory -Path (Join-Path $folder 'resources/suite') -Force | Out-Null
  Set-Content (Join-Path $folder 'resources/suite/suite-lock.json') ('{"suiteVersion":"' + $Version + '"}')
  $folder
}
$script:hives = @{}
function Get-ItemProperty {
  param([string]$Path)
  $hive = if ($Path -like 'HKCU:*') { 'user' } elseif ($Path -like '*WOW6432Node*') { 'wow' } else { 'machine' }
  if ($script:hives[$hive]) { $script:hives[$hive] }
}
function Save-SuiteRelease { throw 'must not download next to an all-users install' }
function Save-SuiteHelper { throw 'must not replace the command helper' }
function Set-SuiteAutoUpdate { throw 'must not change the scheduled task' }
function Start-Process { throw 'must not run the installer' }
function Expect-Refusal($Pattern) {
  $caught = $null
  try { Invoke-SuiteSetup } catch { $caught = $_.Exception.Message }
  Assert ($caught -like $Pattern) "expected refusal $Pattern, got $caught"
}
# An all-users install as on the company PC: NSIS DisplayIcon, no InstallLocation.
$script:hives['machine'] = [pscustomobject]@{ DisplayName='Paseo 1.0.7'; DisplayIcon=(Join-Path (New-App 'all users' '1.0.7') 'Paseo.exe') + ',0' }
foreach ($name in 'Install', 'Update', 'EnableAutoUpdate') {
  $Action = $name
  Expect-Refusal "$name supports per-user installs only. Suite 1.0.7 is installed for all users at *nothing was downloaded or changed. *releases*"
}
$Action = 'Install'
$EnableAutoUpdate = $true
Expect-Refusal '*per-user installs only*'
$EnableAutoUpdate = $false
# Rollback names the all-users install even while automatic updates are on, so turning
# them off first is never asked for in vain.
function Get-ScheduledTask { 'enabled' }
$Action = 'Rollback'
$Version = '1.0.4'
Expect-Refusal 'Rollback supports per-user installs only*releases/tag/v1.0.4*'
function Get-ScheduledTask { }
Assert ($script:requests.Count -eq 0) 'release metadata requested before refusing'
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'install.ps1'))) 'command helper written'
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'status.json'))) 'status written'
Assert (-not (Get-ChildItem $script:UpdaterRoot -Directory -Filter 'v*')) 'release folder created'

# Per-user only: Install goes on to the latest release as before.
$script:hives = @{}
$script:hives['user'] = [pscustomobject]@{ DisplayName='Paseo 1.0.7'; DisplayIcon=(Join-Path (New-App 'per user' '1.0.7') 'Paseo.exe') + ',0' }
function Get-SuiteRelease { $script:requests += 'latest'; [pscustomobject]@{ Version=[version]'1.2.3'; Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' } }
function Save-SuiteRelease($Release) {
  $folder = Join-Path $script:UpdaterRoot $Release.Tag
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  foreach ($name in @($Release.Installer, 'install.ps1')) { Set-Content (Join-Path $folder $name) 'owned' }
  Join-Path $folder $Release.Installer
}
$Action = 'Install'
$DownloadOnly = $true
Invoke-SuiteSetup
Assert ($script:requests -contains 'latest') 'per-user install refused'
`);
    assert.match(stdout, /Suite downloaded/);
  },
);

test(
  "Windows 설치·업데이트·자동 업데이트 켜기·롤백은 사용자별 설치 폴더 아래에 다른 Paseo 설치 폴더가 있으면 등록이 없어도 아무것도 받거나 바꾸기 전에 거부한다",
  { skip: process.platform !== "win32" },
  async () => {
    const { stdout } = await runInstallerProbe(`${olderReleaseAssets}
function Save-SuiteRelease { throw 'must not download into a folder that holds other installs' }
function Save-SuiteHelper { throw 'must not replace the command helper' }
function Set-SuiteAutoUpdate { throw 'must not change the scheduled task' }
function Start-Process { throw 'must not run the installer' }
function Expect-Refusal($Pattern) {
  $caught = $null
  try { Invoke-SuiteSetup } catch { $caught = $_.Exception.Message }
  Assert ($caught -like $Pattern) "expected refusal $Pattern, got $caught"
}
# The company PC after a swap left its all-users registration pointing nowhere: versioned
# installs below the per-user folder, which NSIS /currentuser would install into and a
# later per-user update or uninstall would empty.
$nested = Join-Path $script:UserInstallRoot '1.0.7-suite-26403642aa04-core-733643f1'
New-Item -ItemType Directory -Path $nested -Force | Out-Null
Set-Content (Join-Path $nested 'Paseo.exe') 'app'
$Version = '1.2.1'
foreach ($name in 'Install', 'Update', 'EnableAutoUpdate', 'Rollback') {
  $Action = $name
  Expect-Refusal "$name would install into *Paseo, which holds other Paseo installs (1.0.7-suite-26403642aa04-core-733643f1)*nothing was downloaded or changed*"
}
# A per-user install already at the top is emptied by its next update as well.
Set-Content (Join-Path $script:UserInstallRoot 'Paseo.exe') 'app'
$Action = 'Update'
Expect-Refusal '*holds other Paseo installs*'
# Rollback names the folder before asking to turn automatic updates off.
function Get-ScheduledTask { 'enabled' }
$Action = 'Rollback'
Expect-Refusal 'Rollback would install into*'
function Get-ScheduledTask { }
Assert ($script:requests.Count -eq 0) 'release metadata requested before refusing'
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'install.ps1'))) 'command helper written'
Assert (-not (Test-Path (Join-Path $script:UpdaterRoot 'status.json'))) 'status written'

# An ordinary per-user install: Paseo.exe at the top, its own folders hold no Paseo.exe.
Remove-Item -LiteralPath $nested -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $script:UserInstallRoot 'resources') -Force | Out-Null
function Get-SuiteRelease { $script:requests += 'latest'; [pscustomobject]@{ Version=[version]'1.2.3'; Tag='v1.2.3'; Installer='Paseo-Suite-1.2.3-x64.exe' } }
function Get-InstalledSuiteVersion { [version]'1.2.2' }
function Save-SuiteRelease($Release) {
  $folder = Join-Path $script:UpdaterRoot $Release.Tag
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  foreach ($name in @($Release.Installer, 'install.ps1')) { Set-Content (Join-Path $folder $name) 'owned' }
  Join-Path $folder $Release.Installer
}
$Action = 'Update'
$DownloadOnly = $true
Invoke-SuiteSetup
Assert ($script:requests -contains 'latest') 'ordinary per-user update refused'
`);
    assert.match(stdout, /Suite downloaded/);
  },
);
