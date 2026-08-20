# 数据看板重构(作品一级分类 + 多平台多账号)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 账号成为一等公民(account_credentials 为凭证唯一事实源),发布/采集/看板全链支持多平台多账号,看板以作品为一级分类。

**Architecture:** 新表 account_credentials(account_id, key_type) 取代 platform_credentials 的平台级去重;publish_records/platform_metrics 加 account_id;凭证解析助手 resolveAccountCredential 统一"指定账号 > 平台默认 > 旧表兜底(过渡期)";采集调度器遍历单位从平台改为账号;看板新增 works-dashboard 端点,前端 Analytics.svelte dashboard tab 重构为作品列表 → 平台×账号明细。

**Tech Stack:** TypeScript (Node + Hono + better-sqlite3 + Playwright) / Svelte 5 / Vitest

**Spec:** `docs/desigen/2026-08-20-analytics-work-centric-design.md`

## Global Constraints

- 项目根:`D:\Autoviral`;改代码后 `npm run build` + 重启服务才生效(生产服务端口 3271,执行期间不要重启,最后统一验收)
- 测试:`npx vitest run tests/<path>`;全量 `npx vitest run`;当前基线 934/934 绿
- accounts.id 是 **TEXT(UUID)**,不是 INTEGER —— account_credentials.account_id 必须 TEXT
- 平台键别名:UI/账号体系用 `wechat_mp`,凭证/发布器用 `wechat` —— 所有跨表匹配必须过 `normalizePlatformKey()`
- accounts.status 活跃判定:`!a.status || a.status === "active"`
- commit message 结尾带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- `git add` 用显式路径,禁止 `git add -A`(仓库有未跟踪的字体/调试文件,曾两次误卷入)
- 旧表 platform_credentials **不删**,仅标记 deprecated;旧 playwright 画像目录(`browser-profiles/<platform>`)不迁移,各账号首次发布/采集时重新播种 cookie

---

### Task 1: migrate v29 — account_credentials 新表 + 三处 ALTER + 数据回填

**Files:**
- Modify: `src/db/migrate.ts`(MIGRATIONS 数组尾部 + migrate() 末尾回填调用)
- Test: `tests/db/migrate-v29.test.ts`

**Interfaces:**
- Produces: 表 `account_credentials(id INTEGER PK, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, key_type TEXT NOT NULL, value TEXT, updated_at TEXT, UNIQUE(account_id, key_type))`;列 `publish_records.account_id TEXT`、`platform_metrics.account_id TEXT`、`accounts.is_default INTEGER DEFAULT 0`、`topic_scores.platform TEXT DEFAULT 'all'`;导出函数 `backfillV29Accounts()`(幂等,供单测直接调)

- [ ] **Step 1: 写失败测试**

```ts
// tests/db/migrate-v29.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { getDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";

describe("migrate v29", () => {
  beforeEach(() => { migrate(); });

  it("创建 account_credentials 表及唯一约束", () => {
    const db = getDb();
    db.prepare("INSERT INTO accounts (id, name, platform, status, created_at, updated_at) VALUES ('a1','测试号','douyin','active','2026-01-01','2026-01-01')").run();
    db.prepare("INSERT INTO account_credentials (account_id, key_type, value) VALUES ('a1','session_cookie','x')").run();
    expect(() =>
      db.prepare("INSERT INTO account_credentials (account_id, key_type, value) VALUES ('a1','session_cookie','y')").run()
    ).toThrow();
  });

  it("publish_records / platform_metrics / topic_scores 有 account_id/platform 列", () => {
    const db = getDb();
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
    expect(cols("publish_records")).toContain("account_id");
    expect(cols("platform_metrics")).toContain("account_id");
    expect(cols("accounts")).toContain("is_default");
    expect(cols("topic_scores")).toContain("platform");
  });

  it("幂等:重复执行 migrate 不报错", () => {
    expect(() => migrate()).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/db/migrate-v29.test.ts`
Expected: FAIL(account_credentials 表不存在)

- [ ] **Step 3: 实现 v29**

MIGRATIONS 尾部(v28 之后)追加:

```ts
  {
    version: 29,
    name: "account_credentials_and_account_dimension",
    sql: `
-- 2026-08-20 数据看板重构(方案A):账号成为一等公民。
-- account_credentials 取代 platform_credentials 成为凭证唯一事实源,
-- 去重键从 (platform, key_type) 降为 (account_id, key_type),支持一平台多账号。
CREATE TABLE IF NOT EXISTS account_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key_type TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, key_type)
);
CREATE INDEX IF NOT EXISTS idx_account_credentials_account ON account_credentials(account_id);

ALTER TABLE publish_records ADD COLUMN account_id TEXT;
ALTER TABLE platform_metrics ADD COLUMN account_id TEXT;
ALTER TABLE accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
ALTER TABLE topic_scores ADD COLUMN platform TEXT NOT NULL DEFAULT 'all';
CREATE INDEX IF NOT EXISTS idx_publish_records_account ON publish_records(account_id);
`,
  },
```

注意:SQLite 的 ALTER ADD COLUMN 对已存在列会报错 —— migrate 的版本机制保证只跑一次;但若开发库已被手动 alter 过会炸,测试用例用全新内存库即可(参照 tests/db/ 既有测试的连接初始化方式,若 connection.ts 支持 `AV_DB_PATH` 环境变量则用临时文件,动态 import + 清 env,见 memory 教训"vitest env 测试动态 import+清 env")。

- [ ] **Step 4: 实现数据回填(纯 JS,放在 migrate.ts 末尾,migrate() 每次调用末尾执行,幂等)**

