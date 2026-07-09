<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTemplate, updateTemplateApi, createTemplate, renderPreview, type Template } from "../lib/api.js";
  import { t } from "../lib/i18n.js";

  let { templateId, onBack }: { templateId?: string; onBack: () => void } = $props();

  let template = $state<Partial<Template>>({
    name: "",
    contentForm: "knowledge",
    canvas: { width: 1080, height: 1920, fps: 30 },
    variables: [],
    layers: [],
    audio: [],
    transitions: [],
    status: "draft",
  });
  let jsonText = $state<string>("");
  let saving = $state(false);
  let rendering = $state(false);
  let message = $state("");

  onMount(async () => {
    if (templateId) {
      const loaded = await fetchTemplate(templateId);
      template = loaded;
    }
    jsonText = JSON.stringify(template, null, 2);
  });

  function updateFromJson() {
    try {
      template = JSON.parse(jsonText);
      message = "";
    } catch (err) {
      message = err instanceof Error ? err.message : "Invalid JSON";
    }
  }

  async function save() {
    saving = true;
    try {
      updateFromJson();
      if (template.id) {
        await updateTemplateApi(template.id, template);
      } else {
        const created = await createTemplate(template);
        template = created;
        templateId = created.id;
      }
      message = t("saved");
    } catch (err) {
      message = err instanceof Error ? err.message : t("settingsSaveFailed");
    } finally {
      saving = false;
    }
  }

  async function preview() {
    if (!template.id) {
      message = t("saveFirst");
      return;
    }
    rendering = true;
    try {
      const defaults: Record<string, string | number> = {};
      for (const v of template.variables ?? []) defaults[v.name] = v.default ?? (v.type === "number" ? 0 : "预览");
      const result = await renderPreview(template.id, defaults);
      template.previewUrl = result.previewUrl;
      message = t("previewReady");
    } catch (err) {
      message = err instanceof Error ? err.message : "Preview failed";
    } finally {
      rendering = false;
    }
  }
</script>

<div class="editor-page">
  <header class="page-header">
    <button class="btn-text" onclick={onBack}>{t("back")}</button>
    <h1>{template.id ? template.name : t("newTemplate")}</h1>
    <div class="actions">
      <button class="btn-secondary" disabled={rendering} onclick={preview}>
        {rendering ? t("rendering") : t("preview")}
      </button>
      <button class="btn-primary" disabled={saving} onclick={save}>
        {saving ? t("saving") : t("saveChanges")}
      </button>
    </div>
  </header>

  {#if message}
    <p class="message">{message}</p>
  {/if}

  <div class="editor-layout">
    <div class="field-panel">
      <label class="field">
        <span>{t("templateName")}</span>
        <input type="text" bind:value={template.name} />
      </label>
      <label class="field">
        <span>{t("contentForm")}</span>
        <select bind:value={template.contentForm}>
          <option value="hot_comment">{t("formHotComment")}</option>
          <option value="knowledge">{t("formKnowledge")}</option>
          <option value="industry">{t("formIndustry")}</option>
          <option value="insight">{t("formInsight")}</option>
        </select>
      </label>
      <label class="field">
        <span>{t("canvasSize")}</span>
        <div class="row">
          <input type="number" bind:value={template.canvas.width} />
          <span>×</span>
          <input type="number" bind:value={template.canvas.height} />
          <input type="number" bind:value={template.canvas.fps} />
          <span>fps</span>
        </div>
      </label>
      {#if template.previewUrl}
        <div class="preview-box">
          <video src={template.previewUrl} controls muted loop playsinline></video>
        </div>
      {/if}
    </div>

    <div class="json-panel">
      <label class="field">
        <span>{t("timelineJson")}</span>
        <textarea bind:value={jsonText} onchange={updateFromJson} spellcheck="false"></textarea>
      </label>
    </div>
  </div>
</div>

<style>
  .editor-page { padding: 1rem 0; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 1rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); flex: 1; }
  .actions { display: flex; gap: 0.5rem; }
  .btn-text { background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: var(--size-sm); }
  .btn-text:hover { color: var(--text); }
  .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 1rem; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-inset); color: var(--text); cursor: pointer; }
  .btn-secondary:disabled { opacity: 0.5; cursor: not-allowed; }
  .message { margin-bottom: 1rem; color: var(--spark-red); font-size: var(--size-sm); }
  .editor-layout { display: grid; grid-template-columns: 320px 1fr; gap: 1.5rem; }
  .field-panel { display: flex; flex-direction: column; gap: 1rem; }
  .json-panel { min-height: 60vh; }
  .field { display: flex; flex-direction: column; gap: 0.35rem; font-size: var(--size-sm); }
  .field span { color: var(--text-secondary); }
  .field input, .field select, .field textarea { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; font-family: var(--font-body); }
  .field textarea { flex: 1; min-height: 100%; font-family: monospace; font-size: 0.8rem; line-height: 1.4; resize: vertical; }
  .row { display: flex; align-items: center; gap: 0.4rem; }
  .row input { width: 70px; }
  .preview-box { aspect-ratio: 9 / 16; background: var(--bg-inset); border-radius: 4px; overflow: hidden; }
  .preview-box video { width: 100%; height: 100%; object-fit: cover; }
  @media (max-width: 900px) {
    .editor-layout { grid-template-columns: 1fr; }
  }
</style>
