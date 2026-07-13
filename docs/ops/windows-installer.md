# AutoViral Windows 安装包运维手册

## 构建环境

- Windows 10/11 64 位
- Node.js 18+（建议使用项目 `.nvmrc` 版本）
- npm 9+
- PowerShell 5.1+
- Git Bash（可选，用于 `scripts/build-installer.sh`）

## 构建流程

### 完整构建

```powershell
npm run build:installer
```

该脚本会执行：

1. `npm ci`
2. `npm run build:backend`
3. `npm run build:frontend`
4. `scripts/download-ffmpeg.ps1`
5. `npx electron-builder --win --x64`

输出目录：`release/`

### 跳过前端/后端构建

```powershell
npm run build:installer -- -SkipBuild
```

### 跳过 FFmpeg 下载

```powershell
npm run build:installer -- -SkipFfmpeg
```

## 输出产物

| 产物 | 说明 |
|------|------|
| `AutoViral-<version>-Setup.exe` | NSIS 安装包 |
| `AutoViral-<version>-portable.exe` | 便携版可执行文件 |

## 安装包内容

- `dist/`：编译后的 Node 后端
- `web/dist/`：编译后的前端
- `skills/`：项目 skills
- `bin/ffmpeg/`：Windows FFmpeg 二进制
- `electron/main.cjs`：Electron 主进程
- `scripts/`：启动脚本
- 文档：`docs/setup-guide.md`、`docs/troubleshooting.md`、`docs/ops/claude-code-model-setup.md`

## 应用数据目录

- 安装版：`%USERPROFILE%\.autoviral\`
- 便携版：`<exe 所在目录>\data\`

## 环境变量

| 变量 | 说明 |
|------|------|
| `AUTOVIRAL_PACKAGED` | Electron 主进程设置，标识打包运行 |
| `AUTOVIRAL_APP_ROOT` | 应用根目录 |
| `AUTOVIRAL_FFMPEG_PATH` | bundled ffmpeg.exe 路径 |
| `AUTOVIRAL_FFPROBE_PATH` | bundled ffprobe.exe 路径 |
| `AUTOVIRAL_DATA_DIR` | 便携模式数据目录覆盖 |

## 签名

当前安装包未签名。正式发版前应申请代码签名证书，并在 `electron-builder.yml` 中配置：

```yaml
win:
  certificateFile: "C:\\certs\\autoviral.p12"
  certificatePassword: "<password>"
```

## CI 集成

GitHub Actions 示例：

```yaml
name: Build Installer
on:
  push:
    tags:
      - 'v*'
jobs:
  build:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm run build:installer
      - uses: actions/upload-artifact@v4
        with:
          name: autoviral-installer
          path: release/*.exe
```

## 升级策略

1. 新版本构建完成后，上传 `release/` 中的 `.exe` 到发布页面。
2. 用户下载新版安装包覆盖安装；数据保留在 `%USERPROFILE%\.autoviral\`。
3. 便携版用户下载新版 portable `.exe` 替换旧文件，并保留 `data/` 目录。
