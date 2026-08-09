[CmdletBinding()]
param(
  [string]$Version = "1.126.04524"
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$VendorRoot = Join-Path $WorkspaceRoot "vendor"
$RuntimeRoot = Join-Path $VendorRoot "code-oss-runtime-$Version"
$RuntimeExecutable = Join-Path $RuntimeRoot "VSCodium.exe"
$DownloadRoot = Join-Path $VendorRoot "downloads"
$Archive = Join-Path $DownloadRoot "VSCodium-win32-x64-$Version.zip"
$ChecksumFile = "$Archive.sha256"
$DownloadUrl = "https://github.com/VSCodium/vscodium/releases/download/$Version/VSCodium-win32-x64-$Version.zip"
$ChecksumUrl = "$DownloadUrl.sha256"

& npm.cmd run build:forge-extension
if ($LASTEXITCODE -ne 0) { throw "Forge extension build failed." }

if (-not (Test-Path -LiteralPath $RuntimeExecutable)) {
  if (Test-Path -LiteralPath $RuntimeRoot) {
    throw "An incomplete portable runtime already exists at $RuntimeRoot. Move it aside before retrying."
  }
  New-Item -ItemType Directory -Force -Path $DownloadRoot | Out-Null
  if (-not (Test-Path -LiteralPath $Archive)) {
    Write-Host "Downloading the official VSCodium Code-OSS runtime $Version..."
    & curl.exe --fail --location --output $Archive $DownloadUrl
    if ($LASTEXITCODE -ne 0) { throw "Portable Code-OSS runtime download failed." }
  }
  if (-not (Test-Path -LiteralPath $ChecksumFile)) {
    & curl.exe --fail --location --output $ChecksumFile $ChecksumUrl
    if ($LASTEXITCODE -ne 0) { throw "Portable Code-OSS checksum download failed." }
  }
  $ExpectedHash = ((Get-Content -Raw -LiteralPath $ChecksumFile).Trim() -split "\s+")[0].ToUpperInvariant()
  $ActualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash.ToUpperInvariant()
  if ($ExpectedHash -ne $ActualHash) {
    throw "Portable Code-OSS archive checksum mismatch. Expected $ExpectedHash but received $ActualHash."
  }
  Write-Host "Archive SHA-256 verified: $ActualHash"
  Write-Host "Extracting the portable Code-OSS runtime..."
  Expand-Archive -LiteralPath $Archive -DestinationPath $RuntimeRoot
}

& node (Join-Path $PSScriptRoot "integrate-code-oss-runtime.mjs") $RuntimeRoot
if ($LASTEXITCODE -ne 0) { throw "Portable Code-OSS integration failed." }

$RuntimeSignature = Get-AuthenticodeSignature -LiteralPath $RuntimeExecutable
Write-Host "Runtime signature status: $($RuntimeSignature.Status)"
Set-Content -LiteralPath (Join-Path $VendorRoot "code-oss-runtime.current") -Value $RuntimeRoot -Encoding utf8

$ForgeState = Join-Path $WorkspaceRoot ".forge\code-oss"
$UserData = Join-Path $ForgeState "user-data"
$Extensions = Join-Path $ForgeState "extensions"
New-Item -ItemType Directory -Force -Path $UserData, $Extensions | Out-Null
$RuntimeCli = Join-Path $RuntimeRoot "bin\codium.cmd"
& $RuntimeCli --user-data-dir $UserData --extensions-dir $Extensions --version
if ($LASTEXITCODE -ne 0) { throw "Portable Code-OSS runtime verification failed." }

Write-Host "Forge portable Code-OSS runtime is ready. Run: npm run code-oss:run"
