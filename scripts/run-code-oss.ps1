[CmdletBinding()]
param(
  [string]$Folder = (Get-Location).Path,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodeArguments
)

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$CodeOssRoot = Join-Path $WorkspaceRoot "vendor\code-oss"
$SourceLauncher = Join-Path $CodeOssRoot "scripts\code.bat"
$SourceOutput = Join-Path $CodeOssRoot "out\main.js"
$RuntimePointer = Join-Path $WorkspaceRoot "vendor\code-oss-runtime.current"

if ((Test-Path -LiteralPath $SourceLauncher) -and (Test-Path -LiteralPath $SourceOutput)) {
  $Launcher = $SourceLauncher
} elseif (Test-Path -LiteralPath $RuntimePointer) {
  $RuntimeRoot = (Get-Content -Raw -LiteralPath $RuntimePointer).Trim()
  $Launcher = Join-Path $RuntimeRoot "bin\codium.cmd"
  if (-not (Test-Path -LiteralPath $Launcher)) {
    throw "The configured portable Code-OSS runtime is missing: $RuntimeRoot"
  }
} else {
  throw "No runnable Code-OSS shell exists. Run npm run code-oss:runtime, or install the Spectre C++ libraries and run npm run code-oss:bootstrap."
}

$ForgeState = Join-Path $WorkspaceRoot ".forge\code-oss"
$UserData = Join-Path $ForgeState "user-data"
$Extensions = Join-Path $ForgeState "extensions"
New-Item -ItemType Directory -Force -Path $UserData, $Extensions | Out-Null

$PreviousForgeNodeOptions = $env:NODE_OPTIONS
try {
  if ($env:NODE_OPTIONS -notmatch "(^|\s)--use-system-ca($|\s)") {
    $env:NODE_OPTIONS = (($env:NODE_OPTIONS, "--use-system-ca") -join " ").Trim()
  }
  & $Launcher --user-data-dir $UserData --extensions-dir $Extensions --disable-telemetry $Folder @CodeArguments
} finally {
  $env:NODE_OPTIONS = $PreviousForgeNodeOptions
}
