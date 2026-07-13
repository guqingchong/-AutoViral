#Requires -Version 5.1
<#
.SYNOPSIS
    Download and unpack a Windows FFmpeg essentials build into bin/ffmpeg.
#>
param(
    [string]$OutputDir = "bin/ffmpeg",
    [string]$Url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root $OutputDir
$tempZip = Join-Path $root "ffmpeg-download.zip"
$tempExtract = Join-Path $root "ffmpeg-download"

if (Test-Path $target) {
    Write-Host "FFmpeg already present at $target"
    exit 0
}

Write-Host "Downloading FFmpeg from $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $tempZip -UseBasicParsing

Write-Host "Extracting..."
if (Test-Path $tempExtract) { Remove-Item -Recurse -Force $tempExtract }
Expand-Archive -Path $tempZip -DestinationPath $tempExtract

$inner = Get-ChildItem -Path $tempExtract -Directory | Select-Object -First 1
if (-not $inner) {
    throw "Could not find extracted FFmpeg directory"
}

Write-Host "Moving to $target ..."
New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
Move-Item -Path $inner.FullName -Destination $target -Force

Remove-Item -Recurse -Force $tempExtract -ErrorAction SilentlyContinue
Remove-Item -Force $tempZip -ErrorAction SilentlyContinue

$ffmpeg = Join-Path $target "bin/ffmpeg.exe"
$ffprobe = Join-Path $target "bin/ffprobe.exe"
if ((Test-Path $ffmpeg) -and (Test-Path $ffprobe)) {
    Write-Host "FFmpeg ready: $ffmpeg"
} else {
    throw "FFmpeg binaries not found after extraction"
}
