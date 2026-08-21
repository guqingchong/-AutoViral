<script lang="ts">
  /**
   * WorksDashboard —— 作品一级分类数据看板(Task 12)。
   *
   * 列表:作品 × 五数汇总(播放/点赞/评论/分享/收藏);
   * 下钻:点击作品行展开 平台 × 账号明细(状态/五数/完播率)+ 近 7 日播放趋势(简易 SVG 折线)。
   *
   * 数据:GET /api/analytics/works-dashboard(Task 9),详情接口响应为平铺结构
   * ({ ...workRow, series: [{ recordId, points: [...] }] }),见 api.ts WorkDashboardDetail。
   */
  import { onMount } from "svelte";
  import {
    getWorksDashboard,
    getWorkDashboard,
    type WorkDashboardRow,
    type WorkDashboardDetail,
  } from "../lib/api.js";

  const PLATFORM_LABEL: Record<string, string> = {
    douyin: "抖音",
    xiaohongshu: "小红书",
    bilibili: "B站",
    kuaishou: "快手",
    channels: "视频号",
    zhihu: "知乎",
    wechat_mp: "公众号",
  };
  const PLATFORM_KEYS = Object.keys(PLATFORM_LABEL);

  const STATUS_LABEL: Record<string, string> = {
    published: "已发布",
    publishing: "发布中",
    reviewing: "审核中",
    approved: "待发布",
    failed: "发布失败",
    rejected: "已驳回",
  };

  let works = $state<WorkDashboardRow[]>([]);
  let loading = $state(true);
  let error = $state("");
  let platformFilter = $state(""); // "" = 全部
  let expandedWorkId = $state<string | null>(null);
  let details = $state<Record<string, WorkDashboardDetail>>({});

  async function load() {
    loading = true;
    error = "";
    try {
      const res = await getWorksDashboard(platformFilter ? { platform: platformFilter } : {});
      works = res.works;
    } catch {
      error = "看板数据加载失败,请稍后重试";
      works = [];
    } finally {
      loading = false;
    }
  }

  onMount(load);

  function selectPlatform(p: string) {
    if (platformFilter === p) return;
    platformFilter = p;
    expandedWorkId = null;
    load();
  }

  async function toggle(workId: string) {
    if (expandedWorkId === workId) {
      expandedWorkId = null;
      return;
    }
    expandedWorkId = workId;
    if (!details[workId]) {
      try {
        details[workId] = await getWorkDashboard(workId);
      } catch {
        /* 明细加载失败:回退用列表行内 records 渲染,趋势区提示无数据 */
      }
    }
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  function fmtNum(n: number | null | undefined): string {
    if (n === null || n === undefined) return "-";
    if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
    if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
    return n.toLocaleString();
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return "-";
    const d = new Date(iso.replace(" ", "T"));
    if (isNaN(d.getTime())) return "-";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function fmtRate(r: number | null | undefined): string {
    if (r === null || r === undefined) return "-";
    return (r * 100).toFixed(1) + "%";
  }

  function platformLabel(p: string): string {
    return PLATFORM_LABEL[p] ?? p;
  }

  /** 近 7 日播放趋势:每发布记录取每日最后一次采集值,再跨记录按日求和 */
  function buildTrend(series: WorkDashboardDetail["series"]): Array<{ day: string; views: number }> {
    const perDay = new Map<string, number>();
    for (const s of series) {
      const lastByDay = new Map<string, number>();
      for (const p of s.points) {
        lastByDay.set(p.collectedAt.slice(0, 10), p.views);
      }
      for (const [day, v] of lastByDay) {
        perDay.set(day, (perDay.get(day) ?? 0) + v);
      }
    }
    return [...perDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-7)
      .map(([day, views]) => ({ day, views }));
  }

  function trendPoints(trend: Array<{ day: string; views: number }>): string {
    const W = 560, H = 110, PAD = 8;
    const max = Math.max(...trend.map(p => p.views), 1);
    const stepX = trend.length > 1 ? (W - PAD * 2) / (trend.length - 1) : 0;
    return trend
      .map((p, i) => {
        const x = PAD + i * stepX;
        const y = H - PAD - (p.views / max) * (H - PAD * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }
</script>

<div class="wd">
  <!-- 平台筛选 chips:全部 + 7 平台 -->
  <div class="chip-row">
    <button class="chip" class:active={platformFilter === ""} onclick={() => selectPlatform("")}>
      全部
    </button>
    {#each PLATFORM_KEYS as key}
      <button class="chip" class:active={platformFilter === key} onclick={() => selectPlatform(key)}>
        {PLATFORM_LABEL[key]}
      </button>
    {/each}
  </div>

  <div class="table-card">
    <div class="table-header">
      <h3 class="table-title">作品表现</h3>
      <span class="table-sub">点击作品行展开平台 × 账号明细与近 7 日趋势</span>
    </div>

    {#if loading}
      <div class="wd-loading">
        <div class="spinner"></div>
        <span class="hint-text">加载中…</span>
      </div>
    {:else if error}
      <p class="empty-msg">{error}</p>
    {:else if works.length === 0}
      <p class="empty-msg">暂无作品数据</p>
    {:else}
      <div class="table-wrap">
        <table class="works-table">
          <thead>
            <tr>
              <th class="col-title">标题</th>
              <th class="col-date">发布日期</th>
              <th>平台</th>
              <th class="col-num">播放</th>
              <th class="col-num">点赞</th>
              <th class="col-num">评论</th>
              <th class="col-num">分享</th>
              <th class="col-num">收藏</th>
            </tr>
          </thead>
          <tbody>
            {#each works as work (work.workId)}
              <tr
                class="work-row expandable"
                class:expanded={expandedWorkId === work.workId}
                onclick={() => toggle(work.workId)}
              >
                <td class="col-title">
                  <span class="work-desc" title={work.title ?? ""}>{work.title ?? "(无标题)"}</span>
                </td>
                <td class="col-date muted">{fmtDate(work.publishedAt)}</td>
                <td>
                  <span class="p-chips">
                    {#each work.platforms as p}
                      <span class="p-chip">{platformLabel(p)}</span>
                    {/each}
                  </span>
                </td>
                <td class="col-num">{fmtNum(work.totals.views)}</td>
                <td class="col-num">{fmtNum(work.totals.likes)}</td>
                <td class="col-num">{work.totals.comments ? fmtNum(work.totals.comments) : "-"}</td>
                <td class="col-num">{work.totals.shares ? fmtNum(work.totals.shares) : "-"}</td>
                <td class="col-num">{work.totals.collects ? fmtNum(work.totals.collects) : "-"}</td>
              </tr>

              {#if expandedWorkId === work.workId}
                {@const detail = details[work.workId]}
                {@const records = detail?.records ?? work.records}
                <tr class="detail-row">
                  <td colspan="8">
                    <div class="detail-panel">
                      <!-- 平台 × 账号明细 -->
                      {#if records.length === 0}
                        <p class="empty-msg">暂无发布记录</p>
                      {:else}
                        <table class="works-table detail-table">
                          <thead>
                            <tr>
                              <th>平台</th>
                              <th>账号</th>
                              <th>状态</th>
                              <th class="col-num">播放</th>
                              <th class="col-num">点赞</th>
                              <th class="col-num">评论</th>
                              <th class="col-num">分享</th>
                              <th class="col-num">收藏</th>
                              <th class="col-num">完播率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {#each records as rec (rec.recordId)}
                              <tr class="work-row">
                                <td>{platformLabel(rec.platform)}</td>
                                <td>{rec.accountName ?? rec.accountId ?? "-"}</td>
                                <td><span class="status-badge">{STATUS_LABEL[rec.status] ?? rec.status}</span></td>
                                {#if rec.metrics}
                                  <td class="col-num">{fmtNum(rec.metrics.views)}</td>
                                  <td class="col-num">{fmtNum(rec.metrics.likes)}</td>
                                  <td class="col-num">{rec.metrics.comments ? fmtNum(rec.metrics.comments) : "-"}</td>
                                  <td class="col-num">{rec.metrics.shares ? fmtNum(rec.metrics.shares) : "-"}</td>
                                  <td class="col-num">{rec.metrics.collects ? fmtNum(rec.metrics.collects) : "-"}</td>
                                  <td class="col-num">{fmtRate(rec.metrics.completionRate)}</td>
                                {:else}
                                  <td class="col-num muted" colspan="6">暂无指标</td>
                                {/if}
                              </tr>
                            {/each}
                          </tbody>
                        </table>
                      {/if}

                      <!-- 近 7 日播放趋势 -->
                      {#if detail}
                        {@const trend = buildTrend(detail.series)}
                        {#if trend.length > 0}
                          <div class="trend-block">
                            <span class="trend-title">近 7 日播放趋势</span>
                            <svg class="trend-svg" viewBox="0 0 560 110" preserveAspectRatio="none">
                              <polyline
                                points={trendPoints(trend)}
                                fill="none"
                                stroke="var(--accent)"
                                stroke-width="2"
                                stroke-linejoin="round"
                                stroke-linecap="round"
                              />
                            </svg>
                            <div class="trend-labels">
                              <span>{trend[0].day.slice(5)}</span>
                              <span>{trend[trend.length - 1].day.slice(5)} · {fmtNum(trend[trend.length - 1].views)} 播放</span>
                            </div>
                          </div>
                        {:else}
                          <p class="empty-msg">近 7 日暂无采集数据</p>
                        {/if}
                      {:else}
                        <p class="empty-msg">趋势数据加载中…</p>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>

<style>
  .wd {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  /* ── 平台筛选 chips ─────────────────────────────────────────────────────── */
  .chip-row {
    display: flex;
    gap: 0.3rem;
    flex-wrap: wrap;
  }

  .chip {
    padding: 0.4rem 0.9rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: none;
    color: var(--text-dim);
    font-size: 0.8rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .chip:hover {
    border-color: var(--text-dim);
    color: var(--text);
  }

  .chip.active {
    background: var(--accent-gradient);
    color: var(--accent-text);
    border-color: transparent;
  }

  /* ── Loading ────────────────────────────────────────────────────────────── */
  .wd-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    min-height: 160px;
  }

  .spinner {
    width: 28px;
    height: 28px;
    border: 2.5px solid rgba(0, 0, 0, 0.15);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.75s linear infinite;
  }

  .hint-text {
    font-size: 0.82rem;
    color: var(--text-dim);
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── 表格(复用 Analytics.svelte 既有 class 风格)───────────────────────── */
  .table-card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius, 20px);
    padding: 1.25rem 1.375rem;
    backdrop-filter: var(--card-blur);
    -webkit-backdrop-filter: var(--card-blur);
  }

  .table-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }

  .table-title {
    font-size: 0.92rem;
    font-weight: 720;
    color: var(--text);
    letter-spacing: -0.02em;
    margin: 0;
  }

  .table-sub {
    font-size: 0.72rem;
    color: var(--text-dim);
    font-weight: 500;
  }

  .table-wrap {
    overflow-x: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--scrollbar) transparent;
  }

  .works-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.82rem;
  }

  .works-table thead th {
    font-size: 0.68rem;
    font-weight: 650;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0 0.75rem 0.65rem;
    text-align: left;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  .works-table tbody .work-row {
    border-bottom: 1px solid var(--border-subtle, var(--border));
    transition: background 0.15s ease;
  }

  .works-table tbody .work-row:hover {
    background: var(--bg-hover);
  }

  .works-table tbody .work-row:last-child {
    border-bottom: none;
  }

  .works-table td {
    padding: 0.7rem 0.75rem;
    vertical-align: middle;
  }

  .col-title {
    max-width: 260px;
  }

  .works-table thead th.col-title {
    padding-left: 0.75rem;
  }

  .work-desc {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 260px;
    color: var(--text);
    font-weight: 500;
  }

  .col-date {
    white-space: nowrap;
    min-width: 96px;
  }

  .col-num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    white-space: nowrap;
    min-width: 64px;
  }

  .muted {
    color: var(--text-dim);
  }

  .empty-msg {
    font-size: 0.82rem;
    color: var(--text-dim);
    padding: 1rem 0;
    margin: 0;
  }

  /* ── 行内平台 chips ─────────────────────────────────────────────────────── */
  .p-chips {
    display: inline-flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .p-chip {
    font-size: 0.68rem;
    font-weight: 650;
    padding: 0.14rem 0.5rem;
    border-radius: 9999px;
    background: var(--accent-soft);
    color: var(--accent);
    white-space: nowrap;
  }

  /* ── 展开行 / 下钻面板 ──────────────────────────────────────────────────── */
  .work-row.expandable {
    cursor: pointer;
  }

  .work-row.expandable.expanded {
    background: var(--bg-hover);
    border-left: 2px solid var(--accent);
  }

  .detail-row td {
    padding: 0 0.75rem 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .detail-panel {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--bg-inset);
    border-radius: 10px;
    margin-top: 0.5rem;
    padding: 0.9rem 1rem;
  }

  .detail-table thead th {
    padding-bottom: 0.45rem;
  }

  .detail-table td {
    padding: 0.5rem 0.75rem;
  }

  .status-badge {
    font-size: 0.68rem;
    font-weight: 650;
    padding: 0.14rem 0.5rem;
    border-radius: 9999px;
    background: var(--border);
    color: var(--text-muted);
    white-space: nowrap;
  }

  /* ── 近 7 日趋势 ────────────────────────────────────────────────────────── */
  .trend-block {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .trend-title {
    font-size: 0.72rem;
    font-weight: 650;
    color: var(--text-muted);
    letter-spacing: 0.02em;
  }

  .trend-svg {
    width: 100%;
    height: 90px;
    display: block;
  }

  .trend-labels {
    display: flex;
    justify-content: space-between;
    font-size: 0.68rem;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }
</style>
