$ErrorActionPreference = "Stop"
$syncPackage = Split-Path -Parent $PSScriptRoot
$syncHome = if ($env:PASEO_HOME) { $env:PASEO_HOME } else { Join-Path ([Environment]::GetFolderPath("UserProfile")) ".paseo" }
if ($syncHome -eq "~") { $syncHome = [Environment]::GetFolderPath("UserProfile") }
elseif ($syncHome.StartsWith("~/") -or $syncHome.StartsWith("~\")) { $syncHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) $syncHome.Substring(2) }
$syncHome = [IO.Path]::GetFullPath($syncHome)

function Invoke-SyncCli {
    param([string[]]$Arguments)
    $syncEncoding = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        $syncOutput = & paseo @Arguments
        $syncExit = $LASTEXITCODE
    } finally { [Console]::OutputEncoding = $syncEncoding }
    if ($syncExit -ne 0) { throw "Paseo 명령 실패: $($Arguments[0]) $($Arguments[1])" }
    return ($syncOutput -join "`n")
}
function Get-SyncPlugins {
    $syncRaw = Invoke-SyncCli -Arguments @("plugin", "ls", "--json", "--home", $syncHome)
    if (-not $syncRaw.TrimStart().StartsWith("[")) { throw "플러그인 목록을 읽지 못했습니다. 로컬 호스트와 Paseo CLI를 확인하세요." }
    $syncParsed = $syncRaw | ConvertFrom-Json
    foreach ($syncItem in $syncParsed) { $syncItem }
}
function Get-SyncVersion {
    param([string]$Directory)
    $syncValue = (Get-Content -LiteralPath (Join-Path $Directory "package.json") -Raw | ConvertFrom-Json).version
    if ($syncValue -isnot [string] -or $syncValue -notmatch '^\d+\.\d+\.\d+$') { throw "설치 버전을 확인할 수 없어 변경하지 않았습니다." }
    return [version]$syncValue
}
function Assert-SyncInstalled {
    param([string]$Directory, [bool]$Enabled, [bool]$GlobalEnabled)
    $syncItem = @(Get-SyncPlugins | Where-Object { $_.id -eq "settings-sync" })
    if ($syncItem.Count -ne 1 -or [IO.Path]::GetFullPath($syncItem[0].path) -ne [IO.Path]::GetFullPath($Directory)) { throw "설치 경로가 변경되었습니다." }
    if ($syncItem[0].enabled -ne $Enabled -or ($Enabled -and $GlobalEnabled -and $syncItem[0].status -ne "running")) { throw "Settings Sync 실행 상태를 확인하지 못했습니다." }
}

if ((Get-Content -LiteralPath (Join-Path $syncPackage "paseo-plugin.json") -Raw | ConvertFrom-Json).id -ne "settings-sync") { throw "잘못된 플러그인입니다." }
$syncDesired = Get-SyncVersion -Directory $syncPackage
$syncPrevious = @(Get-SyncPlugins | Where-Object { $_.id -eq "settings-sync" })
if ($syncPrevious.Count -gt 1) { throw "중복된 Settings Sync 항목입니다." }
$syncOld = if ($syncPrevious.Count) { $syncPrevious[0] } else { $null }
$syncRollback = $null
if ($syncOld) {
    $syncOldVersion = Get-SyncVersion -Directory $syncOld.path
    if ($syncOldVersion -gt $syncDesired) { throw "설치된 버전이 릴리즈보다 새롭습니다. 이전 버전으로 내리지 않았습니다." }
    $syncRollback = [IO.Path]::GetFullPath($syncOld.path)
    $syncManaged = (Join-Path $syncHome "plugins/settings-sync").TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar
    if ($syncRollback -eq $syncManaged.TrimEnd("\", "/") -or $syncRollback.StartsWith($syncManaged, [StringComparison]::OrdinalIgnoreCase) -or $syncOld.installation.identity.kind -in @("git", "npm")) {
        if ([IO.Path]::GetFullPath($syncPackage) -eq $syncRollback -or [IO.Path]::GetFullPath($syncPackage).StartsWith($syncRollback.TrimEnd("\", "/") + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "백업 폴더와 기존 설치가 겹칩니다." }
        $syncBackup = Join-Path $syncPackage "previous-installation"
        if (Test-Path -LiteralPath $syncBackup) { throw "기존 백업을 보존했습니다. 새 릴리즈 폴더에서 다시 실행하세요." }
        Copy-Item -LiteralPath $syncRollback -Destination $syncBackup -Recurse -Force
        $syncRollback = $syncBackup
    }
}
$syncGlobal = (Invoke-SyncCli -Arguments @("daemon", "config", "get", "pluginsEnabled", "--home", $syncHome) | ConvertFrom-Json).value -eq $true
$syncWasEnabled = if ($syncOld) { [bool]$syncOld.enabled } else { $false }
$syncTouched = $false
$syncEnabledGlobal = $false
try {
    # A directory install cannot replace an existing ID. Removing its registration
    # retains ~/.paseo/settings-sync and plugin-settings; managed code is backed up above.
    if ($syncOld) {
        $syncLatest = @(Get-SyncPlugins | Where-Object { $_.id -eq "settings-sync" })
        if ($syncLatest.Count -ne 1 -or [IO.Path]::GetFullPath($syncLatest[0].path) -ne [IO.Path]::GetFullPath($syncOld.path) -or $syncLatest[0].enabled -ne $syncOld.enabled -or (Get-SyncVersion -Directory $syncLatest[0].path) -ne $syncOldVersion) { throw "준비 중 기존 설치가 변경되어 보존했습니다." }
        $syncTouched = $true
        Invoke-SyncCli -Arguments @("plugin", "remove", "settings-sync", "--home", $syncHome) | Out-Null
    }
    if (-not $syncGlobal) {
        $syncTouched = $true
        $syncEnabledGlobal = $true
        Invoke-SyncCli -Arguments @("daemon", "config", "set", "pluginsEnabled", "true", "--home", $syncHome) | Out-Null
    }
    $syncTouched = $true
    Invoke-SyncCli -Arguments @("plugin", "install", $syncPackage, "--home", $syncHome) | Out-Null
    Assert-SyncInstalled -Directory $syncPackage -Enabled $true -GlobalEnabled $true
} catch {
    $syncFailure = $_
    if ($syncTouched) {
        try {
            $syncCurrent = @(Get-SyncPlugins | Where-Object { $_.id -eq "settings-sync" })
            $syncAlreadyRestored = $syncCurrent.Count -eq 1 -and $syncOld -and [IO.Path]::GetFullPath($syncCurrent[0].path) -eq [IO.Path]::GetFullPath($syncOld.path) -and $syncCurrent[0].enabled -eq $syncOld.enabled
            if ($syncCurrent.Count -and -not $syncAlreadyRestored -and [IO.Path]::GetFullPath($syncCurrent[0].path) -ne [IO.Path]::GetFullPath($syncPackage)) { throw "다른 작업이 바꾼 설치를 보존했습니다." }
            if ($syncCurrent.Count -and -not $syncAlreadyRestored) { Invoke-SyncCli -Arguments @("plugin", "remove", "settings-sync", "--home", $syncHome) | Out-Null }
            if ($syncEnabledGlobal) { Invoke-SyncCli -Arguments @("daemon", "config", "set", "pluginsEnabled", "false", "--home", $syncHome) | Out-Null }
            if ($syncRollback -and -not $syncAlreadyRestored) {
                Invoke-SyncCli -Arguments @("plugin", "install", $syncRollback, "--home", $syncHome) | Out-Null
                if (-not $syncWasEnabled) { Invoke-SyncCli -Arguments @("plugin", "disable", "settings-sync", "--home", $syncHome) | Out-Null }
                Assert-SyncInstalled -Directory $syncRollback -Enabled $syncWasEnabled -GlobalEnabled $syncGlobal
            } elseif ($syncAlreadyRestored -and $syncWasEnabled -and $syncGlobal -and $syncCurrent[0].status -ne "running") {
                Invoke-SyncCli -Arguments @("plugin", "reload", "settings-sync", "--home", $syncHome) | Out-Null
                Assert-SyncInstalled -Directory $syncOld.path -Enabled $syncWasEnabled -GlobalEnabled $syncGlobal
            }
        } catch { throw "설치와 이전 코드 복구를 완료하지 못했습니다. 보존한 이전 코드: $syncRollback. $($_.Exception.Message)" }
    }
    throw $syncFailure
}
Write-Output "Settings Sync $syncDesired 설치·활성화 완료."
Write-Output (Invoke-SyncCli -Arguments @("plugin", "ls", "settings-sync", "--home", $syncHome))
