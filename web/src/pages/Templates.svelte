<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTemplates, deleteTemplateApi, renderPreview, updateTemplateApi, type Template } from "../lib/api.js";
  import { t } from "../lib/i18n.js";
  import TemplateEditor from "./TemplateEditor.svelte";

  let templates = $state<Template[]>([]);
  let loading = $state(true);
  let editingId = $state<string | undefined>(undefined);
  let statusFilter = $state<string>("");
  let contentFormFilter = $state<string>("");
  let renderingId = $state<string | null>(null);
  let generating = $state(false);
  let genCount = $state(5);
  let genContentForm = $state<string>("knowledge");
  let genReference = $state("");
  let genJobId = $state<string | null>(null);
  let genPollTimer: ReturnType<typeof setInterval> | null = null;
  let genMessage = $state("");

  /** preview_url 可能是 /preview-file 视频端点（img 无法渲染），仅图片扩展名可直接用 <img> */
  const isImageUrl = (u?: string) => !!u && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u);

  async function generateTemplates() {
    generating = true;
    genMessage = "模板生成中... 可以切换页面，生成完成后会自动刷新";
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: genCount, contentForm: genContentForm, reference: genReference }),
      });
      const data = await res.json();
      if (!data.jobId) {
        alert(data.error ?? "生成失败");
        generating = false;
        return;
      }
      genJobId = data.jobId;
      startPolling(data.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      generating = false;
    }
  }

  async function load() {
    loading = true;
    templates = await fetchTemplates(statusFilter || undefined, contentFormFilter || undefined);
    loading = false;
  }

  async function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    await deleteTemplateApi(id);
    await load();
  }

  async function preview(tpl: Template) {
    renderingId = tpl.id;
    try {
      // Force regenerate poster with cache-buster
      const posterRes = await fetch(`/api/templates/${tpl.id}/poster?t=${Date.now()}`);
      if (posterRes.ok) {
        const posterData = await posterRes.json();
        if (posterData.posterUrl) {
          tpl.posterUrl = `${posterData.posterUrl}?t=${Date.now()}`;
          templates = [...templates];
          return;
        }
      }
      // Fallback: try full video preview
      const defaults: Record<string, string | number> = {};
      for (const v of tpl.variables) defaults[v.name] = v.default ?? (v.type === "number" ? 0 : "预览");
      const result = await renderPreview(tpl.id, defaults);
      tpl.previewUrl = result.previewUrl;
    } catch (err) {
      console.error("Preview failed:", err);
    } finally {
      renderingId = null;
    }
  }

  /** candidate → approved（批量自动制作只会列出 approved 模板）；approved → candidate 停用 */
  async function setStatus(tpl: Template, status: string) {
    try {
      await updateTemplateApi(tpl.id, { status });
      tpl.status = status;
      templates = [...templates];
    } catch (err) {
      alert("状态更新失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Auto-generate posters for templates that have no displayable image
  async function autoGeneratePosters() {
    for (const tpl of templates) {
      if (tpl.posterUrl || isImageUrl(tpl.previewUrl)) continue;
      try {
        // Add cache-buster to force regeneration if poster was stale
        const res = await fetch(`/api/templates/${tpl.id}/poster?t=${Date.now()}`);
        if (res.ok) {
          const data = await res.json();
          if (data.posterUrl) {
            tpl.posterUrl = data.posterUrl;
          }
        } else {
          // If poster failed, try preview endpoint
          try {
            const pvRes = await fetch(`/api/templates/${tpl.id}/preview`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ variables: {} }),
            });
            if (pvRes.ok) {
              const pvData = await pvRes.json();
              if (pvData.previewUrl) {
                tpl.previewUrl = pvData.previewUrl;
              }
            }
          } catch {}
        }
      } catch {
        // ignore poster generation errors
      }
    }
    templates = [...templates];
  }

  onMount(async () => {
    await load();
    await autoGeneratePosters();
    // Check if there's a running generation job (page re-entry after switching)
    try {
      const res = await fetch("/api/templates/generate/active");
      if (res.ok) {
        const data = await res.json();
        if (data.active && data.jobId) {
          generating = true;
          genJobId = data.jobId;
          genMessage = `生成中... (已恢复任务 ${data.jobId.slice(-6)})`;
          startPolling(data.jobId);
        }
      }
    } catch {}
  });

  function startPolling(jobId: string) {
    genPollTimer = setInterval(async () => {
      try {
        const statusRes = await fetch(`/api/templates/generate/status/${jobId}`);
        const statusData = await statusRes.json();
        if (statusData.status === "done") {
          if (genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
          genJobId = null;
          generating = false;
          genMessage = `生成完成！新增 ${statusData.generated} 个模板`;
          await load();
          await autoGeneratePosters();
          setTimeout(() => { genMessage = ""; }, 5000);
        } else if (statusData.status === "error") {
          if (genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
          genJobId = null;
          generating = false;
          genMessage = "";
          alert(statusData.error ?? "生成失败");
        }
      } catch {}
    }, 5000);
  }
</script>

<div class="templates-root">
{#if editingId}
  <TemplateEditor templateId={editingId} onBack={() => { editingId = undefined; load(); }} />
{:else}
  <div class="templates-page">
    <header class="page-header">
      <h1>{t("templatesTitle")}</h1>
      <div class="filters">
        <select bind:value={statusFilter} onchange={load}>
          <option value="">{t("filterAll")}</option>
          <option value="draft">{t("templateDraft")}</option>
          <option value="candidate">{t("templateCandidate")}</option>
          <option value="approved">{t("templateApproved")}</option>
          <option value="archived">{t("templateArchived")}</option>
        </select>
        <select bind:value={contentFormFilter} onchange={load}>
          <option value="">{t("filterAllForms")}</option>
          <option value="hot_comment">{t("formHotComment")}</option>
          <option value="knowledge">{t("formKnowledge")}</option>
          <option value="industry">{t("formIndustry")}</option>
          <option value="insight">{t("formInsight")}</option>
        </select>
        <button class="btn-primary" onclick={load}>{t("refresh")}</button>
      </div>
      <div class="gen-row">
        <input type="text" bind:value={genReference} placeholder="参考风格（可选，如 知识科普 蓝白配色）" class="gen-input" />
        <select bind:value={genContentForm}>
          <option value="knowledge">知识传播</option>
          <option value="hot_comment">热点评论</option>
          <option value="industry">行业动态</option>
          <option value="insight">深度洞察</option>
        </select>
        <select bind:value={genCount}>
          <option value="3">3个</option>
          <option value="5">5个</option>
          <option value="8">8个</option>
          <option value="10">10个</option>
        </select>
        <button class="btn-primary gen-btn" disabled={generating} onclick={generateTemplates}>{generating ? "生成中..." : "AI 生成模板"}</button>
      </div>
      {#if genMessage}
        <p class="gen-message">{genMessage}</p>
      {/if}
    </header>

    {#if loading}
      <p class="empty">{t("loading")}</p>
    {:else if templates.length === 0}
      <p class="empty">{t("noTemplates")}</p>
    {:else}
      <div class="template-grid">
        {#each templates as tpl}
          <article class="template-card">
            <div class="preview">
              {#if tpl.posterUrl}
                <img src={tpl.posterUrl} alt={tpl.name} class="poster-img" />
              {:else if isImageUrl(tpl.previewUrl)}
                <img src={tpl.previewUrl} alt={tpl.name} class="poster-img" />
              {:else if tpl.previewUrl && tpl.previewUrl.endsWith(".mp4")}
                <video src={tpl.previewUrl} muted loop playsinline preload="metadata"></video>
              {:else}
                <div class="preview-placeholder">{t("noPreview")}</div>
              {/if}
            </div>
            <div class="meta">
              <span class="status-badge" data-status={tpl.status}>{t(`template${tpl.status.charAt(0).toUpperCase() + tpl.status.slice(1)}`)}</span>
              <span class="form">{tpl.contentForm ?? t("formGeneric")}</span>
            </div>
            <h3>{tpl.name}</h3>
            <p class="dims">{tpl.canvas.width} x {tpl.canvas.height} @ {tpl.canvas.fps}fps</p>
            <div class="actions">
              <button class="btn-sm" disabled={renderingId === tpl.id} onclick={() => preview(tpl)}>
                {renderingId === tpl.id ? t("rendering") : t("preview")}
              </button>
              <button class="btn-sm secondary" onclick={() => editingId = tpl.id}>{t("edit")}</button>
              {#if tpl.status === "candidate"}
                <button class="btn-sm approve" title="设为可用后，批量自动制作可选择此模板" onclick={() => setStatus(tpl, "approved")}>启用</button>
              {:else if tpl.status === "approved"}
                <button class="btn-sm secondary" title="停用后批量自动制作将不再列出此模板" onclick={() => setStatus(tpl, "candidate")}>停用</button>
              {/if}
              <button class="btn-sm secondary" onclick={() => remove(tpl.id)}>{t("delete")}</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </div>
{/if}
</div>

<style>
  .templates-page { padding: 1rem 0; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .filters { display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap; }
  .empty { color: var(--text-muted); padding: 2rem 0; }
  .template-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .template-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .preview { aspect-ratio: 9 / 16; background: var(--bg-inset); border-radius: 4px; overflow: hidden; display: grid; place-items: center; }
  .preview video { width: 100%; height: 100%; object-fit: cover; }
  .poster-img { width: 100%; height: 100%; object-fit: cover; }
  .preview-placeholder { color: var(--text-muted); font-size: var(--size-sm); }
  .meta { display: flex; gap: 0.5rem; align-items: center; }
  .status-badge { font-size: var(--size-xs); padding: 0.15rem 0.4rem; border-radius: 3px; background: var(--bg-inset); color: var(--text-muted); text-transform: capitalize; }
  .form { font-size: var(--size-xs); color: var(--text-muted); }
  .template-card h3 { font-size: var(--size-base); margin: 0; }
  .dims { font-size: var(--size-xs); color: var(--text-dim); margin: 0; }
  .actions { display: flex; gap: 0.5rem; margin-top: auto; }
  .btn-sm { flex: 1; padding: 0.45rem 0.6rem; border: none; border-radius: 4px; background: var(--text); color: var(--bg); font-size: var(--size-xs); font-weight: 600; cursor: pointer; }
  .btn-sm.secondary { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); }
  .btn-sm.approve { background: var(--accent); color: var(--accent-text); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .gen-row { display: flex; gap: 0.5rem; align-items: center; margin-top: 0.75rem; flex-wrap: wrap; }
  .gen-input { flex: 1; min-width: 200px; }
  .gen-btn { background: var(--accent-gradient); }
  .gen-message { font-size: 0.82rem; color: var(--text-secondary); margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; background: var(--accent-soft, rgba(0,0,0,0.05)); border-radius: 4px; }
</style>
