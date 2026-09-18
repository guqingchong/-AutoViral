<script lang="ts">
  /**
   * ForcePassConfirmModal —— 强制通过「带病放行」逐条确认弹窗(2026-09-11)。
   *
   * 后端 force-pass 在最新评审仍有未修复 issues 时返回 409 + 清单;
   * 本组件把清单列出(critical/major 红字置顶),全部勾选后才放行 confirm:true 重发。
   * 来源:镜38 两个 major 被静默放进 assembly 的复盘改进点 1。
   */
  import type { EvalIssue } from "../lib/api.js";

  let {
    issues,
    stepName,
    busy = false,
    onConfirm,
    onCancel,
  }: {
    issues: EvalIssue[];
    stepName: string;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  } = $props();

  let checked: boolean[] = $state(issues.map(() => false));
  const allChecked = $derived(checked.every(Boolean));
  const seriousCount = $derived(issues.filter((i) => i.severity !== "minor").length);

  const SEVERITY_LABEL: Record<string, string> = { critical: "严重", major: "重要", minor: "轻微" };
</script>

<div class="fp-overlay" role="dialog" aria-modal="true">
  <div class="fp-modal">
    <h3 class="fp-title">⚠️ 强制通过 = 带病放行</h3>
    <p class="fp-desc">
      「{stepName}」最新评审仍有 <strong>{issues.length}</strong> 项未修复问题{#if seriousCount}(含 <strong class="fp-red">{seriousCount} 项 严重/重要</strong>){/if}。
      这些问题将随作品进入后续阶段(成本后移)。请逐条阅读并确认接受:
    </p>
    <ul class="fp-list">
      {#each issues as issue, i}
        <li class:fp-serious={issue.severity !== "minor"}>
          <label>
            <input type="checkbox" bind:checked={checked[i]} />
            <span class="fp-sev fp-sev-{issue.severity}">{SEVERITY_LABEL[issue.severity] ?? issue.severity}</span>
            <span class="fp-text">{issue.description}</span>
            {#if issue.file}<span class="fp-file">{issue.file}</span>{/if}
          </label>
        </li>
      {/each}
    </ul>
    <div class="fp-actions">
      <button class="fp-btn fp-cancel" onclick={onCancel} disabled={busy}>取消</button>
      <button class="fp-btn fp-confirm" onclick={onConfirm} disabled={!allChecked || busy}>
        {busy ? "放行中…" : allChecked ? "我已知悉上述风险,确认放行" : `还有 ${checked.filter((c) => !c).length} 条未确认`}
      </button>
    </div>
  </div>
</div>

<style>
  .fp-overlay {
    position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
    display: flex; align-items: center; justify-content: center; z-index: 1000;
  }
  .fp-modal {
    width: min(680px, 92vw); max-height: 84vh; overflow-y: auto;
    background: #1e2230; color: #e5e7eb; border-radius: 14px; padding: 24px 26px;
    box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  }
  .fp-title { margin: 0 0 10px; font-size: 18px; }
  .fp-desc { margin: 0 0 16px; font-size: 13.5px; line-height: 1.6; color: #b6bcc9; }
  .fp-red { color: #f87171; }
  .fp-list { list-style: none; margin: 0 0 18px; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .fp-list li {
    border: 1px solid #333a4d; border-radius: 10px; padding: 10px 12px; background: #262b3a;
  }
  .fp-list li.fp-serious { border-color: #7f2d35; background: #2c2229; }
  .fp-list label { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; font-size: 13px; line-height: 1.55; }
  .fp-list input { margin-top: 3px; accent-color: #ef4444; }
  .fp-sev { flex-shrink: 0; font-size: 11px; padding: 1px 8px; border-radius: 6px; font-weight: 600; }
  .fp-sev-critical { background: #7f1d1d; color: #fecaca; }
  .fp-sev-major { background: #7c2d12; color: #fed7aa; }
  .fp-sev-minor { background: #374151; color: #d1d5db; }
  .fp-text { flex: 1; }
  .fp-file { flex-shrink: 0; font-size: 11px; color: #8b93a5; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fp-actions { display: flex; justify-content: flex-end; gap: 10px; }
  .fp-btn { border: none; border-radius: 9px; padding: 9px 18px; font-size: 13.5px; cursor: pointer; }
  .fp-cancel { background: #374151; color: #e5e7eb; }
  .fp-confirm { background: #dc2626; color: #fff; font-weight: 600; }
  .fp-confirm:disabled { background: #4b5563; color: #9ca3af; cursor: not-allowed; }
</style>
