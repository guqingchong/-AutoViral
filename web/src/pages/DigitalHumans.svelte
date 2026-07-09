<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchAvatars, uploadAvatar, importAvatar, fetchDigitalHumanJobs,
    submitDigitalHumanJob, refreshDigitalHumanJob, type Avatar, type DigitalHumanJob,
  } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";

  let lang = $state(getLanguage());
  let avatars = $state<Avatar[]>([]);
  let jobs = $state<DigitalHumanJob[]>([]);
  let newName = $state("");
  let uploadFiles = $state<FileList | null>(null);
  let providerAvatarId = $state("");
  let audioUrl = $state("");
  let selectedAvatarId = $state("");
  let busy = $state(false);
  let message = $state("");

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    load();
    return () => unsub();
  });

  function tt(key: string): string { void lang; return t(key); }

  async function load() {
    const [a, j] = await Promise.all([fetchAvatars(), fetchDigitalHumanJobs()]);
    avatars = a;
    jobs = j;
  }

  async function handleUpload() {
    if (!uploadFiles?.length || !newName) return;
    busy = true;
    try {
      await uploadAvatar(newName, uploadFiles[0]);
      newName = "";
      uploadFiles = null;
      message = tt("avatarUploaded");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function handleImport() {
    if (!newName || !providerAvatarId) return;
    busy = true;
    try {
      await importAvatar(newName, providerAvatarId);
      newName = "";
      providerAvatarId = "";
      message = tt("avatarImported");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function handleSubmitJob() {
    if (!selectedAvatarId || !audioUrl) return;
    busy = true;
    try {
      await submitDigitalHumanJob({ avatarId: selectedAvatarId, audioUrl });
      audioUrl = "";
      message = tt("jobSubmitted");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function handleRefresh(jobId: string) {
    try {
      await refreshDigitalHumanJob(jobId);
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="page">
  <h1>{tt("digitalHumansTitle")}</h1>
  {#if message}<p class="message">{message}</p>{/if}

  <section class="panel">
    <h2>{tt("uploadAvatar")}</h2>
    <div class="row">
      <input type="text" bind:value={newName} placeholder={tt("avatarName")} />
      <input type="file" accept="video/*,image/*" bind:files={uploadFiles} />
      <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAvatar")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("importAvatar")}</h2>
    <div class="row">
      <input type="text" bind:value={newName} placeholder={tt("avatarName")} />
      <input type="text" bind:value={providerAvatarId} placeholder={tt("providerAvatarId")} />
      <button class="btn-primary" disabled={busy} onclick={handleImport}>{tt("importAvatar")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("avatars")}</h2>
    <ul class="list">
      {#each avatars as a}
        <li class="avatar-card">
          {#if a.preview_url}
            <img src={a.preview_url} alt={a.name} class="thumb" />
          {/if}
          <div class="info">
            <span class="name">{a.name}</span>
            <span class="badge">{a.status}</span>
            <span class="meta">{a.source}</span>
          </div>
        </li>
      {/each}
    </ul>
  </section>

  <section class="panel">
    <h2>{tt("submitJob")}</h2>
    <div class="row">
      <select bind:value={selectedAvatarId}>
        <option value="">{tt("selectAvatar")}</option>
        {#each avatars as a}
          <option value={a.id}>{a.name}</option>
        {/each}
      </select>
      <input type="text" bind:value={audioUrl} placeholder={tt("audioUrl")} />
      <button class="btn-primary" disabled={busy} onclick={handleSubmitJob}>{tt("submitJob")}</button>
    </div>

    <ul class="list">
      {#each jobs as j}
        <li class="job-row">
          <span class="name">{j.id}</span>
          <span class="badge">{j.status}</span>
          <span class="meta">{j.progress}%</span>
          <button class="btn-sm" onclick={() => handleRefresh(j.id)}>{tt("refresh")}</button>
          {#if j.status === "done"}
            <a class="btn-sm" href={`/api/digital-humans/jobs/${encodeURIComponent(j.id)}/output`} target="_blank">{tt("download")}</a>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
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
  .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; text-decoration: none; }
  .message { color: var(--spark-red); margin-bottom: 1rem; }
  .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .avatar-card, .job-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
  .thumb { width: 64px; height: 64px; object-fit: cover; border-radius: 4px; }
  .info { display: flex; flex-direction: column; gap: 0.25rem; }
  .name { font-weight: 600; }
  .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; width: fit-content; }
  .meta { font-size: var(--size-sm); color: var(--text-muted); }
</style>
