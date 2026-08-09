[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$WorkspaceRoot = Split-Path -Parent $PSScriptRoot
$RuntimePointer = Join-Path $WorkspaceRoot "vendor\code-oss-runtime.current"
if (-not (Test-Path -LiteralPath $RuntimePointer)) {
  throw "No portable Code-OSS runtime is configured. Run npm run code-oss:runtime first."
}
$RuntimeRoot = [System.IO.Path]::GetFullPath((Get-Content -Raw -LiteralPath $RuntimePointer).Trim())
$VendorRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "vendor"))
if (-not $RuntimeRoot.StartsWith($VendorRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to package a runtime outside $VendorRoot"
}
if (-not (Test-Path -LiteralPath (Join-Path $RuntimeRoot "Forge.cmd"))) {
  throw "The configured runtime has not been integrated with Forge."
}

$ReleaseRoot = Join-Path $WorkspaceRoot "release"
$Artifact = Join-Path $ReleaseRoot "Forge-CodeOSS-Portable-0.1.0-x64.zip"
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
if (Test-Path -LiteralPath $Artifact) {
  Remove-Item -LiteralPath $Artifact
}
# The runtime-local data directory is a portable user profile. Never include it
# in a distributable: it can contain settings, history, extension state, and
# browser storage created while testing the workbench.
& tar.exe -a -cf $Artifact --exclude "./data" -C $RuntimeRoot .
if ($LASTEXITCODE -ne 0) { throw "Portable Forge Code-OSS package creation failed." }
$ArtifactHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Artifact).Hash
Write-Host "Created $Artifact"
Write-Host "SHA-256: $ArtifactHash"
