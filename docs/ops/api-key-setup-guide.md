# AutoViral API Key 获取与配置指南

本指南说明 AutoViral 所需的各 API Key 的获取方式与费用。

---

## 一、已配置的服务（无需操作）

以下 Key 已在 `.env` 或配置中保存，链路已打通：

| 服务 | 状态 | 用途 |
|------|------|------|
| 即梦（火山引擎） | ✅ 已配置 | AI 图片/视频生成 |
| Seedance | ✅ 复用即梦凭证 | AI 视频生成（与即梦共用火山 AK/SK） |
| MiniMax | ✅ 已配置 | TTS 语音合成 + BGM 音乐生成 |
| OpenRouter | ✅ 已配置 | 备用 LLM 提供商 |

---

## 二、素材库（强烈推荐配置，全部免费）

### Openverse（默认可用，无需注册）
- **费用**：免费
- **API Key**：不需要
- **说明**：聚合 50+ 来源的 CC 授权素材，开箱即用，在素材库页面直接搜索即可。

### Pexels（推荐）
- **费用**：免费（每月 200 次请求/小时，足够日常使用）
- **获取步骤**：
  1. 打开 https://www.pexels.com/api/
  2. 点击「Your API Key」或「Get Started」
  3. 注册账号（邮箱即可）
  4. 填写简单申请表（用途选个人项目/内容创作）
  5. 获取 API Key，填入 AutoViral 设置 → 素材库 → Pexels API Key

### Pixabay（推荐）
- **费用**：免费（每分钟 100 次请求）
- **获取步骤**：
  1. 打开 https://pixabay.com/api/docs/
  2. 注册账号
  3. 登录后页面顶部自动显示你的 API Key
  4. 复制后填入 AutoViral 设置 → 素材库 → Pixabay API Key

### Unsplash（推荐）
- **费用**：免费（每小时 50 次请求，demo 应用足够）
- **获取步骤**：
  1. 打开 https://unsplash.com/developers
  2. 点击「Register as a Developer」
  3. 注册账号
  4. 创建新应用（New Application）
  5. 勾选所有条款，填写应用名称和描述
  6. 创建后在应用详情页获取 Access Key
  7. 填入 AutoViral 设置 → 素材库 → Unsplash Access Key

> **提示**：即使只配置 Openverse（无需注册），也能搜索素材。配齐 Pexels/Pixabay/Unsplash 可获得更多高质量素材。

---

## 三、蝉镜数字人（暂不注册，接口已打通）

### 蝉镜
- **费用**：298 元/月（不限量），按量付费另计
- **状态**：接口和链路已全部打通，**未配置 Key 时页面会提示「未配置」**
- **注册步骤（待你准备好后操作）**：
  1. 打开 https://chanjing.cc/openapi-home
  2. 注册账号并开通 API 服务
  3. 获取 AppID 和 SecretKey
  4. 在 AutoViral 设置 → 蝉镜数字人 → 填入 AppID / SecretKey
  5. 在数字人页面点击「测试连接」验证
- **备用方案**：百炼 LivePortrait（填入百炼 API Key 即可作为备用数字人）

---

## 四、配置方式

所有 Key 支持两种配置方式：

1. **Web UI 配置**（推荐）：启动 AutoViral → 点击右上角设置图标 → 填写对应字段 → 保存
2. **环境变量配置**：编辑 AutoViral 目录下 `.env` 文件，添加对应变量名后重启

| 服务 | 环境变量名 |
|------|-----------|
| 即梦 | `JIMENG_ACCESS_KEY` / `JIMENG_SECRET_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| 蝉镜 | `CHANJING_APP_ID` / `CHANJING_SECRET_KEY` |
| 百炼 | `BAILIAN_API_KEY` |
| Pexels | `PEXELS_API_KEY` |
| Pixabay | `PIXABAY_API_KEY` |
| Unsplash | `UNSPLASH_ACCESS_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |