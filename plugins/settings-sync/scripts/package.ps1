$ErrorActionPreference = "Stop"
$syncRoot = Split-Path -Parent $PSScriptRoot
$syncManifest = Get-Content -LiteralPath (Join-Path $syncRoot "package.json") -Raw | ConvertFrom-Json
$syncOutput = Join-Path $syncRoot ".check/release-$($syncManifest.version)-$([guid]::NewGuid().ToString('N'))"
$syncStage = Join-Path $syncOutput "settings-sync"
New-Item -ItemType Directory -Path $syncStage -Force | Out-Null
foreach ($syncFile in @($syncManifest.files) + @("package.json")) {
    Copy-Item -LiteralPath (Join-Path $syncRoot $syncFile) -Destination (Join-Path $syncStage $syncFile) -Recurse
}
$syncZip = Join-Path $syncOutput "settings-sync.zip"
Compress-Archive -LiteralPath $syncStage -DestinationPath $syncZip -CompressionLevel Optimal
$syncHash = (Get-FileHash -LiteralPath $syncZip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $syncOutput "SHA256SUMS"), "$syncHash  settings-sync.zip`n", [Text.UTF8Encoding]::new($false))
Write-Output $syncOutput
