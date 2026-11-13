#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Update', 'Check', 'EnableAutoUpdate', 'DisableAutoUpdate', 'Rollback')]
    [string]$Action = 'Install',
    [switch]$EnableAutoUpdate,
    [switch]$DownloadOnly,
    [switch]$Scheduled,
    # Rollback only: an older published release, for example 1.0.9.
    [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Repository = 'LCH-1/paseo-suite'
$script:UpdaterRoot = Join-Path $env:LOCALAPPDATA 'PaseoSuite\updater'
# NSIS /currentuser installs here unless an earlier per-user install chose another folder.
$script:UserInstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\Paseo'
$script:TaskName = 'PaseoSuite-Update-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Invoke-SuiteRequest {
    param([string]$Asset, [string]$Tag = 'latest', [string]$OutFile)
    if ($Asset -notmatch '^[\w.-]+$' -or ($Tag -ne 'latest' -and $Tag -notmatch '^v\d+\.\d+\.\d+$')) {
        throw 'Invalid Suite release path.'
    }
    $base = "https://github.com/$script:Repository/releases"
    $url = if ($Tag -eq 'latest') { "$base/latest/download/$Asset" } else { "$base/download/$Tag/$Asset" }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    try {
        if ($OutFile) {
            Invoke-WebRequest -Uri $url -UseBasicParsing -OutFile $OutFile -TimeoutSec 300 -MaximumRedirection 5
        } else {
            Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 60 -MaximumRedirection 5
        }
    } catch {
        throw "Cannot download public Suite release asset: $Asset. Check your internet connection and retry."
    }
}

function Get-SuiteRelease {
    param([string]$Tag = 'latest')
    # Public release assets avoid credentials and the anonymous GitHub REST API quota.
    $lock = Invoke-SuiteRequest -Asset 'suite-lock.json' -Tag $Tag
    if ($lock.schemaVersion -ne 1 -or $lock.suiteVersion -notmatch '^(\d+\.\d+\.\d+)$') {
        throw 'The latest release metadata is not a supported stable Suite release.'
    }
    $version = $Matches[1]
    if ($Tag -ne 'latest' -and "v$version" -ne $Tag) { throw "Release $Tag does not describe Suite $Tag." }
    $installer = "Paseo-Suite-$version-x64.exe"
    return [pscustomobject]@{ Version = [version]$version; Tag = "v$version"; Installer = $installer }
}

function Get-SuiteRegistrations {
    # Scope Machine is an all-users (HKLM) install; this helper installs per user only.
    $registrations = @()
    foreach ($hive in @(
        @{ Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope = 'User' },
        @{ Key = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope = 'Machine' },
        @{ Key = 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'; Scope = 'Machine' }
    )) {
        foreach ($item in @(Get-ItemProperty -Path $hive.Key -ErrorAction SilentlyContinue)) {
            if ($item.PSObject.Properties['DisplayName'] -and $item.DisplayName -match '^Paseo(?: \d+\.\d+\.\d+)?$') {
                $location = $null
                if ($item.PSObject.Properties['InstallLocation'] -and $item.InstallLocation) {
                    $location = $item.InstallLocation
                } elseif ($item.PSObject.Properties['DisplayIcon'] -and $item.DisplayIcon -match '^"?(.+\.(?:exe|ico))"?(?:,-?\d+)?$') {
                    $location = [IO.Path]::GetDirectoryName($Matches[1])
                }
                if (-not $location) { continue }
                $lock = Join-Path $location 'resources\suite\suite-lock.json'
                if (Test-Path -LiteralPath $lock) {
                    $registrations += [pscustomobject]@{
                        Version = [version](Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).suiteVersion
                        Scope = $hive.Scope
                        Location = $location
                    }
                }
            }
        }
    }
    return $registrations
}

function Get-InstalledSuiteVersion {
    return Get-SuiteRegistrations | ForEach-Object { $_.Version } | Sort-Object -Descending | Select-Object -First 1
}

function Assert-SuiteUserScope {
    # NSIS /currentuser never touches an all-users install. The per-user copy lands next to it in
    # %LOCALAPPDATA%\Programs\Paseo, a folder that may already hold other installs and that a later
    # per-user update or uninstall empties, while the all-users one stays registered.
    param([string]$Operation, [string]$Advice)
    $machine = @(Get-SuiteRegistrations | Where-Object { $_.Scope -eq 'Machine' })
    if ($machine.Count -gt 0) {
        throw ("$Operation supports per-user installs only. Suite $($machine[0].Version) is installed for all users at $($machine[0].Location); " +
            "nothing was downloaded or changed. $Advice")
    }
    # Without a registration that still names them, versioned installs below that folder are found
    # only here. NSIS never puts Paseo.exe in a subfolder of its own install.
    $nested = @(Get-ChildItem -LiteralPath $script:UserInstallRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'Paseo.exe') -PathType Leaf } |
        ForEach-Object { $_.Name })
    if ($nested.Count -gt 0) {
        $named = ($nested | Select-Object -First 3) -join ', '
        if ($nested.Count -gt 3) { $named += " and $($nested.Count - 3) more" }
        throw ("$Operation would install into $script:UserInstallRoot, which holds other Paseo installs ($named); " +
            'a later per-user update or uninstall would delete them. Nothing was downloaded or changed. ' +
            'Keep using the tool that installed them, or move them out of that folder first.')
    }
}

