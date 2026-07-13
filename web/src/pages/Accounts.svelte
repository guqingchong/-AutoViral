<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";
  import {
    fetchAccounts,
    createAccountApi,
    updateAccountApi,
    deleteAccountApi,
    ApiError,
    type Account,
  } from "../lib/api.js";

  const PLATFORMS = [
    { key: "douyin", labelKey: "accountPlatformDouyin" },
    { key: "xiaohongshu", labelKey: "accountPlatformXiaohongshu" },
  ];

  let accounts: Account[] = $state([]);
  let loading = $state(true);
  let message: string = $state("");
  let messageType: "success" | "error" = $state("");
  let destroyed = $state(false);

  // Form state
  let editing: Account | null = $state(null);
  let creating = $state(false);
  let formName = $state("");
  let formPlatform = $state("douyin");
  let formStatus = $state("active");
  let formToneJson = $state("{}");
  let formBusy = $state(false);
  let formError = $state("");

  const showForm = $derived(creating || editing !== null);
  const formTitle = $derived(editing ? t("accountEdit") : t("accountNew"));

  async function load() {
    try {
      accounts = await fetchAccounts();
    } catch {
      // silently fail
    } finally {
      loading = false;
    }
  }

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 4000);
  }

  function resetForm() {
    editing = null;
    creating = false;
    formName = "";
    formPlatform = "douyin";
    formStatus = "active";
    formToneJson = "{}";
    formError = "";
    formBusy = false;
  }

  function startCreate() {
    resetForm();
    creating = true;
  }

  function startEdit(account: Account) {
    resetForm();
    editing = account;
    formName = account.name;
    formPlatform = account.platform;
    formStatus = account.status;
    formToneJson = JSON.stringify(account.tone_profile, null, 2);
  }

  async function handleSave() {
    formError = "";
    if (!formName.trim()) { formError = t("accountName") + " " + t("fieldRequired"); return; }

    let toneProfile: Record<string, unknown> = {};
    try {
      toneProfile = JSON.parse(formToneJson);
      if (typeof toneProfile !== "object" || Array.isArray(toneProfile)) {
        formError = "Style profile must be a JSON object"; return;
      }
    } catch {
      formError = "Invalid JSON in style profile"; return;
    }

    formBusy = true;
    try {
      if (editing) {
        await updateAccountApi(editing.id, {
          name: formName.trim(),
          platform: formPlatform,
          tone_profile: toneProfile,
          status: formStatus,
        });
        showMessage("success", t("saved"));
      } else {
        await createAccountApi({
          name: formName.trim(),
          platform: formPlatform,
          tone_profile: toneProfile,
        });
        showMessage("success", t("accountCreated"));
      }
      resetForm();
      await load();
    } catch (err) {
      formError = String(err);
    } finally {
      formBusy = false;
    }
  }

  async function handleDelete(account: Account) {
    if (!confirm(t("accountDeleteConfirm"))) return;
    try {
      await deleteAccountApi(account.id);
      showMessage("success", t("accountDeleted"));
      await load();
    } catch (err: any) {
      showMessage("error", err instanceof ApiError && err.code === "ACCOUNT_REFERENCED"
        ? t("accountDeleteRejected")
        : err.message || String(err));
    }
  }

  function platformLabel(key: string): string {
    const p = PLATFORMS.find((p) => p.key === key);
    return p ? t(p.labelKey) : key;
  }

  onMount(() => {
    load();
    return () => { destroyed = true; };
  });
</script>

