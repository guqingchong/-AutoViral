# AutoViral 安装与设置指南

## 系统要求

- Windows 10/11 64 位
- 8 GB 内存以上（推荐 16 GB）
- 50 GB 以上可用硬盘空间
- 网络连接

## 第一步：安装 Claude Code

AutoViral 的部分 Agent 能力依赖 Claude Code CLI。

1. 以管理员身份打开 PowerShell。
2. 运行：
   ```powershell
   npm install -g @anthropic-ai/claude-code
   ```
3. 运行：
   ```powershell
   claude
   ```
4. 按提示登录 Anthropic 账号或配置 API。
5. 验证安装：
   ```powershell
   claude --version
   ```

如需使用 DeepSeek 或 Kimi Code 模型替代 Anthropic 官方模型，请参阅运维手册：

- **文档路径**：`docs/ops/claude-code-model-setup.md`
- **主要内容**：DeepSeek / Kimi Code Anthropic 兼容端点配置、环境变量持久化、验证与失败排查。

## 第二步：安装 AutoViral

### 安装版（推荐）

1. 下载 `AutoViral-Setup-<版本>.exe`。
2. 双击运行安装向导。
3. 选择安装目录（默认 `C:\Program Files\AutoViral`）。
4. 完成安装后，桌面会生成 `AutoViral` 快捷方式。
5. 双击快捷方式启动。

### 便携版

1. 下载 `AutoViral-<版本>-portable.exe`。
2. 将其复制到目标目录（如 `D:\AutoViral`）。
3. 双击运行；程序会在同级目录创建 `data` 文件夹保存所有数据。
4. 如需启动脚本，可使用 `scripts/start-portable.bat` 或 `scripts/start-portable.ps1`。

## 第三步：配置 API Key

1. 启动 AutoViral 后，浏览器会自动打开 `http://localhost:3271`。
2. 进入「设置 → API Key」。
3. 按分类填写以下 Key：
   - AI 大模型（可选，Claude Code 已配置时可不填）
   - 数字人：蝉镜 appid / secretKey
   - AI 视频生成：即梦 / Seedance
   - 语音/音乐：MiniMax
   - 素材：Pexels / Pixabay / Unsplash
   - 发布平台：快手 / B站 / 知乎 / 公众号等
4. 点击「测试连接」验证。
5. 保存配置。

## 第四步：导入旧数据（可选）

如果你之前使用旧版 AutoViral 并有 YAML 格式的作品数据：

1. 进入「运维管理」页面。
2. 点击「开始迁移」。
3. 系统会一次性将旧 YAML 作品导入 SQLite 数据库。

## 第五步：完整迁移到新电脑

1. 在原电脑上进入「运维管理 → 导出备份」，下载备份 zip。
2. 将备份 zip 复制到新电脑。
3. 在新电脑上安装 AutoViral。
4. 进入「运维管理 → 导入恢复」，选择备份 zip 并勾选「覆盖现有文件」。
5. 重启 AutoViral。

## 常用启动方式

- 安装版：桌面快捷方式或开始菜单。
- 便携版：`scripts/start-portable.bat` 或 `scripts/start-portable.ps1`。
- 命令行（开发模式）：
  ```powershell
  npx tsx src/cli.ts start --foreground
  ```
