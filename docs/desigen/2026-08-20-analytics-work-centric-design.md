# 数据看板重构：作品一级分类 + 多平台多账号矩阵

- **日期**:2026-08-20
- **状态**:已获用户逐节确认(数据模型 / 发布流+采集流 / 看板+回流+测试)
- **方案**:方案 A —— 账号成为一等公民,`accounts` 表为凭证唯一事实源

## 1. 背景与问题

当前数据看板仅支持抖音单账号:

- 看板 `/api/analytics/creator` 硬编码读 `config.analytics.sources[0]`(默认抖音),前端小红书 tab 写死 disabled
- 凭证存 `platform_credentials`,UNIQUE(platform, key_type) —— 一平台一类凭证只能存一行
- `accounts` 表与 `platform_credentials` 是两套分裂的事实源,靠 `bridgeAccountCredentials()` 覆盖式桥接,同平台第二个账号会顶掉第一个的 cookie
- 发布器全部 `getCredential(platform, key)` 单例读凭证,发布不感知账号;`publish_records` 无 `account_id` 列
- Playwright 采集浏览器画像按 platform 单键缓存,一平台一个登录态
- 采集调度器遍历单位是平台(adapter),不是账号

## 2. 目标

- 以**发布的作品为一级分类**,采集并分析其在多个平台、多个账号内的数据
- 所有 7 个平台(douyin / xiaohongshu / channels / kuaishou / bilibili / wechat_mp / zhihu)均支持绑定多账号
- 发布时可为每个平台选择具体账号,落账记录 account_id
- 看板:作品列表(全渠道汇总)→ 作品详情(平台×账号分行明细 + 趋势)

## 3. 用户确认的关键决策

| 决策点 | 结论 |
|---|---|
| 账号形态 | 每平台可绑多账号(矩阵模式) |
| 改造范围 | 发布 + 采集 + 看板全链改 |
| 看板形态 | 作品明细为主(列表 → 下钻 平台×账号 明细 + 汇总卡) |
| 平台范围 | 所有平台全多账号 |
| 同作品同平台多账号 | 允许,publish_records 多行 |
| 旧 platform_credentials 表 | 数据迁移后保留不删,标记 deprecated 留作回滚 |
| 采集并发 | 串行(单浏览器顺序跑账号),单账号失败跳过不拖死整轮 |

## 4. 数据模型(migrate v29)

### 新表 account_credentials(凭证唯一事实源)

```sql
CREATE TABLE account_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL,          -- session_cookie / access_token / app_secret ...
  value TEXT,
  updated_at TEXT,
  UNIQUE(account_id, key_type)
);
```

### ALTER

| 表 | 改动 | 理由 |
|---|---|---|
| publish_records | + account_id INTEGER NULL | 落账回答"发到哪个号";去重键 (work_id, platform) → (work_id, platform, account_id) |
| platform_metrics | + account_id INTEGER NULL | 账号级指标区分账号;作品级指标经 publish_record 间接归属 |
| accounts | + is_default INTEGER DEFAULT 0 | 每平台一个默认号,发布不传 accountId 时回落 |
| topic_scores | + platform TEXT DEFAULT 'all' | 现仅写 'all' 汇总行,预留按平台分权重 |

### 数据迁移

- platform_credentials 每行迁至对应平台默认账号的 account_credentials;该平台无账号则先建占位账号
- platform_credentials 保留不删,标记 deprecated

### 语义说明

- works.account_id 语义不变:作品归属的运营主体
- publish_records.account_id:实际发布到的账号

### 凭证访问层

- 新建 `src/db/account-credentials-repo.ts`:getAccountCredential / setAccountCredential
- 解析助手 `resolveCredential(platform, accountId?)`:指定账号 > 平台默认账号 > 报错
- 7 个发布器 + 2 个爬虫统一改由此层读取

## 5. 发布流

