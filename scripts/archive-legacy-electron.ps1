[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$WorkspaceRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$ReleaseRoot = [System.IO.Path]::GetFullPath((Join-Path $WorkspaceRoot "release"))
$ArchiveRoot = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot "legacy-electron"))
$ReleasePrefix = $ReleaseRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $ArchiveRoot.StartsWith($ReleasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create the legacy archive outside $ReleaseRoot"
}

$LegacyNames = @(
  "Forge-Local-Agent-IDE-Portable-0.1.0-x64.exe",
  "Forge-Local-Agent-IDE-Setup-0.1.0-x64.exe",
  "Forge-Local-Agent-IDE-Setup-0.1.0-x64.exe.blockmap",
  "builder-debug.yml",
  "win-unpacked"
)

$Sources = foreach ($Name in $LegacyNames) {
  $Candidate = [System.IO.Path]::GetFullPath((Join-Path $ReleaseRoot $Name))
  if (-not $Candidate.StartsWith($ReleasePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to move a path outside $ReleaseRoot"
  }
  if (Test-Path -LiteralPath $Candidate) { $Candidate }
}

New-Item -ItemType Directory -Force -Path $ArchiveRoot | Out-Null
foreach ($Source in $Sources) {
  $Destination = Join-Path $ArchiveRoot (Split-Path -Leaf $Source)
  if (Test-Path -LiteralPath $Destination) {
    throw "Archive destination already exists: $Destination"
  }
  Move-Item -LiteralPath $Source -Destination $Destination
  Write-Host "Archived $(Split-Path -Leaf $Source)"
}