function Assert-SuiteChecksum {
    param([string]$File, [string]$Checksums)
    $name = [IO.Path]::GetFileName($File)
    $lines = @(Get-Content -LiteralPath $Checksums | Where-Object { $_ -match ('^[a-fA-F0-9]{64}  ' + [regex]::Escape($name) + '$') })
    if ($lines.Count -ne 1) { throw "Missing or duplicate SHA256: $name" }
    $expected = $lines[0].Substring(0, 64)
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
    if ($actual -ine $expected) {
        throw "SHA256 verification failed: $name"
    }
}

function Save-SuiteRelease {
    # -InstallerOnly skips the helper: releases before 1.0.8 have none, and a
    # rollback must never replace the current helper with an older one.
    param($Release, [switch]$InstallerOnly)
    $verified = @($Release.Installer)
    if (-not $InstallerOnly) { $verified += 'install.ps1' }
    $directory = Join-Path $script:UpdaterRoot $Release.Tag
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if (@($verified + 'SHA256SUMS' | Where-Object { -not (Test-Path -LiteralPath (Join-Path $directory $_)) }).Count -eq 0) {
        foreach ($name in $verified) {
            Assert-SuiteChecksum (Join-Path $directory $name) (Join-Path $directory 'SHA256SUMS')
        }
        return Join-Path $directory $Release.Installer
    }
    # Every download gets its own directory; an interrupted transfer is never installed.
    $temporary = Join-Path $directory ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        foreach ($name in @($Release.Installer, 'SHA256SUMS') + @($verified | Select-Object -Skip 1)) {
            Invoke-SuiteRequest -Asset $name -Tag $Release.Tag -OutFile (Join-Path $temporary $name) | Out-Null
        }
        foreach ($name in $verified) {
            Assert-SuiteChecksum (Join-Path $temporary $name) (Join-Path $temporary 'SHA256SUMS')
        }
        foreach ($name in $verified + 'SHA256SUMS') {
            Move-Item -LiteralPath (Join-Path $temporary $name) -Destination (Join-Path $directory $name) -Force
        }
    } finally {
        # Only files in this invocation's exact, owned directory are removed.
        Get-ChildItem -LiteralPath $temporary -File | Remove-Item -Force
        Remove-Item -LiteralPath $temporary -Force
    }
    return Join-Path $directory $Release.Installer
}

function Remove-SuiteEmptyFolder {
    param([string]$Path)
    # Remove-Item would prompt for a folder that still has unknown children.
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) { Remove-Item -LiteralPath $Path -Force }
}

function Remove-SuiteDownloads {
    param([string]$KeepTag)
    # Runs under update.lock. Only v<x.y.z> folders and the files this helper
    # downloads are removed; links and unknown files stay. updater\install.ps1,
    # status.json and update.lock live outside these folders. Never fails an update.
    try {
        $cutoff = (Get-Date).AddDays(-1)
        $owned = @(Get-ChildItem -LiteralPath $script:UpdaterRoot -Directory -ErrorAction Stop | Where-Object {
            $_.Name -match '^v\d+\.\d+\.\d+$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)
        })
        foreach ($folder in $owned) {
            # An interrupted download leaves its GUID folder; a day-old one has no owner.
            foreach ($temporary in @(Get-ChildItem -LiteralPath $folder.FullName -Directory | Where-Object {
                $_.Name -match '^[0-9a-f]{32}$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and $_.LastWriteTime -lt $cutoff
            })) {
                Get-ChildItem -LiteralPath $temporary.FullName -File -Force | Remove-Item -Force
                Remove-SuiteEmptyFolder $temporary.FullName
            }
            if ($folder.Name -eq $KeepTag) { continue }
            $version = $folder.Name.Substring(1)
            foreach ($name in @("Paseo-Suite-$version-x64.exe", 'install.ps1', 'SHA256SUMS')) {
                $file = Join-Path $folder.FullName $name
                if (Test-Path -LiteralPath $file -PathType Leaf) { Remove-Item -LiteralPath $file -Force }
            }
            Remove-SuiteEmptyFolder $folder.FullName
        }
    } catch {
        Write-Output "Suite download cleanup skipped; it is retried on the next run: $($_.Exception.Message)"
    }
}