```ts
/** v29 数据回填(幂等):旧 platform_credentials → 各平台默认账号的 account_credentials;
 *  publish_records.account_id 回填为该平台默认账号。 */
export function backfillV29Accounts(): void {
  const db = getDb();
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_credentials'").get();
  if (!hasTable) return;

  const platforms = db.prepare("SELECT DISTINCT platform FROM platform_credentials").pluck().all() as string[];
  for (const platform of platforms) {
    // 该平台没有账号 → 建占位账号;有 → 取最早创建的一个
    let account = db.prepare("SELECT id FROM accounts WHERE platform = ? ORDER BY created_at ASC LIMIT 1").get(platform) as { id: string } | undefined;
    if (!account) {
      const id = randomUUID();
      const now = new Date().toISOString();
      db.prepare("INSERT INTO accounts (id, name, platform, tone_profile, status, created_at, updated_at) VALUES (?, ?, ?, '{}', 'active', ?, ?)")
        .run(id, `默认账号-${platform}`, platform, now, now);
      account = { id };
    }
    // 每平台保证恰有一个默认账号(此前无条件)
    db.prepare("UPDATE accounts SET is_default = 0 WHERE platform = ?").run(platform);
    db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(account.id);
    // 凭证搬迁:旧表值不覆盖新表已有值(幂等 + 保护已手工配置的新凭证)
    db.prepare(`
      INSERT INTO account_credentials (account_id, key_type, value, updated_at)
      SELECT ?, key_type, value, updated_at FROM platform_credentials WHERE platform = ?
      ON CONFLICT(account_id, key_type) DO NOTHING
    `).run(account.id, platform);
  }
  // 历史发布记录回填默认账号(只补 NULL)
  db.prepare(`
    UPDATE publish_records SET account_id = (
      SELECT id FROM accounts WHERE accounts.platform = publish_records.platform AND is_default = 1 LIMIT 1
    ) WHERE account_id IS NULL
  `).run();
}
```

`migrate()` 函数末尾(loop 之后)调用 `backfillV29Accounts();`,并 `import { randomUUID } from "node:crypto";`。

注意别名坑:platform_credentials 里 `wechat_mp` 账号体系的凭证存在 `wechat` 键下,回填时 `accounts.platform='wechat_mp'` 匹配不到 `platform_credentials.platform='wechat'`。在 platforms 循环里加别名归一:`const accountPlatform = platform === "wechat" ? "wechat_mp" : platform;`,accounts 查询/占位账号用 accountPlatform,凭证搬迁仍用原 platform。

- [ ] **Step 5: 跑测试确认通过 + 回归 db 测试目录**

Run: `npx vitest run tests/db/`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/db/migrate.ts tests/db/migrate-v29.test.ts
git commit -m "feat(db): v29 account_credentials + 账号维度列 + 旧凭证回填"
```

---

### Task 2: account-credentials-repo + 凭证解析助手

**Files:**
- Create: `src/db/account-credentials-repo.ts`
- Create: `src/services/credential-resolver.ts`
- Test: `tests/db/account-credentials-repo.test.ts`、`tests/services/credential-resolver.test.ts`

**Interfaces:**
- Consumes: Task 1 的表结构与 `accounts.is_default`
- Produces:
  - `setAccountCredential(accountId: string, keyType: string, value: string): void`
  - `getAccountCredential(accountId: string, keyType: string): string | undefined`
  - `deleteAccountCredentialsByAccount(accountId: string): void`
  - `normalizePlatformKey(platform: string): string`(wechat ↔ wechat_mp 双向归一到凭证键 wechat)
  - `resolveAccountCredential(platform: string, accountId: string | undefined, keyType: string): string | undefined` —— 优先级:指定账号 > 平台默认账号 > 平台任一活跃账号(console.warn 告警)> 旧表 platform_credentials(deprecated 兜底)

- [ ] **Step 1: 写失败测试**

```ts
// tests/services/credential-resolver.test.ts(要点)
// ① 指定账号命中 → 返回该账号值
// ② 不指定账号 → 返回 is_default=1 账号的值
// ③ 无默认但有活跃账号 → 返回该活跃账号值(并告警)
// ④ 新表全无 → 回落旧 platform_credentials
// ⑤ 全无 → undefined
// ⑥ wechat_mp 平台解析时旧表兜底读 wechat 键
```

- [ ] **Step 2: 跑测试确认失败**(模块不存在)

- [ ] **Step 3: 实现**

`src/db/account-credentials-repo.ts`:

```ts
import { getDb } from "./connection.js";

