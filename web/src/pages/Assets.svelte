<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    fetchLibraryAssets, uploadLibraryAsset, deleteLibraryAsset,
    recheckAssetCompliance, type AssetLibraryItem,
  } from "../lib/api.js";
  import {
    fetchVoices, fetchBuiltinVoices, cloneVoice, requestVoiceDemo,
    requestBuiltinDemo, favoriteVoice, deleteVoice,
    type VoiceItem, type BuiltinVoice,
  } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";

  let { onOpenSettings }: { onOpenSettings?: () => void } = $props();

  let lang = $state(getLanguage());
  let assets = $state<AssetLibraryItem[]>([]);
  let uploadFiles = $state<FileList | null>(null);
  let category = $state<AssetLibraryItem["category"]>("music");
  let source = $state<AssetLibraryItem["source"]>("upload");
  let license = $state<AssetLibraryItem["license"]>("needs-review");
  let tags = $state("");
  let filterCategory = $state<AssetLibraryItem["category"] | "">("");
  let busy = $state(false);
  let message = $state("");

  // 配音音色（voice cloning）state
  let mainTab = $state<"assets" | "voices">("assets");
  let voices = $state<VoiceItem[]>([]);
  let builtinVoices = $state<BuiltinVoice[]>([]);
  let builtinCategories = $state<string[]>([]);
  let voiceCategoryFilter = $state<string>("");
  let voiceSearch = $state<string>("");
  let showCloneModal = $state(false);
  let cloneName = $state("");
  let cloneFile = $state<FileList | null>(null);
  let cloneBusy = $state(false);
  let recording = $state(false);
  let mediaRecorder: MediaRecorder | null = null;
  let recordChunks: Blob[] = [];
  let discardRecording = false;
  let recordedBlob = $state<Blob | null>(null);
  let recordedUrl = $state<string>("");
  let demoLoadingKey = $state<string>("");
  let demoUrls = $state<Record<string, string>>({});

  // Stock search state
  let stockQuery = $state("");
  let stockType = $state<"all" | "image" | "video">("all");
  let stockResults = $state<StockResultGroup[]>([]);
  let searching = $state(false);
  let downloadCategory = $state<AssetLibraryItem["category"]>("scenes");

  interface StockItem {
    provider: string; id: string; url: string; previewUrl?: string;
    mediaType?: "image" | "video"; duration?: number;
    width?: number; height?: number; author?: string; description?: string;
    license?: string;
  }
  interface StockResultGroup { provider: string; items: StockItem[]; total: number; error?: string; }

  const categories: AssetLibraryItem["category"][] = ["characters", "scenes", "music", "templates", "branding", "general"];
  const sources: AssetLibraryItem["source"][] = ["upload", "pexels", "pixabay", "unsplash", "self-generated", "unknown"];
  const licenses: AssetLibraryItem["license"][] = ["cc0", "commercial", "needs-review", "unknown"];

  // 下拉选项/徽标中文标签（值仍为英文枚举，仅显示层翻译）
  const categoryLabels: Record<string, string> = {
    characters: "人物形象", scenes: "场景素材", music: "音乐音效",
    templates: "模板素材", branding: "品牌标识", general: "通用素材",
  };
  const sourceLabels: Record<string, string> = {
    upload: "本地上传", pexels: "Pexels", pixabay: "Pixabay",
    unsplash: "Unsplash", "self-generated": "AI 生成", unknown: "未知来源",
  };
  const licenseLabels: Record<string, string> = {
    cc0: "CC0 公有领域", commercial: "可商用", "needs-review": "待审核", unknown: "未知授权",
  };
  const typeLabels: Record<string, string> = {
    image: "图片", video: "视频", audio: "音频", font: "字体", other: "其他",
  };
  const complianceLabels: Record<string, string> = {
    passed: "合规通过", pending: "待审核", failed: "不合规",
  };
  const voiceStatusLabels: Record<string, string> = {
    cloning: "克隆中", ready: "可用", failed: "失败",
  };

  const filteredBuiltin = $derived(builtinVoices.filter((v) =>
    (!voiceCategoryFilter || v.category === voiceCategoryFilter) &&
    (!voiceSearch || v.name.includes(voiceSearch) || v.voice_id.includes(voiceSearch))
  ));
  const favoritedIds = $derived(new Set(voices.filter((v) => v.type === "builtin_fav").map((v) => v.voice_id)));

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    load();
    loadVoices();
    return () => unsub();
  });

  function tt(key: string): string { void lang; return t(key); }

  async function load() {
    assets = await fetchLibraryAssets(filterCategory || undefined);
  }

  async function handleUpload() {
    if (!uploadFiles?.length) return;
    busy = true;
    try {
      await uploadLibraryAsset(uploadFiles[0], category, source, license, tags);
      uploadFiles = null;
      tags = "";
      message = tt("assetUploaded");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(tt("confirmDelete"))) return;
    try {
      await deleteLibraryAsset(id);
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleRecheck(id: number) {
    try {
      await recheckAssetCompliance(id);
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  async function searchStock() {
    if (!stockQuery.trim()) return;
    searching = true;
    message = "";
    try {
      const res = await fetch(`/api/stock-assets/search?q=${encodeURIComponent(stockQuery)}&type=${stockType}`);
      const data = await res.json();
      if (data.error) {
        message = `搜索出错: ${data.error}`;
        stockResults = [];
      } else {
        stockResults = data.results ?? [];
        const configuredProviders = data.providers ?? [];
        // 各源错误（网络不可达 / Key 无效）逐条展示，比"未找到结果"更可行动
        const sourceErrors = stockResults.filter((g) => g.error);
        const totalItems = stockResults.reduce((n, g) => n + (g.items?.length ?? 0), 0);
        if (sourceErrors.length > 0) {
          const lines = sourceErrors.map((g) => `${g.provider}: ${g.error}`);
          if (totalItems > 0) {
            message = `部分素材源不可用 —— ${lines.join("；")}`;
          } else {
            const unconfigured = ["pexels", "pixabay", "unsplash"].filter(p => !configuredProviders.includes(p));
            const suffix = unconfigured.length > 0
              ? `；另外 ${unconfigured.join(", ")} 未配置 API Key（设置页可填）`
              : "";
            message = `素材源不可用 —— ${lines.join("；")}${suffix}`;
          }
        } else if (totalItems === 0) {
          const unconfigured = ["pexels", "pixabay", "unsplash"].filter(p => !configuredProviders.includes(p));
          message = unconfigured.length > 0
            ? `未找到结果。以下素材源未配置 API Key: ${unconfigured.join(", ")}（设置页可填，免费注册）。`
            : "未找到结果，请尝试其他关键词。";
        }
      }
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
      stockResults = [];
    } finally {
      searching = false;
    }
  }

  async function downloadStock(item: StockItem) {
    busy = true;
    const isVideo = item.mediaType === "video";
    message = `正在下载 ${item.provider} ${isVideo ? "视频" : "图片"}素材...`;
    try {
      const res = await fetch("/api/stock-assets/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: item.url,
          provider: item.provider,
          mediaType: item.mediaType,
          category: downloadCategory,
          name: `stock_${item.provider}_${item.id}.${isVideo ? "mp4" : "jpg"}`,
          description: item.description,
          author: item.author,
          license: (item as any).license,
          duration: item.duration,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "下载失败");
      }
      message = "素材已下载并加入素材库";
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // 配音音色：克隆 / 录音 / 试听 / 收藏 / 删除
  // ---------------------------------------------------------------------------

  async function loadVoices() {
    try {
      const [vRes, bRes] = await Promise.all([fetchVoices(), fetchBuiltinVoices()]);
      voices = vRes.voices;
      builtinVoices = bRes.voices;
      builtinCategories = bRes.categories;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleClone() {
    const file = cloneFile?.[0] ?? (recordedBlob ? new File([recordedBlob], "recording.webm", { type: "audio/webm" }) : null);
    if (!file || !cloneName.trim()) { message = "请填写名称并选择音频（或录音）"; return; }
    cloneBusy = true;
    try {
      await cloneVoice(cloneName.trim(), file);
      message = "克隆成功，音色已入库";
      showCloneModal = false;
      cloneName = ""; cloneFile = null; recordedBlob = null;
      if (recordedUrl) { URL.revokeObjectURL(recordedUrl); recordedUrl = ""; }
      await loadVoices();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      cloneBusy = false;
    }
  }

  async function toggleRecording() {
    if (recording) { mediaRecorder?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => recordChunks.push(e.data);
      mediaRecorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recording = false;
        if (!discardRecording) {
          recordedBlob = new Blob(recordChunks, { type: "audio/webm" });
          if (recordedUrl) URL.revokeObjectURL(recordedUrl);
          recordedUrl = URL.createObjectURL(recordedBlob);
        }
        discardRecording = false;
      };
      mediaRecorder.start();
      recording = true;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  function closeCloneModal() {
    if (recording) {
      discardRecording = true;
      mediaRecorder?.stop(); // onstop 中释放 stream tracks
    }
    showCloneModal = false;
    cloneName = "";
    cloneFile = null;
    recordedBlob = null;
    if (recordedUrl) { URL.revokeObjectURL(recordedUrl); recordedUrl = ""; }
  }

  onDestroy(() => {
    if (recording) {
      discardRecording = true;
      mediaRecorder?.stop();
    }
    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  });

  async function playVoiceDemo(v: VoiceItem) {
    demoLoadingKey = v.id;
    try {
      const { url } = await requestVoiceDemo(v.id);
      demoUrls = { ...demoUrls, [v.id]: url };
    } catch (err) { message = err instanceof Error ? err.message : String(err); }
    finally { demoLoadingKey = ""; }
  }

  async function playBuiltinDemo(v: BuiltinVoice) {
    demoLoadingKey = v.voice_id;
    try {
      const { url } = await requestBuiltinDemo(v.voice_id);
      demoUrls = { ...demoUrls, [v.voice_id]: url };
    } catch (err) { message = err instanceof Error ? err.message : String(err); }
    finally { demoLoadingKey = ""; }
  }

  async function handleFavorite(v: BuiltinVoice) {
    try {
      await favoriteVoice(v.voice_id, v.name, { category: v.category });
      await loadVoices();
    } catch (err) { message = err instanceof Error ? err.message : String(err); }
  }

  async function handleDeleteVoice(id: string) {
    if (!confirm("确认删除该音色？")) return;
    try {
      await deleteVoice(id);
      await loadVoices();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="page">
  <h1>{tt("assetLibraryTitle")}</h1>
  {#if message}<p class="message">{message}</p>{/if}

  <div class="main-tabs">
    <button class="main-tab" class:active={mainTab === "assets"} onclick={() => (mainTab = "assets")}>素材</button>
    <button class="main-tab" class:active={mainTab === "voices"} onclick={() => (mainTab = "voices")}>配音音色</button>
  </div>

  {#if mainTab === "assets"}
  <section class="panel">
    <h2>素材搜索（Pexels 优先 + Pixabay / Unsplash 补充）</h2>
    <p class="hint">网上素材搜索优先走 Pexels。在设置页配置 Pexels API Key 即可开始搜索；Pixabay/Unsplash 为可选补充源。</p>
    {#if onOpenSettings}
      <button class="btn-settings-link" onclick={() => onOpenSettings?.()}>⚙ 配置素材 API Key</button>
    {/if}
    <div class="row">
      <input type="text" bind:value={stockQuery} placeholder="搜索关键词，如 海浪 城市 科技" class="search-input" onkeydown={(e) => e.key === "Enter" && searchStock()} />
      <select bind:value={stockType} title="素材类型">
        <option value="all">图片+视频</option>
        <option value="image">仅图片</option>
        <option value="video">仅视频</option>
      </select>
      <select bind:value={downloadCategory} title="下载到哪个分类">
        {#each categories as c}<option value={c}>{categoryLabels[c] ?? c}</option>{/each}
      </select>
      <button class="btn-primary" disabled={searching} onclick={searchStock}>{searching ? "搜索中..." : "搜索"}</button>
    </div>
    <p class="hint">Pexels 的图片与视频共用同一个免费 Key。搜索结果可一键下载到本地素材库；视频工作流的「素材准备」步骤也会自动从这里检索。</p>

    {#if stockResults.length > 0}
      <div class="stock-results">
        {#each stockResults as group}
          {#if group.items.length > 0}
            <div class="stock-group">
              <h3 class="stock-group-title">{group.provider}（{group.items.length}）</h3>
              <div class="stock-grid">
                {#each group.items as item}
                  <div class="stock-card">
                    {#if item.previewUrl}
                      <div class="stock-thumb-wrap">
                        <img src={item.previewUrl} alt={item.description ?? ""} class="stock-thumb" />
                        {#if item.mediaType === "video"}
                          <span class="media-badge video">▶ 视频{item.duration ? ` ${Math.round(item.duration)}s` : ""}</span>
                        {/if}
                      </div>
                    {:else if item.mediaType === "video"}
                      <div class="stock-thumb-wrap"><span class="media-badge video">▶ 视频{item.duration ? ` ${Math.round(item.duration)}s` : ""}</span></div>
                    {/if}
                    <div class="stock-info">
                      <span class="stock-desc">{item.description ?? item.id}</span>
                      {#if item.author}<span class="stock-author">@{item.author}</span>{/if}
                      {#if item.width && item.height}<span class="stock-author">{item.width}×{item.height}{item.height > item.width ? " 竖版" : ""}</span>{/if}
                      <button class="btn-sm download-btn" disabled={busy} onclick={() => downloadStock(item)}>下载</button>
                    </div>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel">
    <h2>{tt("uploadAsset")}</h2>
    <div class="row">
      <input type="file" bind:files={uploadFiles} />
      <select bind:value={category} title="素材分类">
        {#each categories as c}<option value={c}>{categoryLabels[c] ?? c}</option>{/each}
      </select>
      <select bind:value={source} title="素材来源">
        {#each sources as s}<option value={s}>{sourceLabels[s] ?? s}</option>{/each}
      </select>
      <select bind:value={license} title="授权类型">
        {#each licenses as l}<option value={l}>{licenseLabels[l] ?? l}</option>{/each}
      </select>
      <input type="text" bind:value={tags} placeholder={tt("tags")} />
      <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAsset")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("filters")}</h2>
    <select bind:value={filterCategory} onchange={load}>
      <option value="">{tt("filterAll")}</option>
      {#each categories as c}<option value={c}>{categoryLabels[c] ?? c}</option>{/each}
    </select>
  </section>

  <div class="asset-grid">
    {#each assets as a}
      <div class="asset-card">
        <div class="asset-preview">
          {#if a.type === "image"}
            <img src={a.url} alt={a.name} class="preview-media" loading="lazy" />
          {:else if a.type === "video"}
            <video src={a.url} class="preview-media" controls preload="metadata"></video>
          {:else if a.type === "audio"}
            <div class="preview-audio">
              <span class="preview-icon">🎵</span>
              <audio src={a.url} controls preload="metadata"></audio>
            </div>
          {:else}
            <div class="preview-placeholder">
              <span class="preview-icon">{a.type === "font" ? "🔤" : "📄"}</span>
              <span class="preview-type">{typeLabels[a.type] ?? a.type}</span>
            </div>
          {/if}
        </div>
        <div class="asset-info">
          <span class="name" title={a.name}>{a.name}</span>
          <div class="badge-row">
            <span class="badge">{typeLabels[a.type] ?? a.type}</span>
            <span class="badge">{categoryLabels[a.category] ?? a.category}</span>
            <span class="badge compliance-{a.compliance_status}">{complianceLabels[a.compliance_status] ?? a.compliance_status}</span>
          </div>
          {#if (a.tags || []).length > 0}<span class="meta">{(a.tags || []).join(", ")}</span>{/if}
          <div class="asset-actions">
            <button class="btn-sm" onclick={() => handleRecheck(a.id)}>{tt("recheck")}</button>
            <button class="btn-sm" onclick={() => handleDelete(a.id)}>{tt("delete")}</button>
          </div>
        </div>
      </div>
    {/each}
  </div>

  {:else}
  <!-- 配音音色选项卡 -->
  <section class="panel">
    <div class="voice-section-head">
      <h2>我的声音</h2>
      <button class="btn-primary" onclick={() => (showCloneModal = true)}>克隆新声音</button>
    </div>
    {#if voices.length === 0}
      <p class="hint">还没有音色。点击「克隆新声音」上传音频或录音，或在下方 AI 音色库中收藏喜欢的音色。</p>
    {:else}
      <div class="voice-grid">
        {#each voices as v (v.id)}
          <div class="voice-card">
            <div class="voice-card-head">
              <span class="name" title={v.name}>{v.name}</span>
              <span class="badge">{v.type === "cloned" ? "克隆" : "收藏"}</span>
              <span class="badge voice-status-{v.status}">{voiceStatusLabels[v.status] ?? v.status}</span>
            </div>
            {#if v.status === "failed" && v.error}
              <span class="voice-error">{v.error}</span>
            {/if}
            {#if demoUrls[v.id]}
              <audio controls src={demoUrls[v.id]} class="voice-audio"></audio>
            {:else if v.status === "ready"}
              <button class="btn-sm" disabled={demoLoadingKey === v.id} onclick={() => playVoiceDemo(v)}>
                {demoLoadingKey === v.id ? "生成试听中..." : "试听"}
              </button>
            {/if}
            <div class="asset-actions">
              <button class="btn-sm" onclick={() => handleDeleteVoice(v.id)}>删除</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="panel">
    <h2>AI 音色库</h2>
    <div class="row">
      <select bind:value={voiceCategoryFilter} title="音色分类">
        <option value="">全部分类</option>
        {#each builtinCategories as c}<option value={c}>{c}</option>{/each}
      </select>
      <input type="text" bind:value={voiceSearch} placeholder="搜索音色名称或 ID" class="search-input" />
    </div>
    <div class="voice-grid builtin-grid">
      {#each filteredBuiltin as v (v.voice_id)}
        <div class="voice-card">
          <div class="voice-card-head">
            <span class="name" title={v.name}>{v.name}</span>
            <span class="badge">{v.category}</span>
          </div>
          {#if v.description}<span class="meta">{v.description}</span>{/if}
          {#if demoUrls[v.voice_id]}
            <audio controls src={demoUrls[v.voice_id]} class="voice-audio"></audio>
          {:else}
            <button class="btn-sm" disabled={demoLoadingKey === v.voice_id} onclick={() => playBuiltinDemo(v)}>
              {demoLoadingKey === v.voice_id ? "生成试听中..." : "试听"}
            </button>
          {/if}
          <div class="asset-actions">
            <button class="btn-sm" disabled={favoritedIds.has(v.voice_id)} onclick={() => handleFavorite(v)}>
              {favoritedIds.has(v.voice_id) ? "已收藏" : "收藏"}
            </button>
          </div>
        </div>
      {/each}
    </div>
    {#if filteredBuiltin.length === 0}
      <p class="hint">没有匹配的音色，请调整分类或搜索关键词。</p>
    {/if}
  </section>
  {/if}
</div>

{#if showCloneModal}
  <div class="modal-backdrop" onclick={(e) => { if (e.target === e.currentTarget) closeCloneModal(); }} onkeydown={(e) => e.key === "Escape" && closeCloneModal()} role="presentation">
    <div class="modal" role="dialog" tabindex="-1" aria-label="克隆新声音">
      <h2>克隆新声音</h2>
      <div class="modal-body">
        <input type="text" bind:value={cloneName} placeholder="音色名称，如 我的声音" />
        <input type="file" accept="audio/*" bind:files={cloneFile} />
        <p class="hint">上传音频（mp3/wav/m4a，10秒~5分钟）</p>
        <div class="row">
          <button class="btn-sm" onclick={toggleRecording}>{recording ? "⏹ 停止录音" : "🎙 开始录音"}</button>
          {#if recordedBlob}
            <span class="hint">已录音 ✓ 可播放确认</span>
            <audio controls src={recordedUrl} class="voice-audio"></audio>
          {/if}
        </div>
        <p class="hint">请录制/上传清晰干声，避免背景音。</p>
      </div>
      <div class="modal-actions">
        <button class="btn-sm" onclick={closeCloneModal}>取消</button>
        <button class="btn-primary" disabled={cloneBusy || recording} onclick={handleClone}>{cloneBusy ? "克隆中..." : "开始克隆"}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .page { padding: 2rem; color: var(--text); font-family: var(--font-body); }
  h1 { font-family: var(--font-display); font-size: var(--size-2xl); margin-bottom: 1.5rem; }
  h2 { font-size: var(--size-lg); margin: 0 0 0.75rem; color: var(--text-secondary); }
  .panel { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
  input, select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; }
  .search-input { flex: 1; min-width: 240px; }
  .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; cursor: pointer; }
  .message { color: var(--spark-red); margin-bottom: 1rem; }
  .hint { font-size: 0.75rem; color: var(--text-dim); margin: 0.5rem 0 0; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .asset-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
  .asset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 0.75rem; }
  .asset-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; }
  .asset-preview { width: 100%; height: 150px; background: var(--bg-inset); display: flex; align-items: center; justify-content: center; overflow: hidden; }
  .preview-media { width: 100%; height: 100%; object-fit: contain; background: #000; }
  .preview-audio { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 0.5rem; width: 100%; }
  .preview-audio audio { width: 90%; height: 32px; }
  .preview-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; color: var(--text-dim); }
  .preview-icon { font-size: 2rem; }
  .preview-type { font-size: 0.75rem; }
  .asset-info { padding: 0.5rem 0.6rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .badge-row { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .asset-actions { display: flex; gap: 0.4rem; margin-top: 0.15rem; }
  .name { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; }
  .compliance-passed { background: var(--success-soft); color: var(--success); }
  .compliance-pending { background: rgba(245, 158, 11, 0.1); color: var(--state-running); }
  .compliance-failed { background: var(--error-soft); color: var(--error); }
  .meta { font-size: var(--size-sm); color: var(--text-muted); }

  .stock-results { margin-top: 1rem; }
  .stock-group { margin-bottom: 1rem; }
  .stock-group-title { font-size: 0.85rem; font-weight: 700; color: var(--text); margin: 0 0 0.5rem; text-transform: capitalize; }
  .stock-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  .stock-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; overflow: hidden; display: flex; flex-direction: column; }
  .stock-thumb { width: 100%; height: 120px; object-fit: cover; }
  .stock-thumb-wrap { position: relative; min-height: 40px; }
  .media-badge { position: absolute; top: 4px; left: 4px; font-size: 0.65rem; padding: 1px 6px; border-radius: 3px; background: rgba(0,0,0,0.65); color: #fff; }
  .media-badge.video { background: rgba(30,100,220,0.85); }
  .stock-info { padding: 0.4rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .stock-desc { font-size: 0.7rem; color: var(--text-secondary); line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .stock-author { font-size: 0.65rem; color: var(--text-dim); }
  .download-btn { margin-top: 0.25rem; }
  .btn-settings-link {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.35rem 0.8rem;
    background: var(--accent-soft, rgba(0,0,0,0.05));
    color: var(--accent, #333);
    border: 1px solid var(--border, #ddd);
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    margin-bottom: 0.5rem;
  }
  .btn-settings-link:hover {
    background: var(--accent, #333);
    color: var(--accent-text, #fff);
  }

  .main-tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .main-tab {
    background: var(--bg-elevated);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 1.2rem;
    font-weight: 600;
    cursor: pointer;
  }
  .main-tab.active {
    background: var(--accent);
    color: var(--accent-text);
    border-color: var(--accent);
  }

  .voice-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .voice-section-head h2 { margin: 0; }
  .voice-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.75rem; }
  .builtin-grid { margin-top: 0.75rem; }
  .voice-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.6rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .voice-card-head { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
  .voice-audio { width: 100%; height: 32px; }
  .voice-error { font-size: var(--size-xs); color: var(--error); }
  .voice-status-ready { background: var(--success-soft); color: var(--success); }
  .voice-status-cloning { background: rgba(245, 158, 11, 0.1); color: var(--state-running); }
  .voice-status-failed { background: var(--error-soft); color: var(--error); }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    padding: 1.25rem;
    width: min(480px, 92vw);
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .modal h2 { margin: 0; }
  .modal-body { display: flex; flex-direction: column; gap: 0.6rem; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; }
</style>