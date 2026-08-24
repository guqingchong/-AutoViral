<script lang="ts">
  import { onMount } from "svelte";
  import { deleteTemplateApi, renderPreview, updateTemplateApi, type Template } from "../lib/api.js";
  import { t } from "../lib/i18n.js";
  import TemplateEditor from "./TemplateEditor.svelte";

  type TemplateWithKind = Template & { kind?: string };

  let templates = $state<TemplateWithKind[]>([]);
  let loading = $state(true);
  let editingId = $state<string | undefined>(undefined);
  let statusFilter = $state<string>("");
  let contentFormFilter = $state<string>("");
  let kindFilter = $state<string>("");
  let renderingId = $state<string | null>(null);
  let generating = $state(false);
  let genCount = $state(5);
  let genContentForm = $state<string>("knowledge");
  let genReference = $state("");
  let genJobId = $state<string | null>(null);
  let genPollTimer: ReturnType<typeof setInterval> | null = null;
  let genMessage = $state("");
  // ── 代码渲染模板生成(2026-08-24 Revideo 支路) ──
  let codeGenStyle = $state("");
  let codeGenOrientation = $state<"portrait" | "landscape">("portrait");
  let codeGenWithDh = $state(false);

  // ── 模板要素（2026-08-03 要素化生成）──
  let elLayout = $state<string>("");
  let elPalette = $state<string>("ai_choice");
  let elMotion = $state<string>("");
  let elDecorations = $state<string[]>([]);
  const LAYOUT_OPTIONS = [
    { key: "", label: "让 AI 混搭" },
    { key: "magazine_left", label: "左对齐杂志风" },
    { key: "big_number", label: "居中大数字风" },
    { key: "top_block", label: "顶部色块标题风" },
    { key: "split_screen", label: "上下分屏风" },
    { key: "card_stack", label: "卡片堆叠风" },
    { key: "fullscreen_caption", label: "全屏字幕风" },
  ];
  const PALETTE_OPTIONS = [
    { key: "ai_choice", label: "让 AI 发挥" },
    { key: "tech_blue", label: "深蓝科技" },
    { key: "warm_gold", label: "暖黑金" },
    { key: "ink_green", label: "墨绿知识" },
    { key: "deep_purple", label: "深紫洞察" },
    { key: "minimal_white", label: "米白简约" },
    { key: "mist_cyan", label: "雾蓝清爽" },
  ];
  const MOTION_OPTIONS = [
    { key: "", label: "让 AI 混搭" },
    { key: "none", label: "无动效" },
    { key: "fade", label: "淡入" },
    { key: "slide", label: "滑入" },
    { key: "bounce", label: "弹性" },
  ];
  const DECORATION_OPTIONS = [
    { key: "accent_bar", label: "顶部装饰条" },
    { key: "serial_number", label: "序号" },
    { key: "divider", label: "分隔线" },
    { key: "texture", label: "底纹" },
    { key: "corner_marks", label: "角标" },
  ];
  function toggleDecoration(key: string) {
    elDecorations = elDecorations.includes(key)
      ? elDecorations.filter((k) => k !== key)
      : [...elDecorations, key];
  }
  function currentElements() {
    return {
      contentForm: genContentForm,
      layout: elLayout || undefined,
      palette: elPalette,
      motion: elMotion || undefined,
      decorations: elDecorations,
      freeText: genReference || undefined,
    };
  }

  // ── 调研学习 ──
  let researching = $state(false);
  let researchMessage = $state("");
  let researchPollTimer: ReturnType<typeof setInterval> | null = null;
  let skillCount = $state(0);

  async function loadSkillCount() {
    try {
      const res = await fetch("/api/templates/skills");
      if (res.ok) {
        const data = await res.json();
        skillCount = (data.skills ?? []).length;
      }
    } catch {}
  }

  async function researchTemplates() {
    researching = true;
    researchMessage = "调研学习中... AI 正在全网调研优秀模板设计（约 2-5 分钟），可切换页面";
    try {
      const res = await fetch("/api/templates/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ elements: currentElements() }),
      });
      const data = await res.json();
      if (!data.jobId) {
        alert(data.error ?? "调研启动失败");
        researching = false;
        researchMessage = "";
        return;
      }
      startResearchPolling(data.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      researching = false;
      researchMessage = "";
    }
  }

  function startResearchPolling(jobId: string) {
    researchPollTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/templates/research/status/${jobId}`);
        const data = await res.json();
        if (data.status === "done") {
          if (researchPollTimer) { clearInterval(researchPollTimer); researchPollTimer = null; }
          researching = false;
          researchMessage = `调研完成！新增 ${data.added} 条设计技能，之后生成模板会自动吸收这些经验`;
          await loadSkillCount();
          setTimeout(() => { researchMessage = ""; }, 8000);
        } else if (data.status === "error") {
          if (researchPollTimer) { clearInterval(researchPollTimer); researchPollTimer = null; }
          researching = false;
          researchMessage = "";
          alert(data.error ?? "调研失败");
        }
      } catch {}
    }, 5000);
  }

  /** preview_url 可能是 /preview-file 视频端点（img 无法渲染），仅图片扩展名可直接用 <img> */
  const isImageUrl = (u?: string) => !!u && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(u);

  // ── 克隆优秀作品模板(2026-08-13 二期) ──
  let cloneUrl = $state("");
  let cloneHint = $state("");
  let cloning = $state(false);
  let cloneMessage = $state("");
  let clonePollTimer: ReturnType<typeof setInterval> | null = null;

  const CLONE_STAGE_LABELS: Record<string, string> = {
    download: "下载/抓取作品",
    frames: "抽帧",
    analyze: "AI 视觉分析版式",
    build: "组装模板",
  };

  async function cloneFromUrl() {
    if (!cloneUrl.trim()) {
      cloneMessage = "请先粘贴作品链接";
      return;
    }
    cloning = true;
    cloneMessage = "";
    try {
      const res = await fetch("/api/templates/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: cloneUrl.trim(), hint: cloneHint.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.jobId) {
        cloneMessage = "✗ " + (data.error ?? "克隆启动失败");
        cloning = false;
        return;
      }
      startClonePolling(data.jobId);
    } catch (err) {
      cloneMessage = "✗ " + (err instanceof Error ? err.message : String(err));
      cloning = false;
    }
  }

  /** 上传本地视频文件克隆(视频号等无视频流平台的通路:先嗅探/录屏拿到 mp4) */
  let cloneFileInput: HTMLInputElement;
  function pickCloneFile() { cloneFileInput?.click(); }
  async function cloneFromUpload(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    cloning = true;
    cloneMessage = "上传中… " + file.name;
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (cloneHint.trim()) fd.append("hint", cloneHint.trim());
      const res = await fetch("/api/templates/clone/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.jobId) {
        cloneMessage = "✗ " + (data.error ?? "上传失败");
        cloning = false;
        return;
      }
      startClonePolling(data.jobId);
    } catch (err) {
      cloneMessage = "✗ " + (err instanceof Error ? err.message : String(err));
      cloning = false;
    }
  }

  function startClonePolling(jobId: string) {
    clonePollTimer = setInterval(async () => {
      try {
        const st = await (await fetch(`/api/templates/clone/status/${jobId}`)).json();
        if (st.status === "done") {
          if (clonePollTimer) { clearInterval(clonePollTimer); clonePollTimer = null; }
          cloning = false;
          cloneMessage = `✓ 克隆完成:「${st.name}」已入库(草稿),预览确认后可启用;还可以用「再加工」继续打磨`;
          cloneUrl = "";
          cloneHint = "";
          await load();
        } else if (st.status === "error") {
          if (clonePollTimer) { clearInterval(clonePollTimer); clonePollTimer = null; }
          cloning = false;
          cloneMessage = "✗ " + (st.error ?? "克隆失败") + "(可换链接重试)";
        } else {
          cloneMessage = `克隆中… ${CLONE_STAGE_LABELS[st.stage] ?? st.stage ?? ""}`;
        }
      } catch {}
    }, 4000);
  }

  async function generateTemplates() {
    generating = true;
    genMessage = "模板生成中... 可以切换页面，生成完成后会自动刷新";
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: genCount, contentForm: genContentForm, reference: genReference, elements: currentElements() }),
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

  /** 生成代码渲染模板:LLM 产 Revideo TSX → 真实渲染验证 → kind=code 入库(2026-08-24) */
  async function generateCodeTemplates() {
    if (!codeGenStyle.trim()) {
      alert("请先描述风格,如「赛博朋克霓虹、深色底、青色辉光」");
      return;
    }
    generating = true;
    genMessage = "代码模板生成中(LLM 设计 + Revideo 渲染验证,约 2-4 分钟)... 可以切换页面";
    try {
      const res = await fetch("/api/templates/generate-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: codeGenStyle, orientation: codeGenOrientation, withDigitalHuman: codeGenWithDh }),
      });
      const data = await res.json();
      if (!data.jobId) {
        alert(data.error ?? "生成失败");
        generating = false;
        return;
      }
      genJobId = data.jobId;
      // 生成完成后切到代码渲染分类,直接看到新模板(带视频预览)
      kindFilter = "code";
      startPolling(data.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      generating = false;
    }
  }

  async function load() {
    loading = true;
    // 直接 fetch 以支持 kind 筛选（lib/api.ts 的 fetchTemplates 暂无 kind 参数）
    const qs = new URLSearchParams();
    if (statusFilter) qs.set("status", statusFilter);
    if (contentFormFilter) qs.set("contentForm", contentFormFilter);
    if (kindFilter) qs.set("kind", kindFilter);
    try {
      const res = await fetch(`/api/templates?${qs.toString()}`);
      const data = await res.json();
      templates = data.templates ?? [];
    } catch {
      templates = [];
    }
    loading = false;
  }

  /** 生成图文模板：走同一 /api/templates/generate 端点（kind=image-text）+ 同一轮询 */
  async function generateImageTextTemplates() {
    generating = true;
    genMessage = "图文模板生成中... 可以切换页面，生成完成后会自动刷新";
    try {
      const res = await fetch("/api/templates/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ count: genCount, kind: "image-text" }),
      });
      const data = await res.json();
      if (!data.jobId) {
        alert(data.error ?? "生成失败");
        generating = false;
        return;
      }
      genJobId = data.jobId;
      // 切到图文分类，生成完成后能直接看到新模板
      kindFilter = "image-text";
      startPolling(data.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      generating = false;
    }
  }

  async function remove(id: string) {
    if (!confirm(t("confirmDelete"))) return;
    await deleteTemplateApi(id);
    await load();
  }

  // ── 分幕灯箱预览(2026-08-13):点预览看大图,左右切换逐幕查看 ──
  let lightboxUrls = $state<string[]>([]);
  let lightboxIdx = $state(0);
  let lightboxName = $state("");

  function openLightbox(tpl: Template) {
    if (!tpl.frameUrls || tpl.frameUrls.length === 0) return false;
    lightboxUrls = tpl.frameUrls;
    lightboxIdx = 0;
    lightboxName = tpl.name;
    return true;
  }
  function closeLightbox() { lightboxUrls = []; }
  function stepLightbox(delta: number) {
    lightboxIdx = (lightboxIdx + delta + lightboxUrls.length) % lightboxUrls.length;
  }
  function onLightboxKeydown(e: KeyboardEvent) {
    if (lightboxUrls.length === 0) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") stepLightbox(-1);
    else if (e.key === "ArrowRight") stepLightbox(1);
  }

  async function preview(tpl: Template) {
    renderingId = tpl.id;
    try {
      // Force regenerate poster with cache-buster
      const posterRes = await fetch(`/api/templates/${tpl.id}/poster?t=${Date.now()}`);
      if (posterRes.ok) {
        const posterData = await posterRes.json();
        if (posterData.frameUrls?.length) tpl.frameUrls = posterData.frameUrls;
        if (posterData.posterUrl) {
          tpl.posterUrl = `${posterData.posterUrl}?t=${Date.now()}`;
          templates = [...templates];
        }
        // 有分幕单帧 → 弹灯箱逐张看;没有则退回旧预览路径
        if (openLightbox(tpl)) return;
        if (posterData.posterUrl) return;
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
          if (data.frameUrls?.length) {
            tpl.frameUrls = data.frameUrls;
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
    loadSkillCount();
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
    // 恢复进行中的调研任务
    try {
      const res = await fetch("/api/templates/research/active");
      if (res.ok) {
        const data = await res.json();
        if (data.active && data.jobId) {
          researching = true;
          researchMessage = "调研学习中... (已恢复任务)";
          startResearchPolling(data.jobId);
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
          alert(friendlyGenError(statusData.error));
        }
      } catch {}
    }, 5000);
  }

  /** 服务端原始报错转人话(2026-08-19:超时黑话 "This operation was aborted" 用户看不懂) */
  function friendlyGenError(raw: string | null | undefined): string {
    if (!raw) return "生成失败,请重试";
    if (/aborted|timed? ?out|ETIMEDOUT/i.test(raw)) {
      return "生成超时:大模型本次响应过慢(高峰期常见)。请稍后重试,或减少一次生成的数量。";
    }
    if (/LLM API 4\d\d/.test(raw)) return "大模型接口拒绝了请求,请到设置页检查 API Key 与模型配置。";
    if (/LLM API 5\d\d|ECONN|network|fetch failed/i.test(raw)) return "大模型服务暂时不可用,请稍后重试。";
    if (/无法从响应提取 JSON/.test(raw)) return "大模型返回的内容格式异常,请重试一次。";
    return `生成失败:${raw}`;
  }
</script>

<svelte:window onkeydown={onLightboxKeydown} />
<div class="templates-root">
{#if lightboxUrls.length > 0}
  <!-- 分幕灯箱:大图逐张查看(2026-08-13) -->
  <div class="lightbox-backdrop" role="button" tabindex="0" onclick={closeLightbox} onkeydown={(e) => e.key === "Enter" && closeLightbox()}>
    <div class="lightbox-body" role="presentation" onclick={(e) => e.stopPropagation()}>
      <div class="lightbox-header">
        <span class="lightbox-title">{lightboxName}</span>
        <span class="lightbox-counter">第 {lightboxIdx + 1} / {lightboxUrls.length} 幕</span>
        <button class="lightbox-close" onclick={closeLightbox}>✕</button>
      </div>
      <div class="lightbox-stage">
        {#if lightboxUrls.length > 1}
          <button class="lightbox-nav prev" onclick={() => stepLightbox(-1)}>‹</button>
        {/if}
        <img src={lightboxUrls[lightboxIdx]} alt={`第 ${lightboxIdx + 1} 幕`} class="lightbox-img" />
        {#if lightboxUrls.length > 1}
          <button class="lightbox-nav next" onclick={() => stepLightbox(1)}>›</button>
        {/if}
      </div>
    </div>
  </div>
{/if}
{#if editingId}
  <TemplateEditor templateId={editingId} onBack={() => { editingId = undefined; load(); }} />
{:else}
  <div class="templates-page">
    <header class="page-header">
      <h1>{t("templatesTitle")}</h1>
      <div class="filters">
        <select bind:value={kindFilter} onchange={load}>
          <option value="">全部类别</option>
          <option value="video">视频模板</option>
          <option value="image-text">图文模板</option>
          <option value="code">代码渲染模板</option>
        </select>
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
      <div class="gen-panel">
        <div class="gen-row">
          <label class="el-label">内容形式
            <select bind:value={genContentForm}>
              <option value="knowledge">知识卡片</option>
              <option value="hot_comment">热点评论</option>
              <option value="industry">行业动态</option>
              <option value="insight">深度洞察</option>
              <option value="data_show">数据展示</option>
              <option value="listicle">清单盘点</option>
            </select>
          </label>
          <label class="el-label">版式结构
            <select bind:value={elLayout}>
              {#each LAYOUT_OPTIONS as o}<option value={o.key}>{o.label}</option>{/each}
            </select>
          </label>
          <label class="el-label">配色方案
            <select bind:value={elPalette}>
              {#each PALETTE_OPTIONS as o}<option value={o.key}>{o.label}</option>{/each}
            </select>
          </label>
          <label class="el-label">动效节奏
            <select bind:value={elMotion}>
              {#each MOTION_OPTIONS as o}<option value={o.key}>{o.label}</option>{/each}
            </select>
          </label>
          <label class="el-label">数量
            <select bind:value={genCount}>
              <option value={3}>3个</option>
              <option value={5}>5个</option>
              <option value={8}>8个</option>
              <option value={10}>10个</option>
            </select>
          </label>
        </div>
        <div class="gen-row deco-row">
          <span class="el-label-text">装饰元素</span>
          {#each DECORATION_OPTIONS as d}
            <button
              class="deco-chip"
              class:active={elDecorations.includes(d.key)}
              onclick={() => toggleDecoration(d.key)}
            >{d.label}</button>
          {/each}
        </div>
        <div class="gen-row">
          <input type="text" bind:value={genReference} placeholder="还有别的想法？用自然语言补充（可留空），如「要像 Apple 发布会那种极简感」" class="gen-input" />
          <button class="btn-primary gen-btn" disabled={generating} onclick={generateTemplates}>{generating ? "生成中..." : "AI 生成模板"}</button>
          <button class="btn-research" disabled={generating} onclick={generateImageTextTemplates} title="AI 生成图文版式方案（封面 + 内容页布局/字体/配色），用于图文内容">
            {generating ? "生成中..." : "生成图文模板"}
          </button>
          <button class="btn-research" disabled={researching} onclick={researchTemplates} title="按当前要素选择调研全网优秀模板，沉淀为设计技能，之后生成自动吸收">
            {researching ? "调研中..." : `🔍 调研学习${skillCount > 0 ? `（已存 ${skillCount} 技能）` : ""}`}
          </button>
        </div>
        <!-- 代码渲染模板生成(2026-08-24 Revideo 支路):圆角/辉光/弹簧动效代码直出,突破 ffmpeg 图层天花板 -->
        <div class="gen-row">
          <input type="text" bind:value={codeGenStyle} placeholder="代码渲染模板:描述风格,如「赛博朋克霓虹、深色底、青色辉光、圆角面板」" class="gen-input" />
          <select bind:value={codeGenOrientation} class="codegen-orient" title="画幅">
            <option value="portrait">竖屏 1080×1920</option>
            <option value="landscape">横屏 1920×1080</option>
          </select>
          <label class="codegen-dh" title="模板包含数字人视频窗口(渲染时可传数字人源片,缺省占位)">
            <input type="checkbox" bind:checked={codeGenWithDh} /> 数字人窗口
          </label>
          <button class="btn-primary gen-btn" disabled={generating} onclick={generateCodeTemplates} title="LLM 生成 Revideo TSX 场景代码,真实渲染验证后入库(约 2-4 分钟)">
            {generating ? "生成中..." : "⚡ 生成代码模板"}
          </button>
        </div>
        <!-- 克隆优秀作品模板(2026-08-13 二期) -->
        <div class="gen-row clone-row">
          <input type="text" bind:value={cloneUrl} placeholder="粘贴优秀作品链接克隆模板:小红书图文笔记 / 抖音视频" class="gen-input" />
          <input type="text" bind:value={cloneHint} placeholder="补充说明(可留空):我特别喜欢它的…" class="gen-input clone-hint" />
          <button class="btn-primary gen-btn" disabled={cloning} onclick={cloneFromUrl} title="下载/截图优秀作品 → AI 视觉分析 → 克隆其版式/配色/节奏为新模板">
            {cloning ? "克隆中…" : "🔗 克隆优秀作品"}
          </button>
          <button class="btn-research" disabled={cloning} onclick={pickCloneFile} title="视频号等无视频流平台:先用 res-downloader 嗅探或录屏拿到 mp4,再从这里上传克隆">
            📤 上传视频克隆
          </button>
          <input type="file" bind:this={cloneFileInput} accept="video/*,.mp4,.mov,.webm,.mkv" style="display:none" onchange={cloneFromUpload} />
        </div>
        {#if cloneMessage}
          <p class="gen-message">{cloneMessage}</p>
        {/if}
      </div>
      {#if genMessage}
        <p class="gen-message">{genMessage}</p>
      {/if}
      {#if researchMessage}
        <p class="gen-message research">{researchMessage}</p>
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
              {#if tpl.kind === "image-text"}
                <span class="kind-badge">图文</span>
              {:else if tpl.kind === "code"}
                <span class="kind-badge">代码渲染</span>
              {/if}
              <span class="form">{tpl.contentForm ?? t("formGeneric")}</span>
            </div>
            <h3>{tpl.name}</h3>
            <p class="dims">{tpl.canvas.width} x {tpl.canvas.height} @ {tpl.canvas.fps}fps{#if tpl.usageCount} · 已用 {tpl.usageCount} 次{/if}</p>
            <div class="actions">
              <button class="btn-sm" disabled={renderingId === tpl.id} onclick={() => preview(tpl)}>
                {renderingId === tpl.id ? t("rendering") : t("preview")}
              </button>
              <button class="btn-sm secondary" onclick={() => editingId = tpl.id}>{t("edit")}</button>
              <button class="btn-sm secondary" title="用自然语言指令让 AI 再加工此模板" onclick={() => editingId = tpl.id}>再加工</button>
              {#if tpl.status === "draft" || tpl.status === "candidate"}
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
  .poster-img { width: 100%; height: 100%; object-fit: contain; }
  .preview-placeholder { color: var(--text-muted); font-size: var(--size-sm); }
  .meta { display: flex; gap: 0.5rem; align-items: center; }
  .status-badge { font-size: var(--size-xs); padding: 0.15rem 0.4rem; border-radius: 3px; background: var(--bg-inset); color: var(--text-muted); text-transform: capitalize; }
  .kind-badge { font-size: var(--size-xs); padding: 0.15rem 0.4rem; border-radius: 3px; background: var(--accent); color: var(--accent-text); }
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
  .gen-panel { margin-top: 0.75rem; padding: 0.75rem; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 6px; }
  .gen-panel .gen-row:first-child { margin-top: 0; }
  .el-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.72rem; color: var(--text-dim); }
  .el-label select { min-width: 110px; }
  .el-label-text { font-size: 0.72rem; color: var(--text-dim); align-self: center; }
  .deco-row { margin-top: 0.5rem; }
  .deco-chip { padding: 0.3rem 0.7rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; color: var(--text-secondary); font-size: 0.78rem; cursor: pointer; }
  .deco-chip.active { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .btn-research { padding: 0.5rem 0.9rem; border-radius: 4px; border: 1px solid var(--accent); background: transparent; color: var(--accent); font-weight: 600; cursor: pointer; }
  .btn-research:disabled { opacity: 0.5; cursor: not-allowed; }
  .gen-message.research { border-left: 3px solid var(--accent); }
  .gen-input { flex: 1; min-width: 200px; }
  .clone-row { margin-top: 0.25rem; }
  .clone-hint { flex: 0.6; min-width: 160px; }
  .gen-btn { background: var(--accent-gradient); }
  .gen-message { font-size: 0.82rem; color: var(--text-secondary); margin: 0.5rem 0 0; padding: 0.5rem 0.75rem; background: var(--accent-soft, rgba(0,0,0,0.05)); border-radius: 4px; }
  /* ── 分幕灯箱 ── */
  .lightbox-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 1000; display: grid; place-items: center; }
  .lightbox-body { background: var(--card-bg); border-radius: 8px; padding: 0.75rem 1rem 1rem; max-width: 92vw; max-height: 92vh; display: flex; flex-direction: column; gap: 0.5rem; }
  .lightbox-header { display: flex; align-items: center; gap: 1rem; }
  .lightbox-title { font-weight: 600; font-size: var(--size-sm); }
  .lightbox-counter { color: var(--text-muted); font-size: var(--size-xs); }
  .lightbox-close { margin-left: auto; border: none; background: transparent; font-size: 1.1rem; cursor: pointer; color: var(--text); }
  .lightbox-stage { display: flex; align-items: center; gap: 0.5rem; min-height: 0; }
  .lightbox-img { max-width: 82vw; max-height: 80vh; object-fit: contain; border-radius: 4px; background: #111; }
  .lightbox-nav { border: none; border-radius: 50%; width: 2.4rem; height: 2.4rem; font-size: 1.4rem; line-height: 1; cursor: pointer; background: var(--bg-inset); color: var(--text); flex-shrink: 0; }
  .lightbox-nav:hover { background: var(--accent); color: var(--accent-text); }
</style>