export function setAccountCredential(accountId: string, keyType: string, value: string): void {
  getDb().prepare(`
    INSERT INTO account_credentials (account_id, key_type, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(account_id, key_type) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(accountId, keyType, value);
}

export function getAccountCredential(accountId: string, keyType: string): string | undefined {
  const row = getDb().prepare(
    "SELECT value FROM account_credentials WHERE account_id = ? AND key_type = ?"
  ).get(accountId, keyType) as { value: string } | undefined;
  return row?.value;
}

export function deleteAccountCredentialsByAccount(accountId: string): void {
  getDb().prepare("DELETE FROM account_credentials WHERE account_id = ?").run(accountId);
}
```

`src/services/credential-resolver.ts`:

```ts
import { getAccountCredential } from "../db/account-credentials-repo.js";
import { getCredential } from "../db/platform-credentials-repo.js";
import { getDb } from "../db/connection.js";

/** UI/账号体系键 → 凭证存储键(wechat_mp 是 UI 侧键,凭证统一存 wechat) */
export function normalizePlatformKey(platform: string): string {
  return platform === "wechat_mp" ? "wechat" : platform;
}

/**
 * 凭证解析(2026-08-20 方案A):指定账号 > 平台默认账号 > 平台任一活跃账号(告警)
 * > 旧 platform_credentials(deprecated 兜底,矩阵改造过渡期保留)。
 */
export function resolveAccountCredential(
  platform: string,
  accountId: string | undefined,
  keyType: string,
): string | undefined {
  const db = getDb();
  if (accountId) {
    const v = getAccountCredential(accountId, keyType);
    if (v) return v;
  }
  const def = db.prepare(
    "SELECT id FROM accounts WHERE platform = ? AND is_default = 1 AND (status IS NULL OR status = 'active') LIMIT 1"
  ).get(platform) as { id: string } | undefined;
  if (def) {
    const v = getAccountCredential(def.id, keyType);
    if (v) return v;
  }
  const any = db.prepare(
    "SELECT id FROM accounts WHERE platform = ? AND (status IS NULL OR status = 'active') ORDER BY created_at ASC LIMIT 1"
  ).get(platform) as { id: string } | undefined;
  if (any && any.id !== def?.id) {
    const v = getAccountCredential(any.id, keyType);
    if (v) {
      console.warn(`[credential-resolver] ${platform} 无默认账号凭证,回落活跃账号 ${any.id}`);
      return v;
    }
  }
  // deprecated 兜底:旧表(键已归一)
  return getCredential(normalizePlatformKey(platform), keyType);
}
```

- [ ] **Step 4: 跑测试确认通过**:`npx vitest run tests/db/account-credentials-repo.test.ts tests/services/credential-resolver.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/db/account-credentials-repo.ts src/services/credential-resolver.ts tests/db/account-credentials-repo.test.ts tests/services/credential-resolver.test.ts
git commit -m "feat: account-credentials repo + 凭证解析助手(指定>默认>活跃>旧表)"
```

---

### Task 3: accounts 路由去桥接 + 默认账号 + 按账号登录

**Files:**
- Modify: `src/server/routes/accounts.ts`(bridgeAccountCredentials 改写、新增默认账号与登录端点)
- Modify: `src/db/accounts-repo.ts`(listAccountsByPlatform / setDefaultAccount / DbAccount.is_default)
- Modify: `src/db/types.ts`(DbAccount 加 is_default)
- Test: `tests/server/accounts-routes.test.ts`(不存在则新建,参照 tests/server/ 既有路由测试)

**Interfaces:**
- Consumes: Task 2 的 setAccountCredential / normalizePlatformKey
- Produces:
  - `accountsRepo.listAccountsByPlatform(platform: string): DbAccount[]`
  - `accountsRepo.setDefaultAccount(platform: string, accountId: string): void`(同事务:该平台全清 0 再置 1)
  - `POST /api/accounts/:id/default` → 设为该平台默认账号
  - `POST /api/accounts/:id/login` → 按账号触发浏览器登录,成功后 cookie 落 account_credentials
  - `GET /api/accounts/login-health` 返回按账号维度(原按平台)

- [ ] **Step 1: 写失败测试**

```ts
// 要点:
// ① POST /api/accounts 创建账号(cookie 字段)→ account_credentials 有 session_cookie,
//    且 platform_credentials 旧表【不再被写入】(去桥接断言)
// ② 同平台建第二个账号 → 第一个账号的 account_credentials 不受影响(原 bug:互相顶掉)
// ③ POST /api/accounts/:id/default → accounts 表该平台仅该行 is_default=1
// ④ DELETE 账号 → 其 account_credentials 级联删除(ON DELETE CASCADE,注意 SQLite 需
//    PRAGMA foreign_keys=ON;若 connection.ts 未开,则在 deleteAccount 内显式调
//    deleteAccountCredentialsByAccount,测试断言其一即可)
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

accounts.ts 的 `bridgeAccountCredentials(platform, username, cookie)` 改为 `storeAccountCredentials(accountId: string, platform: string, username?: string | null, cookie?: string | null): string[]` —— 逻辑结构不变(各平台字段映射规则原样保留),所有 `setCredential(platform, key, val)` 替换为 `setAccountCredential(accountId, key, val)`;平台键归一不再必要(凭证挂账号),但 bilibili 的 SESSDATA 解析、wechat_mp 的 app_id/app_secret 映射保留原样。调用点(POST / 与 PUT /:id)传入新 account id。

新增端点:

```ts
// POST /api/accounts/:id/default — 设为该平台默认账号
accountsRoutes.post("/:id/default", (c) => {
  const account = accountsRepo.getAccount(c.req.param("id"));
  if (!account) return c.json({ error: "Account not found" }, 404);
  accountsRepo.setDefaultAccount(account.platform, account.id);
  return c.json({ success: true });
});

// POST /api/accounts/:id/login — 按账号浏览器登录(仅 RPA 平台)
accountsRoutes.post("/:id/login", async (c) => {
  const account = accountsRepo.getAccount(c.req.param("id"));
  if (!account) return c.json({ error: "Account not found" }, 404);
  if (!RPA_PLATFORMS.has(account.platform)) return c.json({ error: "该平台不支持浏览器登录" }, 400);
  const ok = await triggerLogin(account.platform, account.id);
  // 登录成功后把画像中的 cookie 收进 account_credentials(发布器登录内部仍写旧表,
  // 此处桥到账号维度;旧表保留是 deprecated 兜底,见 credential-resolver)
  if (ok) {
    const legacy = getCredential(normalizePlatformKey(account.platform), "session_cookie");
    if (legacy) setAccountCredential(account.id, "session_cookie", legacy);
  }
  return c.json({ success: ok });
});
```

accounts-repo.ts 追加:

```ts
export function listAccountsByPlatform(platform: string): DbAccount[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM accounts WHERE platform = ? ORDER BY is_default DESC, created_at ASC").all(platform) as Record<string, unknown>[];
  return rows.map(rowToAccount);
}

export function setDefaultAccount(platform: string, accountId: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("UPDATE accounts SET is_default = 0 WHERE platform = ?").run(platform);
    db.prepare("UPDATE accounts SET is_default = 1 WHERE id = ?").run(accountId);
  })();
}
```

types.ts 的 DbAccount 加 `is_default?: number;`,rowToAccount 加 `is_default: row.is_default as number | undefined`。

旧端点 `POST /login/:platform` 保留(前端可能还在用),改为转发到该平台默认账号的 `/:id/login` 逻辑;`GET /login-health` 改为按账号数组返回(每账号 {accountId, name, platform, healthy}),实现上逐账号调 login-health 服务的单平台校验 —— 读 src/services/login-health.ts 现有 verifyAllPlatforms 结构,最小改动:包一层按账号迭代,凭证用 resolveAccountCredential(platform, accountId, ...)。

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/server/ tests/db/`

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/accounts.ts src/db/accounts-repo.ts src/db/types.ts tests/server/accounts-routes.test.ts
git commit -m "feat(accounts): 凭证落账号维度+默认账号+按账号登录,去覆盖式桥接"
```

---

### Task 4: 发布链路 accountId(record 落账 + 路由 + publishing.ts)

**Files:**
- Modify: `src/db/publish-records-repo.ts`(createPublishRecord/listPublishRecords/updatePublishRecord 支持 account_id;DbPublishRecord 加 account_id)
- Modify: `src/db/types.ts`(DbPublishRecord 加 `account_id?: string`)
- Modify: `src/services/publishing.ts`(resolvePublishAccountId + publishToPlatform 读 input.accountId + 三元组去重 + publisher 缓存键)
- Modify: `src/services/publishers/types.ts`(PublishInput 加 `accountId?: string`;Publisher.isConfigured 签名加可选 accountId)
- Modify: `src/server/routes/publish.ts`(body.accountId 透传 + 校验)
- Test: `tests/services/publish-account.test.ts`

**Interfaces:**
- Produces:
  - `resolvePublishAccountId(platform: string, accountId?: string): string | undefined`(publishing.ts 导出)—— 显式 accountId 必须存在且 platform 匹配,否则 throw;缺省回落平台默认账号;再缺省 undefined(旧凭证兜底)
  - `PublishInput.accountId?: string`
  - `DbPublishRecord.account_id?: string`
  - 去重语义:同 (work_id, platform, account_id) 复用非 failed 记录

- [ ] **Step 1: 写失败测试**

```ts
// 要点(mock publisher,不真发):
// ① publishToPlatform 传 accountId → publish_records 行带 account_id
// ② 同作品同平台不同 accountId 连发两次 → 两行记录
// ③ 同作品同平台同 accountId 连发两次 → 仍一行(复用)
// ④ accountId 属于别的平台 → throw "不属于平台"
// ⑤ 不传 accountId → 落该平台默认账号 id
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

