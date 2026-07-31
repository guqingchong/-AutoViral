<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchAvatars, uploadAvatar, deleteAvatarApi, fetchDigitalHumanJobs,
    submitDigitalHumanJob, refreshDigitalHumanJob, deleteDigitalHumanJob,
    regenerateDigitalHumanJob, fetchInstanceStatus,
    ApiError, type Avatar, type DigitalHumanJob, type InstanceView,
  } from "../lib/api.js";
  import { t, getLanguage, subscribe } from "../lib/i18n.js";

  let lang = $state(getLanguage());
  let avatars = $state<Avatar[]>([]);
  let jobs = $state<DigitalHumanJob[]>([]);
  let instance = $state<InstanceView | null>(null);
  let uploadName = $state("");
  let uploadFiles = $state<FileList | null>(null);
  let audioUrl = $state("");
  let selectedAvatarId = $state("");
  let busy = $state(false);
  let message = $state("");

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    load();
    loadInstance();
    const timer = setInterval(() => { loadInstance(); }, 10000);
    return () => { unsub(); clearInterval(timer); };
  });

  function tt(key: string): string { void lang; return t(key); }

  async function load() {
    const [a, j] = await Promise.all([fetchAvatars(), fetchDigitalHumanJobs()]);
    avatars = a;
    jobs = j;
  }

  async function loadInstance() {
    try {
      instance = await fetchInstanceStatus();
    } catch { /* 状态拉取失败不打断页面 */ }
  }

  function instanceStateLabel(state: InstanceView["state"]): string {
    return tt(state === "ready" ? "instanceStateReady" : "instanceStateOffline");
  }

  function avatarMediaUrl(a: Avatar): string | null {
    const mediaName = a.config?.mediaName as string | undefined;
    if (mediaName) {
      return `/api/digital-humans/avatars/${encodeURIComponent(a.id)}/media/${encodeURIComponent(mediaName)}`;
    }
    return a.preview_url ?? null;
  }

  async function handleUpload() {
    if (!uploadFiles?.length || !uploadName) return;
    busy = true;
    try {
      await uploadAvatar(uploadName, uploadFiles[0]);
      uploadName = "";
      uploadFiles = null;
      message = tt("avatarUploaded");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }

  async function handleDeleteAvatar(id: string) {
    if (!confirm(tt("confirmDeleteAvatar"))) return;
    try {
      await deleteAvatarApi(id);
      message = tt("avatarDeleted");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
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
      if (err instanceof ApiError && err.status === 409 && err.message.includes("开机")) {
        message = tt("powerOnFirst");
      } else {
        message = err instanceof Error ? err.message : String(err);
      }
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

  async function handleRegenerate(jobId: string) {
    if (!confirm(tt("confirmRegenerateJob"))) return;
    try {
      await regenerateDigitalHumanJob(jobId);
      message = tt("jobRegenerated");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleDeleteJob(jobId: string) {
    if (!confirm(tt("confirmDelete"))) return;
    try {
      await deleteDigitalHumanJob(jobId);
      message = tt("jobDeleted");
      await load();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }
</script>

<div class="page">
  <h1>{tt("digitalHumansTitle")}</h1>
  {#if message}<p class="message">{message}</p>{/if}

  <section class="panel instance-card">
    <div class="instance-head">
      <h2>{tt("instanceStatus")}</h2>
      {#if instance}
        <span class="state-dot state-{instance.state}"></span>
        <span class="state-label">{instanceStateLabel(instance.state)}</span>
        <span class="meta">GPU ¥{instance.gpuHourlyRateYuan}{tt("perHour")}</span>
      {/if}
    </div>
    {#if instance?.state === "offline"}
      <p class="hint">
        {tt("instanceOfflineHint")}
        <a href={instance.consoleUrl} target="_blank" rel="noopener">{tt("autodlConsole")}</a>
      </p>
    {/if}
    {#if instance && instance.state === "ready" && instance.idleMinutes >= instance.idleReminderMinutes}
      <p class="idle-banner">{tt("idleReminder").replace("{n}", String(instance.idleMinutes))}</p>
    {/if}
  </section>

  <section class="panel">
    <h2>{tt("uploadAvatar")}</h2>
    <div class="row">
      <input type="text" bind:value={uploadName} placeholder={tt("avatarName")} />
      <input type="file" accept="video/*" bind:files={uploadFiles} />
      <button class="btn-primary" disabled={busy} onclick={handleUpload}>{tt("uploadAvatar")}</button>
    </div>
  </section>

  <section class="panel">
    <h2>{tt("avatars")}</h2>
    <ul class="list">
      {#each avatars as a}
        <li class="avatar-card">
          {#if avatarMediaUrl(a)}
            <video controls preload="metadata" src={avatarMediaUrl(a)} class="thumb-video"></video>
          {/if}
          <div class="info">
            <span class="name">{a.name}</span>
            <span class="badge">{a.status}</span>
            <span class="meta">{a.source}</span>
          </div>
          <span class="spacer"></span>
          <button class="btn-sm" onclick={() => handleDeleteAvatar(a.id)}>{tt("delete")}</button>
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
          <div class="job-main">
            <span class="name">{j.id}</span>
            <span class="badge">{j.status}</span>
            <span class="meta">{j.progress}%</span>
            <span class="meta">{tt("actualCost")} ¥{j.actual_cost}</span>
            {#if j.error}<span class="error-text">{j.error}</span>{/if}
            {#if j.status === "done"}
              <video controls preload="metadata" src={`/api/digital-humans/jobs/${encodeURIComponent(j.id)}/output`} class="job-video"></video>
            {/if}
          </div>
          <span class="spacer"></span>
          <div class="job-actions">
            <button class="btn-sm" onclick={() => handleRefresh(j.id)}>{tt("refresh")}</button>
            <button class="btn-sm" onclick={() => handleRegenerate(j.id)}>{tt("regenerate")}</button>
            <button class="btn-sm" onclick={() => handleDeleteJob(j.id)}>{tt("delete")}</button>
            {#if j.status === "done"}
              <a class="btn-sm" href={`/api/digital-humans/jobs/${encodeURIComponent(j.id)}/output`} target="_blank">{tt("download")}</a>
            {/if}
          </div>
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
  .btn-sm { background: var(--accent-soft); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.3rem 0.6rem; text-decoration: none; cursor: pointer; }
  .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
  .message { color: var(--spark-red); margin-bottom: 1rem; }
  .list { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .avatar-card, .job-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
  .job-main { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; }
  .job-actions { display: flex; gap: 0.4rem; flex-shrink: 0; }
  .thumb-video { width: 120px; max-height: 90px; border-radius: 4px; background: #000; }
  .job-video { width: 240px; max-height: 160px; border-radius: 4px; background: #000; flex-basis: 100%; }
  .info { display: flex; flex-direction: column; gap: 0.25rem; }
  .name { font-weight: 600; }
  .badge { text-transform: uppercase; font-size: var(--size-xs); background: var(--accent-soft); padding: 0.15rem 0.4rem; border-radius: 4px; width: fit-content; }
  .meta { font-size: var(--size-sm); color: var(--text-muted); }
  .spacer { flex: 1; }
  .instance-head { display: flex; align-items: center; gap: 0.6rem; }
  .instance-head h2 { margin: 0; }
  .state-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .state-dot.state-offline { background: #6b6560; }
  .state-dot.state-ready { background: #22c55e; }
  .state-label { font-weight: 600; }
  .hint { font-size: var(--size-sm); color: var(--text-muted); margin-top: 0.5rem; }
  .hint a { color: var(--accent); }
  .idle-banner { font-size: var(--size-sm); color: #92600a; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px; padding: 0.5rem 0.75rem; margin-top: 0.75rem; }
  .error-text { font-size: var(--size-sm); color: var(--error); margin-top: 0.5rem; }
</style>
