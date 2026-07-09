<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchLibraryAssets, uploadLibraryAsset, deleteLibraryAsset,
    recheckAssetCompliance, type AssetLibraryItem,
  } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";

  let lang = $state(getLanguage());
  let assets = $state<AssetLibraryItem[]>([]);
  let uploadFiles = $state<FileList | null>(null);
  let category = $state<AssetLibraryItem["category"]>("music");
  let source = $state<AssetLibraryItem["source"]>("upload");
  let license = $state<AssetLibraryItem["license"]>("needs-review");
  let tags = $state("");
  let filterCategory = $state<AssetLibraryItem["category"] | "" >("");
  let busy = $state(false);
  let message = $state("");

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
</script>

<div class="page">
  <h1>{tt("assetLibraryTitle")}</h1>
  {#if message}<p class="message">{message}</p>{/if}

  <section class="panel">
    <h2>{tt("uploadAsset")}</h2>
    <div class="row">
      <input type="file" bind:files={uploadFiles} />
      <select bind:value={category}>
        {#each categories as c}
          <option value={c}>{c}</option>
        {/each}
      </select>
      <select bind:value={source}>
        {#each sources as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
      <select bind:value={license}>
        {#each licenses as l}
          <option value={l}>{l}</option>
        {/each}
      </select>
      <input type="text" bind:value={tags} placeholder={tt("tags")} />
      <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAsset")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("filters")}</h2>
    <select bind:value={filterCategory} onchange={load}>
      <option value="">{tt("filterAll")}</option>
      {#each categories as c}
        <option value={c}>{c}</option>
      {/each}
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
  .btn-primary { background: var(--accent); color: var(--accent-text); border: none; border-radius: 4px; padding: 0.5rem 0.9rem; cursor: pointer; }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; cursor: pointer; }
  .message { color: var(--spark-red); margin-bottom: 1rem; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .asset-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
  .name { font-weight: 600; flex: 1; }
  .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; }
  .compliance-passed { background: var(--success-soft); color: var(--success); }
  .compliance-pending { background: rgba(245, 158, 11, 0.1); color: var(--state-running); }
  .compliance-failed { background: var(--error-soft); color: var(--error); }
  .meta { font-size: var(--size-sm); color: var(--text-muted); }
</style>
