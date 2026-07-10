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
  let complianceViolations = $state<Violation[]>([]);
  let showComplianceDialog = $state(false);
  let timer: ReturnType<typeof setInterval>;
  let unsubPublish: (() => void) | null = null;

  async function loadAccounts() {
    const res = await fetch("/api/publish/accounts");
    const data = await res.json();
    accounts = data.accounts ?? [];
  }

  async function loadRenderJobs() {
    const all = await fetchRenderJobs();
    renderJobs = all.filter((j) => j.status === "completed");
  }

  async function loadJobs() {
    const res = await fetch("/api/publish/jobs");
    const data = await res.json();
    jobs = data.jobs ?? [];
  }

  async function handlePublish(force = false) {
    error = "";
    complianceViolations = [];
    showComplianceDialog = false;

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

  onMount(() => {
    loadAccounts();
    loadRenderJobs().then(() => {
      unsubPublish = publishTarget.subscribe((target) => {
        if (target) {
          applyPublishTarget(target);
          publishTarget.set(null);
        }
      });
    });
    loadJobs();
    timer = setInterval(loadJobs, 3000);

    return () => {
      clearInterval(timer);
      if (unsubPublish) unsubPublish();
    };
  });
</script>

<div class="publish-page">
  <header class="page-header">
    <h1>{t("publishTitle")}</h1>
  </header>

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
    <button onclick={() => handlePublish(false)}>{t("publishPublishButton")}</button>
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
          <button onclick={() => fetch(`/api/publish/jobs/${job.id}/retry`, { method: "POST" }).then(loadJobs)}>{t("publishRetry")}</button>
        {/if}
      </div>
    {/each}
  </section>
</div>

<style>
  .publish-page { padding: 1rem 0; }
  .page-header { margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  section { margin-bottom: 1.5rem; }
  label { display: block; margin: 0.5rem 0; }
  input, textarea, select { display: block; width: 100%; margin-top: 0.25rem; }
  .error { color: var(--error); }
  .compliance-dialog { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .job-row { display: flex; gap: 1rem; align-items: center; padding: 0.5rem 0; }
</style>
