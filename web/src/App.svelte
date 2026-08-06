<script lang="ts">
  import { onMount } from "svelte";
  import Explore from "./pages/Explore.svelte";
  import Analytics from "./pages/Analytics.svelte";
  import Comments from "./pages/Comments.svelte";
  import Evolution from "./pages/Evolution.svelte";
  import Admin from "./pages/Admin.svelte";
  import Studio from "./pages/Studio.svelte";
  import Works from "./pages/Works.svelte";
  import Topics from "./pages/Topics.svelte";
  import DigitalHumans from "./pages/DigitalHumans.svelte";
  import Assets from "./pages/Assets.svelte";
  import Templates from "./pages/Templates.svelte";
  import RenderJobs from "./pages/RenderJobs.svelte";
  import PublishCenter from "./pages/PublishCenter.svelte";
  import ArticleEditor from "./pages/ArticleEditor.svelte";
  import Calendar from "./pages/Calendar.svelte";
  import NewWorkModal from "./components/NewWorkModal.svelte";
  import { fetchConfig, updateConfig, fetchWorks, createWorkApi, type WorkSummary, type ContentCategory } from "./lib/api";
  import { t, getLanguage, setLanguage, subscribe } from "./lib/i18n";
  import { activeTab, type Tab } from "./lib/navigation.js";

  let theme: "light" | "dark" = $state("dark");
  let lang = $state(getLanguage());
  function tt(key: string): string { void lang; return t(key); }

  // App state
  let showStudio = $state(false);
  let currentWorkId: string | null = $state(null);
  let showSettings = $state(false);
  let showNewWorkModal = $state(false);

  // Config state
  let interval: string = $state("1h");
  let model: string = $state("sonnet");
  let autoRun: boolean = $state(false);
  /** 自动调研频率与执行时间（映射为 cron 存 research.schedule） */
  let researchFreq: string = $state("daily");
  let researchTime: string = $state("09:00");

  /** 频率+时间 → cron 表达式（分 时 …） */
  function buildResearchCron(): string {
    const h = Math.max(0, Math.min(23, parseInt(researchTime.split(":")[0] || "9", 10)));
    switch (researchFreq) {
      case "12h": return `0 ${h},${(h + 12) % 24} * * *`;
      case "2d": return `0 ${h} */2 * * *`;
      case "3d": return `0 ${h} */3 * * *`;
      case "weekly": return `0 ${h} * * 1`;
      default: return `0 ${h} * * *`; // daily
    }
  }

  /** cron 表达式 → 频率+时间（回显用，尽力解析，失败回退每天 9 点） */
  function parseResearchCron(cron: string): void {
    const m = cron.match(/^0 (\d{1,2})(?:,(\d{1,2}))? (\*\/\d|\*) \* (\*|\d)$/);
    if (!m) { researchFreq = "daily"; researchTime = "09:00"; return; }
    const hour = m[1].padStart(2, "0");
    researchTime = `${hour}:00`;
    if (m[2]) researchFreq = "12h";
    else if (m[3] === "*/2") researchFreq = "2d";
    else if (m[3] === "*/3") researchFreq = "3d";
    else if (m[4] !== "*") researchFreq = "weekly";
    else researchFreq = "daily";
  }
  let saving: boolean = $state(false);
  let settingsMessage: string = $state("");
  let pexelsApiKey: string = $state("");
  let pixabayApiKey: string = $state("");
  let unsplashAccessKey: string = $state("");
  let jimengAccessKey: string = $state("");
  let jimengSecretKey: string = $state("");
  let minimaxKey: string = $state("");
  let zhihuDataSecret: string = $state("");
  let heygemBaseUrl: string = $state("");
  let heygemApiToken: string = $state("");
  let heygemGpuHourlyRateYuan: number = $state(1.78);
  let heygemTunnelHost: string = $state("");
  let heygemTunnelPort: number = $state(28830);
  let showHeygemToken: boolean = $state(false);
  let showPexelsKey: boolean = $state(false);
  let showPixabayKey: boolean = $state(false);
  let showUnsplashKey: boolean = $state(false);
  let showMinimaxKey: boolean = $state(false);
  let showZhihuSecret: boolean = $state(false);

  function openStudio(workId: string) {
    initialPrompt = "";
    currentWorkId = workId;
    showStudio = true;
  }

  function closeStudio() {
    showStudio = false;
    currentWorkId = null;
  }

  function deriveTitle(data: { title: string; topicHint: string }): string {
    if (data.title) return data.title;
    if (data.topicHint) {
      // Use first line, truncated
      const first = data.topicHint.split("\n")[0].replace(/^[#\-*·•\s]+/, "").trim();
      return first.length > 30 ? first.slice(0, 30) + "…" : first;
    }
    return lang === "zh" ? "未命名作品" : "Untitled";
  }

  let initialPrompt = $state("");

  function buildInitialPrompt(data: { title: string; type: string; contentCategory: string; videoSource: string; videoSearchQuery: string; topicHint: string }): string {
    const categoryMap: Record<string, string> = {
      anxiety: "危机感/焦虑",
      conflict: "观点分歧/愤怒",
      comedy: "搞笑抽象",
      envy: "向往拥有/羡慕",
      other: "其他（用户自定义）",
    };
    const typeMap: Record<string, string> = {
      "short-video": "短视频",
      "image-text": "图文",
    };

    const hasInfo = !!(data.topicHint || data.title);
    const parts: string[] = [];

    if (hasInfo) {
      parts.push(`开始创作。`);
      parts.push(`内容形式：${typeMap[data.type] ?? data.type}`);
      if (data.contentCategory !== "other") {
        parts.push(`情绪品类：${categoryMap[data.contentCategory] ?? data.contentCategory}`);
      }
      if (data.title) parts.push(`标题：${data.title}`);
      if (data.topicHint) parts.push(`创作方向：${data.topicHint}`);
      if (data.videoSource === "search" && data.videoSearchQuery) parts.push(`视频素材搜索：${data.videoSearchQuery}`);
      else if (data.videoSource === "ai-generate") parts.push(`视频素材：AI 生成`);
      else if (data.videoSource === "upload") parts.push(`视频素材：用户上传`);
      parts.push(`请从话题调研开始执行流水线。`);
    } else {
      // Insufficient info — let agent ask questions first
      parts.push(`用户创建了一个新的${typeMap[data.type] ?? data.type}作品，但还没有指定具体创作方向。`);
      if (data.contentCategory && data.contentCategory !== "other") {
        parts.push(`情绪品类：${categoryMap[data.contentCategory] ?? data.contentCategory}`);
      }
      parts.push(`请先了解用户想做什么内容，再开始调研。`);
    }
    return parts.join("\n");
  }

  async function handleCreateWork(data: { title: string; type: string; contentCategory: string; videoSource: string; videoSearchQuery: string; topicHint: string }) {
    showNewWorkModal = false;
    prefillTitle = "";
    prefillTopicHint = "";
    try {
      const newWork = await createWorkApi({
        title: deriveTitle(data),
        type: data.type as any,
        contentCategory: (data.contentCategory || "other") as ContentCategory,
        videoSource: data.videoSource || undefined,
        videoSearchQuery: data.videoSearchQuery || undefined,
        platforms: ["douyin", "xiaohongshu"],
        topicHint: data.topicHint || undefined,
      });
      initialPrompt = buildInitialPrompt(data);
      currentWorkId = newWork.id;
      showStudio = true;
    } catch {
      // creation failed
    }
  }

  let prefillTitle = $state("");
  let prefillTopicHint = $state("");

  function handleCreateFromTrend(title: string, topicHint: string) {
    prefillTitle = title;
    prefillTopicHint = topicHint;
    showNewWorkModal = true;
  }

  async function handleSaveSettings() {
    saving = true;
    settingsMessage = "";
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interval, model, autoRun,
          researchEnabled: autoRun,
          researchCron: buildResearchCron(),
          pexelsApiKey, pixabayApiKey, unsplashAccessKey,
          jimengAccessKey, jimengSecretKey,
          minimaxKey,
          zhihuDataSecret,
          heygemBaseUrl, heygemApiToken, heygemGpuHourlyRateYuan,
          heygemTunnelHost, heygemTunnelPort,
        }),
      });
      // 检查 HTTP 状态：此前 500 也显示"已保存"，掩盖了保存失败
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 回读校验：确认 key 真正落盘（与 SettingsPanel 一致的防呆）
      const verify = await (await fetch("/api/config")).json();
      if (pexelsApiKey.trim() !== (verify.pexelsApiKey ?? "")) {
        throw new Error("Pexels Key 未能写入，请重试");
      }
      if (minimaxKey.trim() !== (verify.minimaxKey ?? "")) {
        throw new Error("MiniMax Key 未能写入，请重试");
      }
      settingsMessage = tt("settingsSaved");
      setTimeout(() => { settingsMessage = ""; }, 3000);
    } catch (err) {
      settingsMessage = tt("settingsSaveFailed") + (err instanceof Error ? ` (${err.message})` : "");
      setTimeout(() => { settingsMessage = ""; }, 6000);
    } finally {
      saving = false;
    }
  }


  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("se-theme", theme);
  }

  function toggleLanguage() {
    const next = lang === "en" ? "zh" : "en";
    setLanguage(next);
  }

  /** 从服务器加载设置字段（onMount 与每次打开设置弹窗时调用） */
  async function loadSettings() {
    try {
      const c = await fetchConfig();
      interval = c.interval;
      model = c.model;
      autoRun = c.autoRun;
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        pexelsApiKey = data.pexelsApiKey ?? "";
        pixabayApiKey = data.pixabayApiKey ?? "";
        unsplashAccessKey = data.unsplashAccessKey ?? "";
        jimengAccessKey = data.jimengAccessKey ?? "";
        jimengSecretKey = data.jimengSecretKey ?? "";
        minimaxKey = data.minimaxKey ?? "";
        zhihuDataSecret = data.zhihuDataSecret ?? "";
        autoRun = data.researchEnabled ?? false;
        if (data.researchCron) parseResearchCron(data.researchCron);
        heygemBaseUrl = data.heygemBaseUrl ?? "";
        heygemApiToken = data.heygemApiToken ?? "";
        heygemGpuHourlyRateYuan = data.heygemGpuHourlyRateYuan ?? 1.78;
        heygemTunnelHost = data.heygemTunnelHost ?? "";
        heygemTunnelPort = data.heygemTunnelPort ?? 28830;
      }
    } catch {}
  }

  onMount(async () => {
    const current = document.documentElement.getAttribute("data-theme") as "light" | "dark" | null;
    theme = current ?? "dark";
    const unsub = subscribe(() => { lang = getLanguage(); });
    await loadSettings();
    return () => {
      unsub();
    };
  });

  // 每次打开设置弹窗时重新拉取最新配置——防止"页面停留时的旧空值
  // 覆盖别处刚保存的新 key"（2026-07-21 Pexels key 丢失根因之一）
  $effect(() => {
    if (showSettings) loadSettings();
  });

  const navItems = [
    { tab: "works" as Tab, labelKey: "works" },
    { tab: "topics" as Tab, labelKey: "topics" },
    { tab: "digital-humans" as Tab, labelKey: "digitalHumans" },
    { tab: "assets" as Tab, labelKey: "assetLibrary" },
    { tab: "templates" as Tab, labelKey: "templates" },
    { tab: "jobs" as Tab, labelKey: "renderJobs" },
    { tab: "publish" as Tab, labelKey: "publish" },
    { tab: "articles" as Tab, labelKey: "navArticles" },
    { tab: "calendar" as Tab, labelKey: "navCalendar" },
    { tab: "explore" as Tab, labelKey: "explore" },
    { tab: "analytics" as Tab, labelKey: "analytics" },
    { tab: "comments" as Tab, labelKey: "navComments" },
    { tab: "evolution" as Tab, labelKey: "navEvolution" },
    { tab: "admin" as Tab, labelKey: "navAdmin" },
  ];