publishing.ts 追加:

```ts
import { getAccount, listAccountsByPlatform } from "../db/accounts-repo.js";

/** 解析发布目标账号:显式 > 平台默认 > undefined(走旧凭证兜底)。显式值非法直接抛错。 */
export function resolvePublishAccountId(platform: string, accountId?: string): string | undefined {
  if (accountId) {
    const account = getAccount(accountId);
    if (!account) throw new Error(`账号不存在: ${accountId}`);
    if (account.platform !== platform) throw new Error(`账号 ${accountId} 不属于平台 ${platform}`);
    return accountId;
  }
  const def = listAccountsByPlatform(platform).find((a) => a.is_default === 1);
  return def?.id;
}
```

`publishToPlatform` 开头(accountId 从 input 取):

```ts
const accountId = resolvePublishAccountId(platform, input.accountId);
const existing = recordsRepo.listPublishRecords({ workId }).find(
  (r) => r.platform === platform && r.status !== "failed" && (r.account_id ?? null) === (accountId ?? null)
);
```

createPublishRecord 调用处加 `account_id: accountId ?? null`;成功落账处不变(account_id 建行时已写)。publisher 缓存键改 `${key}:${accountId ?? "legacy"}`(resolvePublisher/resolvePublisherForWork 加 accountId 参,publish 前调用方传入)——**注意**:此改动与 Task 5 的 PlaywrightPublisher 多 context 配合;若 Task 5 未完成,缓存键先按 platform 保持,Task 5 一并改。为减少耦合,本任务只把 accountId 透传进 PublishInput,publisher 缓存保持现状,Task 5 再改缓存键。

publish.ts 路由:`publishToPlatform(workId, platform, { ...input, accountId: body.accountId as string | undefined })`,try/catch resolvePublishAccountId 的 Error 返回 400 `{ error: err.message }`。

types.ts:`PublishInput` 加 `accountId?: string`;`DbPublishRecord` 加 `account_id?: string`;publish-records-repo 的 rowToRecord 加 account_id 映射,createPublishRecord 的 INSERT 加 account_id 列,listPublishRecords filters 加 `accountId?: string`(WHERE account_id = ?)。

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/services/ tests/db/`

- [ ] **Step 5: Commit**

```bash
git add src/db/publish-records-repo.ts src/db/types.ts src/services/publishing.ts src/services/publishers/types.ts src/server/routes/publish.ts tests/services/publish-account.test.ts
git commit -m "feat(publish): 发布落账 account_id,三元组去重,显式账号校验"
```

---

### Task 5: Playwright 发布器多账号画像

**Files:**
- Modify: `src/services/publishers/playwright-publisher.ts`(context 单例 → Map,画像目录按账号)
- Modify: `src/services/publishing.ts`(publisher 缓存键 `${key}:${accountId ?? "legacy"}`)
- Test: `tests/publishers/playwright-publisher-account.test.ts`

**Interfaces:**
- Consumes: Task 4 的 PublishInput.accountId
- Produces: `PlaywrightPublisher.ensureBrowser(accountId?: string)`;画像目录 `<dataDir>/browser-profiles/<platform>/<accountKey>/`(accountKey = accountId ?? "legacy")

- [ ] **Step 1: 写失败测试**(不真开浏览器 —— 把画像目录解析抽成纯函数测)

```ts
// playwright-publisher.ts 导出纯函数:
export function resolveProfileDir(platform: string, accountId?: string): string {
  return join(dataDir, "browser-profiles", platform, accountId ?? "legacy");
}
// 测试:同平台两账号目录不同;无 accountId 落 legacy;
// isConfigured(accountId) 读对应账号凭证而非平台单例
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

