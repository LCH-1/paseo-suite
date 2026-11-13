#!/usr/bin/env node
"use strict";
/*
 * tools/dev/residue.cjs — Paseo 개발 호스트 잔여물 정리 도구.
 *
 * 기본 동작은 "목록만 출력"이다. --execute 를 주지 않으면 아무것도 옮기거나 지우지 않는다.
 * 프로세스를 종료하지 않고 데몬·앱을 재시작하지 않는다. 이름 바꾸기가 거부되면(사용 중) 건너뛴다.
 * 지우기는 2단계다: quarantine 이 같은 볼륨의 격리 폴더로 이름만 바꾸고, 유예(기본 7일)가
 * 지난 격리분만 purge 가 영구 삭제한다. 격리분은 restore 로 제자리에 되돌린다.
 * manifest 는 이름 바꾸기 전후로 쓰므로 도중에 끊겨도 원래 자리가 남고, purge 는 manifest 가
 * 있는 격리 묶음만 지운다.
 *
 *   node tools/dev/residue.cjs plan [--kind installs,renderer,hotfixes,releases,checkpoints,attachments,linux-core]
 *        [--out plan.json] [--json] [--verbose] [--measure] [--sizes installs.csv] [--keep-install <폴더명>]...
 *        [--min-age-hours 48] [--keep-per-plugin 2] [--keep-checkpoints 3]
 *   node tools/dev/residue.cjs quarantine --plan plan.json --kind <한 종류> [--match <정규식>] [--execute]
 *   node tools/dev/residue.cjs restore --manifest <격리 폴더>/manifest-<종류>.json [--execute]
 *   node tools/dev/residue.cjs purge [--older-than-days 7] [--measure] [--execute]
 *
 * Linux 호스트(원격에 파일을 남기지 않음):
 *   ssh <host> 'node - plan --kind hotfixes,linux-core --out /tmp/residue-plan.json' < tools/dev/residue.cjs
 *
 * 경로 옵션(가짜 트리 시험용): --home --root-installs --root-hotfixes --root-releases --root-tmp
 * --root-server --trash --pins.
 *
 * 참조 수집은 경로에서 이름 "토큰"(설치 폴더 이름, 64자리 해시, 임시 폴더 이름)만 뽑는다.
 * 명령줄·설정·환경 변수 원문은 출력하지도 저장하지도 않는다. 참조 수집이 하나라도 실패하면
 * plan 은 전부 KEEP 으로 표시하고 quarantine 은 거부한다.
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const KINDS = [
  "installs",
  "renderer",
  "hotfixes",
  "releases",
  "checkpoints",
  "attachments",
  "linux-core",
];
// 체크포인트는 이름 규칙과 installed.json 만으로 판정한다. 나머지는 실행 중 참조까지 본다.
const SYSTEM_KINDS = new Set([
  "installs",
  "renderer",
  "hotfixes",
  "releases",
  "attachments",
  "linux-core",
]);
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAN_TTL_MS = 60 * 60000;
const STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?$/;
const MANIFEST = /^manifest-[a-z-]+\.json$/;

// ---------------------------------------------------------------- options
function parseArgs(argv, env = process.env, platform = process.platform) {
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "plan";
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  const flags = (name) =>
    argv.flatMap((value, index) =>
      value === name && index + 1 < argv.length ? [argv[index + 1]] : [],
    );
  const has = (name) => argv.includes(name);
  const number = (name, fallback) => {
    const value = Number(flag(name) ?? fallback);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${name} 는 0 이상의 숫자여야 한다`);
    return value;
  };
  const win = platform === "win32";
  const home = path.resolve(
    flag("--home") || path.join(os.homedir(), ".paseo"),
  );
  const local = win
    ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share");
  const minAgeHours = number("--min-age-hours", 48);
  return {
    command,
    flag,
    flags,
    has,
    win,
    home,
    roots: {
      installs:
        flag("--root-installs") ||
        (win ? path.join(local, "Programs", "Paseo") : null),
      hotfixes: flag("--root-hotfixes") || path.join(home, "suite", "hotfixes"),
      releases:
        flag("--root-releases") || path.join(local, "PaseoSuite", "releases"),
      checkpoints: path.join(home, "suite", "checkpoints"),
      attachments: flag("--root-tmp") || os.tmpdir(),
      server: flag("--root-server") || null,
    },
    trash: flag("--trash") || path.join(local, "PaseoDev", "trash"),
    pins: flag("--pins") || path.join(local, "PaseoDev", "residue-pins.json"),
    minAgeHours,
    // 다시 만들 수 있는 것(release, 화면 묶음)의 유예.
    shortAgeHours: Math.min(24, minAgeHours),
    keepPerPlugin: number("--keep-per-plugin", 2),
    keepCheckpoints: number("--keep-checkpoints", 3),
    graceDays: number("--older-than-days", 7),
    now: Date.now(),
  };
}

// ---------------------------------------------------------------- helpers
const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};
const readJson = (file) => {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
// Junction·심볼릭 링크는 디렉터리로 치지 않는다(따라가지 않음).
const listDirs = (root) => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};
const listFiles = (root) => {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};
const created = (target) => {
  const stat = fs.lstatSync(target);
  return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
};
const sizeMb = (target) => {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      try {
        for (const name of fs.readdirSync(current))
          stack.push(path.join(current, name));
      } catch {}
    } else total += stat.size;
  }
  return Math.round((total / 1048576) * 100) / 100;
};
const pad = (value) => String(value).padStart(2, "0");
const stampOf = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
};
// 표시 시각: "11-12 오후 03:00" (두 자리 시, 초 없음).
const localTime = (ms) => {
  const date = new Date(ms);
  const hours = date.getHours();
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hours < 12 ? "오전" : "오후"} ${pad(hours % 12 || 12)}:${pad(date.getMinutes())}`;
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
// 호스트 구분: Linux 3대는 hostname·사용자·home 이 모두 같아 machine-id 를 섞는다.
function identityOf(o) {
  const machine = (readText("/etc/machine-id") || "").trim();
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}\n${machine}\n${o.home.toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------- reference tokens
// 어떤 문자열이든 여기서 "보호해야 할 이름"만 뽑는다. 원문은 버린다.
const TOKEN_RX = {
  installs: /programs[\\/]+paseo[\\/]+([^\\/"'<>|\r\n\0]+)/gi,
  siblings: /programs[\\/]+(paseo-[^\\/"'<>|\r\n\0]+)/gi,
  hotfixes: /hotfixes[\\/]+([a-f0-9]{64})(?![a-f0-9])/gi,
  releases: /releases[\\/]+([a-f0-9]{64})(?![a-f0-9])/gi,
  attachments: /(paseo-attachments-[\w-]+)/gi,
};
function newRefs() {
  return {
    installs: new Map(),
    siblings: new Map(),
    hotfixes: new Map(),
    releases: new Map(),
    attachments: new Map(),
  };
}
function addTokens(refs, text, source) {
  if (typeof text !== "string" || !text) return;
  for (const [kind, rx] of Object.entries(TOKEN_RX)) {
    rx.lastIndex = 0;
    for (let match; (match = rx.exec(text)); ) {
      const key = match[1].trim().toLowerCase();
      if (!key) continue;
      if (!refs[kind].has(key)) refs[kind].set(key, new Set());
      refs[kind].get(key).add(source);
    }
  }
}
function walkStrings(value, visit, trail = "") {
  if (typeof value === "string") visit(trail, value);
  else if (Array.isArray(value))
    value.forEach((item, index) => walkStrings(item, visit, `${trail}[]`));
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value))
      walkStrings(item, visit, trail ? `${trail}.${key}` : key);
}
// 설정 파일의 모든 문자열(플러그인 경로, provider 명령·환경 등). 깨진 JSON 은 원문 그대로 본다.
function addFileTokens(refs, file, source) {
  const text = readText(file);
  if (text === null) return false;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    addTokens(refs, text, `${source}(원문)`);
    return true;
  }
  walkStrings(parsed, (trail, value) =>
    addTokens(refs, value, trail ? `${source}:${trail}` : source),
  );
  return true;
}

// ---------------------------------------------------------------- Windows collector
// 함수 정의만 담는다. 실행은 Invoke-ResidueCollector. 시험은 함수를 덮어써 가짜 입력을 준다.
// 원문 대신 경로 토큰만 내보낸다. 단계마다 실패를 errors 에 남긴다(조용히 0건으로 진행하지 않음).
const WINDOWS_COLLECTOR = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$script:ResidueRx = '(?i)programs[\\/]+paseo[^\\/"''<>|\r\n]*(?:[\\/]+[^\\/"''<>|\r\n]+)?|hotfixes[\\/]+[a-f0-9]{64}|releases[\\/]+[a-f0-9]{64}|paseo-attachments-[\w-]+'
function Add-ResidueItem([string]$Source, [string]$Text) {
  if (-not $Text) { return }
  $tokens = @([regex]::Matches($Text, $script:ResidueRx) | ForEach-Object { $_.Value } | Select-Object -Unique)
  if ($tokens.Count) { [void]$script:ResidueItems.Add([pscustomobject]@{ src = $Source; tokens = $tokens }) }
}
function Initialize-ResiduePeb {
  if ('ResiduePeb' -as [type]) { return }
  if (-not [Environment]::Is64BitProcess) { throw 'process environment needs 64-bit PowerShell' }
  # Read-only: PROCESS_QUERY_INFORMATION | PROCESS_VM_READ. Returns the working directory and environment block.
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ResiduePeb {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref Basic i, int l, out int r);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(int a, bool i, int p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr b, byte[] buf, IntPtr s, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h, long address, int size) { var b = new byte[size]; IntPtr r; return ReadProcessMemory(h, (IntPtr)address, b, (IntPtr)size, out r) ? b : null; }
  public static string[] Get(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); if (h == IntPtr.Zero) return null;
    try {
      var basic = new Basic(); int length;
      if (NtQueryInformationProcess(h, 0, ref basic, Marshal.SizeOf(basic), out length) != 0) return null;
      var pointer = Read(h, (long)basic.Peb + 0x20, 8); if (pointer == null) return null;
      var header = Read(h, BitConverter.ToInt64(pointer, 0), 0x400); if (header == null) return null;
      int cwdLength = BitConverter.ToUInt16(header, 0x38);
      long environment = BitConverter.ToInt64(header, 0x80), environmentSize = BitConverter.ToInt64(header, 0x3F0);
      var cwd = Read(h, BitConverter.ToInt64(header, 0x40), cwdLength);
      byte[] block = environmentSize > 0 && environmentSize < 4194304 ? Read(h, environment, (int)environmentSize) : null;
      return new string[] { cwd == null ? "" : Encoding.Unicode.GetString(cwd), block == null ? "" : Encoding.Unicode.GetString(block) };
    } finally { CloseHandle(h); }
  }
}
'@
}
function Get-ResidueProcesses { @(Get-CimInstance Win32_Process) }
function Read-ResidueProcess([int]$Id) { [ResiduePeb]::Get($Id) }
function Invoke-ResidueProcessStage {
  Initialize-ResiduePeb
  $processes = @(Get-ResidueProcesses)
  if ($processes.Count -eq 0) { throw 'no process was listed' }
  foreach ($process in $processes) {
    $id = [int]$process.ProcessId
    [void]$script:ResidueFacts.processIds.Add($id)
    if ($process.Name -match '^(Paseo|node|bun)\.exe$' -and $process.CreationDate) {
      if (-not $script:ResidueFacts.earliest -or $process.CreationDate -lt $script:ResidueFacts.earliest) { $script:ResidueFacts.earliest = $process.CreationDate }
    }
    $source = 'process:' + $process.Name + '#' + $id
    Add-ResidueItem $source ([string]$process.ExecutablePath + '|' + [string]$process.CommandLine)
    $memory = $null
    try { $memory = Read-ResidueProcess $id } catch { $memory = $null }
    if (-not $memory) { $script:ResidueFacts.environmentUnreadable++; continue }
    $script:ResidueFacts.environmentRead++
    Add-ResidueItem ($source + ':cwd') $memory[0]
    # Long-lived tools can carry an old CLI or install path in variables such as PASEO_CLI or PATH.
    foreach ($pair in ($memory[1] -split [char]0)) {
      $at = $pair.IndexOf('=')
      if ($at -gt 0) { Add-ResidueItem ($source + ':env:' + $pair.Substring(0, $at)) $pair.Substring($at + 1) }
    }
  }
}
function Get-ResidueRegistryValues([string]$Key) { @(Get-ItemProperty -Path $Key -ErrorAction SilentlyContinue) }
function Get-ResidueRegistryChildren([string]$Root) { @(Get-ChildItem -LiteralPath $Root -ErrorAction SilentlyContinue) }
function Invoke-ResidueRegistryStage {
  foreach ($key in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') {
    foreach ($values in @(Get-ResidueRegistryValues $key)) {
      foreach ($property in $values.PSObject.Properties) { if ($property.Value -is [string]) { Add-ResidueItem ('run:' + $property.Name) $property.Value } }
    }
  }
  foreach ($key in 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*') {
    foreach ($entry in @(Get-ResidueRegistryValues $key)) {
      if (-not ($entry.PSObject.Properties['DisplayName'] -and [string]$entry.DisplayName -like 'Paseo*')) { continue }
      foreach ($name in 'InstallLocation', 'DisplayIcon', 'UninstallString', 'QuietUninstallString') {
        $value = $entry.PSObject.Properties[$name]
        if ($value -and $value.Value) { Add-ResidueItem ('uninstall:' + $name) ([string]$value.Value) }
      }
    }
  }
  foreach ($key in 'HKCU:\Software\Classes\paseo\shell\open\command', 'HKLM:\Software\Classes\paseo\shell\open\command') {
    foreach ($values in @(Get-ResidueRegistryValues $key)) {
      $value = $values.PSObject.Properties['(default)']
      if ($value) { Add-ResidueItem 'protocol:paseo' ([string]$value.Value) }
    }
  }
  # electron-builder reads the folder the next installer removes from Software\<app GUID>, not from Uninstall.
  foreach ($root in 'HKCU:\Software', 'HKLM:\Software', 'HKLM:\Software\WOW6432Node') {
    foreach ($key in @(Get-ResidueRegistryChildren $root)) {
      if ($key.PSChildName -notmatch '^\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?$') { continue }
      $location = $key.GetValue('InstallLocation')
      if ($location) { Add-ResidueItem ('app-key:' + $key.PSChildName + ':InstallLocation') ([string]$location) }
    }
  }
}
function Get-ResidueShortcutFiles {
  $files = @()
  foreach ($folder in @("$env:APPDATA\Microsoft\Windows\Start Menu", "$env:ProgramData\Microsoft\Windows\Start Menu", "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch")) {
    if ($folder -and (Test-Path -LiteralPath $folder)) { $files += @(Get-ChildItem -LiteralPath $folder -Recurse -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
  }
  # Desktop: top level only. Project folders and their shortcut backups live below it.
  foreach ($folder in @([Environment]::GetFolderPath('Desktop'), "$env:USERPROFILE\Desktop", "$env:PUBLIC\Desktop")) {
    if ($folder -and (Test-Path -LiteralPath $folder)) { $files += @(Get-ChildItem -LiteralPath $folder -Filter *.lnk -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }) }
  }
  @($files | Select-Object -Unique)
}
function Invoke-ResidueShortcutStage {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($file in @(Get-ResidueShortcutFiles)) {
    $link = $shell.CreateShortcut($file)
    # The icon can name a different folder than the target (seen on the Start menu shortcut).
    Add-ResidueItem ('shortcut:' + [IO.Path]::GetFileName($file)) ([string]$link.TargetPath + '|' + [string]$link.Arguments + '|' + [string]$link.WorkingDirectory + '|' + [string]$link.IconLocation)
  }
}
function Get-ResidueEnvironmentVariables([string]$Scope) { [Environment]::GetEnvironmentVariables($Scope) }
function Invoke-ResidueEnvironmentStage {
  foreach ($scope in 'User', 'Machine') {
    $variables = Get-ResidueEnvironmentVariables $scope
    foreach ($name in @($variables.Keys)) { Add-ResidueItem ('env:' + $scope + ':' + $name) ([string]$variables[$name]) }
  }
}
function Get-ResidueTasks { @(Get-ScheduledTask) }
function Invoke-ResidueTaskStage {
  foreach ($task in @(Get-ResidueTasks)) {
    foreach ($action in @($task.Actions)) { Add-ResidueItem ('task:' + $task.TaskName) ([string]$action.Execute + '|' + [string]$action.Arguments + '|' + [string]$action.WorkingDirectory) }
  }
}
function Invoke-ResidueCollector {
  $script:ResidueItems = New-Object System.Collections.ArrayList
  $errors = New-Object System.Collections.ArrayList
  $script:ResidueFacts = @{ processIds = (New-Object System.Collections.ArrayList); earliest = $null; environmentRead = 0; environmentUnreadable = 0 }
  foreach ($stage in 'Process', 'Registry', 'Shortcut', 'Environment', 'Task') {
    try { & ('Invoke-Residue' + $stage + 'Stage') } catch { [void]$errors.Add($stage + ': ' + $_.Exception.Message) }
  }
  $earliest = $null
  if ($script:ResidueFacts.earliest) { $earliest = $script:ResidueFacts.earliest.ToUniversalTime().ToString('o') }
  [pscustomobject]@{
    items = @($script:ResidueItems); errors = @($errors); processIds = @($script:ResidueFacts.processIds); earliest = $earliest
    environmentRead = $script:ResidueFacts.environmentRead; environmentUnreadable = $script:ResidueFacts.environmentUnreadable
  } | ConvertTo-Json -Depth 6 -Compress
}
`;

// The collector goes through stdin: as -EncodedCommand it would approach the
// 32,767-character Windows command-line limit.
const STDIN_RUNNER =
  "$reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding $false)); . ([scriptblock]::Create($reader.ReadToEnd()))";

function collectWindows({ overrides = "", timeoutMs = 180000 } = {}) {
  const script = `${WINDOWS_COLLECTOR}\n${overrides}\nInvoke-ResidueCollector\n`;
  const stdout = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(STDIN_RUNNER, "utf16le").toString("base64"),
    ],
    {
      input: script,
      encoding: "utf8",
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("Windows 참조 수집 결과가 없다");
  const parsed = JSON.parse(stdout.slice(start));
  const list = (value) =>
    Array.isArray(value)
      ? value
      : value === null || value === undefined
        ? []
        : [value];
  return {
    items: list(parsed.items).map((item) => ({
      src: item.src,
      tokens: list(item.tokens),
    })),
    errors: list(parsed.errors),
    processIds: list(parsed.processIds).map(Number),
    earliestMs: parsed.earliest ? Date.parse(parsed.earliest) : null,
    environmentRead: parsed.environmentRead ?? 0,
    environmentUnreadable: parsed.environmentUnreadable ?? 0,
  };
}

// Linux: 같은 사용자 프로세스의 exe·cwd·cmdline·maps·environ. 남의 프로세스는 읽히는 것만.
function collectLinux({ procRoot = "/proc" } = {}) {
  const result = {
    items: [],
    errors: [],
    processIds: [],
    earliestMs: null,
    environmentRead: 0,
    environmentUnreadable: 0,
    serverRoot: null,
  };
  let entries;
  try {
    entries = fs.readdirSync(procRoot);
  } catch (error) {
    result.errors.push(`${procRoot}: ${error.code ?? error.message}`);
    return result;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const base = path.join(procRoot, entry);
    result.processIds.push(Number(entry));
    const parts = [];
    for (const link of ["exe", "cwd"]) {
      try {
        parts.push(fs.readlinkSync(path.join(base, link)));
      } catch {}
    }
    for (const file of ["cmdline", "maps"]) {
      const text = readText(path.join(base, file));
      if (text) parts.push(text.replace(/\0/g, "|"));
    }
    const text = parts.join("|");
    if (text) result.items.push({ src: `process#${entry}`, text });
    for (const match of text.matchAll(/(\/[^\s|]*@getpaseo\/server)\/dist\//g))
      result.serverRoot = match[1];
    const environment = readText(path.join(base, "environ"));
    if (environment === null) {
      result.environmentUnreadable += 1;
      continue;
    }
    result.environmentRead += 1;
    for (const pair of environment.split("\0")) {
      const at = pair.indexOf("=");
      if (at > 0)
        result.items.push({
          src: `process#${entry}:env:${pair.slice(0, at)}`,
          text: pair.slice(at + 1),
        });
    }
  }
  if (!result.processIds.length)
    result.errors.push("프로세스를 하나도 읽지 못함");
  return result;
}

function collectSystemRefs(refs, o) {
  return o.win ? collectWindows() : collectLinux();
}

function applySystem(refs, system, o, config) {
  const info = {
    ok: true,
    errors: [...(system.errors ?? [])],
    earliestProcessMs: system.earliestMs ?? null,
    processCount: system.processIds?.length ?? 0,
    environmentRead: system.environmentRead ?? 0,
    environmentUnreadable: system.environmentUnreadable ?? 0,
    serverRoot: system.serverRoot ?? null,
    sources: 0,
  };
  for (const item of system.items ?? []) {
    const texts = item.tokens ?? [item.text];
    const before = Object.values(refs).reduce((sum, map) => sum + map.size, 0);
    for (const text of texts) addTokens(refs, text, item.src);
    if (Object.values(refs).reduce((sum, map) => sum + map.size, 0) !== before)
      info.sources += 1;
  }
  // 살아 있는 데몬이 목록에 없으면 수집이 불완전하다(권한·조회 실패). 판정하지 않는다.
  const pid = Number(config.daemon?.pid);
  if (
    Number.isInteger(pid) &&
    pid > 0 &&
    isAlive(pid) &&
    !(system.processIds ?? []).includes(pid)
  )
    info.errors.push(`데몬 pid ${pid} 가 프로세스 목록에 없다(수집 불완전)`);
  if (!info.processCount) info.errors.push("프로세스 목록이 비었다");
  info.ok = info.errors.length === 0;
  return info;
}

// ---------------------------------------------------------------- config references
function checkpointOrder(o) {
  const entries = listDirs(o.roots.checkpoints)
    .filter((name) => UUID.test(name))
    .map((name) => ({
      name,
      modified: fs.lstatSync(path.join(o.roots.checkpoints, name)).mtimeMs,
    }));
  entries.sort(
    (a, b) => b.modified - a.modified || a.name.localeCompare(b.name),
  );
  return entries;
}

function collectConfigRefs(refs, o) {
  const info = {
    daemon: null,
    currentTreeHash: null,
    currentCheckpoint: null,
    retainedCheckpoints: [],
  };
  addFileTokens(refs, path.join(o.home, "config.json"), "config");
  const installed = readJson(path.join(o.home, "suite", "installed.json"));
  if (installed) {
    info.currentTreeHash =
      typeof installed.treeHash === "string"
        ? installed.treeHash.toLowerCase()
        : null;
    if (typeof installed.checkpoint === "string")
      info.currentCheckpoint = path
        .basename(installed.checkpoint)
        .toLowerCase();
  }
  addFileTokens(
    refs,
    path.join(o.home, "suite", "installed.json"),
    "installed.json",
  );
  addFileTokens(
    refs,
    path.join(o.home, "suite", "rolled-back.json"),
    "rolled-back.json",
  );
  // 남는 체크포인트 = installed.json 이 가리키는 것 + 최근 N개(tools/bootstrap.ts 와 같은 규칙).
  const order = checkpointOrder(o);
  const retained = new Set(
    order.slice(0, o.keepCheckpoints).map((entry) => entry.name.toLowerCase()),
  );
  if (info.currentCheckpoint) retained.add(info.currentCheckpoint);
  info.retainedCheckpoints = [...retained];
  // 디스크에 있는 모든 체크포인트의 모든 문자열(plugins·providers)을 보호한다. 정리 후보 체크포인트의
  // 참조도 그 체크포인트가 실제로 격리될 때까지는 지킨다(체크포인트 → release 순서로 정리).
  for (const name of listDirs(o.roots.checkpoints)) {
    const label = !UUID.test(name)
      ? "대상 아님"
      : retained.has(name.toLowerCase())
        ? "유지"
        : "정리 후보";
    addFileTokens(
      refs,
      path.join(o.roots.checkpoints, name, "config.json"),
      `checkpoint(${label}):${name.slice(0, 8)}`,
    );
  }
  const pid = readJson(path.join(o.home, "paseo.pid"));
  if (pid)
    info.daemon = { pid: pid.pid ?? null, startedAt: pid.startedAt ?? null };
  const pins = readJson(o.pins);
  if (Array.isArray(pins))
    for (const pin of pins) {
      if (pin?.until && Date.parse(pin.until) < o.now) continue;
      addTokens(
        refs,
        String(pin?.path ?? ""),
        `pin:${String(pin?.owner ?? "unknown")}`,
      );
    }
  return info;
}

// ---------------------------------------------------------------- classification
function item(o, kind, name, target, extra = {}) {
  const createdMs = created(target);
  return {
    kind,
    name,
    path: target,
    created: localTime(createdMs),
    createdMs,
    ageHours: Math.round((o.now - createdMs) / 36e5),
    sizeMb: null,
    action: "PRUNE",
    reasons: [],
    ...extra,
  };
}
function keep(entry, reason) {
  entry.action = "KEEP";
  entry.reasons.push(reason);
}
// 토큰이 이름과 같거나, 이름 뒤에 공백·;·, 가 붙은 경우(명령 인자, PATH 목록)도 참조로 친다.
function applyRefs(entry, map, name) {
  const wanted = name.toLowerCase();
  for (const [token, sources] of map)
    if (
      token === wanted ||
      (token.startsWith(wanted) && /^[\s;,]/.test(token.slice(wanted.length)))
    )
      for (const source of sources) keep(entry, source);
}

function planInstalls(ctx) {
  const { o } = ctx;
  const root = o.roots.installs;
  if (!root || !fs.existsSync(root))
    return { items: [], note: "설치 루트 없음" };
  // 제품 기본 위치에 직접 설치돼 있으면 하위 전체가 실행본이다. 손대지 않는다.
  if (fs.existsSync(path.join(root, "Paseo.exe")))
    return {
      items: [],
      blocked: `${root} 바로 아래에 Paseo.exe 가 있다(제자리 설치). 하위 폴더를 정리 대상으로 삼지 않는다.`,
    };
  const sizes = new Map();
  const csv = o.flag("--sizes");
  if (csv)
    for (const line of fs.readFileSync(csv, "utf8").split(/\r?\n/).slice(1)) {
      const cells = line.split(",");
      if (cells.length >= 5)
        sizes.set(cells[1].toLowerCase(), {
          logical: Number(cells[3]),
          exclusive: Number(cells[4]),
        });
    }
  const pinned = new Set(
    o.flags("--keep-install").map((name) => name.toLowerCase()),
  );
  const items = [];
  for (const name of listDirs(root)) {
    const entry = item(o, "installs", name, path.join(root, name));
    const size = sizes.get(name.toLowerCase());
    if (size)
      Object.assign(entry, {
        sizeMb: size.logical,
        exclusiveMb: size.exclusive,
      });
    else if (o.has("--measure")) entry.sizeMb = sizeMb(entry.path);
    applyRefs(entry, ctx.refs.installs, name);
    if (pinned.has(name.toLowerCase()))
      keep(entry, "keep-install(사용자 지정 롤백 대상)");
    if (entry.ageHours < o.minAgeHours) keep(entry, `age<${o.minAgeHours}h`);
    items.push(entry);
  }
  // 형제 폴더(Programs\Paseo-*)는 통째로 한 단위.
  const parent = path.dirname(root);
  for (const name of listDirs(parent)) {
    if (!/^paseo-/i.test(name)) continue;
    const entry = item(o, "installs", `../${name}`, path.join(parent, name));
    if (o.has("--measure")) entry.sizeMb = sizeMb(entry.path);
    applyRefs(entry, ctx.refs.siblings, name);
    if (entry.ageHours < o.minAgeHours) keep(entry, `age<${o.minAgeHours}h`);
    items.push(entry);
  }
  return { items };
}

function planRenderer(ctx, installs) {
  const { o } = ctx;
  // 살아 있는(KEEP) 설치 폴더 안의 화면 묶음만 본다. 옛 폴더 것은 폴더와 함께 처리한다.
  const items = [];
  for (const install of installs.filter(
    (entry) => entry.action === "KEEP" && !entry.name.startsWith("../"),
  )) {
    const dist = path.join(install.path, "resources", "app-dist");
    const web = path.join(dist, "_expo", "static", "js", "web");
    const bundles = listFiles(web).filter((name) =>
      /^index-[a-f0-9]+\.js$/i.test(name),
    );
    if (bundles.length < 2) continue;
    const html = readText(path.join(dist, "index.html")) ?? "";
    const entries = bundles.map((name) =>
      item(o, "renderer", `${install.name}/${name}`, path.join(web, name), {
        file: true,
      }),
    );
    for (const entry of entries)
      entry.sizeMb =
        Math.round((fs.lstatSync(entry.path).size / 1048576) * 100) / 100;
    const oldest = entries.reduce((a, b) =>
      a.createdMs <= b.createdMs ? a : b,
    );
    for (const entry of entries) {
      if (!html) keep(entry, "index.html 을 읽지 못함");
      if (html.includes(path.basename(entry.path)))
        keep(entry, "index.html 참조(현재)");
      if (entry === oldest) keep(entry, "설치 원본(가장 오래된 묶음)");
      if (entry.ageHours < o.shortAgeHours)
        keep(entry, `age<${o.shortAgeHours}h`);
    }
    items.push(...entries);
  }
  return { items };
}

function planHotfixes(ctx) {
  const { o } = ctx;
  const root = o.roots.hotfixes;
  const daemonStartMs = Date.parse(ctx.config.daemon?.startedAt ?? "") || null;
  const items = [];
  const perPlugin = new Map();
  for (const name of listDirs(root)) {
    if (!HEX64.test(name)) continue;
    const entry = item(o, "hotfixes", name, path.join(root, name));
    entry.sizeMb = sizeMb(entry.path);
    entry.plugins = listDirs(path.join(entry.path, "plugins"));
    for (const plugin of entry.plugins) {
      if (!perPlugin.has(plugin)) perPlugin.set(plugin, []);
      perPlugin.get(plugin).push(entry);
    }
    applyRefs(entry, ctx.refs.hotfixes, name);
    if (entry.ageHours < o.minAgeHours) keep(entry, `age<${o.minAgeHours}h`);
    // 지금 데몬이 뜬 뒤 만든 폴더는 그 데몬이 읽었을 수 있다. Linux 는 사용 중이어도 rename 이 성공하므로
    // 프로세스 조사만으로 "안 쓰임"을 단정하지 않는다. 데몬이 바뀔 때까지 둔다.
    if (daemonStartMs && entry.createdMs >= daemonStartMs)
      keep(entry, "현재 데몬 기동 이후 생성");
    items.push(entry);
  }
  for (const [plugin, entries] of perPlugin) {
    entries.sort((a, b) => b.createdMs - a.createdMs);
    entries
      .slice(0, o.keepPerPlugin)
      .forEach((entry, index) =>
        keep(entry, `${plugin} 최신 ${index + 1}번째`),
      );
    const loadedAtStart = daemonStartMs
      ? entries.find((entry) => entry.createdMs < daemonStartMs)
      : null;
    if (loadedAtStart) keep(loadedAtStart, `${plugin} 데몬 기동 직전 최신`);
  }
  return { items };
}

function planReleases(ctx) {
  const { o } = ctx;
  const items = [];
  for (const name of listDirs(o.roots.releases)) {
    if (!HEX64.test(name)) continue;
    const entry = item(o, "releases", name, path.join(o.roots.releases, name));
    entry.sizeMb = sizeMb(entry.path);
    if (ctx.config.currentTreeHash === name.toLowerCase())
      keep(entry, "installed.json 현재 treeHash");
    applyRefs(entry, ctx.refs.releases, name);
    const modified = fs.lstatSync(entry.path).mtimeMs;
    if (Math.min(entry.ageHours, (o.now - modified) / 36e5) < o.shortAgeHours)
      keep(entry, `age<${o.shortAgeHours}h`);
    items.push(entry);
  }
  return { items };
}

function planCheckpoints(ctx) {
  const { o } = ctx;
  // 제품(bootstrap)이 만든 UUID 이름만 다룬다. 사람이 둔 다른 폴더(예: 대화 기록 사본)는 대상이 아니다.
  const items = checkpointOrder(o).map((entry, index) => {
    const result = item(
      o,
      "checkpoints",
      entry.name,
      path.join(o.roots.checkpoints, entry.name),
    );
    result.sizeMb = sizeMb(result.path);
    if (ctx.config.currentCheckpoint === entry.name.toLowerCase())
      keep(result, "installed.json 현재 checkpoint");
    if (index < o.keepCheckpoints) keep(result, `최근 ${o.keepCheckpoints}개`);
    return result;
  });
  return { items };
}

function planAttachments(ctx) {
  const { o } = ctx;
  if (!o.win)
    return { items: [], note: "Linux /tmp 는 OS(tmpfiles.d 30일)가 정리한다" };
  // 살아 있는 데몬의 폴더는 그 데몬 프로세스가 뜬 뒤에 만들어진다. 지금 도는 Paseo/node/bun
  // 프로세스 중 가장 오래된 것보다 먼저 생긴 폴더만 주인 없는 것으로 본다.
  const horizon = ctx.system.earliestProcessMs;
  const items = [];
  for (const name of listDirs(o.roots.attachments)) {
    if (!/^paseo-attachments-/i.test(name)) continue;
    const entry = item(
      o,
      "attachments",
      name,
      path.join(o.roots.attachments, name),
    );
    entry.sizeMb = sizeMb(entry.path);
    applyRefs(entry, ctx.refs.attachments, name);
    if (!horizon) keep(entry, "실행 중 프로세스 시작 시각을 알 수 없음");
    else if (entry.createdMs >= horizon)
      keep(
        entry,
        `가장 오래된 Paseo/node 프로세스(${localTime(horizon)}) 이후 생성`,
      );
    items.push(entry);
  }
  return { items };
}

function planLinuxCore(ctx) {
  const { o } = ctx;
  if (o.win) return { items: [], note: "Linux 전용" };
  const serverRoot =
    o.roots.server ||
    ctx.system.serverRoot ||
    path.join(
      os.homedir(),
      ".local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server",
    );
  const previous = listDirs(serverRoot)
    .filter((name) => /^dist\.prev-[a-f0-9]+-\d{8}T\d{6}/.test(name))
    .map((name) =>
      item(o, "linux-core", name, path.join(serverRoot, name), {
        short: name.split("-")[1],
        stamp: name.split("-")[2],
      }),
    );
  previous.sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  const newest = previous[0];
  const stages = listDirs(path.join(o.home, "suite"))
    .filter((name) => /^linux-core-[a-f0-9]+$/.test(name))
    .map((name) =>
      item(o, "linux-core", `suite/${name}`, path.join(o.home, "suite", name), {
        short: name.split("-")[2],
      }),
    );
  for (const entry of [...previous, ...stages]) {
    entry.sizeMb = sizeMb(entry.path);
    if (!newest) keep(entry, "dist.prev 가 없어 직전 단계를 특정할 수 없음");
    else if (entry === newest) keep(entry, "직전 dist(롤백 원본)");
    else if (entry.name.startsWith("suite/") && entry.short === newest.short)
      keep(entry, "직전 단계의 baseline sums·백업 tgz");
    if (entry.ageHours < o.minAgeHours) keep(entry, `age<${o.minAgeHours}h`);
  }
  // 실패·복구 표식이 하나라도 있으면 전부 보류.
  const markers = listDirs(serverRoot).filter((name) =>
    /^dist\.(failed|restore)/.test(name),
  );
  if (markers.length)
    for (const entry of [...previous, ...stages])
      keep(entry, `복구 표식 존재: ${markers.join(",")}`);
  return {
    items: [...previous, ...stages],
    note: `server root: ${serverRoot}`,
  };
}

function buildPlan(o, kinds, deps) {
  const refs = newRefs();
  const config = collectConfigRefs(refs, o);
  const needsSystem = kinds.some((kind) => SYSTEM_KINDS.has(kind));
  let system = {
    ok: true,
    errors: [],
    earliestProcessMs: null,
    processCount: null,
    sources: 0,
  };
  if (needsSystem) {
    let raw;
    try {
      raw = deps.collectSystem(refs, o);
    } catch (error) {
      raw = {
        items: [],
        errors: [`수집기 실행 실패: ${error.message}`],
        processIds: [],
      };
    }
    system = applySystem(refs, raw, o, config);
  }
  const ctx = { o, refs, config, system };
  const result = {
    schema: 2,
    host: os.hostname(),
    identity: identityOf(o),
    platform: process.platform,
    at: new Date(o.now).toISOString(),
    daemon: config.daemon,
    collection: needsSystem
      ? {
          ok: system.ok,
          errors: system.errors,
          processes: system.processCount,
          environmentRead: system.environmentRead,
          environmentUnreadable: system.environmentUnreadable,
        }
      : {
          ok: true,
          errors: [],
          skipped: "이 종류는 실행 중 참조를 보지 않는다",
        },
    options: {
      minAgeHours: o.minAgeHours,
      keepPerPlugin: o.keepPerPlugin,
      keepCheckpoints: o.keepCheckpoints,
    },
    kinds: {},
  };
  let installs = null;
  for (const kind of kinds) {
    if (kind === "installs" || kind === "renderer") {
      installs ??= o.win
        ? planInstalls(ctx)
        : { items: [], note: "Windows 전용" };
      if (kind === "installs") result.kinds.installs = installs;
      else
        result.kinds.renderer = o.win
          ? planRenderer(ctx, installs.items)
          : { items: [], note: "Windows 전용" };
    } else if (kind === "hotfixes") result.kinds.hotfixes = planHotfixes(ctx);
    else if (kind === "releases") result.kinds.releases = planReleases(ctx);
    else if (kind === "checkpoints")
      result.kinds.checkpoints = planCheckpoints(ctx);
    else if (kind === "attachments")
      result.kinds.attachments = planAttachments(ctx);
    else if (kind === "linux-core")
      result.kinds["linux-core"] = planLinuxCore(ctx);
    else throw new Error(`알 수 없는 종류: ${kind}`);
  }
  for (const section of Object.values(result.kinds))
    for (const entry of section.items) {
      if (!result.collection.ok) keep(entry, "참조 수집 실패 — 판정하지 않음");
      entry.reasons = [...new Set(entry.reasons)];
    }
  return result;
}

function printPlan(plan, o, log) {
  const mb = (entries) => {
    const known = entries.filter((entry) => typeof entry.sizeMb === "number");
    const total =
      Math.round(known.reduce((sum, entry) => sum + entry.sizeMb, 0) * 10) / 10;
    return known.length === entries.length
      ? `${total}MB`
      : `${total}MB(+크기 미측정 ${entries.length - known.length}개)`;
  };
  log(
    `# residue plan  host=${plan.host}  at=${localTime(Date.parse(plan.at))}  daemon.pid=${plan.daemon?.pid ?? "?"}  (목록만: 아무것도 바꾸지 않음)`,
  );
  if (!plan.collection.ok)
    log(
      `!! 참조 수집 실패 — 모든 항목을 KEEP 으로 둔다: ${plan.collection.errors.join("; ")}`,
    );
  else if (plan.collection.processes)
    log(
      `   참조 수집: 프로세스 ${plan.collection.processes}개, 환경 변수 읽음 ${plan.collection.environmentRead}·못 읽음 ${plan.collection.environmentUnreadable}`,
    );
  for (const [kind, section] of Object.entries(plan.kinds)) {
    const keepers = section.items.filter((entry) => entry.action === "KEEP");
    const prunable = section.items.filter((entry) => entry.action === "PRUNE");
    log(
      `\n## ${kind}: 전체 ${section.items.length}개 ${mb(section.items)} | 유지 ${keepers.length}개 ${mb(keepers)} | 정리 후보 ${prunable.length}개 ${mb(prunable)}`,
    );
    if (section.blocked) log(`   BLOCKED: ${section.blocked}`);
    if (section.note) log(`   note: ${section.note}`);
    const short = (name) =>
      name.length > 44 ? `${name.slice(0, 12)}…${name.slice(-28)}` : name;
    for (const entry of keepers)
      log(
        `   KEEP  ${entry.created}  ${String(entry.sizeMb ?? "?").padStart(8)}MB  ${short(entry.name)}  <- ${entry.reasons.slice(0, 4).join("; ")}${entry.reasons.length > 4 ? ` 외 ${entry.reasons.length - 4}` : ""}`,
      );
    if (o.has("--verbose"))
      for (const entry of prunable)
        log(
          `   PRUNE ${entry.created}  ${String(entry.sizeMb ?? "?").padStart(8)}MB  ${entry.name}${entry.plugins ? `  [${entry.plugins.join(",")}]` : ""}`,
        );
    else if (prunable.length)
      log(
        `   PRUNE ${prunable.length}개: ${localTime(Math.min(...prunable.map((entry) => entry.createdMs)))} ~ ${localTime(Math.max(...prunable.map((entry) => entry.createdMs)))} 생성 (--verbose 로 목록)`,
      );
  }
}

// ---------------------------------------------------------------- commands
function parseKinds(o) {
  const value = o.flag("--kind");
  if (!value || value === "all")
    return KINDS.filter((kind) =>
      o.win
        ? kind !== "linux-core"
        : !["installs", "renderer", "attachments"].includes(kind),
    );
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  for (const kind of kinds)
    if (!KINDS.includes(kind)) throw new Error(`알 수 없는 종류: ${kind}`);
  return kinds;
}

function cmdPlan(o, deps) {
  const plan = buildPlan(o, parseKinds(o), deps);
  if (o.has("--json")) deps.log(JSON.stringify(plan));
  else printPlan(plan, o, deps.log);
  const out = o.flag("--out");
  if (out) {
    fs.writeFileSync(out, JSON.stringify(plan, null, 1));
    deps.log(`\nplan 저장: ${out}`);
  }
}

function cmdQuarantine(o, deps) {
  const planFile = o.flag("--plan");
  const kind = o.flag("--kind");
  if (!planFile || !kind || kind.includes(","))
    throw new Error(
      "quarantine 에는 --plan <파일> 과 --kind <한 종류> 가 필요하다",
    );
  const execute = o.has("--execute");
  const saved = readJson(planFile);
  if (!saved?.kinds?.[kind]) throw new Error("plan 파일에 해당 종류가 없다");
  if (saved.identity !== identityOf(o))
    throw new Error("다른 호스트나 다른 home 에서 만든 plan 이다");
  if (o.now - Date.parse(saved.at) > PLAN_TTL_MS)
    throw new Error("plan 이 60분보다 오래됐다. plan 을 다시 만들어라");
  if (!saved.collection?.ok)
    throw new Error("plan 을 만들 때 참조 수집이 실패했다");
  // 실행 직전 참조를 다시 모아 다시 판정한다.
  const fresh = buildPlan(
    o,
    kind === "renderer" ? ["installs", "renderer"] : [kind],
    deps,
  );
  if (!fresh.collection.ok)
    throw new Error(
      `참조 수집 실패로 거부: ${fresh.collection.errors.join("; ")}`,
    );
  if (JSON.stringify(fresh.daemon) !== JSON.stringify(saved.daemon))
    throw new Error("plan 이후 데몬이 재시작됐다. plan 을 다시 만들어라");
  if (fresh.kinds[kind].blocked) throw new Error(fresh.kinds[kind].blocked);
  const current = new Map(
    fresh.kinds[kind].items.map((entry) => [entry.path, entry]),
  );
  const match = o.flag("--match") ? new RegExp(o.flag("--match"), "i") : null;
  let batch = path.join(o.trash, stampOf(o.now));
  for (
    let suffix = 2;
    fs.existsSync(path.join(batch, `manifest-${kind}.json`));
    suffix += 1
  )
    batch = path.join(o.trash, `${stampOf(o.now)}-${suffix}`);
  const manifest = {
    schema: 2,
    host: os.hostname(),
    identity: saved.identity,
    at: new Date(o.now).toISOString(),
    kind,
    moved: [],
    skipped: [],
  };
  const file = path.join(batch, `manifest-${kind}.json`);
  // 이름 바꾸기 전후로 manifest 를 쓴다. 도중에 끊겨도 옮긴 폴더마다 원래 자리가 남는다.
  const save = () => {
    fs.mkdirSync(batch, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(manifest, null, 1));
    fs.renameSync(temporary, file);
  };
  const rename = deps.rename ?? fs.renameSync;
  for (const entry of saved.kinds[kind].items) {
    if (entry.action !== "PRUNE" || (match && !match.test(entry.name)))
      continue;
    const now = current.get(entry.path);
    if (!now || now.action !== "PRUNE") {
      manifest.skipped.push({
        name: entry.name,
        why: now ? `지금은 KEEP: ${now.reasons.join("; ")}` : "없어짐",
      });
      continue;
    }
    const destination = path.join(
      batch,
      kind,
      entry.name.replace(/^\.\.\//, "_sibling_").replace(/[\\/]/g, "__"),
    );
    if (!execute) {
      manifest.moved.push({
        name: entry.name,
        from: entry.path,
        to: destination,
        sizeMb: entry.sizeMb,
        dryRun: true,
      });
      continue;
    }
    const record = {
      name: entry.name,
      from: entry.path,
      to: destination,
      sizeMb: entry.sizeMb,
      state: "moving",
    };
    manifest.moved.push(record);
    save();
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // 같은 볼륨 rename 만 쓴다. 사용 중(EBUSY/EPERM/EACCES)이거나 볼륨이 다르면(EXDEV) 건너뛴다. 복사 후 삭제는 하지 않는다.
      rename(entry.path, destination);
      delete record.state;
    } catch (error) {
      manifest.moved.pop();
      manifest.skipped.push({
        name: entry.name,
        why: `rename 실패 ${error.code ?? error.message}`,
      });
    }
    save();
  }
  if (execute && !manifest.moved.length && fs.existsSync(file)) {
    // 하나도 옮기지 못했으면 빈 격리 묶음을 남기지 않는다.
    fs.rmSync(file, { force: true });
    for (const folder of [path.join(batch, kind), batch])
      try {
        fs.rmdirSync(folder);
      } catch {
        // 다른 종류가 같은 묶음을 쓰면 그대로 둔다.
      }
  }
  const total =
    Math.round(
      manifest.moved.reduce((sum, entry) => sum + (entry.sizeMb ?? 0), 0) * 10,
    ) / 10;
  deps.log(
    `${execute ? "격리함" : "격리 예정(미리보기)"}: ${manifest.moved.length}개 ${total}MB -> ${batch}`,
  );
  for (const entry of manifest.skipped)
    deps.log(`  건너뜀 ${entry.name}: ${entry.why}`);
  if (execute && manifest.moved.length) {
    deps.log(
      `되돌리기: node tools/dev/residue.cjs restore --manifest "${file}" --execute`,
    );
    deps.log(
      `영구 삭제: ${o.graceDays}일 뒤 node tools/dev/residue.cjs purge --execute`,
    );
  } else if (o.has("--verbose"))
    for (const entry of manifest.moved) deps.log(`  ${entry.name}`);
}

function cmdRestore(o, deps) {
  const file = o.flag("--manifest");
  const manifest = readJson(file ?? "");
  if (!manifest?.moved) throw new Error("--manifest <파일> 이 필요하다");
  const batch = path.resolve(path.dirname(file));
  const execute = o.has("--execute");
  // Windows 경로는 대소문자를 가리지 않는다. manifest 경로를 다르게 적어도 같은 묶음이다.
  const fold = (value) => (o.win ? value.toLowerCase() : value);
  for (const entry of manifest.moved) {
    const to = path.resolve(entry.to);
    if (!fold(to).startsWith(fold(batch + path.sep))) {
      deps.log(`  건너뜀 ${entry.name}: 격리 폴더 밖 경로`);
      continue;
    }
    const possible = fs.existsSync(to) && !fs.existsSync(entry.from);
    if (!possible)
      deps.log(
        `  건너뜀 ${entry.name}: ${fs.existsSync(entry.from) ? "원래 자리에 이미 있음" : "격리본 없음"}`,
      );
    else if (!execute) deps.log(`  되돌릴 예정 ${entry.name}`);
    else {
      fs.mkdirSync(path.dirname(entry.from), { recursive: true });
      fs.renameSync(to, entry.from);
      deps.log(`  되돌림 ${entry.name}`);
    }
  }
}

function cmdPurge(o, deps) {
  const execute = o.has("--execute");
  for (const name of listDirs(o.trash)) {
    const match = STAMP.exec(name);
    if (!match) continue;
    const at = new Date(
      +match[1],
      +match[2] - 1,
      +match[3],
      +match[4],
      +match[5],
      +match[6],
    ).getTime();
    const ageDays = (o.now - at) / 864e5;
    const target = path.join(o.trash, name);
    // 이 도구가 만든 격리 묶음(manifest 가 있는 것)만 지운다. --trash 를 잘못 줘도 남의 폴더는 그대로다.
    if (!listFiles(target).some((file) => MANIFEST.test(file))) {
      deps.log(`  건너뜀 ${name}: manifest 없음(이 도구가 격리한 묶음이 아님)`);
      continue;
    }
    if (ageDays < o.graceDays)
      deps.log(
        `  유예 중 ${name} (${ageDays.toFixed(1)}일 / ${o.graceDays}일)`,
      );
    else if (!execute)
      deps.log(
        `  삭제 예정 ${name} (${ageDays.toFixed(1)}일, ${o.has("--measure") ? `${sizeMb(target)}MB` : "크기는 --measure"})`,
      );
    else {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        deps.log(`  삭제함 ${name}`);
      } catch (error) {
        deps.log(
          `  삭제 실패 ${name}: ${error.code ?? error.message} (다음에 다시)`,
        );
      }
    }
  }
}

const USAGE = `사용법 (기본은 목록만, --execute 없이는 아무것도 옮기거나 지우지 않음)
  node tools/dev/residue.cjs plan [--kind ${KINDS.join(",")}] [--out plan.json] [--json] [--verbose]
  node tools/dev/residue.cjs quarantine --plan plan.json --kind <한 종류> [--match <정규식>] [--execute]
  node tools/dev/residue.cjs restore --manifest <격리 폴더>/manifest-<종류>.json [--execute]
  node tools/dev/residue.cjs purge [--older-than-days 7] [--execute]
  Linux: ssh <host> 'node - plan --kind hotfixes,linux-core' < tools/dev/residue.cjs`;

function run(argv, deps = {}) {
  const resolved = {
    log: (line) => console.log(line),
    collectSystem: collectSystemRefs,
    ...deps,
  };
  try {
    if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
      resolved.log(USAGE);
      return 0;
    }
    const o = parseArgs(
      argv,
      deps.env ?? process.env,
      deps.platform ?? process.platform,
    );
    if (o.command === "plan") cmdPlan(o, resolved);
    else if (o.command === "quarantine") cmdQuarantine(o, resolved);
    else if (o.command === "restore") cmdRestore(o, resolved);
    else if (o.command === "purge") cmdPurge(o, resolved);
    else throw new Error(`알 수 없는 명령: ${o.command}`);
    return 0;
  } catch (error) {
    (deps.error ?? ((line) => console.error(line)))(
      `residue: ${error.message}`,
    );
    return 1;
  }
}

module.exports = {
  run,
  parseArgs,
  buildPlan,
  collectWindows,
  collectLinux,
  WINDOWS_COLLECTOR,
  TOKEN_RX,
  newRefs,
  addTokens,
  applyRefs,
  localTime,
};

// `node tools/dev/residue.cjs …` 와 `ssh host node - … < residue.cjs`(모듈 id "[stdin]") 둘 다 실행한다.
if (require.main === module || module.id === "[stdin]")
  process.exitCode = run(process.argv.slice(2));
