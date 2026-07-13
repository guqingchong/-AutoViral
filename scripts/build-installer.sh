#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUTPUT_DIR="${OUTPUT_DIR:-release}"
SKIP_FFMPEG="${SKIP_FFMPEG:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"

# 1. Clean previous release
rm -rf "$OUTPUT_DIR"

# 2. Install dependencies
if [ "$SKIP_BUILD" != "1" ]; then
  echo "Installing dependencies..."
  npm ci
fi

# 3. Build backend and frontend
if [ "$SKIP_BUILD" != "1" ]; then
  echo "Building backend..."
  npm run build:backend
  echo "Building frontend..."
  npm run build:frontend
fi

# 4. Download FFmpeg (requires PowerShell on Windows; skip on non-Windows)
if [ "$SKIP_FFMPEG" != "1" ]; then
  if command -v powershell >/dev/null 2>&1; then
    echo "Downloading FFmpeg..."
    powershell -ExecutionPolicy Bypass -File scripts/download-ffmpeg.ps1
  else
    echo "PowerShell not found; skipping FFmpeg download. Run download-ffmpeg.ps1 on Windows."
  fi
fi

# 5. Build Electron package
echo "Building installer with electron-builder..."
npx electron-builder --win --x64

# 6. Report outputs
echo "Build complete. Artifacts:"
find "$OUTPUT_DIR" -maxdepth 2 \( -name "*.exe" -o -name "*.zip" \) -print