function Test-SuiteRunning {
    # Include background daemons, providers and other users. Never stop them for an update.
    return @(Get-Process -Name Paseo -ErrorAction SilentlyContinue).Count -gt 0
}

function Save-SuiteHelper {
    $target = Join-Path $script:UpdaterRoot 'install.ps1'
    if ([IO.Path]::GetFullPath($PSCommandPath) -ine [IO.Path]::GetFullPath($target)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force
    }
}

function Set-SuiteAutoUpdate {
    param([bool]$Enabled)
    if (-not $Enabled) {
        Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue |
            Unregister-ScheduledTask -Confirm:$false
        Write-Output 'Automatic updates disabled.'
        return
    }
    $target = Join-Path $script:UpdaterRoot 'install.ps1'
    if (-not (Test-Path -LiteralPath $target)) {
        Copy-Item -LiteralPath $PSCommandPath -Destination $target -Force
    }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $target + '" -Action Update -Scheduled'
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $triggers = @(
        (New-ScheduledTaskTrigger -AtLogOn -User $user),
        (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30))
    )
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
    Register-ScheduledTask -TaskName $script:TaskName -Action $taskAction -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
    Write-Output 'Automatic updates enabled for this Windows user (every 30 minutes and at login). Running Paseo processes defer installation.'
}

function Invoke-SuiteInstaller {
    param([string]$Installer)
    # Recheck immediately before NSIS; its customCheckAppRunning guards the startup race too.
    if (Test-SuiteRunning) { return 'pending' }
    $process = Start-Process -FilePath $Installer -ArgumentList '/S /currentuser' -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -eq 2) { return 'pending' }
    if ($process.ExitCode -ne 0) { throw "Suite installer failed: exit $($process.ExitCode)" }
    return 'installed'
}

function Invoke-SuiteRollback {
    # The public GitHub release tag is the rollback source; no local installer copy is kept.
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Rollback needs -Version <major.minor.patch> of a published Suite release.' }
    if ($EnableAutoUpdate) { throw 'Rollback cannot enable automatic updates; they would reinstall the latest release.' }
    # Before the task check: disabling updates would not make an all-users rollback possible.
    Assert-SuiteUserScope 'Rollback' ("Download Paseo-Suite-$Version-x64.exe from https://github.com/$script:Repository/releases/tag/v$Version " +
        'and run it yourself; an all-users install asks for administrator approval.')
    # The scheduled update would reinstall the latest release within 30 minutes.
    if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) {
        throw 'Automatic updates are enabled and would undo the rollback. Run -Action DisableAutoUpdate first.'
    }
    $installed = Get-InstalledSuiteVersion
    if (-not $installed) {
        Write-Output 'No registered Suite installation found. Use -Action Install first.'
        return
    }
    try { $release = Get-SuiteRelease -Tag "v$Version" }
    catch {
        # Some versions were never published (1.0.6 and 1.0.7 have no public tag).
        throw ("Cannot use Suite v$Version for a rollback: $($_.Exception.Message) " +
            "Only versions listed at https://github.com/$script:Repository/releases can be restored.")
    }
    Write-Output "Rollback Suite: $($release.Version); installed: $installed"
    if ($release.Version -ge $installed) {
        Write-Output 'Rollback installs an older release only. Use -Action Update for the latest release.'
        return
    }
    $installer = Save-SuiteRelease $release -InstallerOnly
    $status = if ($DownloadOnly) { 'downloaded' } else { Invoke-SuiteInstaller $installer }
    if ($status -eq 'installed') {
        $actual = Get-InstalledSuiteVersion
        if (-not $actual -or $actual -ne $release.Version) { throw 'Installer completed, but the registered Suite version does not match.' }
        Remove-SuiteDownloads
    } else {
        Remove-SuiteDownloads -KeepTag $release.Tag
    }
    $result = [ordered]@{ version = "$($release.Version)"; status = $status; action = 'rollback'; installer = $installer; checkedAt = [DateTime]::UtcNow.ToString('o') }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:UpdaterRoot 'status.json') -Encoding UTF8
    Write-Output "Suite rollback $status. Installer: $installer"
    if ($status -eq 'installed') { Write-Output 'Start Paseo to switch to the plugins bundled with this release. Automatic updates stay off until you enable them again.' }
    if ($status -eq 'pending') { Write-Output 'Finish your work, exit both Paseo and its local host, then run this rollback again; nothing was stopped.' }
}