<div class="page">
  <div class="page-header">
    <div>
      <h1>{t("accountsTitle")}</h1>
      {#if !loading && accounts.length === 0}
        <p class="subtitle">{t("accountCreateFirst")}</p>
      {/if}
    </div>
    <button class="btn-new" onclick={startCreate}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      {t("accountNew")}
    </button>
  </div>

  {#if message}
    <div class="msg" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>
      {message}
    </div>
  {/if}

  {#if loading}
    <p class="empty">{t("loading")}</p>
  {:else if accounts.length === 0}
    <div class="empty-state">
      <p class="empty">{t("accountNoAccounts")}</p>
      <p class="empty-hint">{t("accountCreateFirst")}</p>
    </div>
  {:else}
    <div class="card-grid">
      {#each accounts as account}
        <div class="acct-card" class:acct-inactive={account.status === "inactive"}>
          <div class="acct-head">
            <span class="acct-platform-badge">{platformLabel(account.platform)}</span>
            <span class="acct-status" class:active={account.status === "active"} class:inactive={account.status === "inactive"}>
              {account.status === "active" ? t("accountStatusActive") : t("accountStatusInactive")}
            </span>
          </div>
          <h3 class="acct-name">{account.name}</h3>
          <div class="acct-tone">
            <span class="acct-label">{t("accountTone")}</span>
            <code>{JSON.stringify(account.tone_profile)}</code>
          </div>
          <div class="acct-actions">
            <button class="btn-sm" onclick={() => startEdit(account)}>{t("accountEdit")}</button>
            <button class="btn-sm btn-danger" onclick={() => handleDelete(account)}>{t("accountDelete")}</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Create / Edit Modal -->
  {#if showForm}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="overlay" onclick={resetForm}></div>
    <div class="modal">
      <h2>{formTitle}</h2>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <label class="field">
        <span class="field-label">{t("accountName")}</span>
        <input type="text" bind:value={formName} placeholder={t("accountName")} />
      </label>
      <label class="field">
        <span class="field-label">{t("accountPlatform")}</span>
        <select bind:value={formPlatform}>
          {#each PLATFORMS as p}
            <option value={p.key}>{t(p.labelKey)}</option>
          {/each}
        </select>
      </label>
      <label class="field">
        <span class="field-label">{t("accountStatus")}</span>
        <select bind:value={formStatus}>
          <option value="active">{t("accountStatusActive")}</option>
          <option value="inactive">{t("accountStatusInactive")}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{t("accountToneEditor")}</span>
        <textarea bind:value={formToneJson} rows="5" placeholder={`{"voice": "professional", "keywords": ["trendy"]}`}></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn-save" onclick={handleSave} disabled={formBusy}>
          {formBusy ? t("saving") : t("accountSave")}
        </button>
        <button class="btn-cancel" onclick={resetForm}>{t("accountCancel")}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .page {
    max-width: 960px;
    margin: 0 auto;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1.5rem;
  }

  .page-header h1 {
    font-family: var(--font-display);
    font-size: var(--size-2xl);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  .subtitle {
    color: var(--text-muted);
    font-size: var(--size-sm);
    margin-top: 0.25rem;
  }

  .btn-new {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 1rem;
    background: var(--spark-red);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .btn-new:hover { opacity: 0.85; }

  .msg {
    padding: 0.6rem 1rem;
    border-radius: 4px;
    font-size: var(--size-sm);
    font-weight: 500;
    margin-bottom: 1rem;
  }

  .msg-success { background: var(--success-soft); color: var(--success); }
  .msg-error { background: var(--error-soft); color: var(--error); }

  .empty-state { text-align: center; padding: 3rem 1rem; }
  .empty { color: var(--text-muted); font-size: var(--size-lg); }
  .empty-hint { color: var(--text-dim); font-size: var(--size-sm); margin-top: 0.5rem; }

  /* Card grid */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 1rem;
  }

  .acct-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: border-color var(--transition-fast), opacity var(--transition-fast);
  }

  .acct-card:hover { border-color: var(--border); }

  .acct-inactive { opacity: 0.55; }

  .acct-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .acct-platform-badge {
    font-size: var(--size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--text-secondary);
  }

  .acct-status {
    font-size: var(--size-xs);
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
  }

  .acct-status.active { background: var(--success-soft); color: var(--success); }
  .acct-status.inactive { background: var(--accent-soft); color: var(--text-dim); }

  .acct-name {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .acct-tone {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .acct-label {
    font-size: var(--size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }

  .acct-tone code {
    font-size: var(--size-xs);
    color: var(--text-secondary);
    background: var(--bg-inset);
    padding: 0.3rem 0.5rem;
    border-radius: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.25rem;
  }

  .btn-sm {
    padding: 0.3rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-family: var(--font-body);
    font-size: var(--size-xs);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-sm:hover { color: var(--text); border-color: var(--text-dim); }

  .btn-danger { color: var(--error); border-color: transparent; }
  .btn-danger:hover { background: var(--error-soft); color: var(--error); }

  /* Modal */
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 900;
    animation: fadeIn 0.15s ease;
  }

  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(440px, 92vw);
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    padding: 1.5rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    box-shadow: var(--shadow-lg);
  }

  .modal h2 {
    font-family: var(--font-display);
    font-size: var(--size-xl);
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .form-error {
    font-size: var(--size-sm);
    color: var(--error);
    background: var(--error-soft);
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .field-label {
    font-size: var(--size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }

  input, textarea, select {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 0.65rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    resize: vertical;
  }

  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--text-dim);
  }

  textarea {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: var(--size-xs);
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .btn-save {
    padding: 0.5rem 1.1rem;
    background: var(--text);
    color: var(--bg);
    border: none;
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 600;
    cursor: pointer;
    transition: opacity var(--transition-fast);
  }

  .btn-save:hover:not(:disabled) { opacity: 0.8; }
  .btn-save:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-cancel {
    padding: 0.5rem 1rem;
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: var(--font-body);
    font-size: var(--size-sm);
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn-cancel:hover { color: var(--text); border-color: var(--text-dim); }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
