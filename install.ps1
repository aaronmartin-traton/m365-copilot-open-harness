#Requires -Version 5.1
<#
.SYNOPSIS
  One-click setup for m365-copilot-open-harness on Windows.

.DESCRIPTION
  Installs the toolchain (Bun, Pi-Bolt), the workspace dependencies, builds the
  library packages, and points Pi-Bolt at the local M365 Copilot proxy.

  Pi-Bolt is the only agent this project drives and keeps its configuration in
  ~/.pi/agent, so setup only writes the `m365-copilot` provider entry into
  models.json and leaves every other provider alone.

.PARAMETER CheckOnly
  Report what is installed and change nothing.

.PARAMETER SkipPiBolt
  Do not install Pi-Bolt. The harness drives Pi-Bolt only, so use this only when
  you manage that install yourself.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipPiBolt
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BunBin = Join-Path $env:USERPROFILE ".bun\bin"

function Write-Step {
  param([Parameter(Mandatory)][string]$Message)

  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
  param([Parameter(Mandatory)][string]$Message)

  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Test-CommandAvailable {
  param([Parameter(Mandatory)][string]$Name)

  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Add-BunToPath {
  if ((Test-Path $BunBin) -and ($env:PATH -notlike "*$BunBin*")) {
    $env:PATH = "$BunBin;$env:PATH"
  }
}

function Get-PiBoltVersion {
  if (-not (Test-CommandAvailable pi-bolt)) { return $null }

  return (& pi-bolt --version 2>&1 | Select-Object -First 1)
}

function Show-Status {
  $piBoltVersion = Get-PiBoltVersion
  $dependencies = Test-Path (Join-Path $RepoRoot "node_modules")
  $harnessBuild = Test-Path (Join-Path $RepoRoot "packages\harness\dist\index.mjs")

  Write-Host "bun:        $(if (Test-CommandAvailable bun) { (& bun --version) } else { 'missing' })"
  Write-Host "pi-bolt:    $(if ($piBoltVersion) { $piBoltVersion } else { 'missing (bun add -g --trust pi-bolt)' })"
  Write-Host "deps:       $(if ($dependencies) { 'installed' } else { 'missing (run bun install)' })"
  Write-Host "harness:    $(if ($harnessBuild) { 'built' } else { 'missing (run bun run build:libs)' })"
}

Set-Location $RepoRoot

Add-BunToPath

if ($CheckOnly) {
  Write-Step "m365-copilot-open-harness status"
  Write-Note "repository: $RepoRoot"
  Show-Status
  exit 0
}

Write-Step "m365-copilot-open-harness setup"
Write-Note "repository: $RepoRoot"

if (-not (Test-CommandAvailable bun)) {
  Write-Step "Installing Bun"

  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression

  Add-BunToPath

  if (-not (Test-CommandAvailable bun)) {
    Write-Host "Bun was installed but is not on PATH yet. Open a new terminal and re-run." -ForegroundColor Red
    exit 1
  }
}

Write-Step "Installing workspace dependencies (bun install)"

& bun install

if ($LASTEXITCODE -ne 0) {
  Write-Host "bun install failed." -ForegroundColor Red
  exit $LASTEXITCODE
}

if (-not $SkipPiBolt) {
  $piBoltVersion = Get-PiBoltVersion

  if ($piBoltVersion) {
    Write-Step "Pi-Bolt is already installed"
    Write-Note $piBoltVersion
  }
  else {
    # --trust is required: Pi-Bolt's postinstall downloads the native release for
    # this platform, and Bun blocks postinstalls by default. Without it the
    # `pi-bolt` shim is left pointing at a package that never fetched a binary.
    Write-Step "Installing Pi-Bolt (bun add -g --trust pi-bolt)"

    & bun add -g --trust pi-bolt

    if ($LASTEXITCODE -ne 0) {
      Write-Note "bun could not install Pi-Bolt. Install it from https://pi-bolt.opensec.in/ and re-run -CheckOnly to confirm."
    }
  }
}

Write-Step "Building library packages and configuring the M365 provider"

& bun run setup

if ($LASTEXITCODE -ne 0) {
  Write-Host "Setup failed." -ForegroundColor Red
  exit $LASTEXITCODE
}

Write-Host ""
Write-Host "Done. Two terminals:" -ForegroundColor Green
Write-Host "  1. bun run proxy    # M365 Copilot proxy on http://127.0.0.1:4141"
Write-Host "  2. bun run web      # console on http://127.0.0.1:4173"
Write-Host ""
Write-Host "Checks: bun run lint, bun run typecheck, bun run test:e2e, bun run doctor"
