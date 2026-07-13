<script lang="ts">
  import { onMount } from "svelte";
  import { getComments, suggestReply, postReply, classifyComments, type CommentFilter } from "$lib/api.js";

  let comments: any[] = $state([]);
  let keyword = $state("");
  let onlyUnreplied = $state(false);
  let selectedComment: any = $state(null);
  let replyContent = $state("");
  let suggestions: { tone: string; replies: string[] } | null = $state(null);
  let classifying = $state(false);

  async function load() {
    const filter: CommentFilter = { limit: 200 };
    if (keyword.trim()) filter.keyword = keyword.trim();
    if (onlyUnreplied) filter.replied = false;
    comments = await getComments(filter);
  }

  async function handleSuggest(c: any) {
    selectedComment = c;
    replyContent = "";
    suggestions = await suggestReply(c.id);
  }

  async function handleSendReply() {
    if (!selectedComment || !replyContent.trim()) return;
    await postReply(selectedComment.id, replyContent.trim());
    suggestions = null;
    selectedComment = null;
    replyContent = "";
    await load();
  }

  async function handleClassify() {
    classifying = true;
    try {
      await classifyComments();
      await load();
    } finally {
      classifying = false;
    }
  }

  function sentimentLabel(s: string): string {
    const map: Record<string, string> = {
      positive: "正面",
      negative: "负面",
      neutral: "中性",
      question: "提问",
    };
    return map[s] ?? s ?? "-";
  }

  function sentimentClass(s: string): string {
    return `sentiment-${s ?? "neutral"}`;
  }

  let debounceTimer: ReturnType<typeof setTimeout>;
  function onKeywordInput() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(load, 300);
  }

  onMount(load);
</script>

