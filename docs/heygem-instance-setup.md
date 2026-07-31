# HeyGem 实例镜像改造操作手册

> 面向非专家操作者。每一步都可以直接复制粘贴执行。
> 目的：把 AutoDL 上的 HeyGem 实例改造成 AutoViral 可用的形态（Bearer Token 鉴权 + SSH 隧道访问），并固化为私有镜像。
>
> **运行模式**：实例的开关机由你在 [AutoDL 控制台](https://www.autodl.com/console) **手动操作**（AutoViral 不调用 AutoDL API）。
> AutoViral 只做状态提醒：每 30 秒健康探测显示实例在线/离线，实例空闲超过阈值时在数字人页面提示你及时关机，避免持续计费。
>
> **连接方式：SSH 隧道**。AutoDL 实例所在区域的公网代理（「自定义服务」）仅对企业认证用户开放，
> 个人用户只能通过 SSH 隧道访问实例服务。AutoViral 会**自动管理隧道生命周期**：
> 健康探测失败时自动建立 `ssh -N -L` 端口转发并重试，无需人工干预。
> 唯一的一次性前置条件：本机已配置对该实例的**免密 SSH 登录**（见第 1 步）。

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

### 一次性配置：免密 SSH（隧道自动化的前提）

AutoViral 自动建隧道时使用 `BatchMode=yes`（不允许交互输密码），因此必须先把本机公钥放到实例上。此配置**只需做一次**（本机已完成，以下备查）：

```bash
# 1. 本机没有密钥则先生成（一路回车，不设口令）
ssh-keygen -t ed25519

# 2. 把公钥复制到实例（最后输一次实例密码）
ssh-copy-id -p 28830 root@connect.nmb1.seetacloud.com
# Windows 没有 ssh-copy-id 时可用：
# type %USERPROFILE%\.ssh\id_ed25519.pub | ssh -p 28830 root@connect.nmb1.seetacloud.com "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"

# 3. 验证免密登录（不应再提示输密码）
ssh -p 28830 root@connect.nmb1.seetacloud.com
```

> 注意：AutoDL 实例**无卡模式开机 / 换实例后 SSH 地址（主机和端口）会变**，公钥也可能丢失，需要重做本步并同步更新 AutoViral 设置页的隧道主机/端口。

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
from fastapi import Request
from fastapi.responses import JSONResponse

HEYGEM_API_TOKEN = os.environ.get("HEYGEM_API_TOKEN", "")
```

4. 找到文件中创建 FastAPI 应用的那一行（形如 `app = FastAPI(...)`），在**它下面紧接着**粘贴中间件：

```python
@app.middleware("http")
async def _auth_middleware(request: Request, call_next):
    if HEYGEM_API_TOKEN and request.headers.get("Authorization") != f"Bearer {HEYGEM_API_TOKEN}":
        return JSONResponse(status_code=401, content={"detail": "unauthorized"})
    return await call_next(request)
```

> 说明：只要环境变量 `HEYGEM_API_TOKEN` 非空，所有请求都必须带 `Authorization: Bearer <你的TOKEN>` 头，否则返回 401。
> 注意：中间件里**必须**用 `return JSONResponse(...)` 直接返回 401，不能用 `raise HTTPException(401)`——`@app.middleware("http")` 注册的中间件运行在 FastAPI 异常处理器之外，raise 出来的 HTTPException 不会被转换成 401，而会变成 500 内部错误。

---

## 第 3 步：注入 Token 环境变量

> 说明：走 SSH 隧道后，实例端口无需对公网暴露，**不需要**把 HeyGem 端口从 6008 改成 6006
> （隧道默认把本机 6006 转发到实例 127.0.0.1:6008）。本步只需注入 Token 环境变量。

1. 备份并打开启动脚本：

```bash
cp /root/HeyGem-Linux-Python-Hack/start_api.sh /root/HeyGem-Linux-Python-Hack/start_api.sh.bak
vi /root/HeyGem-Linux-Python-Hack/start_api.sh
```

2. 在文件里加一行（建议紧跟 `PORT=` 那行下面），把 `<你的TOKEN>` 替换为第 0 步生成的随机串：

```bash
export HEYGEM_API_TOKEN=<你的TOKEN>
```

3. 保存退出（`Esc` → `:wq` → 回车）。

4. 重启 API 服务使改动生效。先杀掉旧进程再启动：

```bash
pkill -f api_server.py
cd /root/HeyGem-Linux-Python-Hack && nohup bash start_api.sh > /root/heygem_api.log 2>&1 &
```

> 如果实例原本就是用 `start_api.sh` 自启的，也可以直接在 AutoDL 控制台对实例执行「关机」再「开机」让它自动拉起。

---

## 第 4 步：验证改造成功（通过 SSH 隧道）

实例服务不对公网开放（个人用户无公网代理权限），验证走 SSH 隧道。在**本地**终端执行：

```bash
# 建立隧道：本机 6006 → 实例 127.0.0.1:6008（把端口/主机换成你实例的 SSH 信息）
ssh -N -L 6006:127.0.0.1:6008 -p 28830 root@connect.nmb1.seetacloud.com
```

该命令会前台挂起（属正常）。**另开一个**本地终端验证：

```bash
curl -H "Authorization: Bearer <你的TOKEN>" http://localhost:6006/api/health
```

- 返回 `{"status":"ok"}`（或类似 ok 字样）→ 成功。
- 返回 401 → Token 不一致，检查第 3 步的 export 与 curl 里的串是否完全相同。
- 不带 `-H` 再试一次应返回 401，说明鉴权确实生效：

```bash
curl http://localhost:6006/api/health
```

验证完可以 `Ctrl+C` 关掉这个手动隧道——AutoViral 运行时会自动建立自己的隧道
（若手动隧道还开着，AutoViral 检测到本机 6006 已可用会直接复用，不会重复建立）。

---

## 第 5 步：固化私有镜像

确认验证通过后：

1. 回到 AutoDL 控制台 →「容器实例」。
2. 先对实例执行「关机」（保存镜像要求关机状态；数据盘内容会保留）。
3. 实例卡片 →「更多」→「保存镜像」，起个名字，例如 `heygem-6006-token-v1`。
4. 以后每次在 AutoDL 控制台基于这个镜像开机，端口和 Token 自动就位，**无需重复本手册**。

---

## 第 6 步：在 AutoViral 设置页填写配置

打开 AutoViral → 设置页，填写以下配置：

| 配置项 | 填什么 | 示例 |
|--------|--------|------|
| `heygem.baseUrl` | 固定填本地隧道地址 `http://localhost:6006`（AutoViral 自动把该端口转发到实例） | `http://localhost:6006` |
| `heygem.apiToken` | 第 0 步生成的随机串 | 与实例里 export 的一致 |
| `heygem.gpuHourlyRateYuan` | GPU 每小时单价（与实例实际价格一致，用于估算任务成本） | `1.78` |
| `heygem.tunnel.host` | 实例 SSH 主机（AutoDL 控制台实例卡片 →「SSH 登录」命令里的主机） | `connect.nmb1.seetacloud.com` |
| `heygem.tunnel.port` | 实例 SSH 端口（同上，`-p` 后面的数字） | `28830` |

可选配置（一般用默认值即可）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `heygem.idleReminderMinutes` | `15` | 空闲提醒阈值——实例空闲超过该时长，数字人页面会提示你去控制台关机 |
| `heygem.tunnel.user` | `root` | SSH 用户 |
| `heygem.tunnel.localPort` | `6006` | 本机转发端口（与 `heygem.baseUrl` 的端口对应） |
| `heygem.tunnel.remotePort` | `6008` | 实例内 HeyGem API 端口（`start_api.sh` 里的 `PORT`） |

> 注意：更换实例 / 无卡模式开机后 SSH 主机和端口会变，记得同步更新设置页的隧道主机和端口，并重新做第 1 步的免密配置。旧版 `autodl.*` 配置会在启动时自动迁移为 `heygem.*`；旧 `heygem` 配置缺 `tunnel` 字段时启动时自动补默认值。

隧道的工作方式：AutoViral 健康探测失败时自动执行等价于
`ssh -N -L 6006:127.0.0.1:6008 -p <tunnel.port> <tunnel.user>@<tunnel.host>`
的端口转发（`BatchMode=yes`，需免密），并随 AutoViral 退出而终止，不留后台进程。

---

## 第 7 步：跑端到端验收脚本

前置条件：本手册第 1-6 步全部完成，且实例已在 AutoDL 控制台**手动开机**、HeyGem API 已就绪（脚本不会帮你开关机）。

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

脚本流程：检查实例健康（未就绪则提示先去控制台开机）→ 注册形象 → 提交约 10 秒音频的合成任务 → 轮询至完成并校验产物（mp4 存在、>100KB、actual_cost > 0）。任一步失败以退出码 1 终止。脚本结束后**不会关机**，如不再使用请记得去 AutoDL 控制台手动关机。

全部输出 `PASS` 即端到端验收通过。

---

## 常见问题

- **页面显示「实例离线」**：实例没开机，或刚开机 HeyGem 还在加载模型（需几分钟）。先去 [AutoDL 控制台](https://www.autodl.com/console) 开机；持续离线则检查隧道——手动执行 `ssh -N -L 6006:127.0.0.1:6008 -p <端口> root@<主机>` 看是否报错（免密失效、SSH 地址变更都会导致隧道建立失败），再 SSH 进实例看 `tail -100 /root/heygem_api.log`。
- **隧道反复断开**：确认实例 SSH 主机/端口与设置页一致；AutoDL 实例关机再开机后 SSH 地址可能变化，需同步更新设置页并重做免密配置（第 1 步）。
- **401 unauthorized**：两端 Token 不一致，或实例是从旧镜像开的（没做第 5 步固化）。
- **忘记关机一直在计费**：在 AutoViral 设置页把 `heygem.idleReminderMinutes` 调小，空闲提醒会更早出现；计费以 AutoDL 控制台为准，不用时及时手动关机。
- **改坏了想回滚**：`cp api_server.py.bak api_server.py && cp start_api.sh.bak start_api.sh`，再重启服务即可。