playwright-publisher.ts:
- `protected context: BrowserContext | null` → `protected contexts = new Map<string, BrowserContext>()`
- `ensureBrowser(accountId?: string)`:key = accountId ?? "legacy";画像目录 resolveProfileDir(this.platform, accountId);cookie 播种改 `resolveAccountCredential(this.platform, accountId, "session_cookie")`
- `isConfigured(accountId?: string)`:同样改 resolveAccountCredential
- `publish(input)` 内部所有 ensureBrowser()/isConfigured() 调用点传 `input.accountId`(在 DouyinPublisher / XiaohongshuPublisher / ChannelsPublisher / ZhihuPublisher / ZhihuVideoPublisher 各自的 publish/login 中,凡 `this.ensureBrowser()` 改为 `this.ensureBrowser(input.accountId)`;login(accountId?: string) 同)
- publishing.ts:publisherCache 键改 `` `${key}:${accountId ?? "legacy"}` ``,resolvePublisher/resolvePublisherForWork 加第三参 accountId;publishToPlatform 调用处传已解析的 accountId;triggerLogin(platform, accountId?) 透传

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/publishers/ tests/services/`

- [ ] **Step 5: Commit**

```bash
git add src/services/publishers/playwright-publisher.ts src/services/publishers/douyin-publisher.ts src/services/publishers/xiaohongshu-publisher.ts src/services/publishers/channels-publisher.ts src/services/publishers/zhihu-publisher.ts src/services/publishers/zhihu-video-publisher.ts src/services/publishing.ts tests/publishers/playwright-publisher-account.test.ts
git commit -m "feat(publishers): Playwright 画像按账号隔离,context 多实例"
```

---

### Task 6: 官方 API 发布器/适配器凭证改走账号维度

**Files:**
- Modify: `src/services/publishers/` 下所有官方 API 发布器(bilibili-official-publisher.ts、kuaishou、wechat、zhihu 官方等 —— 执行时 `grep -rn "getCredential" src/services/publishers/ src/services/platform-adapters/` 找全)
- Modify: `src/server/analytics-api.ts`(registerAllAdapters 改工厂注册,见 Task 7 接口)
- Test: `tests/publishers/official-credential-resolution.test.ts`

**Interfaces:**
- Produces: 所有官方 API 读取点统一为 `resolveAccountCredential(platform, accountId, keyType)`

- [ ] **Step 1: 写失败测试**

```ts
// ① bilibili 发布器构造/发布时凭证来自指定账号的 account_credentials
//    (mock fetch,断言请求用了该账号的 access_token)
// ② 账号无凭证但旧表有 → 仍可用(deprecated 兜底)
// ③ 全无 → 发布失败报"缺少凭证"类错误而非静默
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**:逐文件把 `getCredential(platform, key)` 换成 `resolveAccountCredential(platform, accountId, key)`;发布器从 `input.accountId` 取 accountId;构造期读凭证的(如官方 API adapter 的 constructor 参数)改为发布/采集时惰性读取(构造函数改为接收 platform 键,凭证在使用点 resolve)

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/publishers/`

- [ ] **Step 5: Commit**

```bash
git add src/services/publishers/ src/services/platform-adapters/ tests/publishers/official-credential-resolution.test.ts
git commit -m "feat: 官方 API 发布器/适配器凭证统一走 resolveAccountCredential"
```

---

### Task 7: 采集 adapter 工厂化 + 爬虫按账号实例化

**Files:**
- Modify: `src/services/platform-adapters/registry.ts`(工厂注册 + 按账号取实例)
- Modify: `src/services/platform-adapters/douyin-scraper.ts`、`xiaohongshu-scraper.ts`(构造函数接 accountId,contextKey 按账号)
- Modify: `src/services/platform-adapters/playwright-helper.ts`(getContext/saveState/closeContext 的 key 参数语义改为 contextKey 字符串,调用方传 `platform:accountId`;画像目录 PROFILE_DIR/<contextKey 末段> —— 即 `<platform>/<accountId>` 两级)
- Modify: `src/server/analytics-api.ts`(registerAllAdapters 改注册工厂)
- Test: `tests/services/platform-adapters/registry-account.test.ts`

**Interfaces:**
- Produces:
  - `registerAdapterFactory(platform: string, factory: (accountId?: string) => PlatformAdapter): void`
  - `getAdapterForAccount(platform: string, accountId?: string): PlatformAdapter | undefined`(实例缓存键 `${platform}:${accountId ?? "default"}`)
  - 保留 `getAdapter(platform)`(= getAdapterForAccount(platform, undefined)),旧调用不断

- [ ] **Step 1: 写失败测试**

```ts
// ① 注册工厂后 getAdapterForAccount("douyin","a1") 与 ("douyin","a2") 返回不同实例
// ② 同参数返回同一缓存实例
// ③ scraper 的 contextKey:a1 → "douyin:a1";无 accountId → "douyin:default"
//    (把 contextKey 解析抽成 scraper 上的 readonly 属性或纯函数便于断言)
// ④ playwright-helper.getContext("douyin:a1") 画像目录 = PROFILE_DIR/douyin/a1
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

douyin-scraper.ts:

```ts
export class DouyinScraper implements PlatformAdapter {
  readonly platform = "douyin";
  readonly label = "抖音";
  readonly contextKey: string;
  constructor(readonly accountId?: string) {
    this.contextKey = `douyin:${accountId ?? "default"}`;
  }
  // 所有 getContext("douyin") → getContext(this.contextKey);
  // saveState("douyin") → saveState(this.contextKey)
}
```

playwright-helper.ts:getContext(contextKey: string, ...) 内部 `const profileDir = join(PROFILE_DIR, ...contextKey.split(":"))`(冒号两段 → 两级目录);xiaohongshu-scraper 同构改造。