</script>

<div class="shell" data-lang={lang}>
  <header class="topbar">
    <div class="topbar-left">
      <a class="logo-mark" href="#" onclick={(e) => { e.preventDefault(); $activeTab = "works"; showStudio = false; currentWorkId = null; }}>
        <img class="logo-img" src="/logo.svg" alt="AutoViral" />
        <span class="logo-wordmark">AutoViral</span>
      </a>
      <nav class="nav" role="tablist">
        {#each navItems as item}
          <button
            class="nav-link"
            class:active={$activeTab === item.tab && !showStudio}
            role="tab"
            aria-selected={$activeTab === item.tab && !showStudio}
            onclick={() => { $activeTab = item.tab; showStudio = false; currentWorkId = null; }}
          >
            {tt(item.labelKey)}
          </button>
        {/each}
      </nav>
    </div>
    <button
      class="topbar-action"
      aria-label="Settings"
      onclick={() => { showSettings = !showSettings; }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </header>

  <main class="main" class:main-studio={showStudio && currentWorkId}>
    {#if showStudio && currentWorkId}
      <Studio workId={currentWorkId} onBack={closeStudio} {initialPrompt} />
    {:else if $activeTab === "explore"}
      <Explore />
    {:else if $activeTab === "topics"}
      <Topics />
    {:else if $activeTab === "analytics"}
      <Analytics />
    {:else if $activeTab === "comments"}
      <Comments />
    {:else if $activeTab === "evolution"}
      <Evolution />
    {:else if $activeTab === "admin"}
      <Admin />
    {:else if $activeTab === "digital-humans"}
      <DigitalHumans />
    {:else if $activeTab === "assets"}
      <Assets onOpenSettings={() => { showSettings = true; }} />
    {:else if $activeTab === "templates"}
      <Templates />
    {:else if $activeTab === "jobs"}
      <RenderJobs />
    {:else if $activeTab === "publish"}
      <PublishCenter />
    {:else if $activeTab === "articles"}
      <ArticleEditor />
    {:else if $activeTab === "calendar"}
      <Calendar />
    {:else if $activeTab === "works"}
      <Works
        onOpenStudio={openStudio}
        onCreateNew={() => showNewWorkModal = true}
        onCreateFromTrend={handleCreateFromTrend}
        onGoToInsights={() => { $activeTab = "explore"; }}
      />
    {/if}
  </main>

  {#if showSettings}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="overlay" onclick={() => showSettings = false}></div>
    <aside class="drawer">
      <div class="drawer-head">
        <h2>{tt("settingsTitle")}</h2>
        <button class="drawer-close" onclick={() => showSettings = false}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>

      <div class="drawer-body">
        <div class="field-group">
          <span class="field-label-upper">{tt("languageSetting")}</span>
          <div class="lang-row">
            <span class="lang-opt" class:active={lang === "en"}>EN</span>
            <button class="switch" class:on={lang === "zh"} onclick={toggleLanguage}>
              <span class="switch-thumb"></span>
            </button>
            <span class="lang-opt" class:active={lang === "zh"}>中文</span>
          </div>
        </div>

        <div class="field-group">
          <span class="field-label-upper">{tt("themeSetting")}</span>
          <button class="field-btn" onclick={toggleTheme}>
            {#if theme === "dark"}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              {tt("darkTheme")}
            {:else}
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              {tt("lightTheme")}
            {/if}
          </button>
        </div>

        <div class="field-group">
          <span class="field-label-upper">{tt("researchConfig")}</span>
          <div class="stack">
            <label class="field-row">
              <span class="field-label-sm">调研频率</span>
              <select bind:value={researchFreq}>
                <option value="12h">每 12 小时</option>
                <option value="daily">每天</option>
                <option value="2d">每两天</option>
                <option value="3d">每 3 天</option>
                <option value="weekly">每周</option>
              </select>
            </label>
            <label class="field-row">
              <span class="field-label-sm">执行时间</span>
              <select bind:value={researchTime}>
                {#each Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0") + ":00") as t}
                  <option value={t}>{t}</option>
                {/each}
              </select>
            </label>
            <label class="field-row">
              <span class="field-label-sm">{tt("aiModel")}</span>
              <select bind:value={model}>
                <option value="haiku">{tt("claudeHaikuFast")}</option>
                <option value="sonnet">{tt("claudeSonnetBalanced")}</option>
                <option value="opus">{tt("claudeOpusCapable")}</option>
              </select>
            </label>
            <div class="field-row">
              <span class="field-label-sm">{tt("autoResearch")}</span>
              <button class="switch" class:on={autoRun} onclick={() => autoRun = !autoRun} role="switch" aria-checked={autoRun}>
                <span class="switch-thumb"></span>
              </button>
            </div>
            <p class="hint-sm">开启后按上方频率自动执行全平台选题调研；调研领域沿用选题中心保存的关注领域（未设置时自动沿用上一次的领域）。</p>
          </div>
        </div>

        <div class="field-group">
          <span class="field-label-upper">素材库 API Key</span>
          <div class="stack">
            <label class="field-row">
              <span class="field-label-sm">Pexels API Key</span>
              <div class="key-input-row">
                <input type={showPexelsKey ? "text" : "password"} bind:value={pexelsApiKey} placeholder="可选" class="key-input" />
                <button class="key-toggle" onclick={() => showPexelsKey = !showPexelsKey}>{showPexelsKey ? "🙈" : "👁"}</button>
              </div>
            </label>
            <label class="field-row">
              <span class="field-label-sm">Pixabay API Key</span>
              <div class="key-input-row">
                <input type={showPixabayKey ? "text" : "password"} bind:value={pixabayApiKey} placeholder="可选" class="key-input" />
                <button class="key-toggle" onclick={() => showPixabayKey = !showPixabayKey}>{showPixabayKey ? "🙈" : "👁"}</button>
              </div>
            </label>
            <label class="field-row">
              <span class="field-label-sm">Unsplash Access Key</span>
              <div class="key-input-row">
                <input type={showUnsplashKey ? "text" : "password"} bind:value={unsplashAccessKey} placeholder="可选" class="key-input" />
                <button class="key-toggle" onclick={() => showUnsplashKey = !showUnsplashKey}>{showUnsplashKey ? "🙈" : "👁"}</button>
              </div>
            </label>
            <label class="field-row">
              <span class="field-label-sm">即梦 AccessKey（AI生图）</span>
              <input type="text" bind:value={jimengAccessKey} placeholder="火山引擎 AccessKey" class="key-input" />
            </label>
            <label class="field-row">
              <span class="field-label-sm">即梦 SecretKey（AI生图）</span>
              <input type="text" bind:value={jimengSecretKey} placeholder="火山引擎 SecretKey" class="key-input" />
            </label>
            <p class="hint-sm">Pexels/Pixabay/Unsplash 用于素材搜索（优先走 Pexels）；即梦用于 AI 生图/生视频。</p>
          </div>
        </div>

        <div class="field-group">
          <span class="field-label-upper">MiniMax（配音 / 声音克隆 / 音乐）</span>
          <div class="stack">
            <label class="field-row">
              <span class="field-label-sm">MiniMax API Key</span>
              <div class="key-input-row">
                <input type={showMinimaxKey ? "text" : "password"} bind:value={minimaxKey} placeholder="minimax.chat 平台 API Key" class="key-input" />
                <button class="key-toggle" onclick={() => showMinimaxKey = !showMinimaxKey}>{showMinimaxKey ? "🙈" : "👁"}</button>
              </div>
            </label>
            <p class="hint-sm">用于 AI 配音、真人声音克隆和 BGM 生成。未配置时配音音色功能不可用。</p>
          </div>
        </div>

        <div class="field-group">
          <span class="field-label-upper">知乎数据开放平台（选题调研 / 文章素材）</span>
          <div class="stack">
            <label class="field-row">
              <span class="field-label-sm">Access Secret</span>
              <div class="key-input-row">
                <input type={showZhihuSecret ? "text" : "password"} bind:value={zhihuDataSecret} placeholder="developer.zhihu.com 个人中心获取" class="key-input" />
                <button class="key-toggle" onclick={() => showZhihuSecret = !showZhihuSecret}>{showZhihuSecret ? "🙈" : "👁"}</button>
              </div>
            </label>
            <p class="hint-sm">注册免费 5000 次/天，用于知乎热榜调研与搜索素材。获取方式：developer.zhihu.com → 个人中心。未配置时知乎调研自动退回聚合数据源。</p>
          </div>
        </div>

        <div class="field-group">
          <span class="field-label-upper">数字人 API</span>
          <div class="stack">
            <label class="field-row">
              <span class="field-label-sm">HeyGem 实例地址</span>
              <input type="text" bind:value={heygemBaseUrl} placeholder="http://localhost:6006" class="key-input" />
            </label>
            <label class="field-row">
              <span class="field-label-sm">HeyGem API Token</span>
              <div class="key-input-row">
                <input type={showHeygemToken ? "text" : "password"} bind:value={heygemApiToken} placeholder="HeyGem 服务 Token" class="key-input" />
                <button class="key-toggle" onclick={() => showHeygemToken = !showHeygemToken}>{showHeygemToken ? "🙈" : "👁"}</button>
              </div>
            </label>
            <label class="field-row">
              <span class="field-label-sm">GPU 时价（元/小时）</span>
              <input type="number" step="0.01" min="0" bind:value={heygemGpuHourlyRateYuan} class="key-input" />
            </label>
            <label class="field-row">
              <span class="field-label-sm">SSH 隧道主机</span>
              <input type="text" bind:value={heygemTunnelHost} placeholder="connect.nmb1.seetacloud.com" class="key-input" />
            </label>
            <label class="field-row">
              <span class="field-label-sm">SSH 隧道端口</span>
              <input type="number" min="1" max="65535" bind:value={heygemTunnelPort} placeholder="28830" class="key-input" />
            </label>
            <p class="hint-sm">HeyGem 用于数字人视频生成。实例需在 AutoDL 控制台手动开关机；个人用户通过 SSH 隧道访问实例（隧道由 AutoViral 自动管理），实例地址填 http://localhost:6006。</p>
          </div>
        </div>

        {#if settingsMessage}
          <p class="msg-success">{settingsMessage}</p>
        {/if}

        <button class="btn-primary full" onclick={handleSaveSettings} disabled={saving}>
          {#if saving}
            <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>
          {/if}
          {saving ? tt("saving") : tt("saveChanges")}
        </button>
      </div>
    </aside>
  {/if}

  <NewWorkModal
    open={showNewWorkModal}
    onClose={() => { showNewWorkModal = false; prefillTitle = ""; prefillTopicHint = ""; }}
    onCreate={handleCreateWork}
    {prefillTitle}
    {prefillTopicHint}
  />
</div>

<style>
  /* ═══════════════════════════════════════════════════════════
     DESIGN SYSTEM — "Editorial Noir"
     Warm blacks, sharp type, TikTok accent sparks
     ═══════════════════════════════════════════════════════════ */

  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300..800;1,9..40,300..800&family=Space+Grotesk:wght@400;500;600;700&display=swap');

  :global(:root),
  :global([data-theme="dark"]) {
    /* Surfaces — warm charcoal, not cold blue */
    --bg: #0e0e0e;
    --bg-elevated: #161616;
    --bg-surface: #1a1a1a;
    --bg-inset: #111111;
    --bg-hover: #222222;

    /* Borders */
    --border: rgba(255, 255, 255, 0.1);
    --border-subtle: rgba(255, 255, 255, 0.05);

    /* Text — warm off-whites, higher contrast */
    --text: #f5f2ed;
    --text-secondary: #c4bfb8;
    --text-muted: #8a847e;
    --text-dim: #78726c;

    /* Accents — from the logo */
    --accent: #f0ece6;
    --accent-soft: rgba(240, 236, 230, 0.06);
    --accent-hover: #d6d0c8;
    --accent-text: #0e0e0e;
    --accent-gradient: linear-gradient(135deg, #f0ece6, #c4beb6);
    --spark-red: #FE2C55;
    --spark-cyan: #25F4EE;

    --badge-text: #fff;
    --state-running: #f59e0b;
    --state-idle: #6b6560;
    --state-default: #3d3935;
    --success: #22c55e;
    --success-soft: rgba(34, 197, 94, 0.08);
    --error: #ef4444;
    --error-soft: rgba(239, 68, 68, 0.06);
    --info: #3b82f6;
    --info-soft: rgba(59, 130, 246, 0.06);

    --scrollbar: rgba(255,255,255,0.05);
    --selection: rgba(254, 44, 85, 0.15);
    --selected: rgba(254, 44, 85, 0.08);
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.5);
    --shadow-md: 0 8px 30px rgba(0,0,0,0.5);
    --shadow-lg: 0 24px 64px rgba(0,0,0,0.6);
    --glow: none;
    --card-bg: #161616;
    --card-border: rgba(255, 255, 255, 0.06);
    --card-radius: 6px;
    --card-blur: none;
    --transition-fast: 0.12s ease;
    --transition-normal: 0.25s ease;

    /* Type scale */
    --font-display: 'Space Grotesk', sans-serif;
    --font-body: 'DM Sans', sans-serif;
    --size-xs: 0.7rem;
    --size-sm: 0.8rem;
    --size-base: 0.88rem;
    --size-lg: 1.05rem;
    --size-xl: 1.35rem;
    --size-2xl: 1.8rem;
    --size-3xl: 2.5rem;
  }

  :global([data-theme="light"]) {
    --bg: #f5f2ed;
    --bg-elevated: #faf8f5;
    --bg-surface: #edeae5;
    --bg-inset: #e8e5df;
    --bg-hover: #dfdbd5;
    --border: rgba(0, 0, 0, 0.08);
    --border-subtle: rgba(0, 0, 0, 0.04);
    --text: #1a1714;
    --text-secondary: #57534e;
    --text-muted: #8c8580;
    --text-dim: #9e9890;
    --accent: #1a1714;
    --accent-soft: rgba(26, 23, 20, 0.05);
    --accent-hover: #33302c;
    --accent-text: #f5f2ed;
    --accent-gradient: linear-gradient(135deg, #1a1714, #33302c);
    --spark-red: #FE2C55;
    --spark-cyan: #0ea5a5;
    --badge-text: #fff;
    --state-running: #d97706;
    --state-idle: #8c8580;
    --state-default: #bdb7b0;
    --success: #16a34a;
    --success-soft: rgba(22, 163, 74, 0.06);
    --error: #dc2626;
    --error-soft: rgba(220, 38, 38, 0.05);
    --info: #2563eb;
    --info-soft: rgba(37, 99, 235, 0.05);
    --scrollbar: rgba(0,0,0,0.06);
    --selection: rgba(254, 44, 85, 0.12);
    --shadow-sm: 0 1px 3px rgba(0,0,0,0.04);
    --shadow-md: 0 8px 24px rgba(0,0,0,0.06);
    --shadow-lg: 0 20px 60px rgba(0,0,0,0.08);
    --glow: none;
    --card-bg: #faf8f5;
    --card-border: rgba(0, 0, 0, 0.06);
    --card-radius: 6px;
    --card-blur: none;
    --transition-fast: 0.12s ease;
    --transition-normal: 0.25s ease;
    --font-display: 'Space Grotesk', sans-serif;
    --font-body: 'DM Sans', sans-serif;
  }

  :global(*, *::before, *::after) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(body) {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-body);
    font-weight: 400;
    font-size: var(--size-base);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-optical-sizing: auto;
  }

  :global(::selection) { background: var(--selection); }
  :global(::-webkit-scrollbar) { width: 4px; }
  :global(::-webkit-scrollbar-track) { background: transparent; }
  :global(::-webkit-scrollbar-thumb) { background: var(--scrollbar); border-radius: 2px; }
  :global(:focus-visible) { outline: 1.5px solid var(--spark-red); outline-offset: 2px; }

  /* ── Shell ──────────────────────────────────── */
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }

  /* ── Topbar ─────────────────────────────────── */
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 52px;
    flex-shrink: 0;
    padding: 0 clamp(1rem, 3vw, 2.5rem);
    border-bottom: 1px solid var(--border);
  }

  .topbar-left {
    display: flex;
    align-items: center;
    gap: 2rem;
  }

  .logo-mark {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    text-decoration: none;
    color: var(--text);
  }

  .logo-img {
    width: 26px;
    height: 26px;
    object-fit: contain;
  }

  .logo-wordmark {
    font-family: var(--font-display);
    font-size: var(--size-sm);
    font-weight: 700;
    letter-spacing: -0.03em;
    text-transform: uppercase;
  }

  .nav {
    display: flex;
    gap: 0.15rem;
  }

  .nav-link {
    padding: 0.35rem 0.9rem;
    border: none;
    background: none;
    color: var(--text-muted);
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 500;
    cursor: pointer;
    transition: color var(--transition-fast);
    position: relative;
    border-radius: 4px;
  }

  .nav-link:hover { color: var(--text); }

  .nav-link.active {
    color: var(--text);
    font-weight: 600;
  }

  .nav-link.active::after {
    content: "";
    position: absolute;
    bottom: -10px;
    left: 0;
    right: 0;
    height: 1.5px;
    background: var(--spark-red);
  }

  .topbar-action {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--text-muted);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .topbar-action:hover {
    color: var(--text);
    border-color: var(--border);
  }

  /* ── Main ───────────────────────────────────── */
  .main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: clamp(1rem, 3vw, 2rem) clamp(1rem, 4vw, 3rem) 4rem;
  }

  .main.main-studio {
    overflow: hidden;
    padding: 0 clamp(1rem, 4vw, 3rem);
  }

  /* ── Drawer (Settings) ─────────────────────── */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 500;
    animation: fadeIn 0.15s ease;
  }

  .drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(380px, 90vw);
    background: var(--bg-elevated);
    border-left: 1px solid var(--border);
    z-index: 600;
    display: flex;
    flex-direction: column;
    animation: slideIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    box-shadow: var(--shadow-lg);
  }

  @keyframes slideIn {
    from { transform: translateX(100%); }
    to { transform: translateX(0); }
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .drawer-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.25rem 1.5rem;
    border-bottom: 1px solid var(--border);
  }

  .drawer-head h2 {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .drawer-close {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem;
    display: flex;
    transition: color var(--transition-fast);
  }

  .drawer-close:hover { color: var(--text); }

  .drawer-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .field-group {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .field-label-upper {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .field-label-sm {
    font-size: var(--size-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .field-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .lang-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .lang-opt {
    font-size: var(--size-sm);
    font-weight: 500;
    color: var(--text-dim);
    transition: color 0.15s;
    user-select: none;
  }

  .lang-opt.active { color: var(--text); }

  .field-btn {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 0.85rem;
    color: var(--text);
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 500;
    cursor: pointer;
    transition: border-color var(--transition-fast);
    width: fit-content;
  }

  .field-btn:hover { border-color: var(--text-dim); }

  /* Switch */
  .switch {
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--text-dim);
    border: none;
    cursor: pointer;
    position: relative;
    transition: background 0.2s ease;
    flex-shrink: 0;
    padding: 0;
  }

  .switch.on { background: var(--spark-red); }

  .switch-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s ease;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .switch.on .switch-thumb { transform: translateX(16px); }

  /* Select */
  select {
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
    background-position: right 0.6rem center;
    background-size: 11px;
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  select:focus {
    outline: none;
    border-color: var(--text-muted);
  }

  .msg-success {
    font-size: var(--size-sm);
    font-weight: 500;
    color: var(--success);
  }
  .key-input-row { display: flex; gap: 0.3rem; align-items: center; }
  .key-input { flex: 1; padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-inset); color: var(--text); font-size: 0.8rem; }
  .key-toggle { padding: 0.3rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: none; cursor: pointer; font-size: 0.8rem; }
  .hint-sm { font-size: 0.72rem; color: var(--text-dim); margin: 0.25rem 0 0; }

  /* Buttons */
  .btn-primary {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: var(--text);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    padding: 0.6rem 1.25rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .btn-primary:hover:not(:disabled) { opacity: 0.8; }
  .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-primary.full { width: 100%; }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Responsive ─────────────────────────────── */
  @media (max-width: 768px) {
    .logo-wordmark { display: none; }
    .nav-link { padding: 0.3rem 0.6rem; font-size: 0.78rem; }
    .main { padding: 1rem 1rem 3rem; }
  }
</style>
