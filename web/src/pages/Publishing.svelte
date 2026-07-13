<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";
  import {
    fetchWorks,
    publishWorkToPlatform,
    triggerWorkPublishLogin,
    fetchWorkPublishRecords,
    getWorkPublishFallbackUrl,
    type WorkSummary,
    type PublishRecord,
  } from "../lib/api.js";

  const PLATFORMS = [
    { key: "douyin", label: "抖音", supportsLogin: true },
    { key: "xiaohongshu", label: "小红书", supportsLogin: true },
    { key: "channels", label: "视频号", supportsLogin: false },
  ];

  let works: WorkSummary[] = $state([]);
  let selectedWorkId: string = $state("");
  let publishRecords: PublishRecord[] = $state([]);
  let loading = $state(true);
  let publishing: Record<string, boolean> = $state({});
  let loggingIn: Record<string, boolean> = $state({});
  let message: string = $state("");
  let messageType: "success" | "error" = $state("success");
  let destroyed = $state(false);

  const selectedWork = $derived(works.find((w) => w.id === selectedWorkId));

  async function loadWorks() {
    try {
      works = await fetchWorks();
    } catch {
      // silently fail
    }
  }

  async function loadRecords() {
    if (!selectedWorkId) return;
    try {
      publishRecords = await fetchWorkPublishRecords(selectedWorkId);
    } catch {
      publishRecords = [];
    }
  }

  async function handlePublish(platform: string) {
    if (!selectedWorkId) return;
    publishing = { ...publishing, [platform]: true };
    message = "";
    try {
      const result = await publishWorkToPlatform(selectedWorkId, platform, {});
      showMessage(result.status === "published" ? "success" : "error",
        result.status === "published"
          ? `${platform} ${t("publishSuccess")}`
          : `${platform} ${t("publishFallback")}: ${result.error ?? ""}`);
      await loadRecords();
    } catch (err) {
      showMessage("error", `${platform} ${t("publishFailed")}: ${String(err)}`);
    } finally {
      publishing = { ...publishing, [platform]: false };
    }
  }

  async function handleLogin(platform: string) {
    if (!selectedWorkId) return;
    loggingIn = { ...loggingIn, [platform]: true };
    message = "";
    try {
      const result = await triggerWorkPublishLogin(selectedWorkId, platform);
      showMessage(result.success ? "success" : "error",
        result.success
          ? `${platform} ${t("loginSuccess")}`
          : `${platform} ${t("loginFailed")}`);
    } catch (err) {
      showMessage("error", `${platform} ${t("loginFailed")}: ${String(err)}`);
    } finally {
      loggingIn = { ...loggingIn, [platform]: false };
    }
  }

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 5000);
  }

  function statusLabel(status: string): string {
    const map: Record<string, string> = {
      pending: t("pubStatusPending"),
      publishing: t("pubStatusPublishing"),
      published: t("pubStatusPublished"),
      failed: t("pubStatusFailed"),
      fallback: t("pubStatusFallback"),
      scheduled: t("pubStatusScheduled"),
    };
    return map[status] ?? status;
  }

  $effect(() => {
    if (selectedWorkId) {
      loadRecords();
    }
  });

  onMount(async () => {
    await loadWorks();
    if (!destroyed) loading = false;
    return () => { destroyed = true; };
  });
</script>

