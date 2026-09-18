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

# 4.5 better-sqlite3 Electron 预编译就位(2026-09-11):
# npmRebuild:false 后 electron-builder 不再重建原生模块——打包前必须把
# electron-v125 预编译摆进 build/Release(源码编译需 node-gyp+python,本机没有)。
$bsqDir = "node_modules/better-sqlite3"
if (Test-Path $bsqDir) {
    $bsqVer = (Get-Content "$bsqDir/package.json" | ConvertFrom-Json).version
    $pkg = "better-sqlite3-v$bsqVer-electron-v125-win32-x64.tar.gz"
    $tmpTar = Join-Path $env:TEMP $pkg
    if (-not (Test-Path $tmpTar)) {
        Write-Host "Downloading better-sqlite3 electron prebuilt ($pkg)..."
        $mirrors = @(
            "https://ghfast.top/https://github.com/WiseLibs/better-sqlite3/releases/download/v$bsqVer/$pkg",
            "https://github.com/WiseLibs/better-sqlite3/releases/download/v$bsqVer/$pkg"
        )
        $ok = $false
        foreach ($u in $mirrors) {
            try { Invoke-WebRequest -Uri $u -OutFile $tmpTar -TimeoutSec 180; $ok = $true; break } catch { Write-Host "mirror failed: $u" }
        }
        if (-not $ok) { throw "better-sqlite3 electron 预编译下载失败(两个镜像均不可达)" }
    }
    tar xzf $tmpTar -C $bsqDir
    Write-Host "better-sqlite3 electron prebuilt in place."
}

# 5. Build Electron package
# 2026-09-11 修复:必须用项目本地 electron-builder(v25),--no-install 阻止 npx
# 去拉最新版(v26 的 config schema 与本仓库 electron-builder.yml 不兼容)
# 2026-09-12 修复:GitHub 直连慢导致 electron zip / nsis / winCodeSign 下载失败——
# a) nsis/winCodeSign 走 ghfast.top 镜像(ELECTRON_BUILDER_BINARIES_MIRROR)
# b) electron zip 复用 @electron/get 已有缓存(electronDist 指向含 zip 的缓存目录,
#    命中后 unpack-electron 直接解包,不再下载)
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://ghfast.top/https://github.com/electron-userland/electron-builder-binaries/releases/download/"

$electronDistArgs = @()
$electronCacheRoot = Join-Path $env:LOCALAPPDATA "electron\Cache"
$electronVer = (Get-Content "node_modules/electron/package.json" | ConvertFrom-Json).version
$zipName = "electron-v$electronVer-win32-x64.zip"
$cachedZip = Get-ChildItem -Path $electronCacheRoot -Recurse -Filter $zipName -ErrorAction SilentlyContinue |
    Where-Object { $_.Length -gt 100MB } | Select-Object -First 1
if ($cachedZip) {
    Write-Host "Reusing cached $zipName from $($cachedZip.DirectoryName)"
    $electronDistArgs = @("-c.electronDist=$($cachedZip.DirectoryName)")
} else {
    Write-Host "WARN: 未找到 $zipName 本地缓存,electron-builder 将尝试在线下载(可能很慢)"
}

# 图标门槛:electron-builder 要求 ico 至少含 256x256
& py -3 -c "from PIL import Image; im=Image.open(r'build-resources/icon.ico'); sizes=im.info.get('sizes',set()); exit(0 if any(s[0]>=256 for s in sizes) else 1)"
if ($LASTEXITCODE -ne 0) { throw "build-resources/icon.ico 缺少 256x256 尺寸(可用 icon-512.png 重新生成多尺寸 ico)" }

Write-Host "Building installer with electron-builder..."
& npx --no-install electron-builder --win --x64 @electronDistArgs

# 6. Report outputs
$artifacts = Get-ChildItem -Path $OutputDir -Include "*.exe","*.zip" -Recurse
Write-Host "Build complete. Artifacts:"
$artifacts | ForEach-Object { Write-Host "  $_" }