<div class="comments-page">
  <header class="page-header">
    <h1>评论收件箱</h1>
    <div class="header-actions">
      <button class="btn-secondary" onclick={handleClassify} disabled={classifying}>
        {classifying ? "分类中…" : "批量分类"}
      </button>
    </div>
  </header>

  <div class="filters">
    <input
      class="filter-input"
      type="text"
      placeholder="关键词筛选…"
      bind:value={keyword}
      oninput={onKeywordInput}
    />
    <label class="filter-check">
      <input type="checkbox" bind:checked={onlyUnreplied} onchange={load} />
      只看未回复
    </label>
    <span class="filter-count">{comments.length} 条评论</span>
  </div>

  {#if comments.length === 0}
    <div class="empty">
      <p>暂无评论数据。发布作品并采集数据后，评论将出现在这里。</p>
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th class="col-author">作者</th>
            <th class="col-content">内容</th>
            <th class="col-sentiment">情感</th>
            <th class="col-status">状态</th>
            <th class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {#each comments as c}
            <tr class:replied={c.replied}>
              <td class="col-author">
                <span class="author-name">{c.author_name || "匿名"}</span>
                {#if c.platform}
                  <span class="platform-tag">{c.platform}</span>
                {/if}
              </td>
              <td class="col-content">
                <p class="comment-text">{c.content}</p>
              </td>
              <td class="col-sentiment">
                <span class="sentiment-tag {sentimentClass(c.sentiment)}">
                  {sentimentLabel(c.sentiment)}
                </span>
              </td>
              <td class="col-status">
                {#if c.replied}
                  <span class="status-replied">已回复</span>
                {:else}
                  <span class="status-pending">未回复</span>
                {/if}
              </td>
              <td class="col-actions">
                <button class="btn-suggest" onclick={() => handleSuggest(c)} disabled={c.replied}>
                  建议回复
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  {#if selectedComment}
    <div class="overlay" onclick={() => { selectedComment = null; suggestions = null; }}></div>
    <div class="reply-panel">
      <div class="reply-head">
        <h3>回复建议</h3>
        <button class="btn-close" onclick={() => { selectedComment = null; suggestions = null; }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p class="reply-context">「{selectedComment.content.slice(0, 80)}{selectedComment.content.length > 80 ? "…" : ""}」</p>
      {#if suggestions}
        <div class="suggestions">
          {#each suggestions.replies as r}
            <button class="suggestion-chip" class:selected={replyContent === r} onclick={() => replyContent = r}>
              {r}
            </button>
          {/each}
        </div>
      {/if}
      <textarea
        class="reply-textarea"
        bind:value={replyContent}
        rows="3"
        placeholder="输入回复内容…"
      ></textarea>
      <div class="reply-actions">
        <button class="btn-primary" onclick={handleSendReply} disabled={!replyContent.trim()}>
          发送回复
        </button>
        <button class="btn-cancel" onclick={() => { selectedComment = null; suggestions = null; }}>
          取消
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .comments-page {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .page-header h1 {
    font-size: 1.2rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0;
  }

  .header-actions {
    display: flex;
    gap: 0.5rem;
  }

  .filters {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .filter-input {
    padding: 0.45rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-inset);
    color: var(--text);
    font-size: 0.82rem;
    font-family: inherit;
    outline: none;
    width: 200px;
    transition: border-color 0.15s;
  }

  .filter-input:focus { border-color: var(--text-muted); }
  .filter-input::placeholder { color: var(--text-dim); }

  .filter-check {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.82rem;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .filter-check input[type="checkbox"] {
    accent-color: var(--spark-red);
  }

  .filter-count {
    font-size: 0.78rem;
    color: var(--text-dim);
    margin-left: auto;
  }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-dim);
    font-size: 0.85rem;
  }

  .table-wrap {
    overflow-x: auto;
    scrollbar-width: thin;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  thead th {
    font-size: 0.68rem;
    font-weight: 650;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.75rem 0.65rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  tbody td {
    padding: 0.7rem 0.75rem;
    vertical-align: middle;
    border-bottom: 1px solid var(--border-subtle, var(--border));
  }

  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover { background: var(--bg-hover); }
  tbody tr.replied td { opacity: 0.55; }

  .col-author { min-width: 100px; }
  .col-content { min-width: 200px; }
  .col-sentiment { min-width: 70px; }
  .col-status { min-width: 70px; }
  .col-actions { min-width: 80px; }

  .author-name {
    font-weight: 600;
    color: var(--text);
  }

  .platform-tag {
    display: inline-block;
    margin-left: 0.35rem;
    font-size: 0.65rem;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--text-muted);
    font-weight: 600;
  }

  .comment-text {
    margin: 0;
    line-height: 1.5;
    color: var(--text-secondary);
    max-width: 400px;
    overflow-wrap: break-word;
  }

  .sentiment-tag {
    font-size: 0.7rem;
    font-weight: 650;
    padding: 0.15rem 0.5rem;
    border-radius: 99px;
  }

  .sentiment-positive { background: rgba(34,197,94,0.1); color: var(--success); }
  .sentiment-negative { background: rgba(239,68,68,0.1); color: var(--error); }
  .sentiment-neutral { background: var(--bg-inset); color: var(--text-dim); }
  .sentiment-question { background: rgba(59,130,246,0.1); color: var(--info); }

  .status-replied { color: var(--success); font-size: 0.78rem; font-weight: 550; }
  .status-pending { color: var(--text-dim); font-size: 0.78rem; font-weight: 550; }

  .btn-suggest {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 550;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.12s;
    white-space: nowrap;
  }

  .btn-suggest:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }

  .btn-suggest:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-primary,
  .btn-secondary,
  .btn-cancel {
    padding: 0.45rem 0.9rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.12s;
    border: none;
  }

  .btn-primary {
    background: var(--accent-gradient);
    color: var(--accent-text);
  }

  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-secondary {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }

  .btn-secondary:hover:not(:disabled) { border-color: var(--text-dim); }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-cancel {
    background: none;
    color: var(--text-dim);
  }

  .btn-cancel:hover { color: var(--text); }

  /* Reply panel overlay */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    z-index: 500;
    animation: fadeIn 0.15s ease;
  }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  .reply-panel {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    width: 380px;
    max-width: calc(100vw - 2rem);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1.25rem;
    z-index: 600;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    animation: slideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  @keyframes slideUp {
    from { transform: translateY(20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  .reply-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .reply-head h3 {
    font-size: 0.95rem;
    font-weight: 700;
    margin: 0;
  }

  .btn-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .btn-close:hover { background: var(--bg-hover); color: var(--text); }

  .reply-context {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin: 0;
    padding: 0.5rem;
    background: var(--bg-inset);
    border-radius: 4px;
    line-height: 1.4;
  }

  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .suggestion-chip {
    text-align: left;
    padding: 0.45rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: 0.8rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.12s;
    line-height: 1.4;
  }

  .suggestion-chip:hover,
  .suggestion-chip.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--text);
  }

  .reply-textarea {
    width: 100%;
    padding: 0.6rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-inset);
    color: var(--text);
    font-size: 0.82rem;
    font-family: inherit;
    resize: vertical;
    outline: none;
    line-height: 1.5;
  }

  .reply-textarea:focus { border-color: var(--text-muted); }

  .reply-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
</style>