- `POST /api/works/:id/publish/:platform` 请求体加可选 accountId;不传用平台默认账号;传了校验账号属于此平台,否则 400
- `publishToPlatform(workId, platform, input, accountId?)`:复用查找按 (work_id, platform, account_id) 三元组;成功后落 platform_post_id + account_id + postUrl
- 7 个发布器机械统一改造:由 publishing.ts 解析 accountId 传入,发布器读 getAccountCredential
- Playwright 发布器画像目录:`~/.autoviral/browser-profiles/<platform>/<account_id>/`
- 发布 UI:每个平台行内账号下拉(默认选中默认号),支持同平台多号逐个发

## 6. 采集流

- 调度器遍历单位:平台 adapter → 活跃账号
  - 每日 03:00 账号指标:按账号逐个采
  - 每 6h 作品指标:publish_records 按账号分组,同账号连续采复用浏览器会话
- 爬虫适配器:`createDouyinScraper(accountId)` 式实例化,context 缓存键 `platform:accountId`,画像按账号分目录
- 官方 API 适配器(bilibili/kuaishou/zhihu/wechat):凭证统一走 resolveCredential
- 登录失效:跳过该账号、落错误、`/api/accounts/login-health` 按账号可见,不影响其他账号
- 手动采集 `POST /api/analytics/v2/collect` 加可选 accountId / workId

## 7. 看板

### 新端点

- `GET /api/analytics/works-dashboard` —— 作品列表:标题/日期/平台 chips/全渠道汇总(播放·赞·评·转·藏),支持平台、账号、时间筛选与排序
- `GET /api/analytics/works-dashboard/:workId` —— 作品详情:平台×账号分行明细 + 每行 7 天时间序列 + 顶部汇总卡

### Analytics.svelte「数据看板」tab 重构

- 一级 = 作品列表(不再是账号总览卡)
- 下钻 = 平台×账号明细表 + 汇总卡 + 趋势图
- 平台筛选 chips:全部/抖音/小红书/B站/...(删除写死 disabled 的小红书 tab)
- 账号总览(粉丝 4 卡)降级为次要区块或挪至「数据回收」tab

## 8. 48h 回流

- collectFeedback 按 publish_record 读取后按作品聚合:topic_scores 每作品每天一行,views/likes 跨平台跨账号求和,三率按合计加权(like_rate = Σlikes / Σviews)
- topic_scores 写 platform='all' 汇总行
- 权重计算(品类×情绪)读 'all' 行,逻辑不变

## 9. 错误处理

- 采集登录失效:跳过该账号 + 落错误 + login-health 可见
- 发布 accountId 不存在或跨平台:400 明确报错
- 平台默认账号被删:发布/采集回落该平台任一活跃账号并告警

## 10. 测试

- 凭证解析优先级(指定账号 > 平台默认 > 报错)
- 多账号发布落账(同作品同平台两账号两行,各带 account_id)
- 调度器按账号遍历 + 单账号失败不中断
- 看板聚合 SQL(多平台求和正确性)
- 回流跨平台汇总(两条 publish_record 三率加权)
- v29 迁移幂等 + 旧凭证正确落至默认账号

## 11. 影响面清单(从摸底报告导出)

主要改动文件:

- src/db/migrate.ts(v29)、src/db/account-credentials-repo.ts(新)
- src/server/routes/accounts.ts(去桥接、login-health 按账号)
- src/services/publishing.ts、src/server/routes/publish.ts
- src/services/publishers/*(7 个发布器)
- src/analytics-collector.ts、src/services/analytics-scheduler.ts
- src/services/platform-adapters/*(douyin-scraper、xiaohongshu-scraper、官方 API 适配器、playwright-helper)
- src/server/routes/analytics.ts、src/server/analytics-api.ts(新端点)
- web/src/pages/Analytics.svelte(看板 tab 重构)、发布 UI 组件(账号下拉)
- src/services/feedback-loop.ts(跨平台聚合)

已知不受影响:works 生产流水线、模板/渲染栈、topic 权重消费方(trend-research 读汇总权重,接口不变)。
