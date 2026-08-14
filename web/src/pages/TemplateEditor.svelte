<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTemplate, updateTemplateApi, createTemplate, renderPreview, fetchSharedAssets, uploadAsset, type Template, type AssetFile } from "../lib/api.js";
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

  // AI 再加工(2026-08-13 模板库改造)
  let refineInstruction = $state("");
  let refineSaveAsCopy = $state(false);
  let refining = $state(false);
  let refineMessage = $state("");

  // 品牌 Logo(2026-08-13 模板库改造 功能 c)
  const BRAND_POSITIONS = [
    ["top-left", "top-center", "top-right"],
    ["middle-left", "center", "middle-right"],
    ["bottom-left", "bottom-center", "bottom-right"],
  ];
  let brandingLogos = $state<AssetFile[]>([]);
  let uploadingLogo = $state(false);

  async function loadBrandingLogos() {
    try {
      const all = await fetchSharedAssets();
      brandingLogos = all["branding"] ?? [];
    } catch { brandingLogos = []; }
  }

  async function uploadLogo(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    uploadingLogo = true;
    try {
      await uploadAsset("branding", [...input.files]);
      await loadBrandingLogos();
      // 自动选中新上传的 logo
      const newest = brandingLogos[brandingLogos.length - 1];
      if (newest) setBranding({ logoAsset: `branding/${newest.name}` });
    } catch (err) {
      message = "logo 上传失败:" + (err instanceof Error ? err.message : String(err));
    } finally {
      uploadingLogo = false;
      input.value = "";
    }
  }

  /** 更新 branding 并同步 JSON 面板 */
  function setBranding(patch: Record<string, unknown>) {
    const cur = template.branding ?? { logoAsset: "", position: "top-right", margin: 48, width: 160, opacity: 1 };
    template.branding = { ...cur, ...patch } as Template["branding"];
    if (!template.branding?.logoAsset) template.branding = undefined;
    jsonText = JSON.stringify(template, null, 2);
  }

  function clearBranding() {
    template.branding = undefined;
    jsonText = JSON.stringify(template, null, 2);
  }

  async function refine() {
    if (!template.id) {
      refineMessage = "请先保存模板";
      return;
    }
    if (!refineInstruction.trim()) {
      refineMessage = "请输入加工指令";
      return;
    }
    refining = true;
    refineMessage = "";
    try {
      const res = await fetch(`/api/templates/${template.id}/refine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: refineInstruction, saveAsCopy: refineSaveAsCopy }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { jobId } = await res.json();
      // 轮询直至完成
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await (await fetch(`/api/templates/refine/status/${jobId}`)).json();
        if (st.status === "done") {
          refineMessage = `✓ ${st.diffSummary ?? "加工完成"}`;
          if (st.copied) {
            refineMessage += `(已另存为新模板 ${st.templateId})`;
          } else {
            // 覆盖写回:重新拉取模板刷新编辑器
            const loaded = await fetchTemplate(template.id);
            template = loaded;
            jsonText = JSON.stringify(template, null, 2);
          }
          refineInstruction = "";
          return;
        }
        if (st.status === "error") throw new Error(st.error ?? "加工失败");
      }
      throw new Error("加工超时(10 分钟)");
    } catch (err) {
      refineMessage = "✗ " + (err instanceof Error ? err.message : String(err));
    } finally {
      refining = false;
    }
  }

  onMount(async () => {
    if (templateId) {
      const loaded = await fetchTemplate(templateId);
      template = loaded;
    }
    jsonText = JSON.stringify(template, null, 2);
    loadBrandingLogos();
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
      // Try poster endpoint first (fast, no host_video needed)
      const posterRes = await fetch(`/api/templates/${template.id}/poster`);
      if (posterRes.ok) {
        const posterData = await posterRes.json();
        if (posterData.posterUrl) {
          template.previewUrl = posterData.posterUrl;
          message = "预览图已生成";
          rendering = false;
          return;
        }
      }
      // Fallback: try full video preview (will also fall back to poster internally)
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
          {#if template.previewUrl.endsWith(".mp4")}
            <video src={template.previewUrl} controls muted loop playsinline></video>
          {:else}
            <img src={template.previewUrl} alt="preview" style="width: 100%; height: 100%; object-fit: cover;" />
          {/if}
        </div>
      {/if}

      <!-- 品牌 Logo(所有使用该模板的作品都会带上) -->
      <div class="branding-box">
        <span class="branding-title">品牌 Logo</span>
        {#if template.branding?.logoAsset}
          <div class="branding-current">
            <img src="/api/shared-assets/{template.branding.logoAsset}" alt="logo" class="branding-preview" />
            <button class="btn-text" onclick={clearBranding}>移除</button>
          </div>
          <div class="branding-grid">
            {#each BRAND_POSITIONS as row}
              <div class="branding-grid-row">
                {#each row as pos}
                  <button
                    class="branding-cell"
                    class:active={template.branding?.position === pos}
                    title={pos}
                    onclick={() => setBranding({ position: pos })}
                  ></button>
                {/each}
              </div>
            {/each}
          </div>
          <label class="field">
            <span>宽度 {template.branding?.width ?? 160}px</span>
            <input type="range" min="60" max="400" step="10" value={template.branding?.width ?? 160} oninput={(e) => setBranding({ width: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>边距 {template.branding?.margin ?? 48}px</span>
            <input type="range" min="0" max="200" step="4" value={template.branding?.margin ?? 48} oninput={(e) => setBranding({ margin: Number((e.target as HTMLInputElement).value) })} />
          </label>
          <label class="field">
            <span>不透明度 {Math.round((template.branding?.opacity ?? 1) * 100)}%</span>
            <input type="range" min="0.1" max="1" step="0.05" value={template.branding?.opacity ?? 1} oninput={(e) => setBranding({ opacity: Number((e.target as HTMLInputElement).value) })} />
          </label>
        {:else}
          <label class="field">
            <span>选择已上传的 logo</span>
            <select onchange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) setBranding({ logoAsset: v }); }}>
              <option value="">-- 选择 --</option>
              {#each brandingLogos as f}
                <option value="branding/{f.name}">{f.name}</option>
              {/each}
            </select>
          </label>
          <label class="branding-upload">
            {uploadingLogo ? "上传中…" : "上传新 logo"}
            <input type="file" accept="image/png,image/jpeg,image/webp" style="display:none" onchange={uploadLogo} disabled={uploadingLogo} />
          </label>
        {/if}
        <p class="branding-hint">保存后,所有使用该模板生成的作品(视频+图文)都会自动带上 logo</p>
      </div>
    </div>

    <div class="json-panel">
      {#if template.id}
        <div class="refine-box">
          <span class="refine-title">AI 再加工</span>
          <textarea class="refine-input" bind:value={refineInstruction} placeholder="用自然语言描述修改,如:配色改成墨绿系 / 标题字号加大 / 转场全部换成淡入淡出" spellcheck="false"></textarea>
          <div class="refine-actions">
            <label class="refine-copy">
              <input type="checkbox" bind:checked={refineSaveAsCopy} />
              另存为新模板(保留原版)
            </label>
            <button class="btn-secondary" disabled={refining} onclick={refine}>
              {refining ? "加工中…(约1-2分钟)" : "开始加工"}
            </button>
          </div>
          {#if refineMessage}
            <p class="refine-msg">{refineMessage}</p>
          {/if}
        </div>
      {/if}
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
  .refine-box { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: 6px; margin-bottom: 0.75rem; background: var(--bg-inset); }
  .refine-title { font-size: var(--size-sm); color: var(--text-secondary); font-weight: 600; }
  .refine-input { min-height: 60px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; font-family: var(--font-body); resize: vertical; }
  .refine-actions { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
  .refine-copy { display: flex; align-items: center; gap: 0.35rem; font-size: 0.75rem; color: var(--text-muted); cursor: pointer; }
  .refine-msg { margin: 0; font-size: 0.75rem; color: var(--text-secondary); }
  .branding-box { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.75rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-inset); }
  .branding-title { font-size: var(--size-sm); color: var(--text-secondary); font-weight: 600; }
  .branding-current { display: flex; align-items: center; gap: 0.6rem; }
  .branding-preview { width: 48px; height: 48px; object-fit: contain; background: #fff; border-radius: 4px; }
  .branding-grid { display: flex; flex-direction: column; gap: 4px; width: fit-content; }
  .branding-grid-row { display: flex; gap: 4px; }
  .branding-cell { width: 28px; height: 28px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); cursor: pointer; }
  .branding-cell.active { background: var(--accent); border-color: var(--accent); }
  .branding-upload { display: block; text-align: center; padding: 0.45rem; border: 1px dashed var(--border); border-radius: 6px; color: var(--text-secondary); font-size: 0.75rem; cursor: pointer; }
  .branding-upload:hover { border-color: var(--text-secondary); }
  .branding-hint { margin: 0; font-size: 0.72rem; color: var(--text-dim); }
  @media (max-width: 900px) {
    .editor-layout { grid-template-columns: 1fr; }
  }
</style>
