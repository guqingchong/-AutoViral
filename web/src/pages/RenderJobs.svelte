<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRenderJobs, type RenderJob } from "../lib/api.js";
  import { publishTarget } from "../lib/navigation.js";
  import { t } from "../lib/i18n.js";

  let jobs = $state<RenderJob[]>([]);
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval>;

  async function load() {
    jobs = await fetchRenderJobs();
    loading = false;
  }

  function formatTime(seconds?: number): string {
    if (!seconds) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  onMount(() => {
    load();
    timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  });
</script>

<div class="jobs-page">
  <header class="page-header">
    <h1>{t("renderJobsTitle")}</h1>
  </header>

  {#if loading}
    <p class="empty">{t("loading")}</p>
  {:else if jobs.length === 0}
    <p class="empty">{t("noRenderJobs")}</p>
  {:else}
    <div class="job-list">
      {#each jobs as job}
        <article class="job-row" data-status={job.status}>
          <div class="job-info">
            <span class="job-id">{job.id}</span>
            <span class="job-status">{t(`jobStatus${job.status.charAt(0).toUpperCase() + job.status.slice(1)}`)}</span>
          </div>
          <div class="progress-wrap">
            <div class="progress-bar" style="width: {job.progress}%"></div>
          </div>
          <div class="job-meta">
            <span>{formatTime(job.current_time)} / {formatTime(job.duration)}</span>
            {#if job.error}
              <span class="error">{job.error}</span>
            {/if}
            {#if job.status === "completed"}
              <button onclick={() => publishTarget.set({ renderJobId: job.id, workId: job.work_id, mediaPath: job.output_path })}>
                {t("publishGoToPublish")}
              </button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .jobs-page { padding: 1rem 0; }
  .page-header { margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .empty { color: var(--text-muted); padding: 2rem 0; }
  .job-list { display: flex; flex-direction: column; gap: 0.75rem; }
  .job-row { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .job-info { display: flex; justify-content: space-between; align-items: center; }
  .job-id { font-family: monospace; font-size: var(--size-xs); color: var(--text-muted); }
  .job-status { font-size: var(--size-xs); text-transform: capitalize; color: var(--text-secondary); }
  .progress-wrap { height: 6px; background: var(--bg-inset); border-radius: 3px; overflow: hidden; }
  .progress-bar { height: 100%; background: var(--spark-red); transition: width 0.3s ease; }
  .job-meta { display: flex; justify-content: space-between; font-size: var(--size-xs); color: var(--text-muted); }
  .error { color: var(--error); }
</style>
