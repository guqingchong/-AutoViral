<script lang="ts">
  import { onMount } from "svelte";
  import { t, getLanguage, subscribe } from "../lib/i18n";
  import { fetchWorks, deleteWorkApi, fetchQueue, queueAction, deleteQueueWork, type WorkSummary, type QueueItemInfo } from "../lib/api";
  import InterestTags from "../components/InterestTags.svelte";
  import AssetLibrary from "../components/AssetLibrary.svelte";

  let {
    onOpenStudio,
    onCreateNew,
    onCreateFromTrend,
    onGoToInsights,
  }: {
    onOpenStudio: (workId: string) => void;
    onCreateNew: () => void;
    onCreateFromTrend: (title: string, topicHint: string) => void;
    onGoToInsights?: () => void;
  } = $props();

  let autoResearchOn = $state(false);
  let insightCount = $state(0);
  let competitorCount = $state(0);

  async function loadInsightData() {
    try {
      const configRes = await fetch("/api/config");
      if (configRes.ok) {
        const config = await configRes.json();
        autoResearchOn = config.autoRun ?? false;
      }
    } catch {}
    try {
      // Count trend directions as "ideas"
      for (const platform of ["douyin", "xiaohongshu"]) {
        const res = await fetch(`/api/trends/${platform}`);
        if (res.ok) {
          const data = await res.json();
          const arr = data.topics ?? data.directions ?? data.trends ?? data.items ?? [];
          if (Array.isArray(arr)) {
            insightCount += arr.length;
            competitorCount += Math.max(arr.length * 2, 5); // approximate
          }
        }
      }
    } catch {}
  }

  let lang = $state(getLanguage());
  function tt(key: string): string { void lang; return t(key); }

  let works: WorkSummary[] = $state([]);
  let loading = $state(true);
  let loadError = $state(false);
  let filter: "all" | "draft" | "published" = $state("all");

  // ── 任务队列（作品流水线队列面板，8s 静默轮询，与 loadWorks 同节奏） ──
  let queueItems: QueueItemInfo[] = $state([]);
  let queueActionBusy: Record<string, boolean> = $state({});

  /** 面板只展示活跃项（queued/running/paused），按 position 排序 */
  let activeQueueItems = $derived(
    queueItems
      .filter((q) => q.status === "queued" || q.status === "running" || q.status === "paused")
      .sort((a, b) => a.position - b.position)
  );

  async function loadQueue() {
    try {
      queueItems = await fetchQueue();
    } catch { /* 静默失败，下轮重试 */ }
  }

  /** 作品在队列中的位次（仅 queued 项参与排位，1 起）；不在队列返回 null */
  function queuePositionOf(workId: string): { pos: number; status: "queued" | "running" | "paused" } | null {
    const item = queueItems.find((q) => q.workId === workId);
    if (!item || item.status === "done" || item.status === "failed") return null;
    const queued = queueItems
      .filter((q) => q.status === "queued" || q.status === "paused")
      .sort((a, b) => a.position - b.position);
    const pos = item.status === "running" ? 0 : queued.findIndex((q) => q.workId === workId) + 1;
    return { pos, status: item.status };
  }

  async function handleQueueAction(workId: string, action: "prioritize" | "pause" | "resume" | "remove") {
    if (queueActionBusy[workId]) return;
    queueActionBusy = { ...queueActionBusy, [workId]: true };
    try {
      await queueAction(workId, action);
      await Promise.all([loadQueue(), loadWorks(true)]);
    } catch { /* ignore */ } finally {
      queueActionBusy = { ...queueActionBusy, [workId]: false };
    }
  }

  async function handleQueueDelete(workId: string, title: string) {
    if (queueActionBusy[workId]) return;
    if (!confirm(lang === "zh" ? `确定出队并删除「${title}」？作品将被一并删除。` : `Dequeue and delete "${title}"? The work will be deleted.`)) return;
    queueActionBusy = { ...queueActionBusy, [workId]: true };
    try {
      await deleteQueueWork(workId);
      works = works.filter((w) => w.id !== workId);
      await loadQueue();
    } catch { /* ignore */ } finally {
      queueActionBusy = { ...queueActionBusy, [workId]: false };
    }
  }

  function queueStatusLabel(status: string): string {
    if (status === "running") return lang === "zh" ? "运行中" : "Running";
    if (status === "paused") return lang === "zh" ? "已暂停" : "Paused";
    return lang === "zh" ? "排队中" : "Queued";
  }

  let filteredWorks = $derived.by(() => {
    if (filter === "all") return works;
    if (filter === "draft") return works.filter(w => w.status !== "published" && w.status !== "failed");
    return works.filter(w => w.status === "published");
  });

  async function loadWorks(silent = false) {
    if (!silent) {
      loading = true;
      loadError = false;
    }
    try {
      works = await fetchWorks();
      if (!silent) loadError = false;
    } catch {
      if (!silent) {
        works = [];
        loadError = true;
      }
    } finally {
      if (!silent) loading = false;
    }
  }

  const STATUS_LABELS: Record<string, string> = {
    draft: "workDraft",
    researching: "workResearching",
    planning: "workPlanning",
    assetting: "workAssetting",
    assembling: "workAssembling",
    reviewing: "workReviewing",
    published: "workPublished",
    failed: "workFailed",
  };

  function statusLabel(status: string): string {
    return tt(STATUS_LABELS[status] ?? "workDraft");
  }

  function statusClass(status: string): string {
    if (status === "published") return "status-published";
    if (status === "failed") return "status-failed";
    if (status === "draft") return "status-draft";
    return "status-in-progress";
  }

  function isPublished(status: string): boolean {
    return status === "published";
  }

  /** 进度三态：排队中（第 N 位）/ 进行中 · 步骤 / 停滞 · 自动恢复中（lastActivityAt ≥10 分钟无动静） */
  const STALL_THRESHOLD_MS = 10 * 60 * 1000;
  function progressLabel(w: WorkSummary): { text: string; stalled: boolean; queued: boolean } {
    const qp = queuePositionOf(w.id);
    if (qp && qp.status === "paused") {
      return { text: `已暂停（第 ${qp.pos} 位）`, stalled: true, queued: true };
    }
    if (qp && qp.status === "queued") {
      return { text: `排队中（第 ${qp.pos} 位）`, stalled: false, queued: true };
    }
    const activeStep = w.pipeline?.find((s) => s.status === "active" || s.status === "evaluating" || s.status === "eval_blocked");
    if (activeStep) {
      const stalled = !!w.lastActivityAt && Date.now() - new Date(w.lastActivityAt).getTime() >= STALL_THRESHOLD_MS;
      if (activeStep.status === "eval_blocked") {
        return { text: `评审受阻 · ${activeStep.name}`, stalled: true, queued: false };
      }
      if (stalled) {
        return { text: "停滞 · 自动恢复中", stalled: true, queued: false };
      }
      return { text: `进行中 · ${activeStep.name}`, stalled: false, queued: false };
    }
    return { text: "等待启动", stalled: false, queued: false };
  }

  // Mock stats for published works (in real app, fetched from analytics API)
  function getWorkStats(workId: string): { likes: number; comments: number; newFollowers: number } {
    let hash = 0;
    for (let i = 0; i < workId.length; i++) {
      hash = workId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const seed = Math.abs(hash);
    return {
      likes: (seed % 9000) + 1000,
      comments: (seed % 500) + 50,
      newFollowers: (seed % 200) + 10,
    };
  }

  function formatNum(n: number): string {
    if (n >= 10000) return (n / 10000).toFixed(1) + "w";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function typeLabel(type: string): string {
    if (type === "short-video") return tt("shortVideo");
    if (type === "image-text") return tt("imageText");
    return type;
  }

  function platformLabel(p: string): string {
    if (p === "douyin") return tt("douyin");
    if (p === "xiaohongshu") return tt("xiaohongshu");
    return p;
  }

  function categoryLabel(cat: string): string {
    const map: Record<string, string> = {
      anxiety: tt("categoryAnxiety"),
      conflict: tt("categoryConflict"),
      comedy: tt("categoryComedy"),
      envy: tt("categoryEnvy"),
    };
    return map[cat] ?? cat;
  }

  const gradients = [
    "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
    "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)",
    "linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)",
    "linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)",
    "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
    "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)",
  ];

  async function handleDelete(e: MouseEvent, workId: string, title: string) {
    e.stopPropagation(); // Don't open studio
    if (!confirm(lang === "zh" ? `确定删除「${title}」？` : `Delete "${title}"?`)) return;
    try {
      await deleteWorkApi(workId);
      works = works.filter(w => w.id !== workId);
    } catch { /* ignore */ }
  }

  function cardGradient(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    return gradients[Math.abs(hash) % gradients.length];
  }

  // Inspiration data (embedded from old Explore)
  interface TrendDirection {
    title: string;
    heat: number;
    description: string;
    tags?: string[];
    contentAngles?: string[];
    exampleHook?: string;
    opportunity?: string;
    competition?: string;
    category?: string;
    emotionType?: string;
    emotionSubtype?: string;
  }

  let douyinDirections: TrendDirection[] = $state([]);
  let xhsDirections: TrendDirection[] = $state([]);
  let selectedTrend: TrendDirection | null = $state(null);
  let inspirationPlatform: string = $state("douyin");
  let interests: string[] = $state([]);
  let researchLoading = $state(false);
  let researchSeconds = $state(0);
  let researchTimer: ReturnType<typeof setInterval> | null = null;
  let worksPollTimer: ReturnType<typeof setInterval> | null = null;
  let showResearchModal = $state(false);
  let configInterval = $state("1h");
  let configModel = $state("sonnet");

  async function loadConfig() {
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        configInterval = data.interval ?? "1h";
        configModel = data.model ?? "sonnet";
      }
    } catch {}
  }

  function openResearchModal() {
    if (researchLoading) return;
    showResearchModal = true;
  }

  async function startResearchFromModal() {
    showResearchModal = false;
    researchLoading = true;
    researchSeconds = 30;
    // Clear old directions immediately so user sees fresh results
    if (inspirationPlatform === "douyin") douyinDirections = [];
    else xhsDirections = [];
    // Save config
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRun: autoResearchOn, interval: configInterval, model: configModel }),
      });
    } catch {}
    // Start countdown
    researchTimer = setInterval(() => {
      researchSeconds--;
      if (researchSeconds <= 0) {
        if (researchTimer) clearInterval(researchTimer);
        researchTimer = null;
      }
    }, 1000);
    // Start research — pass interests and competitors
    try {
      await fetch("/api/trends/refresh-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: inspirationPlatform, interests, competitors: [] }),
      });
      // Wait then reload
      setTimeout(async () => {
        if (researchTimer) clearInterval(researchTimer);
        researchTimer = null;
        researchSeconds = 0;
        await loadInspirationDirections();
        await loadInsightData();
        researchLoading = false;
      }, 30000);
    } catch {
      if (researchTimer) clearInterval(researchTimer);
      researchTimer = null;
      researchSeconds = 0;
      researchLoading = false;
    }
  }

  async function toggleAutoResearch() {
    autoResearchOn = !autoResearchOn;
    try {
      await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoRun: autoResearchOn }),
      });
    } catch {
      autoResearchOn = !autoResearchOn;
    }
  }

  let inspirationDirections = $derived(
    inspirationPlatform === "douyin" ? douyinDirections : xhsDirections
  );

  async function loadInspirationDirections() {
    try {
      const res = await fetch("/api/topics?limit=20");
      if (res.ok) {
        const data = await res.json();
        const arr = data.topics ?? [];
        if (Array.isArray(arr)) {
          const mapped = arr.map((item: any) => ({
            title: item.title ?? "",
            heat: Math.min(5, Math.max(1, Number(item.heat ?? 3))),
            description: item.description ?? "",
            tags: Array.isArray(item.tags) ? item.tags : [],
            contentAngles: Array.isArray(item.contentAngles) ? item.contentAngles : [],
            exampleHook: item.exampleHook ?? "",
            opportunity: item.opportunity ?? "",
            competition: item.competition ?? "",
            category: item.category ?? "",
            emotionType: item.emotionType ?? "",
            emotionSubtype: item.emotionSubtype ?? "",
            platform: item.platform ?? "",
          }));
          douyinDirections = mapped;
          xhsDirections = mapped;
        }
      }
    } catch {}
  }

  async function loadInterests() {
    try {
      const res = await fetch("/api/interests");
      if (res.ok) {
        const data = await res.json();
        interests = data.interests ?? [];
      }
    } catch {}
  }

  async function saveInterests(updated: string[]) {
    interests = updated;
    await fetch("/api/interests", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interests: updated }),
    }).catch(() => {});
  }

  function dispatchCreate(dir: TrendDirection) {
    const hint = [
      dir.emotionType ? `目标情绪: ${dir.emotionType}${dir.emotionSubtype ? `（${dir.emotionSubtype}）` : ""}` : "",
      dir.description,
      dir.contentAngles?.length ? `切入角度: ${dir.contentAngles.join("; ")}` : "",
      dir.exampleHook ? `爆款钩子: ${dir.exampleHook}` : "",
      dir.tags?.length ? dir.tags.map(t => "#" + t).join(" ") : "",
    ].filter(Boolean).join("\n");
    onCreateFromTrend(dir.title, hint);
  }

  function heatDots(level: number): string {
    return Array.from({ length: 5 }, (_, i) => i < level ? "\u{1F525}" : "\u00B7").join("");
  }

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    loadWorks();
    loadQueue();
    loadInsightData();
    loadInspirationDirections();
    loadInterests();
    loadConfig();
    // 静默轮询：流水线进展（agent 后台执行）每 8 秒刷新到卡片上；任务队列同节奏
    worksPollTimer = setInterval(() => { loadWorks(true); loadQueue(); }, 8000);
    return () => {
      unsub();
      if (researchTimer) clearInterval(researchTimer);
      if (worksPollTimer) clearInterval(worksPollTimer);
    };
  });
