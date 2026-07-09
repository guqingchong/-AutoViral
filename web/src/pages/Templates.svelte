<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTemplates, deleteTemplateApi, renderPreview, type Template } from "../lib/api.js";
  import { t } from "../lib/i18n.js";

  let templates = $state<Template[]>([]);
  let loading = $state(true);
  let statusFilter = $state<string>("");
  let contentFormFilter = $state<string>("");
  let renderingId = $state<string | null>(null);

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
      const defaults: Record<string, string | number> = {};
      for (const v of tpl.variables) defaults[v.name] = v.default ?? (v.type === "number" ? 0 : "预览");
      const result = await renderPreview(tpl.id, defaults);
      tpl.previewUrl = result.previewUrl;
    } finally {
      renderingId = null;
    }
  }

  onMount(load);
</script>

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
            {#if tpl.previewUrl}
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
            <button class="btn-sm secondary" onclick={() => remove(tpl.id)}>{t("delete")}</button>
          </div>
        </article>
      {/each}
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
  .preview-placeholder { color: var(--text-muted); font-size: var(--size-sm); }
  .meta { display: flex; gap: 0.5rem; align-items: center; }
  .status-badge { font-size: var(--size-xs); padding: 0.15rem 0.4rem; border-radius: 3px; background: var(--bg-inset); color: var(--text-muted); text-transform: capitalize; }
  .form { font-size: var(--size-xs); color: var(--text-muted); }
  .template-card h3 { font-size: var(--size-base); margin: 0; }
  .dims { font-size: var(--size-xs); color: var(--text-dim); margin: 0; }
  .actions { display: flex; gap: 0.5rem; margin-top: auto; }
  .btn-sm { flex: 1; padding: 0.45rem 0.6rem; border: none; border-radius: 4px; background: var(--text); color: var(--bg); font-size: var(--size-xs); font-weight: 600; cursor: pointer; }
  .btn-sm.secondary { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
