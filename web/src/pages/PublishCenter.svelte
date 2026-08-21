<script lang="ts">
  /**
   * 视频发布页：发布看板（待审核/待发布/已发布 三栏）+ 平台账号管理。
   * 看板逻辑在 components/PublishBoard.svelte（与图文发布页共用）。
   */
  import { onMount } from "svelte";
  import PublishBoard from "../components/PublishBoard.svelte";

  /** 视频发布平台（看板 + 账号管理共用） */
  const VIDEO_PLATFORMS = [
    { key: "douyin", label: "抖音" },
    { key: "channels", label: "视频号" },
    { key: "kuaishou", label: "快手" },
    { key: "bilibili", label: "B站" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "zhihu", label: "知乎" },
  ];

  /** 账号管理覆盖全部平台（含图文-only 的公众号） */
  const PLATFORMS = [
    ...VIDEO_PLATFORMS,
    { key: "wechat_mp", label: "公众号" },
  ];

  type Tab = "board" | "accounts";
  let activeTab = $state<Tab>("board");
  let message = $state("");
  let messageType = $state<"success" | "error">("success");
  let destroyed = $state(false);

  // Account state
  let accounts = $state<any[]>([]);
  let editingAccount = $state<any | null>(null);
  let creatingAccount = $state(false);
  let acctForm = $state({ name: "", platform: "douyin", username: "", password: "", cookie: "", status: "active" });
  let acctBusy = $state(false);
  let credentialStatus = $state<Record<string, { keys: string[]; configured: boolean }>>({});
  let loginBusy = $state<Record<string, boolean>>({});

  /** 平台凭证填写引导（accounts 字段 → 发布器实际读取的 platform_credentials） */
  const CRED_GUIDES: Record<string, { mode: "rpa" | "api"; fields: { username?: string; cookie: string }; note: string; loginBtn?: boolean }> = {
    douyin: { mode: "rpa", fields: { cookie: "登录 Cookie（JSON 数组）" }, note: "发布方式：Playwright 浏览器自动化。点击「浏览器登录」人工登录一次，Cookie 自动入库；或手动粘贴浏览器导出的 Cookie JSON。", loginBtn: true },
    xiaohongshu: { mode: "rpa", fields: { cookie: "登录 Cookie（JSON 数组）" }, note: "发布方式：Playwright 浏览器自动化。点击「浏览器登录」人工登录一次，Cookie 自动入库；或手动粘贴 Cookie JSON。", loginBtn: true },
    channels: { mode: "rpa", fields: { cookie: "登录 Cookie（JSON 数组）" }, note: "发布方式：Playwright 浏览器自动化（视频号助手网页版）。点击「浏览器登录」扫码登录一次，Cookie 自动入库；或手动粘贴 Cookie JSON。", loginBtn: true },
    wechat_mp: { mode: "api", fields: { username: "AppID", cookie: "AppSecret" }, note: "发布方式：公众号官方 API。「用户名」填 AppID，下方填 AppSecret（公众平台 → 设置与开发 → 基本配置）。" },
    kuaishou: { mode: "api", fields: { username: "app_id", cookie: "app_secret" }, note: "发布方式：快手开放平台 API。「用户名」填 app_id，下方填 app_secret。" },
    zhihu: { mode: "rpa", fields: { cookie: "登录 Cookie（JSON 数组）" }, note: "发布方式：Playwright 浏览器自动化（知乎官方 API 已关闭个人申请）。点击「浏览器登录」人工登录一次，Cookie 自动入库；或手动粘贴 Cookie JSON。发布产物为知乎专栏文章。", loginBtn: true },
    bilibili: { mode: "api", fields: { cookie: "完整 Cookie（含 SESSDATA 与 bili_jct）" }, note: "发布方式：B站官方 API。粘贴浏览器完整 Cookie，系统自动解析 SESSDATA / bili_jct。" },
  };
  const credGuide = $derived(CRED_GUIDES[acctForm.platform]);
  /** 账号平台键 → 凭证状态键（wechat_mp → wechat） */
  function credKeyOf(platform: string): string { return platform === "wechat_mp" ? "wechat" : platform; }

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 5000);
  }

  async function loadAccounts() {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      accounts = data.accounts ?? [];
    } catch {}
  }

  async function loadCredentialStatus() {
    try {
      const res = await fetch("/api/accounts/credential-status");
      const data = await res.json();
      credentialStatus = data.status ?? {};
    } catch {}
  }

  /** 登录态健康检查（实测凭证有效性，区分"已配置"与"仍有效"）
   *  2026-08-20 Task 3 起 GET /api/accounts/login-health 返回 { accounts: AccountHealth[] }（按账号维度） */
  interface AccountHealth {
    accountId: string;
    name: string;
    platform: string;
    configured: boolean;
    valid: boolean | null;
    detail: string;
    /** valid === true 的便捷布尔 */
    healthy: boolean;
  }
  let loginHealth = $state<AccountHealth[]>([]);
  let healthLoading = $state(false);

  async function loadLoginHealth(force = false) {
    healthLoading = true;
    try {
      const res = await fetch(`/api/accounts/login-health${force ? "?force=1" : ""}`);
      const data = await res.json();
      loginHealth = data.accounts ?? [];
    } catch {} finally { healthLoading = false; }
  }

  /** 平台标题栏徽标数据：聚合该平台全部账号的健康状态（platform 为账号存储键，如 wechat_mp） */
  function platformHealth(platform: string): { count: number; anyInvalid: boolean; allValid: boolean; detail: string } {
    const list = loginHealth.filter((a) => a.platform === platform);
    const invalid = list.filter((a) => a.configured && a.valid === false);
    return {
      count: list.length,
      anyInvalid: invalid.length > 0,
      allValid: list.length > 0 && invalid.length === 0 && list.some((a) => a.healthy),
      detail: invalid.map((a) => `${a.name}: ${a.detail}`).join("；"),
    };
  }

  /** 发布预检：强制实测全部账号，失效账号标红提示 */
  async function handlePrecheck() {
    await loadLoginHealth(true);
    const bad = loginHealth.filter((a) => a.configured && !a.healthy);
    if (bad.length === 0) {
      showMessage("success", "发布预检通过：所有已配置账号登录态有效");
    } else {
      showMessage("error", `预检发现 ${bad.length} 个账号登录态失效：${bad.map((a) => `${platformLabel(a.platform)}/${a.name}`).join("、")}，请重新登录`);
    }
  }

  /** RPA 平台：触发浏览器人工登录，成功后 cookie 自动存入 platform_credentials */
  async function handleBrowserLogin(platform: string) {
    loginBusy = { ...loginBusy, [platform]: true };
    showMessage("success", `正在打开${platformLabel(platform)}登录页，请在浏览器中完成登录…`);
    try {
      const res = await fetch(`/api/accounts/login/${platform}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showMessage("success", `${platformLabel(platform)} 登录成功，Cookie 已保存，发布链路已就绪`);
      } else {
        showMessage("error", `${platformLabel(platform)} 登录未完成：${data.error ?? "已取消或超时"}`);
      }
    } catch (err) {
      showMessage("error", `登录失败：${String(err)}`);
    } finally {
      loginBusy = { ...loginBusy, [platform]: false };
      await loadCredentialStatus();
      loadLoginHealth(true); // 登录成功后强制重测登录态
    }
  }

  // Account CRUD
  function startCreateAccount() {
    editingAccount = null;
    creatingAccount = true;
    acctForm = { name: "", platform: "douyin", username: "", password: "", cookie: "", status: "active" };
  }

  function startEditAccount(acct: any) {
    editingAccount = acct;
    creatingAccount = false;
    acctForm = {
      name: acct.name,
      platform: acct.platform,
      username: acct.username ?? "",
      password: acct.password ?? "",
      cookie: acct.cookie ?? "",
      status: acct.status,
    };
  }

  function resetForm() {
    creatingAccount = false;
    editingAccount = null;
  }

  async function saveAccount() {
    if (!acctForm.name.trim()) return;
    acctBusy = true;
    try {
      let bridged: string[] = [];
      if (editingAccount) {
        const res = await fetch(`/api/accounts/${editingAccount.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(acctForm),
        });
        const data = await res.json();
        bridged = data.bridgedCredentials ?? [];
      } else {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...acctForm, tone_profile: {} }),
        });
        const data = await res.json();
        bridged = data.bridgedCredentials ?? [];
      }
      showMessage("success", bridged.length > 0
        ? `账号已保存，发布凭证已同步（${bridged.join("、")}）`
        : "账号已保存");
      resetForm();
      await Promise.all([loadAccounts(), loadCredentialStatus()]);
    } catch (err) {
      showMessage("error", "保存失败: " + String(err));
    } finally {
      acctBusy = false;
    }
  }

  async function deleteAccount(id: string) {
    if (!confirm("确定删除此账号?")) return;
    try {
      await fetch(`/api/accounts/${id}`, { method: "DELETE" });
      showMessage("success", "账号已删除");
      await loadAccounts();
    } catch (err) {
      showMessage("error", "删除失败: " + String(err));
    }
  }

  function platformLabel(key: string): string {
    const p = PLATFORMS.find((p) => p.key === key);
    return p ? p.label : key;
  }

  function getAccountsForPlatform(platform: string): any[] {
    return accounts.filter((a) => a.platform === platform);
  }

  onMount(async () => {
    await Promise.all([loadAccounts(), loadCredentialStatus()]);
    // 登录态健康检查后台静默执行（实测各平台 Cookie/凭证有效性），不阻塞页面
    loadLoginHealth();
    return () => { destroyed = true; };
  });
