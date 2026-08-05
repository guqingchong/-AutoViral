<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchAvatars, uploadAvatar, deleteAvatarApi, fetchDigitalHumanJobs,
    submitDigitalHumanJob, refreshDigitalHumanJob, deleteDigitalHumanJob,
    regenerateDigitalHumanJob, fetchInstanceStatus,
    fetchDigitalHumanBatchPending, runDigitalHumanBatch, fetchDigitalHumanBatchStatus,
    fetchRenderPool, renderNow,
    ApiError, type Avatar, type DigitalHumanJob, type InstanceView,
    type DigitalHumanBatchState, type RenderPoolView,
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
  let pendingCount = $state(0);
  let batch = $state<DigitalHumanBatchState | null>(null);
  let renderPool = $state<RenderPoolView | null>(null);
  let renderDoneBanner = $state(false);
  let renderBusy = $state(false);

  onMount(() => {
    const unsub = subscribe(() => { lang = getLanguage(); });
    load();
    loadInstance();
    loadPending();
    pollBatch();
    pollRenderPool();
    const timer = setInterval(() => { loadInstance(); }, 10000);
    const batchTimer = setInterval(() => { pollBatch(); }, 5000);
    const poolTimer = setInterval(() => { pollRenderPool(); }, 6000);
    return () => { unsub(); clearInterval(timer); clearInterval(batchTimer); clearInterval(poolTimer); };
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

  async function loadPending() {
    try {
      const data = await fetchDigitalHumanBatchPending();
      pendingCount = data.count;
    } catch { /* 待渲染计数拉取失败不打断页面 */ }
  }

  async function pollBatch() {
    try {
      const state = await fetchDigitalHumanBatchStatus();
      const wasRunning = batch?.running ?? false;
      batch = state;
      if (wasRunning && !state.running) {
        message = tt("batchFinished")
          .replace("{done}", String(state.done))
          .replace("{failed}", String(state.failed));
        await load();
        await loadPending();
      }
    } catch { /* 批量状态拉取失败不打断页面 */ }
  }

  async function handleBatchRun() {
    try {
      message = "";
      batch = await runDigitalHumanBatch();
      await loadPending();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
  }

  async function pollRenderPool() {
    try {
      const prev = renderPool;
      const view = await fetchRenderPool();
      renderPool = view;
      const wasActive = !!prev && (prev.items.length > 0 || prev.batch.running);
      const nowIdle = view.items.length === 0 && !view.batch.running;
      if (wasActive && nowIdle && view.batch.total > 0) {
        // 池刚清空且刚完成过批次 → 强提醒关机省费
        renderDoneBanner = true;
        await load();
      } else if (!nowIdle) {
        renderDoneBanner = false;
      }
    } catch { /* 渲染池拉取失败不打断页面 */ }
  }

  async function handleRenderNow() {
    if (!renderPool) return;
    // 实例离线：引导去 AutoDL 控制台开机；同时通知后端挂起待渲（pendingBoot），上线后自动开渲
    if (renderPool.instance.state !== "ready") {
      renderBusy = true;
      try {
        await renderNow();
      } catch { /* 挂起失败不阻塞开机引导 */ }
      window.open(renderPool.instance.consoleUrl, "_blank", "noopener");
      renderBusy = false;
      await pollRenderPool();
      return;
    }
    renderBusy = true;
    try {
      message = "";
      await renderNow();
      renderDoneBanner = false;
      await pollRenderPool();
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      renderBusy = false;
    }
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
    <h2>{tt("renderQueue")}</h2>
    {#if renderDoneBanner}
      <p class="done-banner">{tt("renderAllDone")}</p>
    {/if}
    {#if renderPool}
      {#if renderPool.items.length > 0}
        <ul class="list">
          {#each renderPool.items as item}
            <li class="pool-row">
              <span class="name">{item.title || item.workId || item.jobId}</span>
              {#if item.queuePosition !== null}
                <span class="meta">{tt("renderPoolQueueOrder").replace("{n}", String(item.queuePosition))}</span>
              {/if}
              <span class="badge">{item.status}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="meta">{tt("renderPoolEmpty")}</p>
      {/if}
      {#if renderPool.pendingBoot}
        <p class="pending-boot">{tt("pendingBootHint")}</p>
      {/if}
      <div class="row pool-actions">
        <span class="spacer"></span>
        <button
          class="btn-primary"
          disabled={renderBusy || renderPool.items.length === 0 || (renderPool.batch.running ?? false)}
          onclick={handleRenderNow}
        >
          {renderPool.instance.state === "ready" ? tt("renderNow") : tt("goPowerOn")}
        </button>
      </div>
      {#if renderPool.batch.running}
        <p class="meta batch-progress">{tt("batchRunning")} {tt("batchProgress")
          .replace("{submitted}", String(renderPool.batch.submitted))
          .replace("{total}", String(renderPool.batch.total))
          .replace("{done}", String(renderPool.batch.done))
          .replace("{failed}", String(renderPool.batch.failed))}
        </p>
      {/if}
    {:else}
      <p class="meta">{tt("loading")}</p>
    {/if}
  </section>

  <section class="panel">
    <h2>{tt("batchRender")}</h2>
    <div class="row">
      <span class="meta">
        {pendingCount > 0 ? tt("batchPendingCount").replace("{n}", String(pendingCount)) : tt("noPendingWorks")}
      </span>
      <span class="spacer"></span>
      <button class="btn-primary" disabled={pendingCount === 0 || (batch?.running ?? false)} onclick={handleBatchRun}>
        {tt("startBatchRender")}
      </button>
    </div>
    {#if batch && (batch.running || batch.total > 0)}
      <p class="meta batch-progress">
        {#if batch.running}{tt("batchRunning")} {/if}{tt("batchProgress")
          .replace("{submitted}", String(batch.submitted))
          .replace("{total}", String(batch.total))
          .replace("{done}", String(batch.done))
          .replace("{failed}", String(batch.failed))}
      </p>
      {#if batch.errors.length > 0}
        <ul class="list">
          {#each batch.errors as e}
            <li class="error-text">{e.workId}: {e.error}</li>
          {/each}
        </ul>
      {/if}
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
  .batch-progress { margin-top: 0.75rem; }
  .pool-row { display: flex; align-items: center; gap: 0.75rem; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 0.6rem 0.8rem; }
  .pool-actions { margin-top: 0.75rem; }
  .pending-boot { font-size: var(--size-sm); color: #92600a; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 4px; padding: 0.5rem 0.75rem; margin-top: 0.75rem; }
  .done-banner { font-weight: 600; color: #166534; background: #dcfce7; border: 1px solid #22c55e; border-radius: 4px; padding: 0.6rem 0.8rem; margin: 0 0 0.75rem; }
</style>
