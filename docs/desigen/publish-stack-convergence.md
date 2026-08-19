# 发布栈收敛评估（2026-08-19,全链路审计 P2）

## 现状：两套并行栈

| | 4a(jobs/drivers) | 4b(records/publishers) |
|---|---|---|
| 服务 | `services/publish-service.ts` | `services/publishing.ts` |
| 路由 | `server/publish-api.ts` → `/api/publish/*` | `server/routes/publish.ts` → `/api/works/:id/publish/*` |
| 数据 | publish_jobs(任务队列表) | publish_records(发布记录表) |
| 执行器 | PlatformDriver 接口 | Publisher 接口(publishers/*) |
| 前端 | PublishCenter.svelte(账号/任务面板) | PublishBoard.svelte(作品一键发布) |
| 状态机 | 有恢复(recoverStuckJobs/recoverTimedOutStuckJobs)+ 5min 超时 race | 无恢复(崩溃即永久 publishing)、无超时 |
| 凭证 | platform_credentials | 同一表,但 B 站等口径不一致(见审计 m10) |

## 已确认的问题(审计原文)

- M5:publish_records 无卡死恢复,服务崩溃即永久 "publishing";existing 复用逻辑(status!=="failed")会让重试复用卡死记录
- M9:组合发布器"官方失败→Web 兜底"可能重复上传(官方失败可能发生在上传已成功之后)
- m12:publish-service recoverStuckJobs 启动时无时间门槛,可误杀刚 enqueue 的正常任务;超时 race 后后台 driver 可能仍真发布成功(状态与平台事实分叉)
- m11:登录路由两处不一致(routes/publish.ts 仅 douyin/xiaohongshu;routes/accounts.ts 全平台)

## 收敛建议(按风险排序,勿一把梭)

1. **先做状态机对齐(低风险)**:给 4b publish_records 加 stuck 恢复(启动时 publishing>10min→failed)+ 发布超时外层 race(参考 publish-service.ts:159 的 5 分钟模式)。这一步就把 4b 拉到 4a 的健壮度,消灭"崩溃永久 publishing"。
2. **再定主栈**:建议保留 **4b(records/publishers)** 为主栈——它是作品中心化的(发布属于作品生命周期),适配器更新更勤;4a 的 jobs/drivers 抽象没有带来额外价值。把 PublishCenter 的账号面板数据改读 4b 的 records + platform_credentials,下线 publish_jobs 表与 publish-service。
3. **最后处理重复发布风险**:组合发布器(官方→Web 兜底)需要区分"未产生平台侧产物"与"已上传待提交"两类失败,仅前者允许兜底;涉及各官方发布器的错误分类,需逐平台实测。

## 2026-08-19 已落地的 P2 部分

- ✅ RPA 发布后 best-effort 解析 platformPostId(douyin /video/<id>、xhs /explore/<id>)
- ✅ 审核中不再当已发布:PublishOutput.reviewing → publish_records.reviewing 态;analytics-scheduler 每 6h 对账(能采到指标→转正 published,published_at 从过审起算;72h 未过审→failed)
- ✅ 收敛第 1 条(状态机对齐):publish_records 卡死恢复(启动时 publishing>10min→failed)+ 发布外层 10min 超时护栏
- ⏳ 上述第 2/3 条(主栈收敛、重复发布风险分类)未实施(需要一次真实发布回归后再动)

## 注意

- 抖音/小红书 RPA 的 postId 解析依赖内容管理页 DOM,页面改版会静默失效(返回 undefined,不影响发布本身)——首次真实发布后应验证 llm_usage→platform_metrics 回流是否真正跑通(端到端)。
- Publish.svelte / Publishing.svelte 疑似死页面(App.svelte 只挂载 PublishCenter),收敛时一并清理。
