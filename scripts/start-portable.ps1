#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $appDir "AutoViral.exe"

if (-not (Test-Path $electron)) {
    Write-Error "AutoViral.exe not found at $electron."
    exit 1
}

$dataDir = Join-Path $appDir "data"
if (-not (Test-Path $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
}

$env:AUTOVIRAL_DATA_DIR = $dataDir

Start-Process -FilePath $electron -ArgumentList "--no-sandbox" -WindowStyle Normal