function Invoke-SuiteSetup {
    if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'This installer requires Windows x64.'
    }
    New-Item -ItemType Directory -Path $script:UpdaterRoot -Force | Out-Null
    try {
        $lock = [IO.File]::Open((Join-Path $script:UpdaterRoot 'update.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    } catch [IO.IOException] {
        Write-Output 'Another Suite installer/updater is already running.'
        return
    }
    try {
        if ($Action -eq 'DisableAutoUpdate') { Set-SuiteAutoUpdate $false; return }
        # Scheduled updates run -Action Update, so they are refused there as well.
        if ($Action -in @('Install', 'Update', 'EnableAutoUpdate')) {
            Assert-SuiteUserScope $Action ("To update it, run Paseo-Suite-<version>-x64.exe from https://github.com/$script:Repository/releases " +
                'yourself (an all-users install asks for administrator approval), or uninstall it before using this helper.')
        }
        if ($Action -eq 'EnableAutoUpdate') { Save-SuiteHelper; Set-SuiteAutoUpdate $true; return }
        if ($Action -eq 'Rollback') { Invoke-SuiteRollback; return }
        $release = Get-SuiteRelease
        $installed = Get-InstalledSuiteVersion
        Write-Output "Latest Suite: $($release.Version); installed: $installed"
        if ($Action -eq 'Check') { return }
        if ($Action -eq 'Update' -and -not $installed) {
            Write-Output 'No registered Suite installation found. Use -Action Install first.'
            return
        }
        if ($installed -and $installed -ge $release.Version) {
            # Direct exe installs may have no command helper, or an old authenticated one.
            if ($installed -eq $release.Version) { Save-SuiteHelper }
            if ($EnableAutoUpdate) { Set-SuiteAutoUpdate $true }
            # Also clears installers that earlier helper versions left behind.
            Remove-SuiteDownloads
            Write-Output 'Suite is already up to date; downgrades are blocked.'
            return
        }
        $installer = Save-SuiteRelease $release
        # Use the verified release helper for future scheduled checks, never a token or dev path.
        Copy-Item -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($installer)) 'install.ps1') -Destination (Join-Path $script:UpdaterRoot 'install.ps1') -Force
        $status = if ($DownloadOnly) { 'downloaded' } else { Invoke-SuiteInstaller $installer }
        if ($status -eq 'installed') {
            $actual = Get-InstalledSuiteVersion
            if (-not $actual -or $actual -ne $release.Version) { throw 'Installer completed, but the registered Suite version does not match.' }
            # Any release can be downloaded again from its public tag; keep no copy.
            Remove-SuiteDownloads
        } else {
            # A pending or downloaded installer is reused; only older tags go.
            Remove-SuiteDownloads -KeepTag $release.Tag
        }
        if ($EnableAutoUpdate) { Set-SuiteAutoUpdate $true }
        $result = [ordered]@{ version = "$($release.Version)"; status = $status; installer = $installer; checkedAt = [DateTime]::UtcNow.ToString('o') }
        $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:UpdaterRoot 'status.json') -Encoding UTF8
        Write-Output "Suite $status. Installer: $installer"
        if ($status -eq 'pending') { Write-Output 'Finish your work and exit both Paseo and its local host. Automatic updates will retry later; nothing was stopped.' }
    } finally { $lock.Dispose() }
}

# Dot-sourcing exposes the functions for offline tests without installing anything.
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-SuiteSetup } catch {
        if ($Scheduled) {
            New-Item -ItemType Directory -Path $script:UpdaterRoot -Force | Out-Null
            @{ status = 'error'; checkedAt = [DateTime]::UtcNow.ToString('o'); message = $_.Exception.Message } |
                ConvertTo-Json | Set-Content -LiteralPath (Join-Path $script:UpdaterRoot 'status.json') -Encoding UTF8
        }
        Write-Error $_.Exception.Message
        exit 1
    }
}
