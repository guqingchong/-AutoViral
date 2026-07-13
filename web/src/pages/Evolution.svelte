<script lang="ts">
  import { onMount } from "svelte";
  import { listEvolutionRules, updateEvolutionRule, deleteEvolutionRule, generateEvolutionRules, getAnalyticsInsights } from "$lib/api.js";

  let rules: any[] = $state([]);
  let generating = $state(false);
  let errorMsg = $state("");

  async function load() {
    try {
      rules = await listEvolutionRules();
    } catch {
      rules = [];
    }
  }

  async function toggle(rule: any) {
    await updateEvolutionRule(rule.id, { enabled: !rule.enabled });
    await load();
  }

  async function remove(rule: any) {
    if (!confirm(`删除规则：${rule.action}？`)) return;
    await deleteEvolutionRule(rule.id);
    await load();
  }

  async function generate() {
    generating = true;
    errorMsg = "";
    try {
      const insightsData = await getAnalyticsInsights();
      const generated = await generateEvolutionRules(insightsData.insights ?? []);
      if (generated.length === 0) {
        errorMsg = "当前数据不足以生成新规则。";
      }
      await load();
    } catch (e: any) {
      errorMsg = e?.message ?? "生成失败";
    } finally {
      generating = false;
    }
  }

  function sourceLabel(s: string): string {
    const map: Record<string, string> = {
      derived: "自动推导",
      manual: "人工",
      llm: "LLM",
    };
    return map[s] ?? s;
  }

  function ruleTypeLabel(t: string): string {
    const map: Record<string, string> = {
      hook: "钩子",
      topic: "选题",
      timing: "时机",
      style: "风格",
      platform: "平台",
    };
    return map[t] ?? t;
  }

  onMount(load);
</script>

<div class="evolution-page">
  <header class="page-header">
    <h1>进化规则</h1>
    <div class="header-actions">
      <button class="btn-primary" onclick={generate} disabled={generating}>
        {#if generating}
          <span class="spinner"></span>
        {/if}
        {generating ? "生成中…" : "从洞察生成规则"}
      </button>
    </div>
  </header>

  {#if errorMsg}
    <div class="error-banner">{errorMsg}</div>
  {/if}

  {#if rules.length === 0}
    <div class="empty">
      <p>暂无进化规则。</p>
      <p class="empty-sub">当系统积累足够的发布数据后，可基于爆款/失败分析自动生成进化规则，或点击上方按钮手动触发。</p>
    </div>
  {:else}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>类型</th>
            <th>规则动作</th>
            <th>置信度</th>
            <th>来源</th>
            <th>应用次数</th>
            <th>启用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {#each rules as r}
            <tr class:disabled={!r.enabled}>
              <td>
                <span class="type-badge">{ruleTypeLabel(r.rule_type)}</span>
              </td>
              <td class="col-action">{r.action}</td>
              <td>
                <div class="confidence-bar">
                  <div class="confidence-fill" style="width: {Math.round(r.confidence * 100)}%"></div>
                </div>
                <span class="confidence-text">{Math.round(r.confidence * 100)}%</span>
              </td>
              <td>
                <span class="source-tag">{sourceLabel(r.source)}</span>
              </td>
              <td class="col-num">{r.applied_count ?? 0}</td>
              <td>
                <button class="switch" class:on={r.enabled} onclick={() => toggle(r)} role="switch" aria-checked={r.enabled}>
                  <span class="switch-thumb"></span>
                </button>
              </td>
              <td>
                <button class="btn-delete" onclick={() => remove(r)}>删除</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .evolution-page {
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

  .btn-primary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.5rem 1rem;
    background: var(--accent-gradient);
    color: var(--accent-text);
    border: none;
    border-radius: 4px;
    font-size: 0.82rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.85; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-delete {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: none;
    color: var(--error);
    font-size: 0.75rem;
    font-weight: 550;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.12s;
  }

  .btn-delete:hover {
    background: var(--error-soft);
    border-color: var(--error);
  }

  .error-banner {
    padding: 0.6rem 1rem;
    background: var(--error-soft);
    border: 1px solid rgba(239,68,68,0.2);
    border-radius: 4px;
    color: var(--error);
    font-size: 0.82rem;
    font-weight: 500;
  }

  .empty {
    text-align: center;
    padding: 3rem 1rem;
    color: var(--text-dim);
  }

  .empty p { margin: 0 0 0.5rem; font-size: 0.85rem; }
  .empty-sub { font-size: 0.78rem; color: var(--text-dim); }

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
  tbody tr.disabled td { opacity: 0.45; }

  .type-badge {
    display: inline-block;
    font-size: 0.7rem;
    font-weight: 650;
    padding: 0.15rem 0.5rem;
    border-radius: 99px;
    background: var(--accent-soft);
    color: var(--text-secondary);
  }

  .col-action { max-width: 300px; }

  .confidence-bar {
    display: inline-block;
    width: 60px;
    height: 5px;
    background: var(--bg-inset);
    border-radius: 3px;
    overflow: hidden;
    vertical-align: middle;
    margin-right: 0.4rem;
  }

  .confidence-fill {
    height: 100%;
    border-radius: 3px;
    background: var(--success);
    transition: width 0.3s ease;
  }

  .confidence-text {
    font-size: 0.75rem;
    font-weight: 650;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .source-tag {
    font-size: 0.7rem;
    font-weight: 550;
    color: var(--text-dim);
  }

  .col-num {
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }

  /* Switch toggle */
  .switch {
    width: 34px;
    height: 20px;
    border-radius: 10px;
    background: var(--text-dim);
    border: none;
    cursor: pointer;
    position: relative;
    transition: background 0.2s ease;
    padding: 0;
  }

  .switch.on { background: var(--success); }

  .switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s ease;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  }

  .switch.on .switch-thumb { transform: translateX(14px); }

  .spinner {
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
    display: inline-block;
  }

  @keyframes spin { to { transform: rotate(360deg); } }
</style>
