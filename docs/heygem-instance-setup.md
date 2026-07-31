# HeyGem 实例镜像改造操作手册

> 面向非专家操作者。每一步都可以直接复制粘贴执行。
> 目的：把 AutoDL 上的 HeyGem 实例改造成 AutoViral 可用的形态（端口 6006 + Bearer Token 鉴权），并固化为私有镜像。

---

## 前置准备

- 一个 AutoDL 账号，里面已有部署好 HeyGem（`HeyGem-Linux-Python-Hack`）的实例（或私有镜像）。
- 本地已安装并能运行 AutoViral。
- 全程约 20-30 分钟。

---

## 第 0 步：生成一个 API Token（随机串）

这个串同时写在实例里和 AutoViral 设置页，两边必须一致。

Windows PowerShell 执行：

```powershell
-join ((48..57) + (97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

或 Git Bash / Linux / macOS 执行：

```bash
openssl rand -hex 20
```

把输出的这串字符复制保存到记事本，后面第 3 步和第 5 步都要用。下文统一用 `<你的TOKEN>` 代指它。

---

## 第 1 步：开机并 SSH 进入实例

两种方式任选其一：

**方式 A（推荐，首次改造用）**：登录 [AutoDL 控制台](https://www.autodl.com/) →「容器实例」→ 找到你的 HeyGem 实例（或用既有私有镜像「开机」一台新实例）→ 点击「开机」。

**方式 B**：实例已在运行，直接复用。

开机后，在实例卡片上点击「快捷工具」→「SSH 登录」，复制 SSH 命令，形如：

```bash
ssh -p 12345 root@connect.cqa1.seetacloud.com
```

在本地终端（PowerShell / Git Bash 均可）粘贴执行，首次连接输入 `yes`，密码在实例卡片「密码」处复制粘贴（输入时屏幕不显示，属正常）。

也可以直接用 AutoDL 控制台实例卡片上的「JupyterLab」→ 打开一个 Terminal，效果相同。

---

## 第 2 步：给 HeyGem API 加 Bearer Token 鉴权

在实例的终端里执行（以下命令逐条复制粘贴）：

1. 先备份原文件：

```bash
cp /root/HeyGem-Linux-Python-Hack/api_server.py /root/HeyGem-Linux-Python-Hack/api_server.py.bak
```

2. 打开文件编辑：

```bash
cd /root/HeyGem-Linux-Python-Hack
vi api_server.py
```

3. 在文件**最顶部**（所有 import 之前即可）粘贴以下内容。vi 操作：按 `i` 进入插入模式 → 粘贴 → 按 `Esc` → 输入 `:wq` 回车保存：

```python
import os
from fastapi import Request, HTTPException

HEYGEM_API_TOKEN = os.environ.get("HEYGEM_API_TOKEN", "")
```

4. 找到文件中创建 FastAPI 应用的那一行（形如 `app = FastAPI(...)`），在**它下面紧接着**粘贴中间件：

```python
@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    if HEYGEM_API_TOKEN and request.headers.get("Authorization") != f"Bearer {HEYGEM_API_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")
    return await call_next(request)
```

> 说明：只要环境变量 `HEYGEM_API_TOKEN` 非空，所有请求都必须带 `Authorization: Bearer <你的TOKEN>` 头，否则返回 401。
> 如果保存后发现 401 响应格式异常（个别 FastAPI 版本在中间件里抛 HTTPException 不会被正常处理），把中间件换成下面的等价写法：
>
> ```python
> @app.middleware("http")
> async def _auth_middleware(request: Request, call_next):
>     if HEYGEM_API_TOKEN and request.headers.get("Authorization") != f"Bearer {HEYGEM_API_TOKEN}":
>         from fastapi.responses import JSONResponse
>         return JSONResponse(status_code=401, content={"detail": "unauthorized"})
>     return await call_next(request)
> ```

---

## 第 3 步：改端口 6006 并注入 Token 环境变量

1. 备份并打开启动脚本：

```bash
cp /root/HeyGem-Linux-Python-Hack/start_api.sh /root/HeyGem-Linux-Python-Hack/start_api.sh.bak
vi /root/HeyGem-Linux-Python-Hack/start_api.sh
```

2. 找到 `PORT=6008` 这一行，改成：

```bash
PORT=6006
```

3. 在同一文件里（建议紧跟 PORT 那行下面）加一行，把 `<你的TOKEN>` 替换为第 0 步生成的随机串：

```bash
export HEYGEM_API_TOKEN=<你的TOKEN>
```

4. 保存退出（`Esc` → `:wq` → 回车）。

5. 重启 API 服务使改动生效。先杀掉旧进程再启动：

```bash
pkill -f api_server.py
cd /root/HeyGem-Linux-Python-Hack && nohup bash start_api.sh > /root/heygem_api.log 2>&1 &
```

> 如果实例原本就是用 `start_api.sh` 自启的，也可以直接在 AutoDL 控制台对实例执行「关机」再「开机」让它自动拉起。

---

## 第 4 步：验证改造成功

在**本地**终端执行（把 `<实例公网地址>` 换成 AutoDL 实例卡片上的「自定义服务」/公网地址，形如 `https://xxxx.region.autodl.com`，把 `<你的TOKEN>` 换成你的随机串）：

