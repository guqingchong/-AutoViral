<script lang="ts">
  import { onMount } from "svelte";
  import { deleteTemplateApi, renderPreview, updateTemplateApi, createBrief, chatBrief, generateFromBrief, fetchCodeSceneTemplates, previewSceneTemplate, type Template, type DesignBrief, type CodeSceneTemplate } from "../lib/api.js";
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
  /** 生成目标(2026-09-02):full=整片代码模板(Revideo) | scene=镜头模板(web 支路 HTML) */
  let codeGenTarget = $state<"full" | "scene">("full");
  /** 整片渲染支路(2026-09-02):web(默认,HTML/WAAPI/WebGL) | revideo(兼容) */
  let codeGenRenderer = $state<"web" | "revideo">("web");
  // ── 分页助手(2026-09-02 分页模板):封面/正文/结尾逐页引导式描述 ──
  let multiPage = $state(false);
  let pageCover = $state("");
  let pageContent = $state("");
  let pageEnding = $state("");
  const PAGE_GUIDES = [
    { key: "cover", label: "封面页", hint: "目标:3秒抓住眼球", examples: ["深蓝底,大标题居中弹入,顶部英文 kicker", "全屏冲击数字+辉光,2 秒内落定"] },
    { key: "content", label: "正文页", hint: "目标:承载核心论证", examples: ["标题居左上,主视觉区留 60% 给素材窗口", "字幕区沉稳不抢戏,呼吸微动"] },
    { key: "ending", label: "结尾页", hint: "目标:收束+引导互动", examples: ["金句放大居中,底部关注引导一行", "整体放慢收束,末帧定格完整信息"] },
  ] as const;
  // ── 意图稿两步向导(2026-08-25) ──
  let briefId = $state("");
  let brief = $state<DesignBrief | null>(null);
  let briefChatInput = $state("");
  let briefLoading = $state(false);
  let briefDiff = $state("");
  let briefImageData = $state<{ data: string; mediaType: string; name: string } | null>(null);

  // ── 镜头模板（kind=web 程序化动画场景，2026-09-01 批次12c-A）──
  // 数据来自 GET /api/assets/code-scene/templates（agent 发现入口同款清单），只读展示
  let sceneTemplates = $state<CodeSceneTemplate[]>([]);
  let sceneThemes = $state<string[]>([]);
  let sceneNote = $state("");
  let sceneLoading = $state(true);

  /** 模板名 → 图标 + 主题（静态视觉用主题色板，不嵌样片视频） */
  const SCENE_META: Record<string, { icon: string; theme: string }> = {
    "structure-growth": { icon: "🌐", theme: "finance_dark" },
    "flow-steps": { icon: "🪜", theme: "ink_green" },
    "logic-chain": { icon: "🔗", theme: "warm_gold" },
    "big-number": { icon: "🔢", theme: "finance_dark" },
    "compare-split": { icon: "⚖️", theme: "magazine_light" },
    timeline: { icon: "🕒", theme: "minimal_light" },
    pyramid: { icon: "🔺", theme: "ink_green" },
    "quote-card": { icon: "💬", theme: "magazine_light" },
    checklist: { icon: "✅", theme: "minimal_light" },
    "bar-compare": { icon: "📊", theme: "warm_gold" },
    "cover-title-wide": { icon: "🎬", theme: "finance_dark" },
    "keynote-leather": { icon: "🎤", theme: "warm_gold" },
  };
  const SCENE_THEME_COLORS: Record<string, { bg: string; fg: string; accent: string }> = {
    finance_dark: { bg: "#0e1a2b", fg: "#e8eef6", accent: "#4d9fff" },
    warm_gold: { bg: "#191307", fg: "#f3e8cf", accent: "#d4a62a" },
    ink_green: { bg: "#0d1f18", fg: "#e2f0e8", accent: "#3ecf8e" },
    minimal_light: { bg: "#f4f1ea", fg: "#2b2b28", accent: "#b0792e" },
    magazine_light: { bg: "#faf7f2", fg: "#1a1a1a", accent: "#c23b22" },
  };
  function sceneMeta(tpl: CodeSceneTemplate) {
    const base = tpl.name.replace(/-wide$/, "");
    return SCENE_META[tpl.name] ?? SCENE_META[base] ?? { icon: "🎞️", theme: "finance_dark" };
  }
  function sceneColors(tpl: CodeSceneTemplate) {
    return SCENE_THEME_COLORS[sceneMeta(tpl).theme] ?? SCENE_THEME_COLORS.finance_dark;
  }
  function isWideScene(tpl: CodeSceneTemplate) {
    return tpl.name.endsWith("-wide") || tpl.name === "keynote-leather";
  }
  async function loadSceneTemplates() {
    sceneLoading = true;
    try {
      const data = await fetchCodeSceneTemplates();
      sceneTemplates = data.templates ?? [];
      sceneThemes = data.themes ?? [];
      sceneNote = data.note ?? "";
    } catch {
      sceneTemplates = [];
    }
    sceneLoading = false;
  }

  // ── 镜头模板样片预览(2026-09-02):内建 sample 参数渲染 4s 样片,弹窗播放 ──
  let scenePreviewing = $state<string | null>(null);
  let sceneVideoUrl = $state("");
  let sceneVideoName = $state("");
  async function openScenePreview(st: CodeSceneTemplate, refresh = false) {
    scenePreviewing = st.name;
    try {
      const r = await previewSceneTemplate(st.name, refresh);
      if (r.success && r.url) {
        sceneVideoUrl = `${r.url}?t=${Date.now()}`;
        sceneVideoName = st.label;
      } else {
        alert(r.error ?? "样片渲染失败");
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "样片渲染失败");
    } finally {
      scenePreviewing = null;
    }
  }
  function closeSceneVideo() { sceneVideoUrl = ""; }

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
  /** 分页结构(2026-09-02):勾选后 AI 生成模板按 封面/正文/结尾 三幕组织 */
  let elMultiPage = $state(false);
  function withMultiPageMarker(ref: string): string {
    if (!elMultiPage) return ref;
    const marker = "分页结构(硬性):封面幕(冲击)/正文幕(信息)/结尾幕(收束引导)三幕组织";
    return ref.trim() ? `${ref.trim()}\n${marker}` : marker;
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
        body: JSON.stringify({ count: genCount, contentForm: genContentForm, reference: withMultiPageMarker(genReference), elements: { ...currentElements(), freeText: withMultiPageMarker(genReference) || undefined } }),
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

  /** 第一步:描述(+参考图) → 生成设计意图稿(不渲染,秒级~1分钟) */
  async function startBrief() {
    if (!codeGenStyle.trim()) {
      alert("请先描述风格,如「赛博朋克霓虹、深色底、青色辉光」");
      return;
    }
    // 分页模式:把三页描述拼进风格文本,LLM 产出 brief.pages(逐页设计稿)
    let style = codeGenStyle.trim();
    if (multiPage && codeGenTarget === "full") {
      const sections: string[] = [];
      if (pageCover.trim()) sections.push(`封面页:${pageCover.trim()}`);
      if (pageContent.trim()) sections.push(`正文页:${pageContent.trim()}`);
      if (pageEnding.trim()) sections.push(`结尾页:${pageEnding.trim()}`);
      style += "\n分页结构要求(整片分 封面/正文/结尾 三页,逐页落实):\n" + (sections.length ? sections.join("\n") : "三页按页角色默认目标设计:封面抓眼球/正文承载论证/结尾收束引导");
    }
    briefLoading = true;
    briefDiff = "";
    try {
      const res = await createBrief({
        style,
        orientation: codeGenOrientation,
        withDigitalHuman: codeGenWithDh,
        multiPage: multiPage && codeGenTarget === "full",
        ...(briefImageData ? { referenceImage: { data: briefImageData.data, mediaType: briefImageData.mediaType } } : {}),
      });
      briefId = res.briefId;
      brief = res.brief;
    } catch (err) {
      alert(err instanceof Error ? err.message : "意图稿生成失败");
    } finally {
      briefLoading = false;
    }
  }

  /** 多轮微调:只改用户点名部分 */
  async function sendBriefChat() {
    if (!briefChatInput.trim() || !briefId) return;
    briefLoading = true;
    try {
      const res = await chatBrief(briefId, briefChatInput.trim());
      brief = res.brief;
      briefDiff = res.diffSummary;
      briefChatInput = "";
    } catch (err) {
      alert(err instanceof Error ? err.message : "微调失败");
    } finally {
      briefLoading = false;
    }
  }

  /** 第二步:确认按稿生成(走现有 2-4 分钟 job 轮询) */
  async function confirmBriefAndGenerate() {
    if (!briefId) return;
    generating = true;
    genMessage = codeGenTarget === "scene"
      ? "镜头模板生成中(LLM 按稿写 HTML 程序化动画 + 真实渲染验证,约 2-4 分钟)... 可以切换页面"
      : "按设计稿生成中(LLM 设计 + Revideo 渲染验证,约 2-4 分钟)... 可以切换页面";
    try {
      const res = await generateFromBrief(briefId, codeGenTarget, codeGenRenderer);
      if (!res.jobId) {
        alert("生成失败");
        generating = false;
        return;
      }
      genJobId = res.jobId;
      if (codeGenTarget !== "scene") kindFilter = "code";
      brief = null;
      briefId = "";
      briefImageData = null;
      briefChatInput = "";
      briefDiff = "";
      startPolling(res.jobId);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      generating = false;
    }
  }

  /** 参考图选择:读为 base64(≤5MB) */
  function pickBriefImage(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      alert("参考图超过 5MB 上限");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      briefImageData = {
        data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        mediaType: file.type,
        name: file.name,
      };
    };
    reader.readAsDataURL(file);
    // 清空 input value:同一文件可二次选择(change 事件才会再次触发)
    (e.target as HTMLInputElement).value = "";
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
    if (e.key === "Escape" && sceneVideoUrl) { closeSceneVideo(); return; }
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
    loadSceneTemplates();
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
          // 镜头模板生成渠道的产物在 scene 分组,一并刷新
          await loadSceneTemplates();
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
{#if sceneVideoUrl}
  <!-- 镜头模板样片弹窗(2026-09-02):真实渲染的 4s 样片 -->
  <div class="lightbox-backdrop" role="button" tabindex="0" onclick={closeSceneVideo} onkeydown={(e) => e.key === "Enter" && closeSceneVideo()}>
    <div class="lightbox-body" role="presentation" onclick={(e) => e.stopPropagation()}>
      <div class="lightbox-header">
        <span class="lightbox-title">{sceneVideoName} · 样片</span>
        <button class="lightbox-close" onclick={closeSceneVideo}>✕</button>
      </div>
      <video src={sceneVideoUrl} controls autoplay loop muted class="scene-video"></video>
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
          <label class="codegen-dh" title="模板按 封面幕/正文幕/结尾幕 三幕组织,预览可分幕逐页查看">
            <input type="checkbox" bind:checked={elMultiPage} /> 分页结构(三幕)
          </label>
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
        <!-- 代码渲染模板:两阶段意图稿向导(2026-08-25)——先确认设计稿再生成,精准落实意图
             2026-09-02:生成目标可选 整片代码模板(Revideo) / 镜头模板(web 支路 HTML) -->
        <div class="gen-row">
          <input type="text" bind:value={codeGenStyle} placeholder="代码渲染模板:描述风格,如「赛博朋克霓虹、深色底、青色辉光、圆角面板」" class="gen-input" />
          <select bind:value={codeGenTarget} class="codegen-orient" title="生成目标:整片模板绑定作品用;镜头模板供 agent 素材阶段逐镜头调用">
            <option value="full">整片代码模板</option>
            <option value="scene">镜头模板(web 动画)</option>
          </select>
          {#if codeGenTarget === "full"}
            <select bind:value={codeGenRenderer} class="codegen-orient" title="渲染支路:web(HTML/WAAPI/WebGL,材质上限高,推荐);Revideo 仅兼容存量">
              <option value="web">web 渲染(推荐)</option>
              <option value="revideo">Revideo(兼容)</option>
            </select>
          {/if}
          <select bind:value={codeGenOrientation} class="codegen-orient" title="画幅">
            <option value="portrait">竖屏 1080×1920</option>
            <option value="landscape">横屏 1920×1080</option>
          </select>
          <label class="codegen-dh" title="模板包含数字人视频窗口(渲染时可传数字人源片,缺省占位)">
            <input type="checkbox" bind:checked={codeGenWithDh} /> 数字人窗口
          </label>
          <label class="btn-research brief-upload" title="上传参考截图,AI 拆解其风格并入设计稿">
            {briefImageData ? `📎 ${briefImageData.name}` : "📎 参考图"}
            <input type="file" accept="image/png,image/jpeg,image/webp" style="display:none" onchange={pickBriefImage} />
          </label>
          {#if briefImageData}
            <button class="brief-image-clear" title="清除参考图" onclick={() => (briefImageData = null)}>✕</button>
          {/if}
          <button class="btn-primary gen-btn" disabled={briefLoading || generating} onclick={startBrief} title="先生成结构化设计意图稿,确认后再生成代码模板">
            {briefLoading && !brief ? "生成设计稿中..." : "📝 生成设计稿"}
          </button>
        </div>
        {#if codeGenTarget === "full"}
          <!-- 分页助手(2026-09-02):分页整片 = 封面/正文/结尾逐页描述,示例 chips 一键填入 -->
          <div class="gen-row multipage-row">
            <label class="codegen-dh" title="整片分 封面/正文/结尾 三页,设计稿逐页呈现、逐页微调">
              <input type="checkbox" bind:checked={multiPage} /> 分页模板(封面/正文/结尾)
            </label>
            {#if multiPage}
              <div class="page-guides">
                {#each PAGE_GUIDES as pg}
                  <div class="page-guide">
                    <div class="page-guide-head"><b>{pg.label}</b><span>{pg.hint}</span></div>
                    <input type="text" class="gen-input"
                      value={pg.key === "cover" ? pageCover : pg.key === "content" ? pageContent : pageEnding}
                      oninput={(e) => { const v = (e.target as HTMLInputElement).value; if (pg.key === "cover") pageCover = v; else if (pg.key === "content") pageContent = v; else pageEnding = v; }}
                      placeholder={`描述${pg.label}的设计要点(可留空按默认目标)`} />
                    <div class="page-examples">
                      {#each pg.examples as ex}
                        <button class="deco-chip" title="点击填入示例" onclick={() => { if (pg.key === "cover") pageCover = ex; else if (pg.key === "content") pageContent = ex; else pageEnding = ex; }}>{ex}</button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
        {#if brief}
          <div class="brief-card">
            <h4>设计意图稿 —— {brief.styleSummary}</h4>
            <div class="brief-section">
              <span class="brief-label">配色</span>
              {#each brief.palette as p}
                <span class="brief-swatch" style="background:{p.hex}" title="{p.hex}"></span>
                <span class="brief-swatch-role">{p.role}{p.note ? ` · ${p.note}` : ""}</span>
              {/each}
            </div>
            <div class="brief-section">
              <span class="brief-label">布局</span>
              <ul>{#each brief.layout as l}<li><b>{l.region}</b>:{l.content}({l.position})</li>{/each}</ul>
            </div>
            <div class="brief-section">
              <span class="brief-label">元素</span>
              {#each brief.elements as el}<span class="deco-chip active">{el}</span>{/each}
            </div>
            <div class="brief-section">
              <span class="brief-label">动效</span>
              <span>入场:{brief.motion.entrance};循环:{brief.motion.loop}</span>
            </div>
            {#if brief.pages?.length}
              <!-- 分页设计稿(2026-09-02):封面/正文/结尾逐页展示,微调对话可针对单页(如「封面标题再大点」) -->
              <div class="brief-pages">
                {#each brief.pages as pg}
                  <div class="brief-page">
                    <div class="brief-page-head">
                      <b>{{ cover: "封面页", content: "正文页", ending: "结尾页" }[pg.role]}</b>
                      <span>{pg.goal}</span>
                    </div>
                    <ul>{#each pg.layout as l}<li><b>{l.region}</b>:{l.content}({l.position})</li>{/each}</ul>
                    {#if pg.motionOverride}<div class="brief-page-motion">动效特例:{pg.motionOverride}</div>{/if}
                    {#if pg.elementsExtra?.length}<div class="brief-page-motion">本页装饰:{pg.elementsExtra.join(" / ")}</div>{/if}
                  </div>
                {/each}
              </div>
            {/if}
            {#if briefDiff}<div class="brief-diff">已调整:{briefDiff}</div>{/if}
            <div class="brief-actions">
              <input type="text" bind:value={briefChatInput} placeholder="想调整什么?如「标题再大点」「去掉网格」「换成青色」"
                class="gen-input" onkeydown={(e) => e.key === "Enter" && sendBriefChat()} />
              <button class="btn-research" disabled={briefLoading} onclick={sendBriefChat}>{briefLoading ? "调整中..." : "微调"}</button>
              <button class="btn-primary gen-btn" disabled={briefLoading || generating} onclick={confirmBriefAndGenerate} title="按此设计稿生成代码模板(约 2-4 分钟)">
                {generating ? "生成中..." : "⚡ 按此稿生成"}
              </button>
            </div>
          </div>
        {/if}
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
      <!-- 分组锚点标签(2026-09-02):两类模板一眼分区、快速跳转 -->
      <nav class="group-tabs">
        <a href="#scene-section" class="group-tab scene">🎞️ 镜头模板 <b>{sceneTemplates.length}</b><span>单镜头程序化动画 · 素材阶段逐镜头调用</span></a>
        <a href="#full-section" class="group-tab full">🎬 整片模板 <b>{templates.length}</b><span>绑定作品 · 约束整片视觉呈现</span></a>
      </nav>
    </header>

    <!-- 镜头模板分组(2026-09-01 批次12c-A):kind=web 程序化动画模板,agent 渲染镜头时经 API 选用
         2026-09-02:卡片视觉与整片模板差异化(深色代码风),支持真实样片预览 -->
    <section class="scene-section" id="scene-section">
      <div class="scene-head">
        <h2>🎞️ 镜头模板<span class="scene-count">{sceneTemplates.length} 款（竖屏 + 横屏 -wide）</span></h2>
        {#if sceneThemes.length}
          <span class="scene-themes">主题：{sceneThemes.join(" / ")}</span>
        {/if}
      </div>
      {#if sceneNote}<p class="scene-note">{sceneNote}</p>{/if}
      {#if sceneLoading}
        <p class="empty">{t("loading")}</p>
      {:else if sceneTemplates.length === 0}
        <p class="empty">暂无镜头模板</p>
      {:else}
        <div class="template-grid scene-grid">
          {#each sceneTemplates as st}
            {@const colors = sceneColors(st)}
            <article class="template-card scene-card" style="border-top: 3px solid {colors.accent}">
              <div
                class="preview scene-swatch"
                class:scene-wide={isWideScene(st)}
                style="background:{colors.bg};color:{colors.fg}"
              >
                <span class="scene-icon">{sceneMeta(st).icon}</span>
                <span class="scene-swatch-label" style="color:{colors.accent}">{st.label}</span>
                <span class="scene-name">{st.name}</span>
              </div>
              <div class="meta">
                <span class="kind-badge">镜头</span>
                {#if isWideScene(st)}<span class="wide-badge">横屏 16:9</span>{/if}
              </div>
              <h3>{st.label}</h3>
              <p class="dims">{st.bestFor}</p>
              <p class="scene-params" title={st.params}>{st.params}</p>
              <div class="actions">
                <button class="btn-sm scene-preview-btn" disabled={scenePreviewing === st.name} onclick={() => openScenePreview(st)}>
                  {scenePreviewing === st.name ? "渲染中…(约20-40s)" : "▶ 预览样片"}
                </button>
                <button class="btn-sm secondary scene-refresh-btn" title="强制重新渲染样片(模板更新后缓存不会自动失效)" disabled={scenePreviewing === st.name} onclick={() => openScenePreview(st, true)}>↻</button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>

    <!-- 整片模板分组:数据库模板(视频/图文/代码渲染),绑定作品约束整片视觉 -->
    <section id="full-section">
      <div class="scene-head">
        <h2>🎬 整片模板<span class="scene-count">{templates.length} 款</span></h2>
      </div>
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
              {:else if (tpl.usageCount ?? 0) === 0}
                <span class="kind-badge" data-deprecated>整片·已停用</span>
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
    </section>
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
  .kind-badge[data-deprecated] { background: var(--bg-inset); color: var(--text-muted); border: 1px solid var(--border); }
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
  .brief-card { border: 1px solid var(--card-border); border-radius: var(--card-radius); background: var(--card-bg); padding: 1rem; margin-top: 0.5rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .brief-card h4 { margin: 0; font-size: var(--size-sm); }
  .brief-section { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; font-size: var(--size-xs); color: var(--text-muted); }
  .brief-section ul { margin: 0; padding-left: 1.2rem; }
  .brief-label { font-weight: 600; color: var(--text); min-width: 2.5rem; }
  .brief-swatch { width: 18px; height: 18px; border-radius: 4px; border: 1px solid var(--card-border); }
  .brief-swatch-role { margin-right: 0.6rem; }
  .brief-diff { font-size: var(--size-xs); color: var(--accent); }
  .brief-actions { display: flex; gap: 0.5rem; }
  .brief-upload { cursor: pointer; }
  /* ── 分页助手与分页设计稿(2026-09-02) ── */
  .multipage-row { align-items: flex-start; }
  .page-guides { display: flex; flex-direction: column; gap: 0.6rem; flex: 1; min-width: 280px; }
  .page-guide { display: flex; flex-direction: column; gap: 0.3rem; padding: 0.55rem 0.7rem; border: 1px dashed var(--border); border-radius: 6px; }
  .page-guide-head { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.8rem; }
  .page-guide-head span { color: var(--text-dim); font-size: 0.72rem; }
  .page-examples { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .page-examples .deco-chip { font-size: 0.7rem; padding: 0.2rem 0.55rem; }
  .brief-pages { display: flex; flex-direction: column; gap: 0.5rem; }
  .brief-page { border: 1px solid var(--card-border); border-radius: 6px; padding: 0.5rem 0.7rem; background: var(--bg-inset); }
  .brief-page-head { display: flex; align-items: baseline; gap: 0.6rem; font-size: 0.8rem; }
  .brief-page-head span { color: var(--text-muted); font-size: 0.72rem; }
  .brief-page ul { margin: 0.3rem 0 0; padding-left: 1.2rem; font-size: var(--size-xs); color: var(--text-muted); }
  .brief-page-motion { font-size: var(--size-xs); color: var(--text-dim); margin-top: 0.25rem; }
  /* ── 镜头模板分组(2026-09-02 视觉差异化:深色代码风,与整片模板一眼区分) ── */
  .scene-section { margin-bottom: 2rem; scroll-margin-top: 1rem; }
  #full-section { scroll-margin-top: 1rem; }
  .group-tabs { display: flex; gap: 0.75rem; margin-top: 1rem; flex-wrap: wrap; }
  .group-tab { display: flex; align-items: baseline; gap: 0.5rem; padding: 0.55rem 0.9rem; border-radius: 8px; border: 1px solid var(--border); text-decoration: none; color: var(--text); font-size: 0.85rem; background: var(--card-bg); }
  .group-tab b { color: var(--accent); }
  .group-tab span { font-size: 0.72rem; color: var(--text-dim); }
  .group-tab.scene { border-left: 3px solid #4d9fff; }
  .group-tab.full { border-left: 3px solid var(--accent); }
  .group-tab:hover { border-color: var(--accent); }
  .scene-grid .scene-card { background: linear-gradient(160deg, #12161f 0%, #171d29 100%); border-color: #2a3342; color: #dbe3ee; }
  .scene-grid .scene-card h3 { color: #eef3fa; }
  .scene-grid .scene-card .dims, .scene-grid .scene-card .scene-params { color: #8b97a8; }
  .scene-name { font-family: ui-monospace, Consolas, monospace; font-size: 0.68rem; opacity: 0.55; letter-spacing: 0.5px; }
  .scene-preview-btn { background: #2b3648; color: #cfe0f5; border: 1px solid #3d4c63; }
  .scene-preview-btn:hover:not(:disabled) { background: #364459; }
  .scene-refresh-btn { flex: 0 0 2.2rem; background: #1d2532; color: #8b97a8; border-color: #3d4c63; }
  .scene-video { max-width: 82vw; max-height: 80vh; border-radius: 4px; background: #000; }
  .scene-head { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 0.25rem; }
  .scene-head h2 { font-family: var(--font-display); font-size: var(--size-lg); margin: 0; }
  .scene-count { font-size: var(--size-xs); color: var(--text-muted); margin-left: 0.5rem; }
  .scene-themes { font-size: var(--size-xs); color: var(--text-dim); }
  .scene-note { font-size: var(--size-xs); color: var(--text-muted); margin: 0.25rem 0 0.75rem; line-height: 1.5; }
  .scene-swatch { display: flex; flex-direction: column; gap: 0.45rem; align-items: center; justify-content: center; }
  .scene-swatch.scene-wide { aspect-ratio: 16 / 9; }
  .scene-icon { font-size: 2rem; line-height: 1; }
  .scene-swatch-label { font-size: var(--size-sm); font-weight: 600; text-align: center; padding: 0 0.6rem; }
  .wide-badge { font-size: var(--size-xs); padding: 0.15rem 0.4rem; border-radius: 3px; background: var(--accent); color: var(--accent-text); }
  .scene-params { font-size: var(--size-xs); color: var(--text-dim); margin: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .brief-image-clear {
    padding: 2px 6px;
    font-size: 12px;
    line-height: 1;
    border: 1px solid var(--border, #444);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
</style>
