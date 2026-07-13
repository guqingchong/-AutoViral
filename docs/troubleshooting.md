# AutoViral 故障排查指南

## 安装问题

### 安装程序提示 "Windows 已保护你的电脑"

- 点击「更多信息」，然后选择「仍要运行」。
- 这是因为安装包尚未进行代码签名。后续版本会补充签名。

### 安装后无法找到 AutoViral.exe

- 检查安装目录（默认 `C:\Program Files\AutoViral`）。
- 如果安装过程中被杀毒软件拦截，请将安装目录加入白名单并重新安装。

## 启动问题

### 双击快捷方式无反应

1. 打开 PowerShell。
2. 运行：
   ```powershell
   & "C:\Program Files\AutoViral\AutoViral.exe" --no-sandbox
   ```
3. 观察报错信息。
4. 如果提示端口 3271 被占用：
   - 关闭其他 AutoViral 实例。
   - 或修改 `~/.autoviral/config.yaml` 中的 `port`。

### 提示 "Dashboard not built"

- 安装包不完整。重新下载安装包并安装。
- 或手动运行 `npm run build:frontend`（仅开发环境）。

## 数据问题

### 迁移旧 YAML 作品失败

- 确认旧版数据目录 `~/.autoviral/works/` 存在。
- 在 PowerShell 中运行：
  ```powershell
  npx tsx src/cli.ts migrate
  ```
- 查看具体错误日志。

### 恢复备份后数据未生效

- 恢复后必须重启 AutoViral。
- 确认恢复时勾选了「覆盖现有文件」。
- 检查恢复日志中是否显示 `db/autoviral.db` 已恢复。

## 模型/API 问题

### Claude Code 无法使用 DeepSeek / Kimi Code

- 参阅 `docs/ops/claude-code-model-setup.md` 中的配置步骤。
- 验证环境变量：
  ```powershell
  claude config get env.ANTHROPIC_BASE_URL
  claude /status
  ```

### API Key 验证失败

- 确认 Key 已保存。
- 检查网络连接。
- 查看 `~/.autoviral/autoviral.log` 中的后端错误。

## 视频合成问题

### FFmpeg 未找到

- 安装版/便携版应自动使用 bundled FFmpeg。
- 如果手动运行源码，请确保 `ffmpeg` 和 `ffprobe` 在系统 PATH 中。
- 检查环境变量 `FFMPEG_PATH` 和 `FFPROBE_PATH`。

## 获取日志

日志文件位置：

- 安装版：`%USERPROFILE%\.autoviral\daemon.log`
- 便携版：`<便携目录>\data\daemon.log`

## 仍未解决？

1. 导出备份：「运维管理 → 导出备份」。
2. 保存日志文件。
3. 联系技术支持并附上备份和日志。