</script>

<div class="publish-center">
  <header class="pc-header">
    <h1>视频发布</h1>
    <div class="tab-bar">
      <button class="tab-btn" class:active={activeTab === "board"} onclick={() => activeTab = "board"}>
        发布看板
      </button>
      <button class="tab-btn" class:active={activeTab === "accounts"} onclick={() => activeTab = "accounts"}>
        账号管理 ({accounts.length})
      </button>
    </div>
  </header>

  {#if activeTab === "board"}
    <PublishBoard kind="video" platforms={VIDEO_PLATFORMS} />
  {:else}
    {#if message}
      <div class="msg" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>{message}</div>
    {/if}
    <!-- Accounts Management -->
    <div class="accounts-section">
      <div class="accounts-header">
        <h2>平台账号管理</h2>
        <div class="accounts-header-btns">
          <button class="btn-precheck" disabled={healthLoading} onclick={handlePrecheck}
            title="实测各平台登录态是否有效，失效平台会在下方标红">
            {healthLoading ? "预检中…（约 10~20 秒）" : "🔍 发布预检"}
          </button>
          <button class="btn-new" onclick={startCreateAccount}>+ 新增账号</button>
        </div>
      </div>
      <p class="accounts-hint">为每个平台配置账号，用于视频/图文的自动化发布。支持抖音、视频号、快手、B站、小红书、知乎、公众号。</p>

      {#if creatingAccount || editingAccount}
        <div class="acct-form">
          <h3>{editingAccount ? "编辑账号" : "新增账号"}</h3>
          <div class="form-row">
            <label>账号名称<input type="text" bind:value={acctForm.name} placeholder="如: 品牌主号" /></label>
            <label>平台
              <select bind:value={acctForm.platform}>
                {#each PLATFORMS as p}<option value={p.key}>{p.label}</option>{/each}
              </select>
            </label>
          </div>
          {#if credGuide}
            <div class="cred-guide" data-mode={credGuide.mode}>
              <span class="cg-mode">{credGuide.mode === "api" ? "官方 API 发布" : "浏览器自动化发布"}</span>
              <p>{credGuide.note}</p>
              {#if credGuide.loginBtn}
                <button class="btn-login" disabled={loginBusy[acctForm.platform]} onclick={() => handleBrowserLogin(acctForm.platform)}>
                  {loginBusy[acctForm.platform] ? "等待登录中…" : "🌐 浏览器登录（推荐）"}
                </button>
              {/if}
            </div>
          {/if}
          <div class="form-row">
            {#if credGuide?.fields.username}
              <label>{credGuide.fields.username}<input type="text" bind:value={acctForm.username} placeholder={credGuide.fields.username} /></label>
            {/if}
            <label>{credGuide?.fields.cookie ?? "Cookie（可选）"}<input type="text" bind:value={acctForm.cookie} placeholder={credGuide?.fields.cookie ?? "已登录Cookie（用于免密发布）"} /></label>
            <label>状态
              <select bind:value={acctForm.status}>
                <option value="active">启用</option>
                <option value="inactive">停用</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button class="btn-save" disabled={acctBusy} onclick={saveAccount}>{acctBusy ? "保存中..." : "保存"}</button>
            <button class="btn-cancel" onclick={resetForm}>取消</button>
          </div>
        </div>
      {/if}

      <div class="accounts-grid">
        {#each PLATFORMS as p}
          {@const cred = credentialStatus[credKeyOf(p.key)]}
          {@const health = platformHealth(p.key)}
          <div class="platform-group">
            <h3 class="platform-title">
              {p.label}
              {#if cred}
                <span class="cred-badge" class:cred-ok={cred.configured} class:cred-missing={!cred.configured}
                  title={cred.configured ? `发布凭证已就绪（${cred.keys.join("、")}）` : "发布凭证未配置，发布将失败"}>
                  {cred.configured ? "✓ 发布就绪" : "⚠ 未配置凭证"}
                </span>
              {/if}
              {#if healthLoading && health.count === 0}
                <span class="cred-badge cred-checking">登录态检测中…</span>
              {:else if health.anyInvalid}
                <span class="cred-badge cred-missing" title={health.detail}>✗ 需重新登录</span>
              {:else if health.allValid}
                <span class="cred-badge cred-verified" title={health.detail}>✓ 已验证</span>
              {/if}
              {#if CRED_GUIDES[p.key]?.loginBtn}
                <button class="btn-login-sm" disabled={loginBusy[p.key]} onclick={() => handleBrowserLogin(p.key)}>
                  {loginBusy[p.key] ? "登录中…" : "浏览器登录"}
                </button>
              {/if}
            </h3>
            <div class="platform-accounts">
              {#if getAccountsForPlatform(p.key).length === 0}
                <p class="no-acct">暂无账号</p>
              {:else}
                {#each getAccountsForPlatform(p.key) as acct}
                  <div class="acct-row">
                    <div class="acct-info">
                      <span class="acct-name">{acct.name}</span>
                      {#if acct.username}<span class="acct-user">{acct.username}</span>{/if}
                      <span class="acct-status {acct.status}">{acct.status === "active" ? "启用" : "停用"}</span>
                    </div>
                    <div class="acct-btns">
                      <button class="btn-sm" onclick={() => startEditAccount(acct)}>编辑</button>
                      <button class="btn-sm btn-danger" onclick={() => deleteAccount(acct.id)}>删除</button>
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .publish-center { padding: 1rem 0; max-width: 1400px; }
  .pc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
  .pc-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .tab-bar { display: flex; gap: 0.5rem; }
  .tab-btn { padding: 0.45rem 1rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-inset); color: var(--text-secondary); cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .tab-btn.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .msg { padding: 0.65rem 1rem; border-radius: 4px; font-size: 0.82rem; font-weight: 500; margin-bottom: 1rem; }
  .msg-success { background: var(--success-soft); color: var(--success); }
  .msg-error { background: var(--error-soft); color: var(--error); }

  /* Accounts */
  .accounts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .accounts-header h2 { font-size: 1.1rem; }
  .accounts-header-btns { display: flex; gap: 0.5rem; }
  .accounts-hint { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1rem; }
  .btn-new { padding: 0.45rem 1rem; background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-precheck { padding: 0.35rem 0.8rem; border-radius: 4px; border: 1px solid var(--accent); background: transparent; color: var(--accent); font-size: 0.78rem; font-weight: 600; cursor: pointer; }
  .btn-precheck:hover { background: var(--accent); color: var(--accent-text); }
  .btn-precheck:disabled { opacity: 0.5; cursor: not-allowed; }
  .acct-form { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1.5rem; }
  .acct-form h3 { font-size: 0.95rem; margin: 0 0 0.75rem; }
  .form-row { display: flex; gap: 1rem; margin-bottom: 0.5rem; }
  .form-row label { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); }
  .form-row input, .form-row select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  .form-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .btn-save { padding: 0.45rem 1.2rem; background: var(--text); color: var(--bg); border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-cancel { padding: 0.45rem 1rem; background: var(--bg-inset); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 4px; font-size: 0.82rem; }
  .accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .platform-group { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 0.75rem; }
  .platform-title { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .cred-badge { font-size: 0.62rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .cred-badge.cred-ok { background: rgba(34, 197, 94, 0.12); color: var(--success, #22c55e); }
  .cred-badge.cred-missing { background: rgba(239, 68, 68, 0.1); color: var(--error, #ef4444); }
  .cred-badge.cred-verified { background: rgba(34, 197, 94, 0.12); color: var(--success, #22c55e); }
  .cred-badge.cred-checking { background: var(--bg-inset); color: var(--text-dim); }
  .btn-login-sm { font-size: 0.68rem; padding: 0.15rem 0.5rem; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-inset); color: var(--text-secondary); cursor: pointer; }
  .btn-login-sm:hover { border-color: var(--accent); color: var(--accent); }
  .btn-login-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .cred-guide { background: var(--accent-soft, rgba(254, 44, 85, 0.06)); border: 1px solid var(--card-border); border-radius: 4px; padding: 0.65rem 0.8rem; margin-bottom: 0.75rem; }
  .cred-guide p { font-size: 0.78rem; color: var(--text-secondary); margin: 0.3rem 0 0; line-height: 1.5; }
  .cg-mode { font-size: 0.68rem; font-weight: 700; color: var(--accent); }
  .btn-login { margin-top: 0.5rem; padding: 0.4rem 0.9rem; border-radius: 4px; border: none; background: var(--accent); color: var(--accent-text); font-size: 0.78rem; font-weight: 600; cursor: pointer; }
  .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
  .platform-accounts { display: flex; flex-direction: column; gap: 0.4rem; }
  .no-acct { font-size: 0.78rem; color: var(--text-dim); }
  .acct-row { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.5rem; background: var(--bg-inset); border-radius: 4px; }
  .acct-info { display: flex; gap: 0.5rem; align-items: center; }
  .acct-name { font-size: 0.82rem; font-weight: 500; }
  .acct-user { font-size: 0.72rem; color: var(--text-dim); }
  .acct-status { font-size: 0.65rem; padding: 0.1rem 0.35rem; border-radius: 3px; font-weight: 600; }
  .acct-status.active { background: var(--success-soft); color: var(--success); }
  .acct-status.inactive { background: var(--accent-soft); color: var(--text-dim); }
  .acct-btns { display: flex; gap: 0.3rem; }
  .btn-sm { padding: 0.25rem 0.55rem; border: 1px solid var(--border); border-radius: 3px; background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; font-size: 0.72rem; }
  .btn-sm:hover { color: var(--text); }
  .btn-danger:hover { color: var(--error); border-color: var(--error); }

  @media (max-width: 768px) {
    .accounts-grid { grid-template-columns: 1fr; }
  }
</style>
