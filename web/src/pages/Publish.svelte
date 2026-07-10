<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";
  import { publishTarget, type PublishTarget } from "../lib/navigation.js";
  import { fetchRenderJobs } from "../lib/api.js";

  type Account = { id: string; platform: string; display_name: string; status: string };
  type RenderJob = { id: string; work_id?: string; output_path?: string; status: string };
  type Job = { id: string; platform: string; title: string; status: string; post_url?: string; error?: string };
  type Violation = { platform: string; word: string; severity: string; context: string };

  let accounts = $state<Account[]>([]);
  let renderJobs = $state<RenderJob[]>([]);
  let jobs = $state<Job[]>([]);
  let selectedAccounts = $state<string[]>([]);
  let title = $state("");
  let content = $state("");
  let workId = $state("");
  let renderJobId = $state("");
  let mediaPath = $state("");
  let error = $state("");
  let loadError = $state("");
  let complianceViolations = $state<Violation[]>([]);
  let showComplianceDialog = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubPublish: (() => void) | null = null;
  let loading = $state(true);
  let destroyed = $state(false);

  async function loadAccounts() {
    try {
      loadError = "";
      const res = await fetch("/api/publish/accounts");
      const data = await res.json();
      if (!destroyed) accounts = data.accounts ?? [];
    } catch {
      if (!destroyed) loadError = t("publishLoadError");
    }
  }

  let renderJobsLoaded = $state(false);

  async function loadRenderJobs() {
    try {
      loadError = "";
      const all = await fetchRenderJobs();
      if (destroyed) return;
      renderJobs = all.filter((j) => j.status === "completed");
      renderJobsLoaded = true;
    } catch {
      if (!destroyed) {
        loadError = t("publishLoadError");
        renderJobsLoaded = true;
      }
    }
  }

  async function loadJobs() {
    try {
      loadError = "";
      const res = await fetch("/api/publish/jobs");
      const data = await res.json();
      if (!destroyed) jobs = data.jobs ?? [];
    } catch {
      if (!destroyed) loadError = t("publishLoadError");
    }
  }

  async function handlePublish(force = false) {
    error = "";
    complianceViolations = [];
    showComplianceDialog = false;

    try {
      const res = await fetch("/api/publish/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workId, renderJobId, accountIds: selectedAccounts, title, content, mediaPath, forcePublish: force }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.compliance?.violations?.length) {
          complianceViolations = data.compliance.violations;
          showComplianceDialog = true;
        } else {
          error = data.error ?? t("publishFailed");
        }
        return;
      }
      await loadJobs();
    } catch {
      error = t("publishFailed");
    }
  }

  function selectRenderJob(jobId: string) {
    const job = renderJobs.find((j) => j.id === jobId);
    if (!job) return;
    renderJobId = job.id;
    workId = job.work_id ?? "";
    mediaPath = job.output_path ?? "";
  }

  function applyPublishTarget(target: PublishTarget) {
    if (target.renderJobId) {
      renderJobId = target.renderJobId;
      selectRenderJob(target.renderJobId);
    }
    if (target.workId) workId = target.workId;
    if (target.mediaPath) mediaPath = target.mediaPath;
  }

  async function handleRetry(jobId: string) {
    try {
      const res = await fetch(`/api/publish/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        try {
          const data = await res.json();
          error = data.error || "Retry failed";
        } catch {
          error = "Retry failed";
        }
        return;
      }
      await loadJobs();
    } catch (err) {
      error = String(err);
    }
  }

  async function scheduleLoadJobs() {
    await loadJobs();
    if (!destroyed) {
      timer = setTimeout(scheduleLoadJobs, 3000);
    }
  }

  onMount(() => {
    loading = true;
    const accountsPromise = loadAccounts();

    // Subscribe to publishTarget immediately so we never miss a navigation event
    let pendingTarget: PublishTarget | null = null;
    unsubPublish = publishTarget.subscribe((target) => {
      if (target) {
        if (!renderJobsLoaded) {
          pendingTarget = target;
        } else {
          applyPublishTarget(target);
        }
        publishTarget.set(null);
      }
    });

    const renderPromise = loadRenderJobs().then(() => {
      if (pendingTarget) {
        applyPublishTarget(pendingTarget);
        pendingTarget = null;
      }
    });

    const jobsPromise = scheduleLoadJobs();

    Promise.all([accountsPromise, renderPromise, jobsPromise]).finally(() => {
      if (!destroyed) loading = false;
    });

    return () => {
      destroyed = true;
      if (timer) clearTimeout(timer);
      if (unsubPublish) unsubPublish();
    };
  });
</script>

{#if loading}
  <div class="loading-state">
    <div class="loader"></div>
    <p>{t("loading")}</p>
  </div>
{:else}

<div class="publish-page">
  <header class="page-header">
    <h1>{t("publishTitle")}</h1>
  </header>

  {#if loadError}
    <p class="load-error">{loadError}</p>
  {/if}

  <section>
    <h2>{t("publishSelectRenderJob")}</h2>
    <select value={renderJobId} onchange={(e) => selectRenderJob(e.currentTarget.value)}>
      <option value="">-- {t("publishSelectRenderJob")} --</option>
      {#each renderJobs as job}
        <option value={job.id}>{job.id} {job.output_path ? `— ${job.output_path}` : ""}</option>
      {/each}
    </select>
  </section>

  <section>
    <h2>{t("publishAccounts")}</h2>
    {#each accounts as account}
      <label>
        <input type="checkbox" bind:group={selectedAccounts} value={account.id} />
        {account.display_name} ({account.platform})
      </label>
    {/each}
  </section>

  <section>
    <h2>{t("publishContent")}</h2>
    <label>{t("publishTitleLabel")} <input type="text" bind:value={title} /></label>
    <label>{t("publishContentLabel")} <textarea bind:value={content}></textarea></label>
    <label>{t("publishMediaPath")} <input type="text" bind:value={mediaPath} /></label>
    <button onclick={() => handlePublish(false)} disabled={selectedAccounts.length === 0}>{t("publishPublishButton")}</button>
    {#if error}<p class="error">{error}</p>{/if}
  </section>

  {#if showComplianceDialog}
    <div class="compliance-dialog" role="dialog" aria-modal="true">
      <h3>{t("publishComplianceWarning")}</h3>
      <ul>
        {#each complianceViolations as v}
          <li><strong>{v.word}</strong> ({v.severity}) — {v.context}</li>
        {/each}
      </ul>
      <button onclick={() => handlePublish(true)}>{t("publishForcePublish")}</button>
      <button onclick={() => showComplianceDialog = false}>{t("cancel")}</button>
    </div>
  {/if}

  <section>
    <h2>{t("publishJobs")}</h2>
    {#each jobs as job}
      <div class="job-row">
        <span>{job.platform}</span>
        <span>{job.status}</span>
        {#if job.post_url}
          <a href={job.post_url} target="_blank">{t("publishPostLink")}</a>
        {/if}
        {#if job.error}
          <span class="error">{job.error}</span>
          <button onclick={() => handleRetry(job.id)}>{t("publishRetry")}</button>
        {/if}
      </div>
    {/each}
  </section>
</div>
{/if}

<style>
  .publish-page { padding: 1rem 0; }
  .page-header { margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  section { margin-bottom: 1.5rem; }
  label { display: block; margin: 0.5rem 0; }
  input, textarea, select { display: block; width: 100%; margin-top: 0.25rem; }
  .error { color: var(--error); }
  .load-error { color: var(--error); background: var(--error-soft); padding: 0.5rem 0.75rem; border-radius: var(--card-radius); margin-bottom: 1rem; }
  .compliance-dialog { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .job-row { display: flex; gap: 1rem; align-items: center; padding: 0.5rem 0; }

  /* Loading */
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
</style>
