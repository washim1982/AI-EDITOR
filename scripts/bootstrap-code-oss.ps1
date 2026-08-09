[CmdletBinding()]
param(
  [string]$SourcePath,
  [switch]$SkipInstall,
  [switch]$SkipCompile
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourcePath) {
  $SourcePath = Join-Path $WorkspaceRoot "vendor\code-oss"
}
$SourcePath = [System.IO.Path]::GetFullPath($SourcePath)
$VendorRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "vendor"))

if (-not $SourcePath.StartsWith($VendorRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Code-OSS source must remain beneath $VendorRoot"
}

& npm.cmd run build:forge-extension
if ($LASTEXITCODE -ne 0) { throw "Forge extension build failed." }

if (-not (Test-Path -LiteralPath (Join-Path $SourcePath "package.json"))) {
  New-Item -ItemType Directory -Force -Path $VendorRoot | Out-Null
  Write-Host "Cloning the official Code-OSS source..."
  & git clone --depth 1 https://github.com/microsoft/vscode.git $SourcePath
  if ($LASTEXITCODE -ne 0) { throw "Code-OSS clone failed." }
}

& node (Join-Path $PSScriptRoot "integrate-code-oss.mjs") $SourcePath
if ($LASTEXITCODE -ne 0) { throw "Code-OSS integration failed." }

Push-Location $SourcePath
$PreviousForgeNodeOptions = $env:NODE_OPTIONS
try {
  if ($env:NODE_OPTIONS -notmatch "(^|\s)--use-system-ca($|\s)") {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, "--use-system-ca") -join " ").Trim()
  }
  if (-not $SkipInstall) {
    Write-Host "Installing Code-OSS dependencies..."
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw "Code-OSS dependency installation failed." }
  }
  if (-not $SkipCompile) {
    Write-Host "Compiling the Forge Code-OSS workbench..."
    & npm.cmd run compile
    if ($LASTEXITCODE -ne 0) { throw "Code-OSS compilation failed." }
  }
} finally {
  $env:NODE_OPTIONS = $PreviousForgeNodeOptions
  Pop-Location
}

Write-Host "Forge Code-OSS is ready. Run: npm run code-oss:run"
