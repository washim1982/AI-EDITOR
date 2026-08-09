[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$RuntimePointer = Join-Path $WorkspaceRoot "vendor\code-oss-runtime.current"
if (-not (Test-Path -LiteralPath $RuntimePointer)) {
  throw "No Code-OSS runtime is configured. Run npm run code-oss:runtime first."
}

$RuntimeRoot = [System.IO.Path]::GetFullPath((Get-Content -Raw -LiteralPath $RuntimePointer).Trim())
$VendorRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "vendor"))
if (-not $RuntimeRoot.StartsWith($VendorRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package a runtime outside $VendorRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "Forge.Installed.cmd"))) {
  throw "The configured Code-OSS runtime has not been integrated with Forge."
}

$NsisCache = Join-Path $env:LOCALAPPDATA "electron-builder\Cache\nsis"
$NsisCompiler = Get-ChildItem -LiteralPath $NsisCache -Recurse -Filter "makensis.exe" -File |
  Where-Object { $_.Length -gt 100000 } |
  Sort-Object FullName |
  Select-Object -First 1
if (-not $NsisCompiler) {
  throw "NSIS compiler was not found in the electron-builder cache. Run npm run dist:win once to download it."
}

$ReleaseRoot = Join-Path $WorkspaceRoot "release"
$Artifact = Join-Path $ReleaseRoot "Forge-CodeOSS-Setup-0.1.0-x64.exe"
$InstallerScript = Join-Path $PSScriptRoot "forge-code-oss-installer.nsi"
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
$ReleaseRoot = [System.IO.Path]::GetFullPath($ReleaseRoot)
$ReleasePrefix = $ReleaseRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$StagingRoot = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot ".installer-staging-$PID"))
if (-not $StagingRoot.StartsWith($ReleasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create installer staging outside $ReleaseRoot"
}
if (Test-Path -LiteralPath $StagingRoot) {
  throw "Installer staging already exists: $StagingRoot"
}

try {
  New-Item -ItemType Directory -Path $StagingRoot | Out-Null
  Get-ChildItem -LiteralPath $RuntimeRoot -Force |
    Where-Object { $_.Name -ne "data" } |
    Copy-Item -Destination $StagingRoot -Recurse -Force

  if (Test-Path -LiteralPath $Artifact) {
    Remove-Item -LiteralPath $Artifact
  }
  & $NsisCompiler.FullName "/WX" "/DForgeRuntime=$StagingRoot" "/DForgeOutput=$Artifact" $InstallerScript
  if ($LASTEXITCODE -ne 0) { throw "Forge Code-OSS NSIS installer build failed." }
} finally {
  if (Test-Path -LiteralPath $StagingRoot) {
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force
  }
}

$ArtifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash
Write-Host "Created $Artifact"
Write-Host "SHA-256: $ArtifactHash"
