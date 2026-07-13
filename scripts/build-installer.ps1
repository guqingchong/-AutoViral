#Requires -Version 5.1
<#
.SYNOPSIS
    Build the AutoViral Windows installer and portable executable.
#>
param(
    [switch]$SkipFfmpeg,
    [switch]$SkipBuild,
    [string]$OutputDir = "release"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 1. Clean previous release
if (Test-Path $OutputDir) {
    Remove-Item -Recurse -Force $OutputDir
}

# 2. Install dependencies
if (-not $SkipBuild) {
    Write-Host "Installing dependencies..."
    npm ci
}

# 3. Build backend and frontend
if (-not $SkipBuild) {
    Write-Host "Building backend..."
    npm run build:backend
    Write-Host "Building frontend..."
    npm run build:frontend
}

# 4. Download FFmpeg
if (-not $SkipFfmpeg) {
    Write-Host "Downloading FFmpeg..."
    & powershell -ExecutionPolicy Bypass -File scripts/download-ffmpeg.ps1
}

# 5. Build Electron package
Write-Host "Building installer with electron-builder..."
& npx electron-builder --win --x64

# 6. Report outputs
$artifacts = Get-ChildItem -Path $OutputDir -Include "*.exe","*.zip" -Recurse
Write-Host "Build complete. Artifacts:"
$artifacts | ForEach-Object { Write-Host "  $_" }
