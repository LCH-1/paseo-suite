#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Install', 'Update', 'Check', 'EnableAutoUpdate', 'DisableAutoUpdate')]
    [string]$Action = 'Install',
    [switch]$EnableAutoUpdate,
    [switch]$DownloadOnly,
    [switch]$Scheduled
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:Repository = 'LCH-1/paseo-suite'
$script:UpdaterRoot = Join-Path $env:LOCALAPPDATA 'PaseoSuite\updater'
$script:TaskName = 'PaseoSuite-Update-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value

function Invoke-SuiteGh {
    param([string[]]$Arguments)
    $command = Get-Command gh -ErrorAction SilentlyContinue
    $program = if ($command) { $command.Source } else { Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe' }
    if (-not (Test-Path -LiteralPath $program)) {
        throw 'Install GitHub CLI first: winget install --id GitHub.cli -e; then gh auth login'
    }
    $output = & $program @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        # Do not include command output: credential/helper errors can contain secrets.
        throw 'GitHub request failed. Run gh auth login with an account allowed to access LCH-1/paseo-suite.'
    }
    return $output -join "`n"
}

function Get-SuiteRelease {
    $release = Invoke-SuiteGh @('api', "repos/$script:Repository/releases/latest") | ConvertFrom-Json
    if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(\d+\.\d+\.\d+)$') {
        throw 'The latest release is not a supported stable Suite release.'
    }
    $version = $Matches[1]
    $installer = "Paseo-Suite-$version-x64.exe"
    foreach ($name in @($installer, 'SHA256SUMS', 'install.ps1')) {
        if (@($release.assets | Where-Object { $_.name -ceq $name }).Count -ne 1) {
            throw "Incomplete Suite release: $name"
        }
    }
    return [pscustomobject]@{ Version = [version]$version; Tag = $release.tag_name; Installer = $installer }
}

function Get-InstalledSuiteVersion {
    $versions = @()
    foreach ($key in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        foreach ($item in @(Get-ItemProperty -Path $key -ErrorAction SilentlyContinue)) {
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
                    $versions += [version](Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json).suiteVersion
                }
            }
        }
    }
    return $versions | Sort-Object -Descending | Select-Object -First 1
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
    param($Release)
    $directory = Join-Path $script:UpdaterRoot $Release.Tag
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    if ((Test-Path -LiteralPath (Join-Path $directory $Release.Installer)) -and
        (Test-Path -LiteralPath (Join-Path $directory 'install.ps1')) -and
        (Test-Path -LiteralPath (Join-Path $directory 'SHA256SUMS'))) {
        foreach ($name in @($Release.Installer, 'install.ps1')) {
            Assert-SuiteChecksum (Join-Path $directory $name) (Join-Path $directory 'SHA256SUMS')
        }
        return Join-Path $directory $Release.Installer
    }
    # Every download gets its own directory; an interrupted transfer is never installed.
    $temporary = Join-Path $directory ([guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $temporary | Out-Null
    try {
        Invoke-SuiteGh @('release', 'download', $Release.Tag, '--repo', $script:Repository,
            '--pattern', $Release.Installer, '--pattern', 'SHA256SUMS', '--pattern', 'install.ps1', '--dir', $temporary) | Out-Null
        foreach ($name in @($Release.Installer, 'install.ps1')) {
            Assert-SuiteChecksum (Join-Path $temporary $name) (Join-Path $temporary 'SHA256SUMS')
        }
        foreach ($name in @($Release.Installer, 'install.ps1', 'SHA256SUMS')) {
            Move-Item -LiteralPath (Join-Path $temporary $name) -Destination (Join-Path $directory $name) -Force
        }
    } finally {
        # Only files in this invocation's exact, owned directory are removed.
        Get-ChildItem -LiteralPath $temporary -File | Remove-Item -Force
        Remove-Item -LiteralPath $temporary -Force
    }
    return Join-Path $directory $Release.Installer
}

function Test-SuiteRunning {
    # Include background daemons, providers and other users. Never stop them for an update.
    return @(Get-Process -Name Paseo -ErrorAction SilentlyContinue).Count -gt 0
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
        if ($Action -eq 'EnableAutoUpdate') { Set-SuiteAutoUpdate $true; return }
        $release = Get-SuiteRelease
        $installed = Get-InstalledSuiteVersion
        Write-Output "Latest Suite: $($release.Version); installed: $installed"
        if ($Action -eq 'Check') { return }
        if ($Action -eq 'Update' -and -not $installed) {
            Write-Output 'No registered Suite installation found. Use -Action Install first.'
            return
        }
        if ($installed -and $installed -ge $release.Version) {
            if ($EnableAutoUpdate) { Set-SuiteAutoUpdate $true }
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
