<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchLibraryAssets, uploadLibraryAsset, deleteLibraryAsset,
    recheckAssetCompliance, type AssetLibraryItem,
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

  // Stock search state
  let stockQuery = $state("");
  let stockResults = $state<StockResultGroup[]>([]);
  let searching = $state(false);
  let downloadCategory = $state<AssetLibraryItem["category"]>("scenes");

  interface StockItem {
    provider: string; id: string; url: string; previewUrl?: string;
    width?: number; height?: number; author?: string; description?: string;
    license?: string;
  }
  interface StockResultGroup { provider: string; items: StockItem[]; total: number; error?: string; }

  const categories: AssetLibraryItem["category"][] = ["characters", "scenes", "music", "templates", "branding", "general"];
  const sources: AssetLibraryItem["source"][] = ["upload", "pexels", "pixabay", "unsplash", "self-generated", "unknown"];
  const licenses: AssetLibraryItem["license"][] = ["cc0", "commercial", "needs-review", "unknown"];

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    load();
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
      const res = await fetch(`/api/stock-assets/search?q=${encodeURIComponent(stockQuery)}`);
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
    message = `正在下载 ${item.provider} 素材...`;
    try {
      const res = await fetch("/api/stock-assets/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: item.url,
          provider: item.provider,
          category: downloadCategory,
          name: `stock_${item.provider}_${item.id}.jpg`,
          description: item.description,
          author: item.author,
          license: (item as any).license,
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
</script>

<div class="page">
  <h1>{tt("assetLibraryTitle")}</h1>
  {#if message}<p class="message">{message}</p>{/if}

  <section class="panel">
    <h2>素材搜索（Openverse 免费 + Pexels / Pixabay / Unsplash）</h2>
    <p class="hint">Openverse 无需 API Key 即可搜索。配置 Pexels/Pixabay/Unsplash API Key 可获得更多高质量素材。</p>
    {#if onOpenSettings}
      <button class="btn-settings-link" onclick={() => onOpenSettings?.()}>⚙ 配置素材 API Key</button>
    {/if}
    <div class="row">
      <input type="text" bind:value={stockQuery} placeholder="搜索关键词，如 海浪 城市 科技" class="search-input" onkeydown={(e) => e.key === "Enter" && searchStock()} />
      <select bind:value={downloadCategory}>
        {#each categories as c}<option value={c}>{c}</option>{/each}
      </select>
      <button class="btn-primary" disabled={searching} onclick={searchStock}>{searching ? "搜索中..." : "搜索"}</button>
    </div>
    <p class="hint">Openverse（免费，无需 Key）默认可用。如需更多高质量素材，可在「设置」中配置 Pexels/Pixabay/Unsplash 免费 API Key。搜索结果可一键下载到本地素材库。</p>

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
                      <img src={item.previewUrl} alt={item.description ?? ""} class="stock-thumb" />
                    {/if}
                    <div class="stock-info">
                      <span class="stock-desc">{item.description ?? item.id}</span>
                      {#if item.author}<span class="stock-author">@{item.author}</span>{/if}
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
      <select bind:value={category}>
        {#each categories as c}<option value={c}>{c}</option>{/each}
      </select>
      <select bind:value={source}>
        {#each sources as s}<option value={s}>{s}</option>{/each}
      </select>
      <select bind:value={license}>
        {#each licenses as l}<option value={l}>{l}</option>{/each}
      </select>
      <input type="text" bind:value={tags} placeholder={tt("tags")} />
      <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAsset")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("filters")}</h2>
    <select bind:value={filterCategory} onchange={load}>
      <option value="">{tt("filterAll")}</option>
      {#each categories as c}<option value={c}>{c}</option>{/each}
    </select>
  </section>

  <ul class="list">
    {#each assets as a}
      <li class="asset-row">
        <span class="name">{a.name}</span>
        <span class="badge">{a.type}</span>
        <span class="badge compliance-{a.compliance_status}">{a.compliance_status}</span>
        <span class="meta">{(a.tags || []).join(", ")}</span>
        <button class="btn-sm" onclick={() => handleRecheck(a.id)}>{tt("recheck")}</button>
        <button class="btn-sm" onclick={() => handleDelete(a.id)}>{tt("delete")}</button>
      </li>
    {/each}
  </ul>
</div>

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
  .name { font-weight: 600; flex: 1; }
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
</style>