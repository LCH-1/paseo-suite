export const windowsInstall = `& {
$ErrorActionPreference = "Stop"
$syncDir = Join-Path $env:LOCALAPPDATA ("paseo-nest/releases/" + [guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($syncDir) | Out-Null
gh release download --repo LCH-1/paseo-nest --pattern settings-sync.zip --pattern SHA256SUMS --dir $syncDir
if ($LASTEXITCODE -ne 0) { throw "릴리즈 다운로드 실패" }
$syncZip = Join-Path $syncDir "settings-sync.zip"
$syncExpected = ((Get-Content -LiteralPath (Join-Path $syncDir "SHA256SUMS") -Raw).Trim() -split '\\s+')[0]
if ((Get-FileHash -LiteralPath $syncZip -Algorithm SHA256).Hash -ne $syncExpected) { throw "다운로드 검증 실패" }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($syncZip, $syncDir)
& (Join-Path $syncDir "settings-sync/install/install.ps1")
}`;

export const ubuntuInstall = `(
set -eu
mkdir -p "$HOME/.local/share/paseo-nest/releases"
sync_dir="$(mktemp -d "$HOME/.local/share/paseo-nest/releases/install-XXXXXXXX")"
gh release download --repo LCH-1/paseo-nest --pattern settings-sync.zip --pattern SHA256SUMS --dir "$sync_dir"
(cd "$sync_dir" && sha256sum -c SHA256SUMS)
unzip -q "$sync_dir/settings-sync.zip" -d "$sync_dir"
bash "$sync_dir/settings-sync/install/install.sh"
)`;
