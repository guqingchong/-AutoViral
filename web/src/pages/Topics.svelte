<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTopics, convertTopicToWork, collectTrends, fetchConfig, updateConfig, type Topic } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";

  let topics = $state<Topic[]>([]);
  let loading = $state(true);
  let platform = $state<string>("");
  let lang = $state(getLanguage());
  let interests = $state("");
  let researchStatus: "idle" | "collecting" | "streaming" | "done" | "error" = $state("idle");
  let researchMessage = $state("");
  let lastCollectedCount = $state(0);
  let deleteConfirmId = $state<number | null>(null);
  // Batch automation state
  let selectedTopicIds = $state<Set<number>>(new Set());
  let showBatchModal = $state(false);
  let batchTemplateId = $state<string>("");
  let batchDigitalHumanId = $state<string>("");
  let batchType = $state<"short-video" | "image-text">("short-video");
  let templates = $state<any[]>([]);
  let avatars = $state<any[]>([]);
  let batchConverting = $state(false);
  let batchResult = $state<string>("");

  function tt(key: string): string { void lang; return t(key); }

  const platforms = [
    { value: "", label: tt("allPlatforms") || "All" },
    { value: "douyin", label: tt("douyinTab") },
    { value: "xiaohongshu", label: tt("xiaohongshuTab") },
    { value: "kuaishou", label: tt("kuaishouTab") || "快手" },
    { value: "bilibili", label: tt("bilibiliTab") || "B站" },
    { value: "zhihu", label: tt("zhihuTab") || "知乎" },
  ];

  // Pre-load config to show saved interests
  onMount(async () => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    try {
      const config = await fetchConfig();
      if (config.interests) {
        interests = Array.isArray(config.interests) ? config.interests.join(", ") : String(config.interests);
      }
    } catch {}
    await load();
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

  async function startAITrendResearch() {
    researchStatus = "collecting";
    const targetPlatform = platform || "";
    const platformLabel = targetPlatform
      ? (targetPlatform === "douyin" ? "抖音" : targetPlatform === "xiaohongshu" ? "小红书" : targetPlatform === "bilibili" ? "B站" : targetPlatform === "zhihu" ? "知乎" : targetPlatform === "kuaishou" ? "快手" : targetPlatform)
      : "全平台";
    researchMessage = tt("topicsCollecting").replace("{platform}", platformLabel);
    try {
      const interestArr = interests.split(",").map(s => s.trim()).filter(Boolean);
      await updateConfig({ interests: interestArr } as any);
      const res = await fetch("/api/trends/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: targetPlatform || undefined, interests: interestArr }),
      });
      const data = await res.json();
      if (!data.jobId) throw new Error("No jobId returned");
      pollTimer = setInterval(async () => {
        try {
          const statusRes = await fetch("/api/trends/collect/status/" + data.jobId);
          const statusData = await statusRes.json();
          if (statusData.status === "done") {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            lastCollectedCount = statusData.collected;
            await load();
            researchStatus = "done";
            researchMessage = tt("topicsCollected").replace("{count}", String(statusData.collected));
            setTimeout(() => { if (researchStatus === "done") researchStatus = "idle"; }, 5000);
          } else if (statusData.status === "error") {
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            researchStatus = "error";
            researchMessage = statusData.error || tt("topicsResearchFailed");
            setTimeout(() => { if (researchStatus === "error") researchStatus = "idle"; }, 8000);
          }
        } catch {}
      }, 5000);
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
  }

  async function convert(topic: Topic) {
    try {
      const res = await convertTopicToWork(topic.id, { platforms: [topic.platform || "douyin"], type: "short-video" });
      topic.status = "converted";
    } catch {
      alert(t("error") || "转换失败");
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
    // Load templates and avatars for selection
    try {
      const tplRes = await fetch("/api/templates?status=approved");
      if (tplRes.ok) {
        const data = await tplRes.json();
        templates = data.templates ?? [];
      }
    } catch {}
    try {
      const avRes = await fetch("/api/digital-humans/avatars");
      if (avRes.ok) {
        const data = await avRes.json();
        avatars = data.avatars ?? [];
      }
    } catch {}
  }

  async function batchConvert() {
    if (selectedTopicIds.size === 0) return;
    batchConverting = true;
    batchResult = "正在批量创建作品并自动启动流水线...";
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
        }),
      });
      const data = await res.json();
      const success = data.results?.filter((r: any) => r.workId).length ?? 0;
      const failed = data.results?.filter((r: any) => r.error).length ?? 0;
      batchResult = `完成！成功创建 ${success} 个作品${failed > 0 ? `，失败 ${failed} 个` : ""}。流水线已自动启动。`;
      // Mark converted topics
      for (const r of data.results ?? []) {
        if (r.workId) {
          const topic = topics.find(t => t.id === r.topicId);
          if (topic) topic.status = "converted";
        }
      }
      selectedTopicIds = new Set();
      topics = [...topics];
    } catch (err) {
      batchResult = "批量转换失败：" + (err instanceof Error ? err.message : String(err));
    } finally {
      batchConverting = false;
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
          <button class="btn-manual-add" disabled={loading}>
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
    {/if}
  </div>

  <!-- Results Summary -->
  {#if !loading && topics.length > 0}
    <div class="results-summary">
      <span class="summary-count">{topics.length} topics</span>
      <span class="summary-divider">·</span>
      <button class="summary-filter" class:active={platform === ""} onclick={() => { platform = ""; load(); }}>All</button>
      <button class="summary-filter" class:active={platform === "douyin"} onclick={() => { platform = "douyin"; load(); }}>{tt("douyinTab")}</button>
      <button class="summary-filter" class:active={platform === "xiaohongshu"} onclick={() => { platform = "xiaohongshu"; load(); }}>{tt("xiaohongshuTab")}</button>
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

{#if showBatchModal}
  <div class="batch-overlay" onclick={(e) => { if (e.target.classList.contains("batch-overlay")) showBatchModal = false; }}>
    <div class="batch-modal">
      <div class="batch-modal-header">
        <h2>批量自动制作</h2>
        <button class="batch-close" onclick={() => showBatchModal = false}>✕</button>
      </div>
      <div class="batch-modal-body">
        {#if batchResult}
          <p class="batch-result">{batchResult}</p>
          {#if !batchConverting && batchResult.includes("完成")}
            <button class="btn-primary" onclick={() => showBatchModal = false}>完成</button>
          {/if}
        {:else}
          <div class="batch-field">
            <label>内容类型</label>
            <select bind:value={batchType}>
              <option value="short-video">短视频</option>
              <option value="image-text">图文</option>
            </select>
          </div>
          <div class="batch-field">
            <label>使用模板（可选，选择后将自动执行流水线）</label>
            <select bind:value={batchTemplateId}>
              <option value="">不使用模板（手动确认每个环节）</option>
              {#each templates as tpl}
                <option value={tpl.id}>{tpl.name}</option>
              {/each}
            </select>
            {#if templates.length === 0}
              <p class="batch-hint">暂无已批准模板，可前往模板库生成并批准模板</p>
            {/if}
          </div>
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
          <div class="batch-info">
            <p>将选中的 <strong>{selectedTopicIds.size}</strong> 个选题批量转为作品。</p>
            {#if batchTemplateId || batchDigitalHumanId}
              <p class="batch-auto-notice">已选择模板/数字人，系统将自动执行完整流水线，无需用户逐步确认。制作完成后可在作品页审核发布。</p>
            {:else}
              <p class="batch-hint">选择模板或数字人后可启用全自动流水线模式</p>
            {/if}
          </div>
          <button class="btn-batch-start" disabled={batchConverting} onclick={batchConvert}>
            {batchConverting ? "创建中..." : `批量创建 ${selectedTopicIds.size} 个作品`}
          </button>
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
  .batch-modal-body { padding: 1.25rem; display: flex; flex-direction: column; gap: 1rem; }
  .batch-field { display: flex; flex-direction: column; gap: 0.35rem; }
  .batch-field label { font-size: 0.8rem; font-weight: 600; color: var(--text-secondary); }
  .batch-field select {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
    font-size: 0.82rem;
  }
  .batch-hint { font-size: 0.72rem; color: var(--text-dim); margin: 0; }
  .batch-info { padding: 0.6rem; background: var(--bg-inset); border-radius: 4px; }
  .batch-info p { font-size: 0.8rem; margin: 0 0 0.35rem; color: var(--text-secondary); }
  .batch-auto-notice { font-size: 0.78rem; color: var(--success); margin-top: 0.5rem; }
  .batch-result { font-size: 0.85rem; color: var(--text); text-align: center; padding: 1rem 0; }
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
