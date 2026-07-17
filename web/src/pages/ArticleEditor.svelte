<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";

  let articles = $state<any[]>([]);
  let loading = $state(true);
  let selectedId = $state<number | null>(null);
  let editTitle = $state("");
  let editContent = $state("");
  let editPlatform = $state("");
  let saving = $state(false);
  let message = $state("");
  let destroyed = $state(false);

  const selected = $derived(articles.find((a) => a.id === selectedId));

  async function load() {
    try {
      const res = await fetch("/api/articles?limit=200");
      const data = await res.json();
      articles = data.articles ?? [];
    } catch { articles = []; }
    loading = false;
  }

  function selectArticle(id: number) {
    const a = articles.find((x) => x.id === id);
    if (!a) return;
    selectedId = id;
    editTitle = a.title;
    editContent = a.content;
    editPlatform = a.platform ?? "";
    message = "";
  }

  async function save() {
    if (!selectedId) return;
    saving = true;
    try {
      const res = await fetch(`/api/articles/${selectedId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle, content: editContent, platform: editPlatform }),
      });
      if (res.ok) {
        message = "保存成功";
        const idx = articles.findIndex((a) => a.id === selectedId);
        if (idx >= 0) {
          articles[idx].title = editTitle;
          articles[idx].content = editContent;
          articles[idx].platform = editPlatform;
          articles = [...articles];
        }
      } else {
        message = "保存失败";
      }
    } catch { message = "保存失败"; }
    saving = false;
    setTimeout(() => { if (!destroyed) message = ""; }, 3000);
  }

  onMount(() => { load(); return () => { destroyed = true; }; });
</script>

<div class="article-editor-page">
  <header class="ae-header">
    <h1>文章管理</h1>
    <p class="ae-subtitle">选题调研后自动生成的文章，可编辑、保存。文章可在发布中心发布到公众号和知乎。</p>
  </header>

  {#if loading}
    <p class="loading-text">加载中...</p>
  {:else}
    <div class="ae-layout">
      <!-- Article list -->
      <div class="ae-list">
        <h3>文章列表 ({articles.length})</h3>
        {#if articles.length === 0}
          <p class="empty">暂无文章。选题转作品后会自动生成文章。</p>
        {:else}
          {#each articles as a}
            <div class="article-item" class:active={selectedId === a.id} onclick={() => selectArticle(a.id)}>
              <h4>{a.title}</h4>
              <div class="item-meta">
                {#if a.platform}<span class="badge">{a.platform}</span>{/if}
                <span class="date">{a.created_at?.slice(0, 10)}</span>
              </div>
            </div>
          {/each}
        {/if}
      </div>

      <!-- Editor -->
      <div class="ae-editor">
        {#if selected}
          <div class="editor-toolbar">
            <button class="btn-save" disabled={saving} onclick={save}>{saving ? "保存中..." : "保存"}</button>
            {#if message}<span class="msg">{message}</span>{/if}
          </div>
          <div class="editor-fields">
            <label>
              <span>标题</span>
              <input type="text" bind:value={editTitle} placeholder="文章标题" />
            </label>
            <label>
              <span>目标平台</span>
              <select bind:value={editPlatform}>
                <option value="">不限</option>
                <option value="wechat_mp">公众号</option>
                <option value="zhihu">知乎</option>
                <option value="douyin">抖音</option>
                <option value="xiaohongshu">小红书</option>
              </select>
            </label>
          </div>
          <div class="content-editor">
            <textarea bind:value={editContent} placeholder="文章正文内容..."></textarea>
          </div>
          <div class="preview-section">
            <h4>预览</h4>
            <div class="preview-box">
              <h3>{editTitle}</h3>
              <pre style="white-space: pre-wrap; font-family: inherit; line-height: 1.8;">{editContent}</pre>
            </div>
          </div>
        {:else}
          <div class="no-selection">
            <p>← 请从左侧列表选择一篇文章进行编辑</p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .article-editor-page { padding: 1rem 0; }
  .ae-header { margin-bottom: 1.5rem; }
  .ae-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .ae-subtitle { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.25rem; }
  .loading-text { color: var(--text-dim); padding: 2rem; text-align: center; }
  .ae-layout { display: grid; grid-template-columns: 280px 1fr; gap: 1.5rem; }
  .ae-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .ae-list h3 { font-size: 0.85rem; font-weight: 600; color: var(--text-secondary); margin: 0 0 0.5rem; }
  .empty { color: var(--text-dim); font-size: 0.82rem; }
  .article-item { padding: 0.6rem 0.75rem; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 4px; cursor: pointer; transition: border-color 0.15s; }
  .article-item:hover { border-color: var(--accent); }
  .article-item.active { border-color: var(--accent); background: var(--accent-soft); }
  .article-item h4 { font-size: 0.82rem; margin: 0 0 0.3rem; line-height: 1.3; }
  .item-meta { display: flex; gap: 0.4rem; align-items: center; }
  .badge { font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.35rem; border-radius: 3px; background: var(--accent-soft); color: var(--text-secondary); }
  .date { font-size: 0.65rem; color: var(--text-dim); }
  .ae-editor { display: flex; flex-direction: column; gap: 0.75rem; }
  .editor-toolbar { display: flex; align-items: center; gap: 0.75rem; }
  .btn-save { padding: 0.45rem 1.2rem; border: none; border-radius: 4px; background: var(--accent); color: var(--accent-text); cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
  .msg { font-size: 0.8rem; color: var(--success); }
  .editor-fields { display: flex; gap: 1rem; }
  .editor-fields label { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.8rem; color: var(--text-secondary); }
  .editor-fields input, .editor-fields select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; font-size: 0.82rem; }
  .content-editor { flex: 1; }
  .content-editor textarea { width: 100%; min-height: 350px; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; font-size: 0.85rem; line-height: 1.7; resize: vertical; font-family: var(--font-body); }
  .preview-section { margin-top: 0.5rem; }
  .preview-section h4 { font-size: 0.82rem; color: var(--text-secondary); margin: 0 0 0.4rem; }
  .preview-box { background: var(--bg-inset); border-radius: 4px; padding: 1rem; max-height: 300px; overflow-y: auto; }
  .preview-box h3 { font-size: 1rem; margin: 0 0 0.5rem; }
  .preview-box pre { font-size: 0.85rem; color: var(--text-secondary); }
  .no-selection { display: flex; align-items: center; justify-content: center; height: 300px; color: var(--text-dim); }
  @media (max-width: 768px) { .ae-layout { grid-template-columns: 1fr; } }
</style>
