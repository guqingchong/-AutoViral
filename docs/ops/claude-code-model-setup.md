# Claude Code 模型配置指南

本指南说明如何配置 Claude Code CLI 使用 DeepSeek 或 Kimi Code 作为 Anthropic 兼容端点。

## DeepSeek 配置

1. 设置环境变量：

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<你的 DeepSeek API Key>", "User")
```

2. 验证配置：

```powershell
claude /status
```

## Kimi Code 配置

1. 设置环境变量：

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://api.moonshot.cn/anthropic", "User")
[Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "<你的 Kimi API Key>", "User")
```

2. 验证配置：

```powershell
claude /status
```

## 验证与排查

### 验证配置

```powershell
claude config get env.ANTHROPIC_BASE_URL
claude /status
```

### 常见问题

**Q: 显示 "Unknown model" 错误**

- 确认 API 端点支持 Anthropic Messages API 兼容接口
- 检查 API Key 是否有效
- 确认网络连接正常

**Q: 重启后环境变量丢失**

- 确认使用 `[Environment]::SetEnvironmentVariable` 的 `User` 或 `Machine` scope
- 重启 PowerShell 窗口后生效
- 使用 `claude config set` 命令持久化配置

**Q: 想切回 Anthropic 官方模型**

```powershell
[Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "", "User")
```

或删除该环境变量即可。