<div class="publishing-page">
  <header class="page-header">
    <h1>{t("publishingTitle")}</h1>
    <p class="subtitle">{t("publishingSubtitle")}</p>
  </header>

  {#if loading}
    <div class="loading-state">
      <div class="loader"></div>
      <p>{t("loading")}</p>
    </div>
  {:else}
    <!-- Work Selector -->
    <section class="work-selector">
      <label class="field-label">{t("selectWork")}</label>
      <select
        bind:value={selectedWorkId}
        class="work-select"
        onchange={() => { message = ""; }}
      >
        <option value="">-- {t("selectWork")} --</option>
        {#each works.filter((w) => w.status === "ready" || w.status === "published" || w.status === "draft") as work}
          <option value={work.id}>
            {work.title} — {work.status} — {work.type}
          </option>
        {/each}
      </select>
    </section>

    {#if selectedWork}
      <!-- Work Info -->
      <section class="work-info">
        <div class="info-card">
          <span class="info-label">{t("title")}</span>
          <span class="info-value">{selectedWork.title}</span>
        </div>
        <div class="info-card">
          <span class="info-label">{t("status")}</span>
          <span class="info-value status-badge" class:ready={selectedWork.status === "ready"}>{selectedWork.status}</span>
        </div>
      </section>

      <!-- Platform Actions -->
      <section class="platform-actions">
        <h2>{t("publishToPlatform")}</h2>
        <div class="platform-grid">
          {#each PLATFORMS as plat}
            <div class="platform-card">
              <div class="plat-header">
                <span class="plat-name">{plat.label}</span>
              </div>
              <div class="plat-actions">
                <button
                  class="btn-publish"
                  onclick={() => handlePublish(plat.key)}
                  disabled={publishing[plat.key]}
                >
                  {#if publishing[plat.key]}
                    <span class="spin-inline"></span>
                  {/if}
                  {t("publish")}
                </button>
                {#if plat.supportsLogin}
                  <button
                    class="btn-login"
                    onclick={() => handleLogin(plat.key)}
                    disabled={loggingIn[plat.key]}
                  >
                    {#if loggingIn[plat.key]}
                      <span class="spin-inline"></span>
                    {/if}
                    {t("login")}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </section>

      <!-- Message -->
      {#if message}
        <div class="message" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>
          {message}
        </div>
      {/if}

      <!-- Publish Records -->
      <section class="records-section">
        <h2>{t("publishRecords")}</h2>
        {#if publishRecords.length === 0}
          <p class="empty-hint">{t("noPublishRecords")}</p>
        {:else}
          <div class="records-table-wrap">
            <table class="records-table">
              <thead>
                <tr>
                  <th>{t("platform")}</th>
                  <th>{t("status")}</th>
                  <th>{t("postUrl")}</th>
                  <th>{t("actions")}</th>
                </tr>
              </thead>
              <tbody>
                {#each publishRecords as record}
                  <tr>
                    <td>{record.platform}</td>
                    <td>
                      <span class="status-chip" class:chip-published={record.status === "published"} class:chip-failed={record.status === "failed"} class:chip-fallback={record.status === "fallback"}>
                        {statusLabel(record.status)}
                      </span>
                    </td>
                    <td>
                      {#if record.postUrl}
                        <a href={record.postUrl} target="_blank" rel="noopener noreferrer" class="post-link">{t("viewPost")}</a>
                      {:else if record.error}
                        <span class="error-text" title={record.error}>{record.error.slice(0, 40)}…</span>
                      {/if}
                    </td>
                    <td>
                      {#if record.status === "fallback"}
                        <a
                          href={getWorkPublishFallbackUrl(selectedWorkId, record.platform)}
                          class="download-link"
                          download
                        >
                          {t("downloadFallback")}
                        </a>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
  .publishing-page {
    max-width: 900px;
    margin: 0 auto;
    padding: 1rem 0;
  }

  .page-header {
    margin-bottom: 2rem;
  }

  .page-header h1 {
    font-family: var(--font-display);
    font-size: var(--size-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
    margin: 0;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: var(--size-sm);
    margin-top: 0.3rem;
  }

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

  /* Work Selector */
  .work-selector {
    margin-bottom: 1.5rem;
  }

  .field-label {
    display: block;
    font-size: var(--size-sm);
    font-weight: 600;
    color: var(--text-secondary);
    margin-bottom: 0.5rem;
  }

  .work-select {
    width: 100%;
    padding: 0.6rem 0.75rem;
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    font-family: var(--font-body);
    font-size: var(--size-base);
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236b6560' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    cursor: pointer;
    transition: border-color var(--transition-fast);
  }

  .work-select:focus {
    outline: none;
    border-color: var(--text-muted);
  }

  /* Work Info */
  .work-info {
    display: flex;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .info-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 0.75rem 1rem;
    flex: 1;
  }

  .info-label {
    font-size: var(--size-xs);
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .info-value {
    font-size: var(--size-base);
    font-weight: 500;
  }

  .status-badge.ready {
    color: var(--success);
  }

  /* Platform Actions */
  .platform-actions {
    margin-bottom: 1.5rem;
  }

  .platform-actions h2 {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    margin-bottom: 1rem;
  }

  .platform-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 0.75rem;
  }

  .platform-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1rem;
  }

  .plat-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .plat-name {
    font-family: var(--font-display);
    font-size: var(--size-base);
    font-weight: 600;
  }

  .plat-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-publish {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    background: var(--spark-red);
    color: #fff;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .btn-publish:hover:not(:disabled) { opacity: 0.85; }
  .btn-publish:disabled { opacity: 0.5; cursor: not-allowed; }

  .btn-login {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-login:hover:not(:disabled) {
    border-color: var(--text-dim);
    color: var(--text);
  }

  .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }

  .spin-inline {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    display: inline-block;
  }

  /* Message */
  .message {
    padding: 0.65rem 1rem;
    border-radius: var(--card-radius);
    font-size: var(--size-sm);
    font-weight: 500;
    margin-bottom: 1.5rem;
  }

  .msg-success {
    background: var(--success-soft);
    color: var(--success);
  }

  .msg-error {
    background: var(--error-soft);
    color: var(--error);
  }

  /* Records */
  .records-section h2 {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    margin-bottom: 1rem;
  }

  .empty-hint {
    color: var(--text-dim);
    font-size: var(--size-sm);
  }

  .records-table-wrap {
    overflow-x: auto;
  }

  .records-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--size-sm);
  }

  .records-table th {
    text-align: left;
    padding: 0.5rem 0.75rem;
    font-weight: 600;
    color: var(--text-muted);
    font-size: var(--size-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
  }

  .records-table td {
    padding: 0.6rem 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
    vertical-align: middle;
  }

  .status-chip {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    font-size: var(--size-xs);
    font-weight: 600;
    background: var(--bg-inset);
    color: var(--text-dim);
  }

  .chip-published {
    background: var(--success-soft);
    color: var(--success);
  }

  .chip-failed {
    background: var(--error-soft);
    color: var(--error);
  }

  .chip-fallback {
    background: var(--info-soft);
    color: var(--info);
  }

  .post-link {
    color: var(--spark-red);
    text-decoration: none;
    font-weight: 500;
  }

  .post-link:hover { text-decoration: underline; }

  .error-text {
    color: var(--error);
  }

  .download-link {
    color: var(--info);
    text-decoration: none;
    font-weight: 500;
    font-size: var(--size-xs);
  }

  .download-link:hover { text-decoration: underline; }
</style>