```bash
curl -H "Authorization: Bearer <你的TOKEN>" https://<实例公网地址>/api/health
```

- 返回 `{"status":"ok"}`（或类似 ok 字样）→ 成功。
- 返回 401 → Token 不一致，检查第 3 步的 export 与 curl 里的串是否完全相同。
- 不带 `-H` 再试一次应返回 401，说明鉴权确实生效：

```bash
curl https://<实例公网地址>/api/health
```

---

## 第 5 步：固化私有镜像

确认验证通过后：

1. 回到 AutoDL 控制台 →「容器实例」。
2. 先对实例执行「关机」（保存镜像要求关机状态；数据盘内容会保留）。
3. 实例卡片 →「更多」→「保存镜像」，起个名字，例如 `heygem-6006-token-v1`。
4. 以后每次从 AutoViral 开机，都会基于这个镜像拉起，端口和 Token 自动就位，**无需重复本手册**。

> 注意：在 AutoViral 设置里填的实例必须是「用这个镜像开的实例」。如果你保存镜像后新开了一台实例，记得更新设置页的实例 ID。

---

## 第 6 步：在 AutoViral 设置页填写配置

打开 AutoViral → 设置页，填写以下 4 项：

| 配置项 | 填什么 | 示例 |
|--------|--------|------|
| `autodl.token` | AutoDL 开发者 Token（AutoDL 控制台 → 账号设置 → 开发者 Token） | `eyJhbGci...` |
| `autodl.instanceUuid` | 实例 ID（实例卡片上的 UUID） | `a1b2c3d4-...` |
| `autodl.publicBaseUrl` | 实例公网地址（与第 4 步 curl 用的相同，不带末尾 `/`） | `https://xxxx.region.autodl.com` |
| `heygem.apiToken` | 第 0 步生成的随机串 | 与实例里 export 的一致 |

同时确认 GPU 每小时单价（`gpuHourlyRateYuan`）和实例实际价格一致——它用于估算任务成本，验收脚本会断言 `actual_cost > 0`。

---

## 第 7 步：跑端到端验收脚本

前置条件：本手册第 1-6 步全部完成，实例处于**关机**状态（脚本会自己开机）。

在 AutoViral 项目根目录执行：

```bash
npx tsx scripts/test-heygem-live.ts
```

> 项目未内置 tsx，`npx` 会临时下载调用，不改动项目依赖。
> 测试素材默认读取 `D:\Autoviral\data\test-assets\guqingchong-2.mp4` 和 `test-script.wav`（主仓库路径，需确认存在）；可用环境变量覆盖：
>
> ```bash
> HEYGEM_TEST_VIDEO=/path/to/video.mp4 HEYGEM_TEST_AUDIO=/path/to/audio.wav npx tsx scripts/test-heygem-live.ts
> ```

脚本流程：开机并等待就绪（真实等待 3-5 分钟）→ 注册形象 → 提交约 10 秒音频的合成任务 → 轮询至完成并校验产物（mp4 存在、>100KB、actual_cost > 0）→ 关机并校验 stopped。任一步失败以退出码 1 终止。

全部输出 `PASS` 即端到端验收通过。

---

## 常见问题

- **健康检查一直不过**：实例刚开机 HeyGem 加载模型要几分钟，脚本最多等 5 分钟；超时的话 SSH 进实例看 `tail -100 /root/heygem_api.log`。
- **401 unauthorized**：两端 Token 不一致，或实例是从旧镜像开的（没做第 5 步固化）。
- **关机时报「有任务进行中」**：有合成任务没跑完，等它结束或在 AutoViral 里删除该任务后再关机。
- **改坏了想回滚**：`cp api_server.py.bak api_server.py && cp start_api.sh.bak start_api.sh`，再重启服务即可。
