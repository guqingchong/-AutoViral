<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";
  import { fetchWorks, publishWorkToPlatform, fetchWorkPublishRecords, type WorkSummary, type PublishRecord } from "../lib/api.js";

  const PLATFORMS = [
    { key: "douyin", label: "抖音", type: "video" },
    { key: "channels", label: "视频号", type: "video" },
    { key: "kuaishou", label: "快手", type: "video" },
    { key: "bilibili", label: "B站", type: "video" },
    { key: "xiaohongshu", label: "小红书", type: "video+image-text" },
    { key: "wechat_mp", label: "公众号", type: "article" },
    { key: "zhihu", label: "知乎", type: "article" },
  ];

  type Tab = "review" | "accounts";
  let activeTab = $state<Tab>("review");
  let works = $state<WorkSummary[]>([]);
  let loading = $state(true);
  let message = $state("");
  let messageType = $state<"success" | "error">("success");
  let destroyed = $state(false);

  // Review state
  let reviewWorks = $state<WorkSummary[]>([]);
  let selectedWorkId = $state("");
  let reviewComment = $state("");
  let publishing = $state<Record<string, boolean>>({});
  let publishRecords = $state<PublishRecord[]>([]);
  let showArticlePreview = $state(false);
  let articleContent = $state("");
  let articleTitle = $state("");

  // Account state
  let accounts = $state<any[]>([]);
  let editingAccount = $state<any | null>(null);
  let creatingAccount = $state(false);
  let acctForm = $state({ name: "", platform: "douyin", username: "", password: "", cookie: "", status: "active" });
  let acctBusy = $state(false);

  const selectedWork = $derived(works.find((w) => w.id === selectedWorkId));

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 5000);
  }

  async function loadWorks() {
    try {
      works = await fetchWorks();
      // Works in "reviewing" status go to review queue
      reviewWorks = works.filter((w) => w.status === "reviewing" || w.status === "assembling");
    } catch {}
  }

  async function loadAccounts() {
    try {
      const res = await fetch("/api/accounts");
      const data = await res.json();
      accounts = data.accounts ?? [];
    } catch {}
  }

  async function loadRecords() {
    if (!selectedWorkId) { publishRecords = []; return; }
    try {
      publishRecords = await fetchWorkPublishRecords(selectedWorkId);
    } catch { publishRecords = []; }
  }

  async function handlePublish(platform: string) {
    if (!selectedWorkId) return;
    publishing = { ...publishing, [platform]: true };
    try {
      const result = await publishWorkToPlatform(selectedWorkId, platform, {});
      showMessage(result.status === "published" ? "success" : "error",
        result.status === "published" ? `${platform} 发布成功` : `${platform} 发布失败: ${result.error ?? ""}`);
      await loadRecords();
    } catch (err) {
      showMessage("error", `${platform} 发布失败: ${String(err)}`);
    } finally {
      publishing = { ...publishing, [platform]: false };
    }
  }

  async function handleReject() {
    if (!selectedWorkId || !reviewComment.trim()) {
      showMessage("error", "请填写审核意见");
      return;
    }
    try {
      await fetch(`/api/works/${selectedWorkId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "assembling", reviewComment }),
      });
      showMessage("success", "已打回修改，审核意见已提交");
      reviewComment = "";
      selectedWorkId = "";
      await loadWorks();
    } catch (err) {
      showMessage("error", "打回失败: " + String(err));
    }
  }

  async function handleApprove() {
    if (!selectedWorkId) return;
    try {
      await fetch(`/api/works/${selectedWorkId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      });
      showMessage("success", "审核通过，可选择平台发布");
      await loadRecords();
    } catch (err) {
      showMessage("error", "操作失败: " + String(err));
    }
  }

  async function loadArticle(workId: string) {
    try {
      const res = await fetch(`/api/works/${workId}/articles`);
      const data = await res.json();
      if (data.articles?.length) {
        articleTitle = data.articles[0].title;
        articleContent = data.articles[0].content;
      } else {
        articleTitle = "";
        articleContent = "";
      }
    } catch { articleContent = ""; }
  }

  function selectWork(workId: string) {
    selectedWorkId = workId;
    reviewComment = "";
    loadRecords();
    loadArticle(workId);
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
      if (editingAccount) {
        await fetch(`/api/accounts/${editingAccount.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(acctForm),
        });
      } else {
        await fetch("/api/accounts", {
          method: "PUT" === "POST" ? "POST" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...acctForm, tone_profile: {} }),
        });
      }
      showMessage("success", "账号已保存");
      resetForm();
      await loadAccounts();
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
    await Promise.all([loadWorks(), loadAccounts()]);
    if (!destroyed) loading = false;
    return () => { destroyed = true; };
  });
</script>

<div class="publish-center">
  <header class="pc-header">
    <h1>发布中心</h1>
    <div class="tab-bar">
      <button class="tab-btn" class:active={activeTab === "review"} onclick={() => activeTab = "review"}>
        待审核 ({reviewWorks.length})
      </button>
      <button class="tab-btn" class:active={activeTab === "accounts"} onclick={() => activeTab = "accounts"}>
        账号管理 ({accounts.length})
      </button>
    </div>
  </header>

  {#if message}
    <div class="msg" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>{message}</div>
  {/if}

  {#if loading}
    <div class="loading"><div class="loader"></div><p>加载中...</p></div>
  {:else if activeTab === "review"}
    <!-- Review Queue -->
    {#if !selectedWorkId}
      <div class="review-grid">
        {#if reviewWorks.length === 0}
          <p class="empty">暂无待审核作品。视频制作完成后会自动出现在这里。</p>
        {:else}
          {#each reviewWorks as work}
            <div class="review-card" onclick={() => selectWork(work.id)}>
              {#if work.coverImage}
                <div class="card-cover">
                  {#if work.coverIsVideo}
                    <video src={work.coverImage} muted preload="metadata"></video>
                  {:else}
                    <img src={work.coverImage} alt={work.title} />
                  {/if}
                </div>
              {:else}
                <div class="card-cover placeholder"><span>{work.type === "image-text" ? "图文" : "视频"}</span></div>
              {/if}
              <div class="card-body">
                <h3>{work.title}</h3>
                <div class="card-meta">
                  <span class="badge type-{work.type}">{work.type === "image-text" ? "图文" : "短视频"}</span>
                  <span class="badge status-review">{work.status}</span>
                </div>
              </div>
            </div>
          {/each}
        {/if}
      </div>
    {:else}
      <!-- Selected work detail -->
      <div class="review-detail">
        <button class="btn-back" onclick={() => { selectedWorkId = ""; }}>← 返回列表</button>

        <div class="detail-header">
          <h2>{selectedWork?.title}</h2>
          <span class="badge type-{selectedWork?.type}">{selectedWork?.type === "image-text" ? "图文" : "短视频"}</span>
        </div>

        <!-- Preview area -->
        <div class="preview-area">
          {#if selectedWork?.coverImage}
            {#if selectedWork?.coverIsVideo}
              <video src={selectedWork.coverImage} controls></video>
            {:else}
              <img src={selectedWork.coverImage} alt="preview" />
            {/if}
          {:else}
            <p class="preview-empty">暂无预览内容</p>
          {/if}
        </div>

        <!-- Article preview (for WeChat/Zhihu publishing) -->
        {#if articleContent}
          <div class="article-section">
            <div class="article-header">
              <h3>文章内容</h3>
              <button class="btn-sm" onclick={() => showArticlePreview = !showArticlePreview}>
                {showArticlePreview ? "收起" : "展开"}
              </button>
            </div>
            {#if showArticlePreview}
              <div class="article-body">
                <h4>{articleTitle}</h4>
                <pre style="white-space: pre-wrap; font-family: inherit;">{articleContent}</pre>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Review actions -->
        <div class="review-actions">
          <div class="review-input">
            <textarea bind:value={reviewComment} placeholder="审核意见（如有修改意见请填写并点击打回修改）" rows="3"></textarea>
          </div>
          <div class="review-btns">
            <button class="btn-reject" onclick={handleReject} disabled={!reviewComment.trim()}>打回修改</button>
            <button class="btn-approve" onclick={handleApprove}>审核通过</button>
          </div>
        </div>

        <!-- Publishing -->
        <div class="publish-section">
          <h3>选择发布平台</h3>
          {#if selectedWork?.type === "image-text"}
            <p class="publish-hint">⚠ 图文格式仅支持小红书平台发布</p>
          {/if}
          <div class="platform-grid">
            {#if selectedWork?.type === "image-text"}
              {#each PLATFORMS.filter(p => p.key === "xiaohongshu") as p}
                <div class="platform-card">
                  <span class="plat-name">{p.label}</span>
                  <span class="plat-type">图文发布</span>
                  {#if getAccountsForPlatform(p.key).length > 0}
                    <button class="btn-publish" disabled={publishing[p.key]} onclick={() => handlePublish(p.key)}>
                      {publishing[p.key] ? "发布中..." : "发布"}
                    </button>
                  {:else}
                    <span class="plat-no-acct">未配置账号</span>
                  {/if}
                </div>
              {/each}
            {:else}
              {#each PLATFORMS.filter(p => p.type === "video" || p.type === "video+image-text") as p}
                <div class="platform-card">
                  <span class="plat-name">{p.label}</span>
                  <span class="plat-type">视频发布</span>
                  {#if getAccountsForPlatform(p.key).length > 0}
                    <button class="btn-publish" disabled={publishing[p.key]} onclick={() => handlePublish(p.key)}>
                      {publishing[p.key] ? "发布中..." : "发布"}
                    </button>
                  {:else}
                    <span class="plat-no-acct">未配置账号</span>
                  {/if}
                </div>
              {/each}
              {#if articleContent}
                {#each PLATFORMS.filter(p => p.type === "article") as p}
                  <div class="platform-card article-card">
                    <span class="plat-name">{p.label}</span>
                    <span class="plat-type">文章发布</span>
                    {#if getAccountsForPlatform(p.key).length > 0}
                      <button class="btn-publish btn-article" disabled={publishing[p.key]} onclick={() => handlePublish(p.key)}>
                        {publishing[p.key] ? "发布中..." : "发布文章"}
                      </button>
                    {:else}
                      <span class="plat-no-acct">未配置账号</span>
                    {/if}
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
        </div>

        <!-- Publish records -->
        {#if publishRecords.length > 0}
          <div class="records-section">
            <h3>发布记录</h3>
            <table class="records-table">
              <thead><tr><th>平台</th><th>状态</th><th>时间</th><th>链接</th></tr></thead>
              <tbody>
                {#each publishRecords as r}
                  <tr>
                    <td>{platformLabel(r.platform)}</td>
                    <td><span class="status-chip chip-{r.status}">{r.status}</span></td>
                    <td>{r.createdAt}</td>
                    <td>{#if r.postUrl}<a href={r.postUrl} target="_blank">查看</a>{/if}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}
  {:else if activeTab === "accounts"}
    <!-- Accounts Management -->
    <div class="accounts-section">
      <div class="accounts-header">
        <h2>平台账号管理</h2>
        <button class="btn-new" onclick={startCreateAccount}>+ 新增账号</button>
      </div>
      <p class="accounts-hint">为每个平台配置账号，用于视频/文章的自动化发布。支持抖音、视频号、快手、B站、公众号、知乎、小红书。</p>

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
          <div class="form-row">
            <label>用户名/手机号<input type="text" bind:value={acctForm.username} placeholder="登录用户名" /></label>
            <label>密码<input type="text" bind:value={acctForm.password} placeholder="登录密码" /></label>
          </div>
          <div class="form-row">
            <label>Cookie（可选）<input type="text" bind:value={acctForm.cookie} placeholder="已登录Cookie（用于免密发布）" /></label>
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
          <div class="platform-group">
            <h3 class="platform-title">{p.label}</h3>
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
  .publish-center { padding: 1rem 0; max-width: 1200px; }
  .pc-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
  .pc-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .tab-bar { display: flex; gap: 0.5rem; }
  .tab-btn { padding: 0.45rem 1rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-inset); color: var(--text-secondary); cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .tab-btn.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .msg { padding: 0.65rem 1rem; border-radius: 4px; font-size: 0.82rem; font-weight: 500; margin-bottom: 1rem; }
  .msg-success { background: var(--success-soft); color: var(--success); }
  .msg-error { background: var(--error-soft); color: var(--error); }
  .loading { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 4rem 0; color: var(--text-dim); }
  .loader { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: var(--text-dim); padding: 2rem 0; text-align: center; }

  /* Review grid */
  .review-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
  .review-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); overflow: hidden; cursor: pointer; transition: border-color 0.15s; }
  .review-card:hover { border-color: var(--accent); }
  .card-cover { aspect-ratio: 9/16; background: var(--bg-inset); overflow: hidden; }
  .card-cover img, .card-cover video { width: 100%; height: 100%; object-fit: cover; }
  .card-cover.placeholder { display: flex; align-items: center; justify-content: center; color: var(--text-dim); }
  .card-body { padding: 0.75rem; }
  .card-body h3 { font-size: 0.9rem; margin: 0 0 0.5rem; }
  .card-meta { display: flex; gap: 0.4rem; }
  .badge { font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; }
  .badge.type-short-video { background: var(--accent-soft); color: var(--accent); }
  .badge.type-image-text { background: rgba(254,44,85,0.1); color: var(--spark-red); }
  .badge.status-review { background: var(--accent-soft); color: var(--text-secondary); }

  /* Review detail */
  .review-detail { max-width: 700px; }
  .btn-back { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 0.85rem; margin-bottom: 1rem; }
  .detail-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .detail-header h2 { font-size: 1.1rem; margin: 0; }
  .preview-area { background: var(--bg-inset); border-radius: var(--card-radius); overflow: hidden; margin-bottom: 1rem; max-height: 500px; display: flex; justify-content: center; }
  .preview-area video, .preview-area img { max-width: 100%; max-height: 500px; }
  .preview-empty { color: var(--text-dim); padding: 3rem; text-align: center; }

  .article-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .article-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .article-header h3 { font-size: 0.9rem; margin: 0; }
  .article-body { max-height: 400px; overflow-y: auto; padding: 0.5rem; background: var(--bg-inset); border-radius: 4px; }
  .article-body h4 { font-size: 1rem; margin: 0 0 0.5rem; }
  .article-body pre { font-size: 0.85rem; line-height: 1.6; color: var(--text-secondary); }

  .review-actions { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .review-input textarea { width: 100%; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; font-size: 0.85rem; resize: vertical; }
  .review-btns { display: flex; gap: 0.5rem; margin-top: 0.75rem; }
  .btn-reject { padding: 0.5rem 1.2rem; border: 1px solid var(--error); border-radius: 4px; background: none; color: var(--error); cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-reject:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-approve { padding: 0.5rem 1.2rem; border: none; border-radius: 4px; background: var(--success); color: #fff; cursor: pointer; font-size: 0.82rem; font-weight: 600; }

  .publish-section { margin-bottom: 1rem; }
  .publish-section h3 { font-size: 0.95rem; margin: 0 0 0.75rem; }
  .publish-hint { font-size: 0.8rem; color: var(--spark-red); background: rgba(254,44,85,0.06); padding: 0.5rem 0.75rem; border-radius: 4px; margin-bottom: 0.75rem; }
  .platform-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; }
  .platform-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; align-items: center; }
  .platform-card.article-card { border-color: rgba(59,130,246,0.3); }
  .plat-name { font-weight: 600; font-size: 0.9rem; }
  .plat-type { font-size: 0.7rem; color: var(--text-dim); }
  .plat-no-acct { font-size: 0.7rem; color: var(--text-dim); }
  .btn-publish { padding: 0.4rem 1rem; border: none; border-radius: 4px; background: var(--spark-red); color: #fff; cursor: pointer; font-size: 0.8rem; font-weight: 600; }
  .btn-publish:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-article { background: #3b82f6; }

  .records-section { margin-top: 1.5rem; }
  .records-section h3 { font-size: 0.95rem; margin: 0 0 0.75rem; }
  .records-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .records-table th { text-align: left; padding: 0.5rem; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .records-table td { padding: 0.5rem; border-bottom: 1px solid var(--border-subtle); }
  .status-chip { padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; }
  .chip-published { background: var(--success-soft); color: var(--success); }
  .chip-failed { background: var(--error-soft); color: var(--error); }

  /* Accounts */
  .accounts-section { }
  .accounts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .accounts-header h2 { font-size: 1.1rem; }
  .accounts-hint { font-size: 0.8rem; color: var(--text-dim); margin-bottom: 1rem; }
  .btn-new { padding: 0.45rem 1rem; background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .acct-form { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1.5rem; }
  .acct-form h3 { font-size: 0.95rem; margin: 0 0 0.75rem; }
  .form-row { display: flex; gap: 1rem; margin-bottom: 0.5rem; }
  .form-row label { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); }
  .form-row input, .form-row select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.4rem 0.6rem; font-size: 0.82rem; }
  .form-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .btn-save { padding: 0.45rem 1.2rem; background: var(--text); color: var(--bg); border: none; border-radius: 4px; cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-cancel { padding: 0.45rem 1rem; background: var(--bg-inset); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
  .accounts-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .platform-group { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 0.75rem; }
  .platform-title { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; }
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
    .review-grid { grid-template-columns: 1fr; }
    .platform-grid { grid-template-columns: 1fr; }
    .accounts-grid { grid-template-columns: 1fr; }
  }
</style>
