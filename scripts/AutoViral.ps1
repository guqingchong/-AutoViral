#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $appDir "AutoViral.exe"

if (-not (Test-Path $electron)) {
    Write-Error "AutoViral.exe not found at $electron. Please reinstall AutoViral."
    exit 1
}

Start-Process -FilePath $electron -ArgumentList "--no-sandbox" -WindowStyle Normal