registry.ts 加工厂 Map + getAdapterForAccount 缓存;analytics-api.ts 的 registerAllAdapters:官方 API 改 `registerAdapterFactory("kuaishou", (accountId) => new KuaishouAdapter(resolveAccountCredential("kuaishou", accountId, "app_id") ?? process.env["KUAISHOU_APP_ID"], ...))` 形式;爬虫改 `registerAdapterFactory("douyin", (accountId) => new DouyinScraper(accountId))`。

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/services/`

- [ ] **Step 5: Commit**

```bash
git add src/services/platform-adapters/ src/server/analytics-api.ts tests/services/platform-adapters/registry-account.test.ts
git commit -m "feat(analytics): adapter 工厂化+按账号实例,爬虫画像按账号隔离"
```

---

### Task 8: 调度器按账号遍历 + 指标落 account_id

**Files:**
- Modify: `src/services/analytics-scheduler.ts`
- Modify: `src/db/platform-metrics-repo.ts`(createMetric 支持 account_id)
- Modify: `src/analytics-collector.ts`(collectAll 按账号;可选 accountId/workId 过滤)
- Modify: `src/server/analytics-api.ts`(POST /collect 接 accountId/workId)
- Test: `tests/services/analytics-scheduler-account.test.ts`

**Interfaces:**
- Consumes: Task 7 的 getAdapterForAccount;Task 1 的 platform_metrics.account_id
- Produces: `collectAll(options?: { accountId?: string; workId?: string }): Promise<CollectResult>`

- [ ] **Step 1: 写失败测试**

```ts
// ① 账号指标循环:两账号同平台 → 两行 account 指标,各带 account_id
// ② 某账号 adapter 抛错 → 循环继续,其余账号正常落库
// ③ 作品指标:publish_record 有 account_id → 用该账号 adapter 采
// ④ account_id 为 NULL 的历史记录 → getAdapterForAccount(platform, undefined) 兜底
// ⑤ collectAll({ accountId }) 只采该账号
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

scheduler 账号指标段改为:

```ts
const accounts = listAccounts().filter((a) => !a.status || a.status === "active");
for (const account of accounts) {
  const adapter = getAdapterForAccount(account.platform, account.id);
  if (!adapter) continue;
  try {
    const metrics = await adapter.collectAccountMetrics();
    await createMetric({
      platform: account.platform,
      account_id: account.id,
      metric_type: "account",
      collected_at: metrics.collectedAt,
      followers: metrics.followers,
      raw_data: metrics.rawData,
    });
  } catch (e) {
    console.error(`[analytics-scheduler] ${account.platform}/${account.name} 采集失败(跳过):`, e);
  }
}
```

作品指标段:`getAdapter(record.platform)` → `getAdapterForAccount(record.platform, record.account_id ?? undefined)`;createMetric 调用加 `account_id: record.account_id ?? null`。审核对账段同样换 getAdapterForAccount。基线段保持平台级不变。collectAll(analytics-collector.ts)同构改造 + 可选过滤参数;POST /api/analytics/v2/collect body 透传。

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/services/`

- [ ] **Step 5: Commit**

```bash
git add src/services/analytics-scheduler.ts src/db/platform-metrics-repo.ts src/analytics-collector.ts src/server/analytics-api.ts tests/services/analytics-scheduler-account.test.ts
git commit -m "feat(analytics): 调度器遍历账号,指标落 account_id,单账号失败跳过"
```

---

### Task 9: works-dashboard 端点(作品一级分类聚合)

**Files:**
- Modify: `src/server/routes/analytics.ts`
- Test: `tests/server/works-dashboard.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/analytics/works-dashboard?platform=&accountId=&from=&to=` → `{ works: WorkDashboardRow[] }`
    `WorkDashboardRow = { workId, title, workType, category, publishedAt, platforms: string[], totals: { views, likes, comments, shares, collects }, records: Array<{ recordId, platform, accountId, accountName, status, publishedAt, metrics: { views, likes, comments, shares, collects, completionRate } | null }> }`
  - `GET /api/analytics/works-dashboard/:workId` → 上行单作品 + `series: Array<{ recordId, points: Array<{ collectedAt, views, likes, comments, shares, collects }> }>`(近 7 天)

- [ ] **Step 1: 写失败测试**

```ts
// 数据种子:作品 W 有两条 published 记录(douyin/acc1 views=100, xiaohongshu/acc2 views=200),
// 每条两次采集(取最新)。断言:
// ① 列表返回一个作品,totals.views=300(最新值求和,不是采集次数求和)
// ② records 两行,各带 accountName
// ③ platform=douyin 过滤后 totals.views=100
// ④ 详情 series 每个 recordId 两条点,按 collected_at 升序
// ⑤ reviewing 记录无指标时 metrics=null 且不计入 totals
```

- [ ] **Step 2: 跑测试确认失败**(404)

- [ ] **Step 3: 实现**

routes/analytics.ts 追加:

```ts
// GET /api/analytics/works-dashboard — 作品一级分类看板(2026-08-20 重构)
analyticsRoutes.get("/works-dashboard", (c) => {
  const db = getDb();
  const platform = c.req.query("platform");
  const accountId = c.req.query("accountId");
  const conds = ["pr.status IN ('published','reviewing')"];
  const params: unknown[] = [];
  if (platform) { conds.push("pr.platform = ?"); params.push(platform); }
  if (accountId) { conds.push("pr.account_id = ?"); params.push(accountId); }
  const rows = db.prepare(`
    SELECT w.id AS work_id, w.title, w.type AS work_type, w.topic_category,
           pr.id AS record_id, pr.platform, pr.account_id, pr.status, pr.published_at,
           a.name AS account_name,
           pm.views, pm.likes, pm.comments, pm.shares, pm.collects, pm.completion_rate
    FROM publish_records pr
    JOIN works w ON w.id = pr.work_id
    LEFT JOIN accounts a ON a.id = pr.account_id
    LEFT JOIN platform_metrics pm ON pm.id = (
      SELECT id FROM platform_metrics WHERE publish_record_id = pr.id AND metric_type = 'work'
      ORDER BY collected_at DESC LIMIT 1
    )
    WHERE ${conds.join(" AND ")}
    ORDER BY pr.published_at DESC
  `).all(...params) as Array<Record<string, unknown>>;
  // JS 侧按 work_id 聚合 totals + records(代码略:分组求和,metrics 全 null → null)
  // ...聚合后 return c.json({ works });
});

