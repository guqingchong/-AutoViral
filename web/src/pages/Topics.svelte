<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTopics, convertTopicToWork, collectTrends, fetchConfig, updateConfig, fetchVoices, type Topic, type VoiceItem } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";
  import { activeTab } from "../lib/navigation.js";

  let topics = $state<Topic[]>([]);
  let loading = $state(true);
  let platform = $state<string>("");
  let lang = $state(getLanguage());
  let interests = $state("");
  let researchStatus: "idle" | "collecting" | "streaming" | "done" | "error" = $state("idle");
  let researchMessage = $state("");
  let lastCollectedCount = $state(0);
  /** 每平台调研进度（后端实时推送） */
  interface PlatformProgress { platform: string; status: "pending" | "running" | "done" | "error"; count?: number; error?: string }
  let researchPlatforms = $state<PlatformProgress[]>([]);
  /** 每次调研最终入库的选题数量（TopN） */
  let topicCount = $state(10);
  const TOPIC_COUNT_OPTIONS = [1, 3, 5, 8, 10, 15, 20];
  let deleteConfirmId = $state<number | null>(null);
  // Batch automation state
  let selectedTopicIds = $state<Set<number>>(new Set());
  let showBatchModal = $state(false);
  let batchTemplateId = $state<string>("");
  let batchDigitalHumanId = $state<string>("");
  let batchType = $state<"short-video" | "video+image-text" | "image-text">("short-video");
  // 视频制作控制条件（全自动模式）：时长/风格/素材样式/配音风格
  let batchDuration = $state<number>(60);
  let batchContentForm = $state<string>("knowledge");
  let batchAssetForm = $state<string>("video-mix");
  // 默认 smart 精品混合:按镜头内容自动路由(数据→程序化素材、氛围→AI、真实画面→素材库)
  let batchAssetSource = $state<string>("smart");
  let batchAssetBudget = $state<string>("eco");
  let batchVoiceStyle = $state<string>("male-qn-qingse");
  let myVoices = $state<VoiceItem[]>([]);
  let favVoices = $state<VoiceItem[]>([]);
  let batchVoiceMode = $state<"cloned" | "ai">("ai");
  // 质量评审闸门：默认开（每阶段完成后由独立评审会话把关,不合格打回重做）
  let batchEvaluation = $state<boolean>(true);
  // 评审分级(批次10.2):standard=每阶段 LLM 评审;express=机器门禁照跑+仅成片单轮终审
  let batchEvalMode = $state<"standard" | "express">("standard");
  // 画幅(批次12c-A):竖屏 9:16 缺省 / 横屏 16:9(镜头模板选 -wide 款)
  let batchAspect = $state<"portrait" | "landscape">("portrait");
  // ── 用途驱动(04 方案):预设从 /api/purposes 拉取,一处定义前后端共用 ──
  interface PurposeOption { key: string; label: string; icon: string; goal: string; strategy: string; forms: string[]; defaults: { duration: number; assetForm: string; assetSource: string; assetBudget: string }; skillCount: number; }
  let purposeOptions = $state<PurposeOption[]>([]);
  let contentFormMap = $state<Record<string, { label: string; desc: string }>>({});
  let batchPurpose = $state<string>("");
  let skillResearching = $state(false);
  let showAdvanced = $state(false);

  async function loadPurposes() {
    try {
      const res = await fetch("/api/purposes");
      if (res.ok) {
        const data = await res.json();
        purposeOptions = data.purposes ?? [];
        contentFormMap = data.contentForms ?? {};
      }
    } catch { /* 静默:用途拉取失败时退化为旧平铺 */ }
  }

  /** 选用途 → 联动默认参数(用户仍可在高级区改) */
  function selectPurpose(key: string) {
    batchPurpose = batchPurpose === key ? "" : key;
    const p = purposeOptions.find((x) => x.key === batchPurpose);
    if (!p) return;
    batchDuration = p.defaults.duration;
    batchAssetForm = p.defaults.assetForm;
    batchAssetSource = p.defaults.assetSource;
    batchAssetBudget = p.defaults.assetBudget;
    if (p.forms.length) batchContentForm = p.forms[0];
  }

  /** 用途过滤后的内容形式选项(未选用途时展示全部) */
  function visibleContentForms(): { value: string; label: string; desc: string }[] {
    const entries = Object.entries(contentFormMap);
    const filtered = batchPurpose
      ? entries.filter(([k]) => purposeOptions.find((x) => x.key === batchPurpose)?.forms.includes(k))
      : entries;
    return filtered.map(([value, v]) => ({ value, label: v.label, desc: v.desc }));
  }

  async function updateSkillPack() {
    if (!batchPurpose || skillResearching) return;
    skillResearching = true;
    try {
      await fetch(`/api/purposes/${batchPurpose}/research`, { method: "POST" });
      // 后台调研(2-5 分钟),轮询条数变化
      const before = purposeOptions.find((x) => x.key === batchPurpose)?.skillCount ?? 0;
      const started = Date.now();
      const timer = setInterval(async () => {
        await loadPurposes();
        const now = purposeOptions.find((x) => x.key === batchPurpose)?.skillCount ?? 0;
        if (now !== before || Date.now() - started > 6 * 60_000) {
          clearInterval(timer);
          skillResearching = false;
        }
      }, 15_000);
    } catch { skillResearching = false; }
  }

  // 模式/列表变化时同步选中的音色，避免提交了另一模式下的 voice_id
  $effect(() => {
    if (batchVoiceMode === "cloned") {
      batchVoiceStyle = myVoices[0]?.voice_id ?? "";
    } else {
      batchVoiceStyle = favVoices.some((v) => v.voice_id === batchVoiceStyle)
        ? batchVoiceStyle
        : (favVoices[0]?.voice_id ?? "");
    }
  });

  // 内容类型变化时过滤模板（模板无 kind 字段视为 video），按质量评分降序，并清掉不适用的选择
  let filteredTemplates = $derived(
    templates
      .filter((tpl) =>
        batchType === "image-text" ? tpl.kind === "image-text" : (tpl.kind ?? "video") !== "image-text"
      )
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  );
  $effect(() => {
    // 已选模板在新类型下不适用时,重选该类型下评分最高者(用户手动选"不使用模板"则保持空)
    if (batchTemplateId && !filteredTemplates.some((tpl) => tpl.id === batchTemplateId)) {
      batchTemplateId = filteredTemplates[0]?.id ?? "";
    }
    if (batchType === "image-text") batchDigitalHumanId = "";
  });

  const DURATION_OPTIONS = [
    { value: 60, label: "约 1 分钟" },
    { value: 180, label: "约 3 分钟" },
    { value: 300, label: "约 5 分钟" },
    { value: 420, label: "约 7 分钟" },
    { value: 600, label: "约 10 分钟" },
    { value: 900, label: "约 15 分钟" },
  ];
  const ASSET_FORM_OPTIONS = [
    { value: "video-mix", label: "视频混剪" },
    { value: "image-carousel", label: "图片轮播" },
    { value: "slides", label: "讲解幻灯片" },
    { value: "auto", label: "LLM 自选" },
  ];
  const ASSET_SOURCE_OPTIONS = [
    { value: "smart", label: "精品混合（推荐）：数据→程序化图表、氛围→AI、实拍→素材库" },
    { value: "stock", label: "仅素材库" },
    { value: "ai", label: "仅 AI 生成" },
    { value: "user", label: "仅用户指定素材" },
    { value: "auto", label: "LLM 自选" },
  ];
  const ASSET_BUDGET_OPTIONS = [
    { value: "eco", label: "经济型（禁 AI 视频）" },
    { value: "premium", label: "不计成本" },
  ];
  let templates = $state<any[]>([]);
  let avatars = $state<any[]>([]);
  let batchConverting = $state(false);
  let batchResult = $state<string>("");
  let batchJob = $state<any | null>(null);
  let batchJobId = $state<string | null>(null);
  let batchPollTimer: ReturnType<typeof setInterval> | null = null;

  // 手动添加选题
  let showManualAdd = $state(false);
  let manualSaving = $state(false);
  let manualForm = $state({ title: "", platform: "", description: "", tags: "", contentAngles: "", exampleHook: "" });

  function openManualAdd() {
    manualForm = { title: "", platform: platform || "", description: "", tags: "", contentAngles: "", exampleHook: "" };
    showManualAdd = true;
  }

  async function saveManualTopic() {
    if (!manualForm.title.trim()) return;
    manualSaving = true;
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: manualForm.title.trim(),
          platform: manualForm.platform || undefined,
          description: manualForm.description.trim(),
          tags: manualForm.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean),
          content_angles: manualForm.contentAngles.split(/[,，\n]/).map(s => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showManualAdd = false;
      await load();
    } catch {
      alert("保存失败，请重试");
    } finally {
      manualSaving = false;
    }
  }

  function tt(key: string): string { void lang; return t(key); }

  const platforms = [
    { value: "", label: tt("allPlatforms") || "All" },
    { value: "douyin", label: tt("douyinTab") },
    { value: "xiaohongshu", label: tt("xiaohongshuTab") },
    { value: "kuaishou", label: tt("kuaishouTab") || "快手" },
    { value: "bilibili", label: tt("bilibiliTab") || "B站" },
    { value: "zhihu", label: tt("zhihuTab") || "知乎" },
    { value: "channels", label: "视频号" },
    { value: "wechat_mp", label: "公众号" },
  ];

  // Pre-load config to show saved interests
  onMount(async () => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    try {
      const config = await fetchConfig();
      if (config.interests) {
        interests = Array.isArray(config.interests) ? config.interests.join(", ") : String(config.interests);
      }
      if (Number(config.researchTopN) > 0) topicCount = Number(config.researchTopN);
    } catch {}
    await load();
    // 恢复未完成的调研任务（切换页面/刷新浏览器后重新挂接进度）
    try {
      const res = await fetch("/api/trends/collect/active");
      const data = await res.json();
      if (data.job && data.job.status === "running") {
        researchStatus = "collecting";
        researchPlatforms = data.job.platformsProgress ?? [];
        researchMessage = "调研仍在进行中（已恢复进度跟踪）…";
        startPolling(data.job.jobId);
      }
    } catch {}
    return unsub;
  });

  async function load() {
    loading = true;
    try {
      topics = await fetchTopics(platform || undefined);
    } catch {
      topics = [];
    } finally {
      loading = false;
    }
  }

  async function saveInterests() {
    try {
      const arr = interests.split(",").map(s => s.trim()).filter(Boolean);
      await updateConfig({ interests: arr } as any);
    } catch {}
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  /** 平台键 → 中文名（进度显示用） */
  function progressLabel(key: string): string {
    return platforms.find(p => p.value === key)?.label ?? key;
  }

  /** 轮询任务状态（启动后与页面恢复共用） */
  function startPolling(jobId: string) {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    pollTimer = setInterval(async () => {
      try {
        const statusRes = await fetch("/api/trends/collect/status/" + jobId);
        const statusData = await statusRes.json();
        if (statusData.platformsProgress) researchPlatforms = statusData.platformsProgress;
        if (statusData.status === "done") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          lastCollectedCount = statusData.collected;
          await load();
          researchStatus = "done";
          // 部分平台失败时显式提示(2026-08-19 P1:失败不再静默吞成"0 条")
          researchMessage = statusData.error
            ? `收集 ${statusData.collected} 条,但${statusData.error}`
            : tt("topicsCollected").replace("{count}", String(statusData.collected));
        } else if (statusData.status === "error") {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          researchStatus = "error";
          researchMessage = statusData.error || tt("topicsResearchFailed");
        }
      } catch {}
    }, 5000);
  }

  async function startAITrendResearch() {
    researchStatus = "collecting";
    researchPlatforms = [];
    const targetPlatform = platform || "";
    const platformLabel = targetPlatform
      ? (platforms.find(p => p.value === targetPlatform)?.label ?? targetPlatform)
      : "全平台";
    researchMessage = tt("topicsCollecting").replace("{platform}", platformLabel);
    try {
      const interestArr = interests.split(",").map(s => s.trim()).filter(Boolean);
      await updateConfig({ interests: interestArr, researchTopN: topicCount } as any);
      const res = await fetch("/api/trends/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: targetPlatform || undefined, interests: interestArr, topN: topicCount }),
      });
      const data = await res.json();
      if (!data.jobId) throw new Error("No jobId returned");
      startPolling(data.jobId);
    } catch {
      researchStatus = "error";
      researchMessage = tt("topicsResearchFailed");
      setTimeout(() => { if (researchStatus === "error") researchStatus = "idle"; }, 5000);
    }
  }

  async function quickCollect() {
    await startAITrendResearch();
  }

  function cancelResearch() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    researchStatus = "idle";
    researchMessage = "";
    researchPlatforms = [];
  }

  async function convert(topic: Topic) {
    try {
      const res = await convertTopicToWork(topic.id, { platforms: [topic.platform || "douyin"], type: "short-video" });
      topic.status = "converted";
    } catch (err) {
      // 2026-08-31 修复:此前 alert(t("error")) 在不存在的 i18n key 上退化为显示字面量 "error",
      // 真实错误被吞。直接展示后端返回的错误消息。
      alert("转换失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  function toggleSelect(topicId: number) {
    if (selectedTopicIds.has(topicId)) {
      selectedTopicIds.delete(topicId);
    } else {
      selectedTopicIds.add(topicId);
    }
    selectedTopicIds = new Set(selectedTopicIds);
  }

  function selectAllConverted() {
    for (const t of topics) {
      if (t.status !== "converted") {
        selectedTopicIds.add(t.id);
      }
    }
    selectedTopicIds = new Set(selectedTopicIds);
  }

  function clearSelection() {
    selectedTopicIds = new Set();
  }

  async function openBatchModal() {
    showBatchModal = true;
    batchResult = "";
    loadPurposes(); // 用途预设(04 方案)——异步,不阻塞弹窗
    // Load templates and avatars for selection
    try {
      const tplRes = await fetch("/api/templates?status=approved");
      if (tplRes.ok) {
        const data = await tplRes.json();
        templates = data.templates ?? [];
        // 默认选中类型匹配的最高分模板(精品优先);用户仍可改选或清空为"不使用模板"
        if (!batchTemplateId || !templates.some((tpl: any) => tpl.id === batchTemplateId)) {
          batchTemplateId = filteredTemplates[0]?.id ?? "";
        }
      }
    } catch {}
    try {
      const avRes = await fetch("/api/digital-humans/avatars");
      if (avRes.ok) {
        const data = await avRes.json();
        avatars = data.avatars ?? [];
      }
    } catch {}
    try {
      const vRes = await fetchVoices();
      myVoices = vRes.voices.filter((v) => v.status === "ready" && v.type === "cloned");
      favVoices = vRes.voices.filter((v) => v.status === "ready" && v.type === "builtin_fav");
    } catch {}
  }

  async function batchConvert() {
    if (selectedTopicIds.size === 0) return;
    batchConverting = true;
    batchResult = "";
    batchJob = null;
    const isVideo = batchType !== "image-text";
    // 与旧 videoSource 字段兼容映射：stock/smart→search(smart 含素材库路由,需要素材搜索步骤),ai→ai-generate
    const legacyVideoSource = batchAssetSource === "stock" || batchAssetSource === "smart" ? "search" : batchAssetSource === "ai" ? "ai-generate" : batchAssetSource;
    try {
      const res = await fetch("/api/topics/batch-convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicIds: [...selectedTopicIds],
          templateId: batchTemplateId || undefined,
          digitalHumanId: batchDigitalHumanId || undefined,
          type: batchType,
          platforms: ["douyin", "xiaohongshu"],
          autoPipeline: true,
          duration: isVideo ? batchDuration : undefined,
          contentForm: isVideo ? batchContentForm : undefined,
          videoSource: isVideo ? legacyVideoSource : undefined,
          assetForm: isVideo ? batchAssetForm : undefined,
          assetSource: isVideo ? batchAssetSource : undefined,
          assetBudget: isVideo ? batchAssetBudget : undefined,
          purpose: batchPurpose || undefined,
          voiceStyle: isVideo ? batchVoiceStyle : undefined,
          voiceMode: isVideo ? batchVoiceMode : undefined,
          evaluationMode: batchEvaluation,
          evalMode: batchEvalMode === "express" ? "express" : undefined,
          aspect: isVideo ? batchAspect : undefined,
        }),
      });
      const data = await res.json();
      if (!data.jobId) {
        batchResult = "批量转换启动失败：" + (data.error ?? "未知错误");
        batchConverting = false;
        return;
      }
      batchJobId = data.jobId;
      startBatchPolling(data.jobId);
    } catch (err) {
      batchResult = "批量转换失败：" + (err instanceof Error ? err.message : String(err));
      batchConverting = false;
    }
  }

  function startBatchPolling(jobId: string) {
    if (batchPollTimer) clearInterval(batchPollTimer);
    const poll = async () => {
      try {
        const res = await fetch(`/api/topics/batch-status/${jobId}`);
        if (!res.ok) return;
        const job = await res.json();
        batchJob = job;
        // Mark converted topics as soon as their workId appears
        for (const item of job.items ?? []) {
          if (item.workId) {
            const topic = topics.find(t => t.id === item.topicId);
            if (topic) topic.status = "converted";
          }
        }
        topics = [...topics];
        if (job.status === "done") {
          if (batchPollTimer) { clearInterval(batchPollTimer); batchPollTimer = null; }
          const ok = job.items.filter((i: any) => i.workId && i.stage !== "error").length;
          const failed = job.items.filter((i: any) => i.stage === "error").length;
          batchResult = `全部处理完成：成功 ${ok} 个${failed > 0 ? `，失败 ${failed} 个` : ""}。流水线已在后台自动执行，可在作品页查看进展。`;
          batchConverting = false;
          selectedTopicIds = new Set();
        }
      } catch {}
    };
    poll();
    batchPollTimer = setInterval(poll, 3000);
  }

  /** 批量条目阶段显示 */
  function batchStageLabel(stage: string): string {
    switch (stage) {
      case "queued": return "排队中";
      case "creating": return "创建作品…";
      case "generating": return "生成文案…";
      case "starting": return "启动流水线…";
      case "running": return "流水线执行中";
      case "done": return "完成";
      case "error": return "失败";
      default: return stage;
    }
  }

  async function deleteTopic(topic: Topic) {
    try {
      await fetch(`/api/topics/${topic.id}`, { method: "DELETE" });
      await load();
    } catch {
      alert("删除失败");
    }
    deleteConfirmId = null;
  }

  function emotionColor(etype: string): string {
    const map: Record<string, string> = {
      "焦虑": "#f59e0b",
      "愤怒": "#ef4444",
      "搞笑": "#22c55e",
      "羡慕": "#3b82f6",
      "信息价值": "#8b5cf6",
    };
    return map[etype] ?? "var(--text-dim)";
  }

  function competitionColor(comp: string): string {
    if (!comp) return "var(--text-dim)";
    if (comp === "低") return "#22c55e";
    if (comp === "中") return "#f59e0b";
    if (comp === "高") return "#ef4444";
    return "var(--text-dim)";
  }

  function opportunityColor(opp: string): string {
    if (!opp) return "var(--text-dim)";
    if (opp === "金矿") return "#f59e0b";
    if (opp === "蓝海") return "#3b82f6";
    if (opp === "红海") return "#ef4444";
    return "var(--text-dim)";
  }
