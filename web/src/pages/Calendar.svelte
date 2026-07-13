<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18n.js";
  import {
    fetchCalendarMonth,
    createScheduleEntry,
    updateScheduleEntry,
    deleteScheduleEntry,
    fetchAccounts,
    type ScheduleEntry,
    type Account,
  } from "../lib/api.js";

  const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WEEKDAYS_ZH = ["日", "一", "二", "三", "四", "五", "六"];
  const COLORS = ["#FE2C55", "#FF6B35", "#FFD23F", "#2EC4B6", "#4361EE", "#7209B7", "#F72585", "#4CC9F0"];

  let entries: ScheduleEntry[] = $state([]);
  let counts: Record<string, number> = $state({});
  let accounts: Account[] = $state([]);
  let loading = $state(true);
  let selectedDate: string | null = $state(null);
  let message = $state("");
  let messageType = $state<"success" | "error">("");
  let destroyed = $state(false);

  // Current month as YYYY-MM
  let currentMonth: string = $state("");

  // Form state
  let editing: ScheduleEntry | null = $state(null);
  let creating = $state(false);
  let formTitle = $state("");
  let formDate = $state("");
  let formTime = $state("");
  let formPlatform = $state("");
  let formContentType = $state("short-video");
  let formStatus = $state("planned");
  let formAccountId = $state("");
  let formWorkId = $state("");
  let formDescription = $state("");
  let formColor = $state(COLORS[0]);
  let formBusy = $state(false);
  let formError = $state("");

  const showForm = $derived(creating || editing !== null);
  const formTitleLabel = $derived(editing ? t("scheduleEdit") : t("scheduleNew"));

  // Calendar computation
  const calendarGrid = $derived.by(() => {
    const [year, month] = currentMonth.split("-").map(Number);
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const startDayOfWeek = firstDay.getDay();
    const daysInMonth = lastDay.getDate();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const weeks: Array<Array<{ day: number | null; dateStr: string; isToday: boolean; isSelected: boolean; count: number }>> = [];
    let currentWeek: typeof weeks[0] = [];

    // Leading blanks
    for (let i = 0; i < startDayOfWeek; i++) {
      currentWeek.push({ day: null, dateStr: "", isToday: false, isSelected: false, count: 0 });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dd = String(d).padStart(2, "0");
      currentWeek.push({
        day: d,
        dateStr,
        isToday: dateStr === todayStr,
        isSelected: dateStr === selectedDate,
        count: counts[dd] || 0,
      });

      if (currentWeek.length === 7) {
        weeks.push(currentWeek);
        currentWeek = [];
      }
    }

    // Trailing blanks
    if (currentWeek.length > 0) {
      while (currentWeek.length < 7) {
        currentWeek.push({ day: null, dateStr: "", isToday: false, isSelected: false, count: 0 });
      }
      weeks.push(currentWeek);
    }

    return weeks;
  });

  const dayEntries = $derived(
    selectedDate ? entries.filter((e) => e.scheduled_date === selectedDate) : []
  );

  function initMonth() {
    const now = new Date();
    currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    selectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  }

  initMonth();

  async function loadData() {
    try {
      const [data, accts] = await Promise.all([
        fetchCalendarMonth(currentMonth),
        fetchAccounts(),
      ]);
      entries = data.entries;
      counts = data.counts;
      accounts = accts;
    } catch {
      // silently fail
    } finally {
      loading = false;
    }
  }

  async function navigateMonth(delta: number) {
    loading = true;
    const [year, month] = currentMonth.split("-").map(Number);
    const d = new Date(year, month - 1 + delta, 1);
    currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    selectedDate = null;
    await loadData();
  }

  async function goToday() {
    loading = true;
    const now = new Date();
    currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    selectedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await loadData();
  }

  function selectDate(dateStr: string) {
    selectedDate = dateStr;
  }

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 4000);
  }

  function resetForm() {
    editing = null;
    creating = false;
    formTitle = "";
    formDate = "";
    formTime = "";
    formPlatform = "";
    formContentType = "short-video";
    formStatus = "planned";
    formAccountId = "";
    formWorkId = "";
    formDescription = "";
    formColor = COLORS[0];
    formError = "";
    formBusy = false;
  }

  function startCreate() {
    resetForm();
    formDate = selectedDate || currentMonth + "-01";
    creating = true;
  }

  function startEdit(entry: ScheduleEntry) {
    resetForm();
    editing = entry;
    formTitle = entry.title;
    formDate = entry.scheduled_date;
    formTime = entry.scheduled_time || "";
    formPlatform = entry.platform;
    formContentType = entry.content_type;
    formStatus = entry.status;
    formAccountId = entry.account_id || "";
    formWorkId = entry.work_id || "";
    formDescription = entry.description;
    formColor = entry.color || COLORS[0];
  }

  async function handleSave() {
    formError = "";
    if (!formTitle.trim()) { formError = t("scheduleTitle") + " " + t("fieldRequired"); return; }
    if (!formDate) { formError = t("scheduleDate") + " " + t("fieldRequired"); return; }

    formBusy = true;
    try {
      if (editing) {
        await updateScheduleEntry(editing.id, {
          title: formTitle.trim(),
          scheduled_date: formDate,
          scheduled_time: formTime || undefined,
          platform: formPlatform,
          content_type: formContentType,
          status: formStatus,
          account_id: formAccountId || undefined,
          work_id: formWorkId || undefined,
          description: formDescription,
          color: formColor,
        } as Partial<ScheduleEntry>);
        showMessage("success", t("saved"));
      } else {
        await createScheduleEntry({
          title: formTitle.trim(),
          scheduled_date: formDate,
          scheduled_time: formTime || undefined,
          platform: formPlatform,
          content_type: formContentType,
          status: formStatus,
          account_id: formAccountId || undefined,
          work_id: formWorkId || undefined,
          description: formDescription,
          color: formColor,
        });
        showMessage("success", t("accountCreated"));
      }
      resetForm();
      await loadData();
    } catch (err: any) {
      formError = err.message || String(err);
    } finally {
      formBusy = false;
    }
  }

  async function handleDelete(entry: ScheduleEntry) {
    if (!confirm(t("scheduleDeleteConfirm"))) return;
    try {
      await deleteScheduleEntry(entry.id);
      showMessage("success", t("accountDeleted"));
      await loadData();
    } catch (err: any) {
      showMessage("error", err.message || String(err));
    }
  }

  function monthLabel(): string {
    const [y, m] = currentMonth.split("-");
    return `${y} / ${m}`;
  }

  onMount(() => {
    loadData();
    return () => { destroyed = true; };
  });