// GET /api/analytics/works-dashboard/:workId — 作品详情:明细 + 近 7 天序列
analyticsRoutes.get("/works-dashboard/:workId", (c) => {
  // 复用上行单作品查询(WHERE pr.work_id = ?),再按记录查:
  // SELECT publish_record_id, views, likes, comments, shares, collects, collected_at
  // FROM platform_metrics
  // WHERE publish_record_id IN (...) AND metric_type='work'
  //   AND datetime(collected_at) >= datetime('now', '-7 days')
  // ORDER BY collected_at ASC
});
```

注意:子查询取"最新一条指标"用 `pm.id = (SELECT ... LIMIT 1)` 形式,替代原 creator 端点的 `GROUP BY pr.id HAVING MAX(collected_at)`(那个写法在含 NULL 的 LEFT JOIN 下会丢 reviewing 行)。

- [ ] **Step 4: 跑测试确认通过**:`npx vitest run tests/server/works-dashboard.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/analytics.ts tests/server/works-dashboard.test.ts
git commit -m "feat(analytics): works-dashboard 作品维度聚合端点(列表+详情+7日序列)"
```

---

### Task 10: feedback-loop 跨平台跨账号汇总

**Files:**
- Modify: `src/services/feedback-loop.ts`
- Test: `tests/services/feedback-loop.test.ts`(已有,改/加用例)

**Interfaces:**
- Produces: `collectFeedback()` 语义变:topic_scores 每作品每天一行(platform='all'),views/likes 等跨该作品全部 published 记录求和,三率按合计加权;`getTopicWeights()`/`refreshPurposePerformance()` 只读 platform='all' 行

- [ ] **Step 1: 写失败测试**

```ts
// 种子:作品 W 两条 published 记录(平台 A views=1000 likes=50;平台 B views=2000 likes=150),
// 均超过 48h。断言:
// ① topic_scores 仅一行,platform='all',views=3000
// ② like_rate = 200/3000(加权,不是两率取平均)
// ③ 同日再跑幂等(先删后插,仍一行)
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

collectFeedback 主查询改为两层:内层取每条记录最新指标(同 Task 9 的 `pm.id = (SELECT ... LIMIT 1)` 写法),外层按 work_id 聚合:

```ts
const rows = db.prepare(`
  SELECT pr.work_id,
         MIN(w.topic_id) AS topic_id, MIN(w.topic_category) AS topic_category, MIN(w.emotion_type) AS emotion_type,
         SUM(pm.views) AS views, SUM(pm.likes) AS likes, SUM(pm.comments) AS comments,
         SUM(pm.shares) AS shares, SUM(pm.collects) AS collects,
         AVG(pm.completion_rate) AS completion_rate
  FROM publish_records pr
  JOIN works w ON w.id = pr.work_id
  JOIN platform_metrics pm ON pm.id = (
    SELECT id FROM platform_metrics WHERE publish_record_id = pr.id AND metric_type = 'work'
    ORDER BY collected_at DESC LIMIT 1
  )
  WHERE pr.status = 'published'
    AND pr.published_at IS NOT NULL
    AND datetime(pr.published_at) <= datetime('now', '-48 hours')
  GROUP BY pr.work_id
`).all();
```

INSERT 加 platform 列写 'all';DELETE 条件加 `AND platform = 'all'`;getTopicWeights/refreshPurposePerformance 的 SQL 加 `WHERE platform = 'all'`(refreshPurposePerformance 的全局均值同理)。

- [ ] **Step 4: 跑测试确认通过 + 回归**:`npx vitest run tests/services/feedback-loop.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/feedback-loop.ts tests/services/feedback-loop.test.ts
git commit -m "feat(feedback): 三率回流按作品跨平台汇总,topic_scores 写 platform='all'"
```

---

### Task 11: 前端 api.ts + 发布 UI 账号下拉

**Files:**
- Modify: `web/src/lib/api.ts`(Account 类型、publishWorkToPlatform、新增 getWorksDashboard/getWorkDashboard/loginAccount/setDefaultAccount)
- Modify: `web/src/components/PublishBoard.svelte`(平台行内账号下拉)
- Test: 前端无测试基座,手动验证列入 Task 13

**Interfaces:**
- Consumes: Task 3/4/9 的端点
- Produces:
  - `publishWorkToPlatform(workId, platform, input?, accountId?)`
  - `getWorksDashboard(params?: { platform?: string; accountId?: string }): Promise<{ works: WorkDashboardRow[] }>`
  - `getWorkDashboard(workId: string): Promise<WorkDashboardDetail>`
  - `loginAccount(accountId: string): Promise<{ success: boolean }>`
  - `setDefaultAccount(accountId: string): Promise<{ success: boolean }>`

- [ ] **Step 1: api.ts 追加/修改**

```ts
export async function publishWorkToPlatform(
  workId: string, platform: string,
  input?: { videoPath?: string; coverPath?: string; title?: string; options?: Record<string, unknown> },
  accountId?: string,
) {
  return post<PublishRecord>(
    `/api/works/${encodeURIComponent(workId)}/publish/${encodeURIComponent(platform)}`,
    { ...(input ?? {}), accountId },
  );
}
```

PublishRecord 类型加 `accountId?: string`;Account 类型加 `isDefault?: boolean`(映射 is_default)。

- [ ] **Step 2: PublishBoard.svelte 账号下拉**

在平台行渲染处(发布按钮旁)加:

```svelte
<script lang="ts">
  // 既有 script 内追加:
  import { getAccounts } from "$lib/api"; // 若已有账号列表函数则复用,没有则按 GET /api/accounts 补
  let accountsByPlatform: Record<string, Array<{ id: string; name: string; isDefault?: boolean }>> = {};
  let selectedAccount: Record<string, string> = {}; // platform → accountId
  // onMount 拉账号,按 platform 分组;selectedAccount 默认取 isDefault 的 id
</script>

{#each accountsByPlatform[platform.key] ?? [] as acc}
  <option value={acc.id}>{acc.name}{acc.isDefault ? "(默认)" : ""}</option>
{/each}
```

发布调用处:`publishWorkToPlatform(workId, platform.key, undefined, selectedAccount[platform.key])`。账号数为 0 时 UI 提示"该平台未绑账号,将使用旧凭证兜底"。