</script>

<div class="topics-page">
  <!-- Hero Header -->
  <div class="page-hero">
    <div class="hero-text">
      <h1>{tt("topicsTitle")}</h1>
      <p class="hero-sub">{tt("topicsSubtitle")}</p>
    </div>
  </div>

  <!-- Research Input Bar -->
  <div class="research-bar">
    <div class="research-row">
      <div class="research-field">
        <label class="field-label">{tt("topicsPlatformLabel")}</label>
        <select bind:value={platform} class="platform-select">
          {#each platforms as p}
            <option value={p.value}>{p.label}</option>
          {/each}
        </select>
      </div>
      <div class="research-field interests-field">
        <label class="field-label">{tt("topicsInterestsLabel")}</label>
        <input
          type="text"
          class="interests-input"
          bind:value={interests}
          placeholder={tt("topicsInterestsHint")}
          onchange={saveInterests}
        />
      </div>
      <div class="research-field">
        <label class="field-label">选题数量</label>
        <select bind:value={topicCount} class="platform-select" title="每次调研最终入库的选题卡片数量（按综合评分取前 N 名）">
          {#each TOPIC_COUNT_OPTIONS as n}
            <option value={n}>{n} 个</option>
          {/each}
        </select>
      </div>
      <div class="research-actions">
        {#if researchStatus === "streaming" || researchStatus === "collecting"}
          <button class="btn-cancel-research" onclick={cancelResearch}>
            <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
            {tt("cancelResearch")}
          </button>
        {:else}
          <button class="btn-ai-research" onclick={startAITrendResearch} disabled={loading}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            {tt("topicsStartResearch")}
          </button>
          <button class="btn-manual-add" disabled={loading} onclick={openManualAdd}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            {tt("topicsManualAdd")}
          </button>
        {/if}
        <button class="btn-refresh" onclick={load} disabled={loading}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        </button>
      </div>
    </div>

    <!-- Research Status -->
    {#if researchStatus !== "idle"}
      <div class="research-status" class:error={researchStatus === "error"} class:done={researchStatus === "done"}>
        {#if researchStatus === "streaming" || researchStatus === "collecting"}
          <span class="status-dot pulse"></span>
        {:else if researchStatus === "done"}
          <span class="status-dot done"></span>
        {:else}
          <span class="status-dot error"></span>
        {/if}
        <span class="status-text">{researchMessage}</span>
      </div>
      {#if researchPlatforms.length > 0}
        <div class="research-progress">
          {#each researchPlatforms as pp}
            <div class="rp-item" data-status={pp.status} title={pp.error ?? ""}>
              <span class="rp-dot"></span>
              <span class="rp-name">{progressLabel(pp.platform)}</span>
              <span class="rp-state">
                {#if pp.status === "running"}调研中…
                {:else if pp.status === "done"}✓ {pp.count ?? 0} 条候选
                {:else if pp.status === "error"}✗ 失败
                {:else}等待中{/if}
              </span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  <!-- Results Summary -->
  {#if !loading && topics.length > 0}
    <div class="results-summary">
      <span class="summary-count">{topics.length} topics</span>
      <span class="summary-divider">·</span>
      {#each platforms as p}
        <button class="summary-filter" class:active={platform === p.value} onclick={() => { platform = p.value; load(); }}>{p.label}</button>
      {/each}
    </div>
  {/if}

  <!-- Content -->
  {#if loading}
    <div class="empty-state">
      <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      <p class="empty-text">{tt("loading")}</p>
    </div>
  {:else if topics.length === 0}
    <div class="empty-state">
      <svg class="empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      <p class="empty-text">{tt("topicsNoTopics")}</p>
      <p class="empty-hint">{tt("topicsNoTopicsHint")}</p>
    </div>
  {:else}
    {#if topics.filter(t => t.status !== "converted").length > 0}
    <div class="batch-bar">
      <label class="batch-check">
        <input type="checkbox" onchange={(e) => e.target.checked ? selectAllConverted() : clearSelection()} />
        全选未转换
      </label>
      <span class="batch-count">{selectedTopicIds.size} 个已选</span>
      <button class="btn-batch" disabled={selectedTopicIds.size === 0} onclick={openBatchModal}>
        批量转为作品（自动流水线）
      </button>
    </div>
  {/if}

  <div class="topic-grid">
      {#each topics as topic (topic.id)}
        <article class="topic-card" class:converted={topic.status === "converted"}>
          {#if topic.status !== "converted"}
            <input type="checkbox" class="topic-checkbox" checked={selectedTopicIds.has(topic.id)} onchange={() => toggleSelect(topic.id)} />
          {/if}
          <!-- Top Row: Platform + Emotion + Status -->
          <div class="card-top">
            <span class="platform-tag">{topic.platform ?? "通用"}</span>
            {#if topic.emotion_type}
              <span class="emotion-tag" style="border-color:{emotionColor(topic.emotion_type)};color:{emotionColor(topic.emotion_type)}">
                {topic.emotion_type}{topic.emotion_subtype ? `/${topic.emotion_subtype}` : ""}
              </span>
            {/if}
            {#if topic.status === "converted"}
              <span class="converted-tag">{tt("topicsConverted")}</span>
            {/if}
          </div>

          <!-- Title -->
          <h3 class="card-title">{topic.title}</h3>

          <!-- Description -->
          {#if topic.description}
            <p class="card-desc">{topic.description}</p>
          {/if}

          <!-- Metrics Row -->
          <div class="card-metrics">
            {#if topic.heat}
              <span class="metric">
                <span class="metric-label">{tt("topicsHeat")}</span>
                <span class="metric-value heat">{topic.heat}/5</span>
              </span>
            {/if}
            {#if topic.competition}
              <span class="metric">
                <span class="metric-label">{tt("topicsCompetition")}</span>
                <span class="metric-value" style="color:{competitionColor(topic.competition)}">{topic.competition}</span>
              </span>
            {/if}
            {#if topic.opportunity}
              <span class="metric">
                <span class="metric-label">{tt("topicsOpportunity")}</span>
                <span class="metric-value" style="color:{opportunityColor(topic.opportunity)}">{topic.opportunity}</span>
              </span>
            {/if}
          </div>

          <!-- Content Angles -->
          {#if topic.content_angles && topic.content_angles.length > 0}
            <div class="card-angles">
              {#each topic.content_angles as angle}
                <span class="angle-chip">{angle}</span>
              {/each}
            </div>
          {/if}

          <!-- Example Hook -->
          {#if topic.example_hook}
            <p class="card-hook">{topic.example_hook}</p>
          {/if}

          <!-- Tags -->
          {#if topic.tags && topic.tags.length > 0}
            <div class="card-tags">
              {#each topic.tags as tag}
                <span class="tag">#{tag}</span>
              {/each}
            </div>
          {/if}

          <!-- Actions -->
          <div class="card-actions">
            <button
              class="btn-convert"
              disabled={topic.status === "converted"}
              onclick={() => convert(topic)}
            >
              {topic.status === "converted" ? tt("topicsConverted") : tt("topicsConvertToWork")}
            </button>
            <button class="btn-delete" onclick={() => deleteConfirmId = topic.id}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>

          <!-- Delete Confirm -->
          {#if deleteConfirmId === topic.id}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="delete-overlay" onclick={() => deleteConfirmId = null}>
              <div class="delete-confirm" onclick={(e) => e.stopPropagation()}>
                <p>{tt("confirmDelete")}</p>
                <div class="delete-actions">
                  <button class="btn-cancel-sm" onclick={() => deleteConfirmId = null}>{tt("cancel")}</button>
                  <button class="btn-delete-sm" onclick={() => deleteTopic(topic)}>{tt("delete")}</button>
                </div>
              </div>
            </div>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

{#if showManualAdd}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="batch-overlay" onclick={(e) => { if ((e.target as HTMLElement).classList.contains("batch-overlay")) showManualAdd = false; }}>
    <div class="batch-modal">
      <div class="batch-modal-header">
        <h2>手动添加选题</h2>
        <button class="batch-close" onclick={() => showManualAdd = false}>✕</button>
      </div>
      <div class="batch-modal-body">
        <div class="batch-field">
          <label>标题 *</label>
          <input class="manual-input" bind:value={manualForm.title} placeholder="选题标题（必填）" />
        </div>
        <div class="batch-field">
          <label>平台</label>
          <select bind:value={manualForm.platform}>
            {#each platforms as p}
              <option value={p.value}>{p.label}</option>
            {/each}
          </select>
        </div>
        <div class="batch-field">
          <label>描述</label>
          <textarea class="manual-input" rows="3" bind:value={manualForm.description} placeholder="为什么值得做、趋势背景（可选）"></textarea>
        </div>
        <div class="batch-field">
          <label>标签（逗号分隔）</label>
          <input class="manual-input" bind:value={manualForm.tags} placeholder="如：AI, 教程, 中考" />
        </div>
        <div class="batch-field">
          <label>切入角度（逗号或换行分隔）</label>
          <textarea class="manual-input" rows="2" bind:value={manualForm.contentAngles} placeholder="每条角度一行或用逗号分隔（可选）"></textarea>
        </div>
        <button class="btn-batch-start" disabled={manualSaving || !manualForm.title.trim()} onclick={saveManualTopic}>
          {manualSaving ? "保存中..." : "保存选题"}
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showBatchModal}
  <div class="batch-overlay" onclick={(e) => { if (e.target.classList.contains("batch-overlay")) showBatchModal = false; }}>
    <div class="batch-modal">
      <div class="batch-modal-header">
        <h2>批量自动制作</h2>
        <button class="batch-close" onclick={() => showBatchModal = false}>✕</button>
      </div>
      <div class="batch-modal-body">
        {#if batchJob || batchResult}
          <!-- 实时进度视图 -->
          {#if batchJob}
            <div class="batch-progress">
              <div class="batch-progress-header">
                <strong>批量制作进行中</strong>
                <span class="batch-progress-count">
                  {batchJob.items.filter((i: any) => i.stage === "done" || i.stage === "running" || (i.stage === "queued" && i.workId)).length} / {batchJob.items.length} 已进入流水线
                </span>
              </div>
              <div class="batch-items">
                {#each batchJob.items as item}
                  <div class="batch-item" data-stage={item.stage}>
                    <span class="bi-dot"></span>
                    <span class="bi-title">{item.title ?? `选题 #${item.topicId}`}</span>
                    <span class="bi-stage">{batchStageLabel(item.stage)}</span>
                    {#if item.error}<span class="bi-error" title={item.error}>⚠</span>{/if}
                  </div>
                {/each}
              </div>
              <p class="batch-hint">作品创建后将由 AI 全自动执行流水线（调研→分镜→素材→合成），无需人工介入。可关闭本窗口，在作品页查看每个作品的实时进展。</p>
            </div>
          {/if}
          {#if batchResult}
            <p class="batch-result">{batchResult}</p>
            {#if !batchConverting}
              <div class="batch-done-actions">
                <button class="btn-primary" onclick={() => { showBatchModal = false; batchJob = null; batchResult = ""; }}>完成</button>
                <button class="btn-secondary" onclick={() => { showBatchModal = false; batchJob = null; batchResult = ""; activeTab.set("works"); }}>前往作品页查看</button>
              </div>
            {/if}
          {/if}
        {:else}
          <!-- 第 1 层:用途(04 方案)——决定内容策略/形式推荐/参数默认/技能包注入 -->
          <div class="batch-field">
            <label>用途（先选这个——决定内容策略与默认参数）</label>
            {#if purposeOptions.length}
              <div class="purpose-grid">
                {#each purposeOptions as p}
                  <button
                    class="purpose-card"
                    class:selected={batchPurpose === p.key}
                    onclick={() => selectPurpose(p.key)}
                    title={p.strategy}
                  >
                    <span class="purpose-icon">{p.icon}</span>
                    <span class="purpose-label">{p.label}</span>
                    <span class="purpose-goal">{p.goal}</span>
                    <span class="purpose-skills" class:empty={p.skillCount === 0}>
                      {p.skillCount > 0 ? `技能包 ${p.skillCount} 条` : "技能包空"}
                    </span>
                  </button>
                {/each}
              </div>
              {#if batchPurpose}
                {@const sel = purposeOptions.find((x) => x.key === batchPurpose)}
                {#if sel}
                  <p class="batch-hint">{sel.strategy}</p>
                  {#if sel.skillCount === 0}
                    <p class="batch-hint warn">该用途技能包为空，建议先更新——AI 将按调研沉淀的爆款方法论执行。</p>
                  {/if}
                {/if}
                <button class="btn-skill-research" disabled={skillResearching} onclick={updateSkillPack}>
                  {skillResearching ? "调研中(约2-5分钟,可继续其他操作)..." : "🔄 更新该用途技能包（联网调研最新爆款方法论）"}
                </button>
              {/if}
            {:else}
              <p class="batch-hint">用途预设加载中…（加载失败时可直接用下方高级选项）</p>
            {/if}
          </div>

          <!-- 第 2 层:内容类型 + 内容形式(按用途过滤推荐) -->
          <div class="batch-field-row">
            <div class="batch-field">
              <label>内容类型</label>
              <select bind:value={batchType}>
                <option value="short-video">短视频</option>
                <option value="video+image-text">短视频+图文</option>
                <option value="image-text">图文</option>
              </select>
            </div>
            {#if batchType !== "image-text"}
              <div class="batch-field">
                <label>内容形式{batchPurpose ? "（按用途推荐）" : ""}</label>
                <select bind:value={batchContentForm}>
                  {#each visibleContentForms() as o}
                    <option value={o.value}>{o.label}（{o.desc}）</option>
                  {/each}
                </select>
              </div>
              <div class="batch-field">
                <label>画幅</label>
                <select bind:value={batchAspect}>
                  <option value="portrait">竖屏 9:16（抖音/小红书）</option>
                  <option value="landscape">横屏 16:9（B 站等，镜头模板用 -wide 款）</option>
                </select>
              </div>
            {/if}
          </div>

          <div class="batch-field">
            <label>使用模板（可选）</label>
            <select bind:value={batchTemplateId}>
              <option value="">不使用模板（AI 自主设计视觉）</option>
              {#each filteredTemplates as tpl}
                <option value={tpl.id}>{(tpl.score ?? 0) >= 90 ? "★精品 " : ""}{tpl.name}{tpl.score != null ? `（${tpl.score}分）` : ""}</option>
              {/each}
            </select>
            {#if filteredTemplates.length === 0}
              <p class="batch-hint">{batchType === "image-text" ? "暂无已启用图文模板，可前往模板库生成并启用图文模板" : "暂无已启用模板，可前往模板库生成并启用模板"}</p>
            {/if}
          </div>
          {#if batchType !== "image-text"}
            <div class="batch-field">
              <label>使用数字人（可选）</label>
              <select bind:value={batchDigitalHumanId}>
                <option value="">不使用数字人</option>
                {#each avatars as av}
                  <option value={av.id}>{av.name ?? av.id}</option>
                {/each}
              </select>
              {#if avatars.length === 0}
                <p class="batch-hint">暂无数字人，可前往数字人页面创建</p>
              {/if}
            </div>

            <!-- 第 3 层:高级参数(用途已给默认值,一般不用动) -->
            <div class="batch-field">
              <button class="advanced-toggle" onclick={() => showAdvanced = !showAdvanced}>
                {showAdvanced ? "▾ 收起高级选项" : "▸ 高级选项（时长/素材/成本/配音——用途已给默认值）"}
              </button>
            </div>
            {#if showAdvanced}
              <div class="batch-field-group">
                <p class="batch-group-title">视频制作控制</p>
                <div class="batch-field-row">
                  <div class="batch-field">
                    <label>视频时长</label>
                    <select bind:value={batchDuration}>
                      {#each DURATION_OPTIONS as o}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="batch-field">
                    <label>素材形态</label>
                    <select bind:value={batchAssetForm}>
                      {#each ASSET_FORM_OPTIONS as o}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </div>
                </div>
                <div class="batch-field-row">
                  <div class="batch-field">
                    <label>获取策略</label>
                    <select bind:value={batchAssetSource}>
                      {#each ASSET_SOURCE_OPTIONS as o}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </div>
                  <div class="batch-field">
                    <label>成本档</label>
                    <select bind:value={batchAssetBudget}>
                      {#each ASSET_BUDGET_OPTIONS as o}
                        <option value={o.value}>{o.label}</option>
                      {/each}
                    </select>
                  </div>
                </div>
                <div class="batch-field-row">
                  <div class="batch-field">
                    <label>配音模式</label>
                    <select bind:value={batchVoiceMode}>
                      <option value="ai">AI 合成音色</option>
                      <option value="cloned">我的克隆声音</option>
                    </select>
                  </div>
                  <div class="batch-field">
                    <label>配音音色</label>
                    <select bind:value={batchVoiceStyle}>
                      {#if batchVoiceMode === "cloned"}
                        {#each myVoices as v}
                          <option value={v.voice_id}>{v.name}</option>
                        {/each}
                        {#if myVoices.length === 0}
                          <option value="" disabled>暂无克隆声音，请先到素材库克隆</option>
                        {/if}
                      {:else}
                        {#each favVoices as v}
                          <option value={v.voice_id}>{v.name}</option>
                        {/each}
                        {#if favVoices.length === 0}
                          <option value="" disabled>请先到素材库收藏音色</option>
                        {/if}
                      {/if}
                    </select>
                  </div>
                </div>
              </div>
            {/if}
          {/if}
          <div class="batch-info">
            <p>将选中的 <strong>{selectedTopicIds.size}</strong> 个选题批量转为作品。</p>
            <label class="batch-eval-toggle" style="display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer;">
              <input type="checkbox" bind:checked={batchEvaluation} />
              质量评审(每阶段由独立评审把关,不合格自动打回重做,强烈建议开启)
            </label>
            {#if batchEvaluation}
              <label class="batch-eval-toggle" style="display:flex;align-items:center;gap:6px;margin:4px 0;cursor:pointer;">
                评审模式
                <select bind:value={batchEvalMode} style="margin-left:4px;">
                  <option value="standard">标准(每阶段 LLM 评审)</option>
                  <option value="express">极速(机器门禁照跑,仅成片单轮终审)</option>
                </select>
              </label>
            {/if}
            <p class="batch-hint">出片后自动执行质量门禁(时长/黑帧/静音/字幕覆盖率机器检测),低级错误拦截在发布前。</p>
            <p class="batch-auto-notice"><strong>全自动模式</strong>：本入口创建的作品一律由 AI 无人值守执行完整流水线（不会向你提问，所有创意决策按 skills 推荐方案自主拍板），本窗口实时显示每个选题的制作进度。模板/数字人为可选项，不影响模式。</p>
          </div>
          <div class="batch-modal-footer">
            <button class="btn-batch-start" disabled={batchConverting || (batchType !== "image-text" && ((batchVoiceMode === "cloned" && myVoices.length === 0) || (batchVoiceMode === "ai" && favVoices.length === 0)))} onclick={batchConvert}>
              {batchConverting ? "启动中..." : `批量创建 ${selectedTopicIds.size} 个作品`}
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .topics-page {
    padding: 1rem 0;
    max-width: 1200px;
  }

  /* ── Hero ─────────────────────────────────── */
  .page-hero {
    margin-bottom: 1.5rem;
  }

  .hero-text h1 {
    font-family: var(--font-display);
    font-size: var(--size-2xl);
    font-weight: 700;
    letter-spacing: -0.03em;
    margin: 0 0 0.3rem;
  }

  .hero-sub {
    font-size: var(--size-sm);
    color: var(--text-muted);
    margin: 0;
  }

  /* ── Research Bar ─────────────────────────── */
  .research-bar {
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    padding: 1rem 1.25rem;
    margin-bottom: 1.25rem;
  }

  .research-row {
    display: flex;
    align-items: flex-end;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .research-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field-label {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .platform-select {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 2rem 0.45rem 0.65rem;
    font-size: var(--size-sm);
    font-family: var(--font-body);
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b6560' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.5rem center;
    background-size: 10px;
    cursor: pointer;
    min-width: 120px;
  }

  .interests-field {
    flex: 1;
    min-width: 200px;
  }

  .interests-input {
    width: 100%;
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.7rem;
    font-size: var(--size-sm);
    font-family: var(--font-body);
    transition: border-color 0.15s;
  }

  .interests-input:focus {
    outline: none;
    border-color: var(--text-muted);
  }

  .interests-input::placeholder {
    color: var(--text-dim);
  }

  .research-actions {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
  }

  .btn-ai-research {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--spark-red);
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.45rem 1rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.12s;
    white-space: nowrap;
  }

  .btn-ai-research:hover:not(:disabled) { opacity: 0.85; }
  .btn-ai-research:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-cancel-research {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--bg-inset);
    color: var(--error);
    border: 1.5px solid var(--error);
    border-radius: 4px;
    padding: 0.45rem 1rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
  }

  .btn-manual-add {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--bg-inset);
    color: var(--text-secondary);
    border: 1.5px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 1rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 550;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-manual-add:hover:not(:disabled) {
    border-color: var(--text-dim);
    color: var(--text);
  }
  .btn-manual-add:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-refresh {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    background: var(--bg-inset);
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-refresh:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--text-dim);
  }
  .btn-refresh:disabled { opacity: 0.4; cursor: not-allowed; }

  .spin {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Research Status ──────────────────────── */
  .research-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding: 0.45rem 0.75rem;
    border-radius: 4px;
    background: var(--info-soft);
    font-size: var(--size-xs);
    font-weight: 500;
    color: var(--info);
  }

  .research-status.error {
    background: var(--error-soft);
    color: var(--error);
  }

  .research-status.done {
    background: var(--success-soft);
    color: var(--success);
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--info);
    flex-shrink: 0;
  }

  .status-dot.pulse {
    animation: pulse 1.5s ease-in-out infinite;
  }

  .status-dot.done { background: var(--success); }
  .status-dot.error { background: var(--error); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .status-text {
    line-height: 1.3;
  }

  /* ── Research Progress（每平台进度） ────────── */
  .research-progress {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .rp-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.72rem;
  }
  .rp-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); flex-shrink: 0; }
  .rp-item[data-status="running"] .rp-dot { background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
  .rp-item[data-status="done"] .rp-dot { background: var(--success); }
  .rp-item[data-status="error"] .rp-dot { background: var(--error); }
  .rp-name { font-weight: 600; color: var(--text-secondary); }
  .rp-state { color: var(--text-dim); }
  .rp-item[data-status="done"] .rp-state { color: var(--success); }
  .rp-item[data-status="error"] .rp-state { color: var(--error); }

  /* ── Results Summary ──────────────────────── */
  .results-summary {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .summary-count {
    font-size: var(--size-sm);
    font-weight: 600;
    color: var(--text-secondary);
  }

  .summary-divider {
    color: var(--text-dim);
  }

  .summary-filter {
    background: none;
    border: 1px solid var(--border);
    border-radius: 99px;
    padding: 0.2rem 0.75rem;
    font-size: var(--size-xs);
    font-family: var(--font-body);
    color: var(--text-muted);
    cursor: pointer;
    transition: all 0.12s;
  }

  .summary-filter:hover { color: var(--text); border-color: var(--text-dim); }
  .summary-filter.active {
    background: var(--accent-soft);
    border-color: var(--text-dim);
    color: var(--text);
  }

  /* ── Empty State ──────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 4rem 1rem;
    text-align: center;
  }

  .empty-icon {
    color: var(--text-dim);
    margin-bottom: 1rem;
    opacity: 0.5;
  }

  .empty-text {
    font-size: var(--size-lg);
    font-weight: 600;
    color: var(--text-muted);
    margin: 0 0 0.35rem;
  }

  .empty-hint {
    font-size: var(--size-sm);
    color: var(--text-dim);
    margin: 0;
    max-width: 320px;
  }

  /* ── Topic Grid ───────────────────────────── */
  .topic-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 1rem;
  }

  .topic-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1rem 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    position: relative;
    transition: border-color 0.15s;
  }

  .topic-card:hover {
    border-color: rgba(255, 255, 255, 0.1);
  }

  .topic-card.converted {
    opacity: 0.65;
  }

  .card-top {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .platform-tag {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    background: var(--bg-inset);
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
  }

  .emotion-tag {
    font-size: 0.65rem;
    font-weight: 600;
    border: 1px solid;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
  }

  .converted-tag {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--success);
    background: var(--success-soft);
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    margin-left: auto;
  }

  .card-title {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    margin: 0;
    line-height: 1.3;
    letter-spacing: -0.01em;
  }

  .card-desc {
    font-size: var(--size-sm);
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .card-metrics {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .metric {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .metric-label {
    font-size: var(--size-xs);
    color: var(--text-dim);
  }

  .metric-value {
    font-size: var(--size-xs);
    font-weight: 650;
  }

  .metric-value.heat {
    color: var(--spark-red);
  }

  .card-angles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .angle-chip {
    font-size: 0.7rem;
    color: var(--text-secondary);
    background: var(--bg-inset);
    border: 1px solid var(--border-subtle);
    border-radius: 3px;
    padding: 0.2rem 0.55rem;
    line-height: 1.3;
  }

  .card-hook {
    font-size: var(--size-sm);
    color: var(--spark-red);
    margin: 0;
    font-style: italic;
    line-height: 1.4;
    padding: 0.35rem 0.5rem;
    background: rgba(254, 44, 85, 0.04);
    border-radius: 3px;
    border-left: 2px solid rgba(254, 44, 85, 0.4);
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .tag {
    font-size: var(--size-xs);
    color: var(--text-muted);
    background: var(--bg-inset);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .card-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: auto;
    padding-top: 0.25rem;
  }

  .btn-convert {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.45rem;
    background: var(--text);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.12s;
  }

  .btn-convert:hover:not(:disabled) { opacity: 0.85; }
  .btn-convert:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    background: var(--bg-surface);
    color: var(--text-dim);
    border: 1px solid var(--border);
  }

  .btn-delete {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    background: none;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-delete:hover {
    color: var(--error);
    border-color: var(--error);
  }

  /* ── Delete Confirm ───────────────────────── */
  .delete-overlay {
    position: absolute;
    inset: 0;
    background: rgba(14, 14, 14, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--card-radius);
    z-index: 10;
  }

  .delete-confirm {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1rem 1.25rem;
    text-align: center;
  }

  .delete-confirm p {
    font-size: var(--size-sm);
    color: var(--text-secondary);
    margin: 0 0 0.75rem;
  }

  .delete-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
  }

  .btn-cancel-sm {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.35rem 1rem;
    font-family: var(--font-body);
    font-size: var(--size-xs);
    font-weight: 600;
    cursor: pointer;
  }

  .btn-delete-sm {
    background: var(--error);
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 1rem;
    font-family: var(--font-body);
    font-size: var(--size-xs);
    font-weight: 600;
    cursor: pointer;
  }

  /* Batch automation styles */
  .batch-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.6rem 0.8rem;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  .batch-check { display: flex; align-items: center; gap: 0.35rem; font-size: 0.82rem; cursor: pointer; color: var(--text-secondary); }
  .batch-count { font-size: 0.8rem; color: var(--text-dim); }
  .btn-batch {
    margin-left: auto;
    padding: 0.45rem 0.9rem;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 4px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-batch:disabled { opacity: 0.4; cursor: not-allowed; }

  .batch-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
  }
  .batch-modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 100%;
    max-width: 440px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-lg, 0 8px 32px rgba(0,0,0,0.3));
  }
  .batch-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border);
  }
  .batch-modal-header h2 { font-size: 1rem; font-weight: 700; margin: 0; }
  .batch-close { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 1.1rem; }
  .batch-modal-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; overflow-y: auto; flex: 1; min-height: 0; }
  .batch-modal-footer {
    position: sticky;
    bottom: 0;
    background: var(--bg-elevated);
    border-top: 1px solid var(--border);
    margin: 0 -1.25rem -1.25rem;
    padding: 0.75rem 1.25rem 1.25rem;
  }
  .batch-field { display: flex; flex-direction: column; gap: 0.35rem; }

  /* 用途卡片选择器(04 方案) */
  .purpose-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }
  .purpose-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    padding: 0.55rem 0.6rem;
    border-radius: 10px;
    border: 1px solid var(--border, rgba(128,128,128,0.25));
    background: transparent;
    color: inherit;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
  }
  .purpose-card:hover { border-color: var(--spark-red, #FE2C55); }
  .purpose-card.selected {
    border-color: var(--spark-red, #FE2C55);
    background: rgba(254, 44, 85, 0.06);
  }
  .purpose-icon { font-size: 1.1rem; }
  .purpose-label { font-size: 0.8rem; font-weight: 600; }
  .purpose-goal { font-size: 0.65rem; opacity: 0.55; }
  .purpose-skills { font-size: 0.62rem; opacity: 0.65; margin-top: 0.15rem; }
  .purpose-skills.empty { color: #f59e0b; opacity: 1; }
  .btn-skill-research {
    margin-top: 0.3rem;
    padding: 0.35rem 0.6rem;
    border-radius: 7px;
    border: 1px dashed rgba(128,128,128,0.4);
    background: transparent;
    color: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .btn-skill-research:hover { border-color: var(--spark-red, #FE2C55); }
  .btn-skill-research:disabled { opacity: 0.6; cursor: default; }
  .batch-hint.warn { color: #f59e0b; }
  .advanced-toggle {
    padding: 0.4rem 0.6rem;
    border-radius: 7px;
    border: 1px solid var(--border, rgba(128,128,128,0.25));
    background: transparent;
    color: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    text-align: left;
  }
  .advanced-toggle:hover { border-color: var(--spark-red, #FE2C55); }
  .batch-field label { font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); }
  .batch-field select {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
    font-size: 0.82rem;
  }
  .batch-field-group { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.7rem; background: var(--bg-inset); border-radius: 6px; border: 1px solid var(--border-subtle, var(--border)); }
  .batch-group-title { font-size: 0.78rem; font-weight: 700; color: var(--text-secondary); margin: 0; }
  .batch-field-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.7rem; }
  .batch-hint { font-size: 0.72rem; color: var(--text-dim); margin: 0; }
  .batch-info { padding: 0.6rem; background: var(--bg-inset); border-radius: 4px; }
  .batch-info p { font-size: 0.8rem; margin: 0 0 0.35rem; color: var(--text-secondary); }
  .batch-auto-notice { font-size: 0.78rem; color: var(--success); margin-top: 0.5rem; }
  .batch-result { font-size: 0.85rem; color: var(--text); text-align: center; padding: 1rem 0; }
  .batch-progress { display: flex; flex-direction: column; gap: 0.6rem; }
  .batch-progress-header { display: flex; justify-content: space-between; align-items: center; font-size: 0.88rem; }
  .batch-progress-count { font-size: 0.78rem; color: var(--text-dim); }
  .batch-items { display: flex; flex-direction: column; gap: 0.35rem; max-height: 320px; overflow-y: auto; }
  .batch-item { display: flex; align-items: center; gap: 0.5rem; padding: 0.45rem 0.6rem; background: var(--bg-inset); border-radius: 4px; font-size: 0.8rem; }
  .bi-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-dim); flex-shrink: 0; }
  .batch-item[data-stage="creating"] .bi-dot, .batch-item[data-stage="generating"] .bi-dot, .batch-item[data-stage="starting"] .bi-dot { background: var(--accent); animation: bi-pulse 1s ease-in-out infinite; }
  .batch-item[data-stage="running"] .bi-dot { background: #3b82f6; animation: bi-pulse 1.4s ease-in-out infinite; }
  .batch-item[data-stage="done"] .bi-dot { background: var(--success, #22c55e); }
  .batch-item[data-stage="error"] .bi-dot { background: var(--error, #ef4444); }
  @keyframes bi-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .bi-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bi-stage { font-size: 0.72rem; color: var(--text-secondary); flex-shrink: 0; }
  .bi-error { color: var(--error, #ef4444); cursor: help; }
  .batch-done-actions { display: flex; gap: 0.6rem; justify-content: center; }
  .btn-secondary { padding: 0.5rem 1rem; border-radius: 4px; border: 1px solid var(--border); background: var(--bg-inset); color: var(--text); cursor: pointer; font-size: 0.82rem; }
  .btn-batch-start {
    width: 100%;
    padding: 0.6rem;
    background: var(--accent);
    color: var(--accent-text);
    border: none;
    border-radius: 4px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-batch-start:disabled { opacity: 0.5; cursor: not-allowed; }
  .topic-checkbox {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    z-index: 5;
  }
  .manual-input {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
    font-size: 0.82rem;
    font-family: var(--font-body);
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
  }
  .manual-input:focus { outline: none; border-color: var(--text-muted); }

  /* ── Responsive ────────────────────────────── */
  @media (max-width: 768px) {
    .research-row {
      flex-direction: column;
      align-items: stretch;
    }
    .research-actions {
      justify-content: flex-start;
    }
    .topic-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