</script>

<div class="page">
  <div class="page-header">
    <h1>{t("calendarTitle")}</h1>
    <button class="btn-new" onclick={startCreate}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      {t("scheduleNew")}
    </button>
  </div>

  {#if message}
    <div class="msg" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>{message}</div>
  {/if}

  <div class="calendar-layout">
    <!-- Calendar Grid -->
    <div class="calendar-panel">
      <div class="month-nav">
        <button class="month-btn" onclick={() => navigateMonth(-1)} title={t("monthPrev")}>←</button>
        <span class="month-label">{monthLabel()}</span>
        <button class="month-btn" onclick={() => navigateMonth(1)} title={t("monthNext")}>→</button>
        <button class="today-btn" onclick={goToday}>{t("monthToday")}</button>
      </div>

      <div class="weekday-row">
        {#each WEEKDAYS_EN as day, i}
          <div class="weekday">{day}</div>
        {/each}
      </div>

      <div class="cal-grid">
        {#each calendarGrid as week}
          {#each week as cell}
            {#if cell.day !== null}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div
                class="cal-cell"
                class:cal-today={cell.isToday}
                class:cal-selected={cell.isSelected}
                onclick={() => selectDate(cell.dateStr)}
              >
                <span class="cal-day-num">{cell.day}</span>
                {#if cell.count > 0}
                  <span class="cal-dot">{cell.count}</span>
                {/if}
              </div>
            {:else}
              <div class="cal-cell cal-empty"></div>
            {/if}
          {/each}
        {/each}
      </div>
    </div>

    <!-- Day Detail Panel -->
    <div class="detail-panel">
      {#if selectedDate}
        <h2 class="detail-date">{selectedDate}</h2>
        {#if loading}
          <p class="empty">{t("loading")}</p>
        {:else if dayEntries.length === 0}
          <p class="empty">{t("scheduleNoEvents")}</p>
        {:else}
          <div class="entry-list">
            {#each dayEntries as entry}
              <div class="entry-card" style="border-left: 3px solid {entry.color || '#888'}">
                <div class="entry-head">
                  <span class="entry-title">{entry.title}</span>
                  <span class="entry-time">{entry.scheduled_time || ""}</span>
                </div>
                {#if entry.platform || entry.content_type}
                  <div class="entry-meta">
                    {#if entry.platform}
                      <span class="meta-badge">{entry.platform}</span>
                    {/if}
                    <span class="meta-badge">{entry.content_type}</span>
                    <span class="status-chip" class:chip-planned={entry.status === "planned"} class:chip-progress={entry.status === "in_progress"} class:chip-done={entry.status === "done"} class:chip-cancelled={entry.status === "cancelled"}>
                      {entry.status === "planned" ? t("statusPlanned") : entry.status === "in_progress" ? t("statusInProgress") : entry.status === "done" ? t("statusDone") : t("statusCancelled")}
                    </span>
                  </div>
                {/if}
                <div class="entry-actions">
                  <button class="btn-sm" onclick={() => startEdit(entry)}>{t("scheduleEdit")}</button>
                  <button class="btn-sm btn-danger" onclick={() => handleDelete(entry)}>{t("delete")}</button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="empty">{t("scheduleNoEvents")}</p>
      {/if}
    </div>
  </div>

  <!-- Create / Edit Modal -->
  {#if showForm}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="overlay" onclick={resetForm}></div>
    <div class="modal">
      <h2>{formTitleLabel}</h2>
      {#if formError}
        <p class="form-error">{formError}</p>
      {/if}
      <label class="field">
        <span class="field-label">{t("scheduleTitle")}</span>
        <input type="text" bind:value={formTitle} placeholder={t("scheduleTitle")} />
      </label>
      <div class="field-row">
        <label class="field">
          <span class="field-label">{t("scheduleDate")}</span>
          <input type="date" bind:value={formDate} />
        </label>
        <label class="field">
          <span class="field-label">{t("scheduleTime")}</span>
          <input type="time" bind:value={formTime} />
        </label>
      </div>
      <div class="field-row">
        <label class="field">
          <span class="field-label">{t("schedulePlatform")}</span>
          <select bind:value={formPlatform}>
            <option value="">—</option>
            <option value="douyin">{t("accountPlatformDouyin")}</option>
            <option value="xiaohongshu">{t("accountPlatformXiaohongshu")}</option>
          </select>
        </label>
        <label class="field">
          <span class="field-label">{t("scheduleContentType")}</span>
          <select bind:value={formContentType}>
            <option value="short-video">Short Video</option>
            <option value="image-text">Image + Text</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span class="field-label">{t("scheduleStatus")}</span>
        <select bind:value={formStatus}>
          <option value="planned">{t("statusPlanned")}</option>
          <option value="in_progress">{t("statusInProgress")}</option>
          <option value="done">{t("statusDone")}</option>
          <option value="cancelled">{t("statusCancelled")}</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">{t("scheduleColor")}</span>
        <div class="color-row">
          {#each COLORS as c}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <span class="color-swatch" class:color-active={formColor === c} style="background:{c}" onclick={() => formColor = c}></span>
          {/each}
        </div>
      </label>
      <label class="field">
        <span class="field-label">{t("scheduleDescription")}</span>
        <textarea bind:value={formDescription} rows="2" placeholder={t("scheduleDescription")}></textarea>
      </label>
      <div class="modal-actions">
        <button class="btn-save" onclick={handleSave} disabled={formBusy}>
          {formBusy ? t("saving") : t("saveChanges")}
        </button>
        <button class="btn-cancel" onclick={resetForm}>{t("cancel")}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .page { max-width: 1100px; margin: 0 auto; }

  .page-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1.25rem;
  }

  .page-header h1 {
    font-family: var(--font-display);
    font-size: var(--size-2xl);
    font-weight: 600;
    letter-spacing: -0.03em;
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

  .calendar-layout {
    display: grid;
    grid-template-columns: 1fr 320px;
    gap: 1.5rem;
    align-items: start;
  }

  .calendar-panel {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1.25rem;
  }

  .month-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .month-label {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    flex: 1;
    text-align: center;
  }

  .month-btn {
    padding: 0.3rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-size: var(--size-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .month-btn:hover { color: var(--text); border-color: var(--text-dim); }

  .today-btn {
    padding: 0.3rem 0.7rem;
    border: 1px solid var(--spark-red);
    border-radius: 4px;
    background: transparent;
    color: var(--spark-red);
    font-size: var(--size-xs);
    font-weight: 600;
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .today-btn:hover { background: var(--spark-red); color: #fff; }

  .weekday-row {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    text-align: center;
    margin-bottom: 0.25rem;
  }

  .weekday {
    font-size: var(--size-xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    padding: 0.4rem 0;
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }

  .cal-cell {
    aspect-ratio: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    position: relative;
    font-size: var(--size-sm);
    color: var(--text);
    transition: all var(--transition-fast);
  }
  .cal-cell:hover { background: var(--accent-soft); }
  .cal-empty { cursor: default; background: none; }
  .cal-empty:hover { background: none; }

  .cal-today { background: var(--accent-soft); }
  .cal-today .cal-day-num {
    color: var(--spark-red);
    font-weight: 700;
  }

  .cal-selected { background: var(--spark-red); }
  .cal-selected .cal-day-num { color: #fff; font-weight: 700; }
  .cal-selected .cal-dot { color: #fff; }

  .cal-day-num { position: relative; z-index: 1; }

  .cal-dot {
    position: absolute;
    bottom: 4px;
    right: 4px;
    background: var(--spark-red);
    color: #fff;
    font-size: 0.6rem;
    font-weight: 700;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  /* Detail panel */
  .detail-panel {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1.25rem;
    min-height: 200px;
  }

  .detail-date {
    font-family: var(--font-display);
    font-size: var(--size-lg);
    font-weight: 600;
    margin-bottom: 1rem;
    letter-spacing: -0.02em;
  }

  .empty {
    color: var(--text-muted);
    font-size: var(--size-sm);
  }

  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .entry-card {
    background: var(--bg-inset);
    border-radius: 4px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .entry-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .entry-title {
    font-weight: 600;
    font-size: var(--size-sm);
  }

  .entry-time {
    font-size: var(--size-xs);
    color: var(--text-dim);
    font-family: 'SF Mono', monospace;
  }

  .entry-meta {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }

  .meta-badge {
    font-size: var(--size-xs);
    font-weight: 500;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .status-chip {
    font-size: var(--size-xs);
    font-weight: 600;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }
  .chip-planned { background: var(--accent-soft); color: var(--text-secondary); }
  .chip-progress { background: var(--warning-soft, #fff3cd); color: var(--warning, #856404); }
  .chip-done { background: var(--success-soft); color: var(--success); }
  .chip-cancelled { background: var(--error-soft); color: var(--error); }

  .entry-actions {
    display: flex;
    gap: 0.4rem;
  }

  .btn-sm {
    padding: 0.25rem 0.55rem;
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
  .btn-danger:hover { background: var(--error-soft); }

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
    width: min(480px, 92vw);
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: var(--card-radius);
    padding: 1.5rem;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
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

  .field-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  input, select, textarea {
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
    font-family: var(--font-body);
    font-size: var(--size-sm);
  }

  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--text-dim);
  }

  textarea { resize: vertical; }

  .color-row {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: all var(--transition-fast);
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-active { border-color: var(--text); transform: scale(1.15); }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.25rem;
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
  }
  .btn-cancel:hover { color: var(--text); border-color: var(--text-dim); }

  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