- [ ] **Step 3: 前端构建验证**:`cd web && npm run build`(或仓库前端既有构建命令)

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts web/src/components/PublishBoard.svelte
git commit -m "feat(web): 发布按账号选择,api 加账号维度方法"
```

---

### Task 12: Analytics.svelte 看板 tab 重构(作品一级分类)

**Files:**
- Modify: `web/src/pages/Analytics.svelte`(dashboard tab)
- Create: `web/src/components/WorksDashboard.svelte`(作品列表 + 下钻详情,dashboard tab 内容抽成组件,避免 1835 行页面继续膨胀)

**Interfaces:**
- Consumes: Task 11 的 getWorksDashboard/getWorkDashboard
- Produces: `<WorksDashboard />` 组件,Analytics.svelte 的 activeView === "dashboard" 分支改为渲染它

- [ ] **Step 1: 新建 WorksDashboard.svelte**

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { getWorksDashboard, getWorkDashboard } from "$lib/api";

  type DashRecord = { recordId: number; platform: string; accountId?: string; accountName?: string;
    status: string; publishedAt?: string;
    metrics: { views: number; likes: number; comments: number; shares: number; collects: number; completionRate?: number } | null };
  type DashWork = { workId: string; title: string; publishedAt?: string; platforms: string[];
    totals: { views: number; likes: number; comments: number; shares: number; collects: number };
    records: DashRecord[] };

  let works: DashWork[] = [];
  let loading = true;
  let platformFilter = "";   // "" = 全部
  let expandedWorkId: string | null = null;
  let detail: Record<string, { series: Array<{ recordId: number; points: Array<{ collectedAt: string; views: number; likes: number }> }> }> = {};

  const PLATFORM_LABEL: Record<string, string> = {
    douyin: "抖音", xiaohongshu: "小红书", bilibili: "B站", kuaishou: "快手",
    channels: "视频号", zhihu: "知乎", wechat_mp: "公众号",
  };

  async function load() {
    loading = true;
    const res = await getWorksDashboard(platformFilter ? { platform: platformFilter } : {});
    works = res.works as DashWork[];
    loading = false;
  }
  onMount(load);

  async function toggle(workId: string) {
    expandedWorkId = expandedWorkId === workId ? null : workId;
    if (expandedWorkId && !detail[workId]) {
      detail[workId] = await getWorkDashboard(workId) as never;
    }
  }
</script>

<!-- 平台筛选 chips:全部 + 7 平台(不再 disabled) -->
<!-- 作品表:标题 | 发布日期 | 平台 chips | 播放 | 点赞 | 评论 | 分享 | 收藏(totals) -->
<!-- 点击行 toggle() 展开:平台×账号明细表(平台/账号/状态/五数/完播率)+ 近7日播放趋势(简易 SVG 折线) -->
```

样式复用 Analytics.svelte 既有 `.works-table`/`.table-card` class(把对应 CSS 留在页面内,组件通过 :global 或上移共用 —— 最小改动:WorksDashboard 内 `<style>` 从 Analytics.svelte 复制表格相关 class)。

- [ ] **Step 2: Analytics.svelte 接线**

dashboard 分支:整段账号总览卡 + 平台 tabs(501-511 行写死 disabled 的 ptab)+ 作品表现表,替换为 `<WorksDashboard />`;原 `/api/analytics/creator` 相关 fetch 与"连接账号引导"逻辑保留但挪到「数据回收」tab 底部("账号总览"次级区块),或标注 deprecated 暂留 dashboard 底部 —— 执行时以"页面不报错、功能可回退"为准,优先挪走。

- [ ] **Step 3: 前端构建验证 + 手动看页面**(build 通过;手动验证列入 Task 13)

- [ ] **Step 4: Commit**

```bash
git add web/src/components/WorksDashboard.svelte web/src/pages/Analytics.svelte
git commit -m "feat(web): 数据看板重构为作品一级分类,平台×账号明细下钻"
```

---

### Task 13: 全量回归 + 构建 + 服务重启冒烟

**Files:** 无(纯验证)

- [ ] **Step 1: 全量测试** `npx vitest run`(目标:全绿,新增 ~30 用例)
- [ ] **Step 2: 后端构建** `npm run build`
- [ ] **Step 3: 前端构建** `cd web && npm run build`
- [ ] **Step 4: 重启服务** `kill 3271 PID; node dist/index.js start --foreground`(确认 migrate v29 日志无报错,account_credentials 回填行数符合预期)
- [ ] **Step 5: 冒烟清单**
  - `curl -s http://localhost:3271/api/analytics/works-dashboard | head -c 500` 返回 works 数组
  - 数据页 dashboard tab 渲染作品列表(有发布记录的作品)
  - 账号页:建第二个抖音测试账号 → 两账号凭证互不覆盖(GET /api/accounts + 查库 account_credentials)
  - 设默认账号 → 发布该作品(可发测试作品)→ publish_records 行带 account_id
  - 手动采集 `POST /api/analytics/v2/collect {}` → platform_metrics 新行带 account_id
- [ ] **Step 6: 更新 feature 状态 + memory**(session-end 快照)

---

## Self-Review 记录

- Spec §4 数据模型 → Task 1/2/3 ✓;§5 发布流 → Task 4/5/6/11 ✓;§6 采集流 → Task 7/8(+Task 3 login-health)✓;§7 看板 → Task 9/11/12 ✓;§8 回流 → Task 10 ✓;§9 错误处理 → 各任务内(跳过+告警/400/回落)✓;§10 测试 → 每任务 Step 1 + Task 13 ✓
- 命名一致性:resolveAccountCredential / getAdapterForAccount / resolvePublishAccountId / works-dashboard 全计划统一
- 已知留白(executor 需现场核对):① connection.ts 测试库初始化方式(参照 tests/db/ 既有用例);② login-health.ts 的 verifyAllPlatforms 内部结构;③ Analytics.svelte 账号总览挪移的具体行号;④ 前端 getAccounts 是否已存在于 api.ts