</script>

<div class="works-page">
  <AssetLibrary />

  <!-- ═══ 任务队列面板（仅在有活跃队列项时显示） ═══ -->
  {#if activeQueueItems.length > 0}
    <div class="queue-panel">
      <div class="queue-panel-head">
        <h2 class="section-title">{lang === "zh" ? "任务队列" : "Task Queue"}</h2>
        <span class="queue-count">{activeQueueItems.length}</span>
      </div>
      <div class="queue-list">
        {#each activeQueueItems as q (q.workId)}
          <div class="queue-row">
            <span class="queue-status queue-status-{q.status}">{queueStatusLabel(q.status)}</span>
            <span class="queue-title" title={q.title}>{q.title || q.workId}</span>
            <span class="queue-actions">
              <button
                class="queue-btn"
                disabled={q.status === "running" || !!queueActionBusy[q.workId]}
                title={lang === "zh" ? "优先：插队到运行中之后" : "Prioritize"}
                onclick={() => handleQueueAction(q.workId, "prioritize")}
              >⬆</button>
              {#if q.status === "paused"}
                <button
                  class="queue-btn"
                  disabled={!!queueActionBusy[q.workId]}
                  title={lang === "zh" ? "恢复排队" : "Resume"}
                  onclick={() => handleQueueAction(q.workId, "resume")}
                >▶</button>
              {:else}
                <button
                  class="queue-btn"
                  disabled={!!queueActionBusy[q.workId]}
                  title={lang === "zh" ? "暂停" : "Pause"}
                  onclick={() => handleQueueAction(q.workId, "pause")}
                >⏸</button>
              {/if}
              <button
                class="queue-btn"
                disabled={!!queueActionBusy[q.workId]}
                title={lang === "zh" ? "移出队列，转为手动制作" : "Remove from queue (manual mode)"}
                onclick={() => handleQueueAction(q.workId, "remove")}
              >↗</button>
              <button
                class="queue-btn queue-btn-danger"
                disabled={!!queueActionBusy[q.workId]}
                title={lang === "zh" ? "出队并删除作品" : "Dequeue and delete"}
                onclick={() => handleQueueDelete(q.workId, q.title)}
              >🗑</button>
            </span>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- ═══ Zone 1: Greeting + Viral Ideas ═══ -->
  <div class="hero-zone">
    <p class="hero-text">
      {tt("insightBannerWithData").replace("{competitors}", String(competitorCount))}
      <span class="hero-highlight">{insightCount}{tt("viralIdeas")}</span>
      {tt("viralIdeasSuffix")}
    </p>
    <div class="section-header">
      <div class="section-title-row">
        <h2 class="section-title">{tt("inspirationTitle")}</h2>
        <InterestTags {interests} onUpdate={saveInterests} />
      </div>
      <div class="section-right">
        <div class="pill-group">
          <button class="pill" class:active={inspirationPlatform === "douyin"} onclick={() => inspirationPlatform = "douyin"}>
            {tt("douyinTab")}{#if douyinDirections.length > 0} <span class="pill-num">{douyinDirections.length}</span>{/if}
          </button>
          <button class="pill" class:active={inspirationPlatform === "xiaohongshu"} onclick={() => inspirationPlatform = "xiaohongshu"}>
            {tt("xiaohongshuTab")}{#if xhsDirections.length > 0} <span class="pill-num">{xhsDirections.length}</span>{/if}
          </button>
        </div>
        <button class="new-work-btn" onclick={openResearchModal} disabled={researchLoading}>
          {#if researchLoading}
            <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            {lang === "zh" ? "思考中" : "Thinking"}{#if researchSeconds > 0} ({researchSeconds}s){/if}
          {:else}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            {lang === "zh" ? "想新思路" : "New Ideas"}
          {/if}
        </button>
      </div>
    </div>
    {#if inspirationDirections.length > 0}
      <div class="inspiration-scroll">
        {#each inspirationDirections.slice(0, 10) as dir}
          <button class="inspiration-card" onclick={() => selectedTrend = dir}>
            <div class="insp-card-top">
              {#if dir.emotionType}
                <span class="insp-emotion">{dir.emotionType}</span>
              {/if}
              {#if dir.category}
                <span class="insp-category">{dir.category}</span>
              {/if}
              <span class="insp-heat">{heatDots(dir.heat)}</span>
            </div>
            <h4 class="insp-title">{dir.title}</h4>
            {#if dir.description}
              <p class="insp-desc">{dir.description}</p>
            {/if}
            {#if dir.tags && dir.tags.length > 0}
              <div class="insp-tags">
                {#each dir.tags.slice(0, 3) as tag}
                  <span class="insp-tag">#{tag}</span>
                {/each}
              </div>
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <p class="section-empty">{tt("emptyTrendsDesc")}</p>
    {/if}
  </div>

  <!-- ═══ Zone 2: Works List ═══ -->
  <div class="section">
    <div class="section-header">
      <h2 class="section-title">{tt("workList")}</h2>
      <div class="section-right">
        <div class="pill-group">
          <button class="pill" class:active={filter === "all"} onclick={() => filter = "all"}>
            {tt("filterAll")}
          </button>
          <button class="pill" class:active={filter === "draft"} onclick={() => filter = "draft"}>
            {tt("filterDraft")}
          </button>
          <button class="pill" class:active={filter === "published"} onclick={() => filter = "published"}>
            {tt("filterPublished")}
          </button>
        </div>
        <button class="new-work-btn" onclick={onCreateNew}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {tt("newWork")}
        </button>
      </div>
    </div>

  <!-- Loading -->
  {#if loading}
    <div class="loading-state">
      <div class="loader"></div>
      <p>{tt("loading")}</p>
    </div>
  <!-- API error -->
  {:else if loadError}
    <div class="empty-state error-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#e53e3e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.7">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <p style="color: #e53e3e;">服务器连接失败，请检查后端是否运行</p>
      <button class="cta-btn" onclick={() => loadWorks()}>重试</button>
    </div>
  <!-- Empty state -->
  {:else if filteredWorks.length === 0 && works.length === 0}
    <div class="empty-state">
      <div class="empty-icon">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>
      <h3>{tt("createFirstWork")}</h3>
      <p>{tt("noWorks")}</p>
      <button class="cta-btn" onclick={onCreateNew}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        {tt("newWork")}
      </button>
    </div>
  {:else if filteredWorks.length === 0}
    <div class="empty-state">
      <div class="empty-icon">
        {#if filter === "draft"}
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        {:else}
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        {/if}
      </div>
      <h3>{filter === "draft" ? tt("noDrafts") : tt("noPublished")}</h3>
      <p>{filter === "draft" ? tt("noDraftsDesc") : tt("noPublishedDesc")}</p>
    </div>
  {:else}
    <!-- Gallery grid -->
    <div class="gallery-grid">
      {#each filteredWorks as w}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <div class="work-card" onclick={() => onOpenStudio(w.id)}>
          <!-- Cover -->
          <div class="card-cover">
            {#if w.coverImage && w.coverIsVideo}
              <video src={w.coverImage} muted preload="metadata" style="width:100%;height:100%;object-fit:cover;"></video>
            {:else if w.coverImage}
              <img src={w.coverImage} alt={w.title} />
            {:else}
              <div class="cover-gradient" style="background: {cardGradient(w.id)};">
                <span class="cover-icon">
                  {#if w.type === "short-video"}
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                  {:else}
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                  {/if}
                </span>
              </div>
            {/if}
            <span class="status-badge {statusClass(w.status)}">{statusLabel(w.status)}</span>
          </div>

          <!-- Info -->
          <div class="card-body">
            <div class="card-title-row">
              <h3 class="card-title">{w.title}</h3>
              <button class="delete-btn" onclick={(e) => handleDelete(e, w.id, w.title)} title={tt("delete")}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </div>
            <div class="card-tags">
              {#if w.templateId || w.digitalHumanId}
                <span class="card-tag mode-auto" title="已配置模板/数字人，AI 全自动执行流水线，无需逐步确认">⚡ 全自动</span>
              {:else}
                <span class="card-tag mode-manual" title="深度介入模式：在制作对话中逐步确认每个环节；配置模板/数字人后可切换全自动">🖐 深度介入</span>
              {/if}
              <span class="card-tag">{typeLabel(w.type)}</span>
              {#if w.contentCategory}
                <span class="card-tag">{categoryLabel(w.contentCategory)}</span>
              {/if}
              {#each w.platforms as p}
                <span class="card-tag">{platformLabel(p)}</span>
              {/each}
            </div>
            {#if queuePositionOf(w.id) || (w.pipeline && w.pipeline.length > 0 && w.pipeline.some((s) => s.status !== "done" && s.status !== "skipped"))}
              {@const prog = progressLabel(w)}
              <div class="pipeline-progress" title="流水线实时进度">
                <div class="pp-bar">
                  {#each w.pipeline ?? [] as s}
                    <span
                      class="pp-seg"
                      class:pp-done={s.status === "done" || s.status === "skipped"}
                      class:pp-active={!prog.stalled && !prog.queued && (s.status === "active" || s.status === "evaluating")}
                      class:pp-blocked={s.status === "eval_blocked"}
                      title={`${s.name}: ${s.status}`}
                    ></span>
                  {/each}
                </div>
                <span class="pp-label" class:pp-stalled={prog.stalled}>{prog.text}</span>
              </div>
            {/if}
            {#if isPublished(w.status)}
              {@const stats = getWorkStats(w.id)}
              <div class="card-stats">
                <span class="monitor-dot"></span>
                <span class="stat-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                  {formatNum(stats.likes)}
                </span>
                <span class="stat-item">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  {formatNum(stats.comments)}
                </span>
                <span class="stat-item stat-followers">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                  +{formatNum(stats.newFollowers)}
                </span>
              </div>
            {/if}
            <span class="card-date">{new Date(w.updatedAt).toLocaleDateString()}</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
  </div>
</div>

{#if selectedTrend}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="trend-overlay" onclick={(e) => { if ((e.target as HTMLElement).classList.contains('trend-overlay')) selectedTrend = null; }}>
    <div class="trend-modal">
      <div class="trend-modal-head">
        <div class="trend-modal-meta">
          {#if selectedTrend.category}
            <span class="tm-category">{selectedTrend.category}</span>
          {/if}
          {#if selectedTrend.opportunity}
            <span class="tm-badge">{selectedTrend.opportunity}</span>
          {/if}
          {#if selectedTrend.competition}
            <span class="tm-badge tm-comp">{lang === "zh" ? "竞争" : "Competition: "}{selectedTrend.competition}</span>
          {/if}
        </div>
        <button class="trend-modal-close" onclick={() => selectedTrend = null}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <h2 class="trend-modal-title">{selectedTrend.title}</h2>
      <div class="tm-heat">{heatDots(selectedTrend.heat)}</div>

      {#if selectedTrend.description}
        <p class="tm-desc">{selectedTrend.description}</p>
      {/if}

      {#if selectedTrend.contentAngles && selectedTrend.contentAngles.length > 0}
        <div class="tm-section">
          <span class="tm-section-label">{lang === "zh" ? "切入角度" : "Content Angles"}</span>
          {#each selectedTrend.contentAngles as angle}
            <div class="tm-angle">{angle}</div>
          {/each}
        </div>
      {/if}

      {#if selectedTrend.exampleHook}
        <div class="tm-section">
          <span class="tm-section-label">{tt("viralHook")}</span>
          <p class="tm-hook">&ldquo;{selectedTrend.exampleHook}&rdquo;</p>
        </div>
      {/if}

      {#if selectedTrend.tags && selectedTrend.tags.length > 0}
        <div class="tm-tags">
          {#each selectedTrend.tags as tag}
            <span class="tm-tag">#{tag}</span>
          {/each}
        </div>
      {/if}

      <button class="tm-create-btn" onclick={() => { dispatchCreate(selectedTrend!); selectedTrend = null; }}>
        {tt("createFromTrend")}
      </button>
    </div>
  </div>
{/if}

{#if showResearchModal}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div class="research-overlay" onclick={(e) => { if ((e.target as HTMLElement).classList.contains('research-overlay')) showResearchModal = false; }}>
    <div class="research-modal">
      <div class="rm-head">
        <h3 class="rm-title">{lang === "zh" ? "想新思路" : "New Ideas"}</h3>
        <button class="rm-close" onclick={() => showResearchModal = false}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="rm-body">
        <label class="rm-field">
          <span class="rm-label">{tt("researchInterval")}</span>
          <select bind:value={configInterval}>
            <option value="15m">{tt("minutes15")}</option>
            <option value="30m">{tt("minutes30")}</option>
            <option value="1h">{tt("hour1")}</option>
            <option value="2h">{tt("hours2")}</option>
            <option value="4h">{tt("hours4")}</option>
            <option value="8h">{tt("hours8")}</option>
          </select>
        </label>

        <label class="rm-field">
          <span class="rm-label">{tt("aiModel")}</span>
          <select bind:value={configModel}>
            <option value="haiku">{tt("claudeHaikuFast")}</option>
            <option value="sonnet">{tt("claudeSonnetBalanced")}</option>
            <option value="opus">{tt("claudeOpusCapable")}</option>
          </select>
        </label>

        <div class="rm-switch-field">
          <span class="rm-label">{tt("autoResearchLabel")}</span>
          <button class="apple-switch" class:on={autoResearchOn} onclick={toggleAutoResearch} role="switch" aria-checked={autoResearchOn}>
            <span class="apple-switch-thumb"></span>
          </button>
        </div>
      </div>

      <button class="rm-start-btn" onclick={startResearchFromModal}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        {tt("startResearch")}
      </button>
    </div>
  </div>
{/if}

<style>
  .works-page {
    max-width: 1200px;
    margin: 0 auto;
  }

  /* ── Zone 1: Hero (Greeting + Viral Ideas) ────────── */
  .hero-zone {
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .hero-text {
    font-family: var(--font-display);
    font-size: var(--size-xl);
    font-weight: 600;
    color: var(--text-secondary);
    line-height: 1.4;
    letter-spacing: -0.02em;
    margin: 1.5rem 0 1.25rem;
  }

  .hero-highlight {
    color: var(--spark-red);
    font-weight: 700;
  }

  /* ── Shared section styles (Zone 2 & 3) ──────────── */
  .section {
    margin-top: 1.5rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.85rem;
  }

  .section-title-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .section-title {
    font-family: var(--font-display);
    font-size: var(--size-base);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
    white-space: nowrap;
  }

  .section-right {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  /* Pill filter group */
  .pill-group {
    display: flex;
    gap: 0.2rem;
  }

  .pill {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    padding: 0.25rem 0.65rem;
    border: none;
    border-radius: 99px;
    background: none;
    color: var(--text-dim);
    font-family: var(--font-body);
    font-size: var(--size-xs);
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .pill:hover {
    color: var(--text-secondary);
    background: var(--accent-soft);
  }

  .pill.active {
    color: var(--text);
    background: var(--selected, rgba(254, 44, 85, 0.08));
    font-weight: 600;
  }

  .pill-num {
    font-size: 0.58rem;
    opacity: 0.5;
  }

  .pill.active .pill-num {
    opacity: 0.7;
  }

  .apple-switch {
    position: relative;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    border: none;
    background: var(--text-dim);
    cursor: pointer;
    transition: background 0.25s ease;
    flex-shrink: 0;
    padding: 0;
  }

  .apple-switch.on {
    background: var(--spark-red, #FE2C55);
  }

  .apple-switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .apple-switch.on .apple-switch-thumb {
    transform: translateX(16px);
  }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .section-empty {
    font-size: var(--size-sm);
    color: var(--text-dim);
    padding: 1rem 0;
  }

  .new-work-btn {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: var(--text);
    color: var(--bg);
    border: none;
    padding: 0.35rem 0.8rem;
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-xs);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
    white-space: nowrap;
  }

  .new-work-btn:hover { opacity: 0.8; }

  /* ── Loading ──────────────────────────────────────────── */
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 5rem 0;
    color: var(--text-dim);
  }

  .loader {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Empty State ──────────────────────────────────────── */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    padding: 5rem 1rem;
    text-align: center;
  }

  .empty-icon {
    color: var(--text-dim);
    opacity: 0.4;
    margin-bottom: 0.5rem;
  }

  .empty-state h3 {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-secondary);
  }

  .empty-state p {
    font-size: 0.88rem;
    color: var(--text-muted);
    max-width: 320px;
  }

  .empty-filter-text {
    font-size: 0.88rem;
    color: var(--text-dim);
  }

  .cta-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--text);
    color: var(--bg);
    border: none;
    padding: 0.55rem 1.25rem;
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
    margin-top: 0.75rem;
  }

  .cta-btn:hover { opacity: 0.8; }

  /* ── Gallery Grid ─────────────────────────────────────── */
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 1.25rem 0.85rem;
  }

  @media (min-width: 900px) {
    .gallery-grid { grid-template-columns: repeat(5, 1fr); }
  }

  /* ── Work Card ────────────────────────────────────────── */
  .work-card {
    cursor: pointer;
    text-align: left;
    color: var(--text);
    font-family: inherit;
    padding: 0;
    background: none;
    border: none;
    transition: opacity 0.15s;
  }

  .work-card:hover {
    opacity: 0.85;
  }

  /* Cover — 9:16 portrait */
  .card-cover {
    aspect-ratio: 9 / 16;
    position: relative;
    overflow: hidden;
    border-radius: var(--card-radius);
    background: var(--bg-surface);
  }

  .card-cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: transform 0.3s ease;
  }

  .work-card:hover .card-cover img {
    transform: scale(1.03);
  }

  .cover-gradient {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .cover-icon {
    color: rgba(255, 255, 255, 0.25);
  }

  .status-badge {
    position: absolute;
    top: 0.5rem;
    left: 0.5rem;
    font-size: var(--size-xs);
    font-weight: 600;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .status-published { background: var(--success); color: #fff; }
  .status-failed { background: var(--error); color: #fff; }
  .status-draft { background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.7); }
  .status-in-progress { background: var(--state-running); color: #fff; }

  /* Body */
  .card-body {
    padding: 0.5rem 0.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .card-title-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.2rem;
  }

  .card-title {
    font-family: var(--font-display);
    font-size: var(--size-sm);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    flex: 1;
    min-width: 0;
  }

  .delete-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.15rem;
    border-radius: 3px;
    transition: all 0.12s;
    flex-shrink: 0;
    opacity: 0;
  }

  .work-card:hover .delete-btn { opacity: 1; }

  .delete-btn:hover {
    color: var(--error);
  }

  .card-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.15rem;
  }

  .card-tag {
    font-size: 10px;
    font-weight: 500;
    color: var(--text-muted);
    background: var(--bg-elevated);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    line-height: 1.4;
  }
  .card-tag.mode-auto {
    color: var(--accent);
    background: var(--accent-soft, rgba(254, 44, 85, 0.08));
    font-weight: 600;
  }
  .card-tag.mode-manual {
    color: var(--text-dim);
    border: 1px dashed var(--border);
    background: transparent;
  }
  .pipeline-progress { margin-top: 0.45rem; display: flex; align-items: center; gap: 0.5rem; }
  .pp-bar { flex: 1; display: flex; gap: 2px; height: 4px; }
  .pp-seg { flex: 1; border-radius: 2px; background: var(--bg-elevated); }
  .pp-seg.pp-done { background: var(--accent); }
  .pp-seg.pp-active { background: var(--accent); animation: pp-pulse 1.2s ease-in-out infinite; }
  .pp-seg.pp-blocked { background: var(--error, #ef4444); }
  @keyframes pp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .pp-label { font-size: 9px; color: var(--text-dim); white-space: nowrap; }
  .pp-label.pp-stalled { color: var(--warning, #f59e0b); font-weight: 600; }

  /* ── 任务队列面板 ────────────────────────────────── */
  .queue-panel {
    margin-top: 1rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    background: var(--bg-surface);
  }

  .queue-panel-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }

  .queue-count {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-dim);
    background: var(--bg-elevated);
    padding: 0.05rem 0.45rem;
    border-radius: 99px;
  }

  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .queue-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.3rem 0.35rem;
    border-radius: 4px;
    transition: background 0.12s;
  }

  .queue-row:hover {
    background: var(--accent-soft, rgba(254, 44, 85, 0.05));
  }

  .queue-status {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 600;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    white-space: nowrap;
  }

  .queue-status-running { background: var(--state-running, var(--accent)); color: #fff; }
  .queue-status-queued { background: var(--bg-elevated); color: var(--text-muted); }
  .queue-status-paused { background: var(--warning, #f59e0b); color: #fff; }

  .queue-title {
    flex: 1;
    min-width: 0;
    font-family: var(--font-display);
    font-size: var(--size-sm);
    font-weight: 500;
    color: var(--text);
    letter-spacing: -0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .queue-actions {
    display: flex;
    align-items: center;
    gap: 0.15rem;
    flex-shrink: 0;
  }

  .queue-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border: none;
    border-radius: 4px;
    background: none;
    color: var(--text-dim);
    font-size: 12px;
    cursor: pointer;
    transition: all 0.12s;
    padding: 0;
  }

  .queue-btn:hover:not(:disabled) {
    background: var(--bg-elevated);
    color: var(--text);
  }

  .queue-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .queue-btn-danger:hover:not(:disabled) {
    color: var(--error);
  }

  .card-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-top: 0.1rem;
  }

  .type-badge {
    font-size: var(--size-xs);
    font-weight: 500;
    color: var(--text-muted);
  }

  /* Published stats row */
  .card-stats {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-top: 0.2rem;
  }

  .monitor-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    flex-shrink: 0;
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
    50% { opacity: 0.6; box-shadow: 0 0 0 4px rgba(34, 197, 94, 0); }
  }

  .stat-item {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--size-xs);
    font-weight: 500;
    color: var(--text-muted);
  }

  .stat-item svg {
    opacity: 0.6;
  }

  .stat-followers {
    color: var(--success);
  }

  .stat-followers svg {
    opacity: 0.8;
  }

  .card-date {
    font-size: var(--size-xs);
    color: var(--text-dim);
    font-weight: 400;
  }

  /* ── Inspiration Cards ────────────────────────────── */

  .inspiration-scroll {
    display: flex;
    gap: 0.65rem;
    overflow-x: auto;
    padding-bottom: 0.35rem;
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar) transparent;
  }

  .inspiration-scroll::-webkit-scrollbar { height: 3px; }
  .inspiration-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 2px; }

  .inspiration-card {
    flex-shrink: 0;
    width: 200px;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    background: var(--bg-surface);
    cursor: pointer;
    transition: border-color 0.12s;
    text-align: left;
    font-family: var(--font-body);
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .inspiration-card:hover {
    border-color: var(--text-dim);
  }

  .insp-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.3rem;
  }

  .insp-emotion {
    font-size: 0.62rem;
    font-weight: 600;
    color: var(--spark-red, #FE2C55);
    background: rgba(254, 44, 85, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
  }

  .insp-category {
    font-size: var(--size-xs);
    font-weight: 500;
    color: var(--text-dim);
  }

  .insp-heat {
    font-size: 0.65rem;
    letter-spacing: -0.02em;
  }

  .insp-title {
    font-family: var(--font-display);
    font-size: var(--size-sm);
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.02em;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .insp-desc {
    font-size: var(--size-xs);
    color: var(--text-muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .insp-tags {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
    margin-top: 0.15rem;
  }

  .insp-tag {
    font-size: 0.65rem;
    color: var(--text-dim);
  }

  @media (max-width: 640px) {
    .section-header { flex-direction: column; align-items: flex-start; gap: 0.5rem; }
    .section-right { width: 100%; flex-wrap: wrap; }
  }

  /* ── Trend Detail Modal ────────────────────────────── */
  .trend-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    animation: fadeIn 0.12s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .trend-modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    width: 100%;
    max-width: 480px;
    max-height: 80vh;
    overflow-y: auto;
    padding: 1.5rem;
    box-shadow: var(--shadow-lg);
    animation: modalIn 0.15s ease;
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .trend-modal-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .trend-modal-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }

  .tm-category {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .tm-badge {
    font-size: var(--size-xs);
    font-weight: 500;
    color: var(--spark-red);
    padding: 0.1rem 0.4rem;
    border: 1px solid currentColor;
    border-radius: 3px;
    line-height: 1.3;
  }

  .tm-comp {
    color: var(--text-muted);
  }

  .trend-modal-close {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.15rem;
    display: flex;
    transition: color 0.12s;
    flex-shrink: 0;
  }

  .trend-modal-close:hover { color: var(--text); }

  .trend-modal-title {
    font-family: var(--font-display);
    font-size: var(--size-xl);
    font-weight: 700;
    color: var(--text);
    letter-spacing: -0.03em;
    line-height: 1.25;
    margin-bottom: 0.35rem;
  }

  .tm-heat {
    font-size: var(--size-sm);
    margin-bottom: 0.75rem;
  }

  .tm-desc {
    font-size: var(--size-sm);
    color: var(--text-secondary);
    line-height: 1.6;
    margin-bottom: 1rem;
  }

  .tm-section {
    margin-bottom: 0.85rem;
  }

  .tm-section-label {
    display: block;
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.35rem;
  }

  .tm-angle {
    font-size: var(--size-sm);
    color: var(--text-secondary);
    padding: 0.2rem 0;
    padding-left: 0.75rem;
    border-left: 2px solid var(--border);
    margin-bottom: 0.2rem;
  }

  .tm-hook {
    font-size: var(--size-sm);
    color: var(--text);
    font-style: italic;
    line-height: 1.5;
    padding: 0.5rem 0.75rem;
    border-left: 2px solid var(--spark-red);
    background: rgba(254, 44, 85, 0.04);
  }

  .tm-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    margin-bottom: 1.25rem;
  }

  .tm-tag {
    font-size: var(--size-xs);
    color: var(--text-dim);
  }

  .tm-create-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    padding: 0.55rem;
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

  .tm-create-btn:hover { opacity: 0.8; }

  /* ── Research Config Modal ─────────────────────────── */
  .research-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    animation: fadeIn 0.12s ease;
  }

  .research-modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    width: 100%;
    max-width: 360px;
    padding: 1.25rem;
    box-shadow: var(--shadow-lg);
    animation: modalIn 0.15s ease;
  }

  .rm-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1rem;
  }

  .rm-title {
    font-family: var(--font-display);
    font-size: var(--size-base);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .rm-close {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 0.15rem;
    display: flex;
    transition: color 0.12s;
  }

  .rm-close:hover { color: var(--text); }

  .rm-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .rm-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .rm-label {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rm-field select {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.4rem 2rem 0.4rem 0.6rem;
    font-size: var(--size-sm);
    font-family: var(--font-body);
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b6560' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.6rem center;
    background-size: 11px;
    cursor: pointer;
  }

  .rm-field select:focus {
    outline: none;
    border-color: var(--text-muted);
  }

  .rm-switch-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.15rem 0;
  }

  .rm-start-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.55rem;
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

  .rm-start-btn:hover { opacity: 0.8; }
</style>
