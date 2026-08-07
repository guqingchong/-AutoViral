<script lang="ts">
  /**
   * PublishBoard —— 视频发布 / 图文发布共用的三栏发布看板。
   *
   * 状态机（与后端 works.status 对齐）：
   *   reviewing → 待审核栏（审核通过 → approved）
   *   approved  → 待发布栏（一键全发布 / 单平台发布）
   *   published → 已发布栏（任一平台发布成功即进入；角标 全发布 / 未全发布）
   *
   * "已配置平台"以 /api/accounts/credential-status 为准（发布器实际读取的凭证）。
   */
  import { onMount } from "svelte";
  import {
    fetchWorks,
    fetchWorkPublishRecords,
    publishWorkToPlatform,
    rejectWork,
    type WorkSummary,
    type PublishRecord,
  } from "../lib/api.js";

  export interface BoardPlatform {
    key: string;
    label: string;
  }

  let {
    kind,
    platforms,
  }: {
    kind: "video" | "image-text";
    platforms: BoardPlatform[];
  } = $props();

  let works = $state<WorkSummary[]>([]);
  let loading = $state(true);
  let message = $state("");
  let messageType = $state<"success" | "error">("success");
  let destroyed = $state(false);

  // 凭证配置状态（platform → configured）
  let credentialStatus = $state<Record<string, { keys: string[]; configured: boolean }>>({});

  // 每个作品的发布记录（待发布 + 已发布栏需要）
  let recordsByWork = $state<Record<string, PublishRecord[]>>({});

  // 详情视图
  let selectedWorkId = $state("");
  let reviewComment = $state("");
  let rejectStage = $state("assembly");
  let rejecting = $state(false);
  let approving = $state(false);
  let publishing = $state<Record<string, boolean>>({});
  let publishAllBusy = $state(false);

  // 图文文章编辑（kind === "image-text" 的审核详情）
  let articleId = $state<number | null>(null);
  let articleTitle = $state("");
  let articleContent = $state("");
  let articleSaving = $state(false);
  let showArticle = $state(false);

  // 图文产物预览（kind === "image-text"）：小红书卡片 + 知乎/公众号文内插图
  let cardImages = $state<string[]>([]);
  let contentImages = $state<string[]>([]);

  /** 打回重做的可选阶段（与流水线 step key 对齐） */
  const REJECT_STAGES = [
    { key: "plan", label: "策划/文案" },
    { key: "assets", label: "素材" },
    { key: "assembly", label: "合成" },
  ];

  /** 账号平台键 → 凭证状态键（wechat_mp → wechat） */
  function credKeyOf(platform: string): string {
    return platform === "wechat_mp" ? "wechat" : platform;
  }

  function isConfigured(platform: string): boolean {
    return credentialStatus[credKeyOf(platform)]?.configured === true;
  }

  /** 本看板平台中已配置凭证的平台 */
  const configuredPlatforms = $derived(platforms.filter((p) => isConfigured(p.key)));

  const typeMatches = (w: WorkSummary) =>
    kind === "image-text" ? w.type === "image-text" : w.type !== "image-text";

  const reviewWorks = $derived(works.filter((w) => typeMatches(w) && w.status === "reviewing"));
  const approvedWorks = $derived(works.filter((w) => typeMatches(w) && w.status === "approved"));
  const publishedWorks = $derived(works.filter((w) => typeMatches(w) && w.status === "published"));

  const selectedWork = $derived(works.find((w) => w.id === selectedWorkId));
  const selectedRecords = $derived(selectedWorkId ? (recordsByWork[selectedWorkId] ?? []) : []);

  function showMessage(type: "success" | "error", text: string) {
    messageType = type;
    message = text;
    setTimeout(() => { if (!destroyed) message = ""; }, 6000);
  }

  /** 某作品在某平台的最新发布状态 */
  function platformState(workId: string, platform: string): { state: "published" | "publishing" | "failed" | "fallback" | "none"; record?: PublishRecord } {
    const records = (recordsByWork[workId] ?? []).filter((r) => r.platform === platform);
    if (records.length === 0) return { state: "none" };
    // 同一平台可能有多条记录（失败后重发），优先已发布
    const published = records.find((r) => r.status === "published");
    if (published) return { state: "published", record: published };
    const latest = records[records.length - 1];
    if (latest.status === "publishing" || latest.status === "pending" || latest.status === "scheduled") {
      return { state: "publishing", record: latest };
    }
    if (latest.status === "fallback") return { state: "fallback", record: latest };
    return { state: "failed", record: latest };
  }

  /** 已发布栏角标：已配置平台全部发布 → 全发布，否则未全发布 */
  function fullPublished(workId: string): boolean {
    if (configuredPlatforms.length === 0) return false;
    return configuredPlatforms.every((p) => platformState(workId, p.key).state === "published");
  }

  /** 待发布/已发布栏作品未发布完成的已配置平台 */
  function pendingPlatforms(workId: string): BoardPlatform[] {
    return configuredPlatforms.filter((p) => platformState(workId, p.key).state !== "published");
  }

  async function loadRecordsFor(workIds: string[]) {
    const entries = await Promise.all(
      workIds.map(async (id) => {
        try {
          return [id, await fetchWorkPublishRecords(id)] as const;
        } catch {
          return [id, []] as const;
        }
      }),
    );
    const next = { ...recordsByWork };
    for (const [id, records] of entries) next[id] = records;
    recordsByWork = next;
  }

  async function loadWorks() {
    try {
      works = await fetchWorks();
      // 待发布与已发布栏需要发布记录来计算平台状态/角标
      const needRecords = works.filter(
        (w) => typeMatches(w) && (w.status === "approved" || w.status === "published"),
      );
      await loadRecordsFor(needRecords.map((w) => w.id));
    } catch {}
  }

  async function loadCredentialStatus() {
    try {
      const res = await fetch("/api/accounts/credential-status");
      const data = await res.json();
      credentialStatus = data.status ?? {};
    } catch {}
  }

  async function loadArticle(workId: string) {
    articleId = null;
    articleTitle = "";
    articleContent = "";
    try {
      const res = await fetch(`/api/works/${workId}/articles`);
      const data = await res.json();
      if (data.articles?.length) {
        articleId = data.articles[0].id;
        articleTitle = data.articles[0].title;
        articleContent = data.articles[0].content;
      }
    } catch {}
  }

  /** 文章段落（预览渲染用） */
  const articleParagraphs = $derived(articleContent.split(/\n\s*\n/).filter((p) => p.trim()));

  /**
   * 文内插图位置（与发布链路 planImageInsertions 同思路：插图均匀分布到段落间隙）。
   * 返回 Map: 段落索引 → 该段之后插入的图片 URL。
   */
  const articleIllustrations = $derived.by(() => {
    const map = new Map<number, string>();
    const paras = articleParagraphs;
    if (paras.length < 2 || contentImages.length === 0) return map;
    const gaps = paras.length - 1;
    const used = new Set<number>();
    for (let g = 0; g < gaps; g++) {
      const idx = Math.round(((g + 1) * contentImages.length) / gaps) - 1;
      const clamped = Math.min(Math.max(idx, 0), contentImages.length - 1);
      if (!used.has(clamped)) {
        used.add(clamped);
        map.set(g, contentImages[clamped]);
      }
    }
    return map;
  });

  /** 素材路径 → 可访问 URL（与作品列表封面同一拼法） */
  function assetUrl(workId: string, rel: string): string {
    return `/api/works/${workId}/assets/${rel.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
  }

  /** 加载图文产物预览:小红书卡片(output/cards)+ 知乎/公众号文内插图(assets/images) */
  async function loadImageTextAssets(workId: string) {
    cardImages = [];
    contentImages = [];
    try {
      const res = await fetch(`/api/works/${workId}/assets`);
      const data = await res.json();
      const assets: string[] = data.assets ?? [];
      const isImg = (a: string) => /\.(png|jpe?g|webp|gif)$/i.test(a);
      cardImages = assets
        .filter((a) => a.startsWith("output/cards/") && isImg(a))
        .sort()
        .map((a) => assetUrl(workId, a));
      contentImages = assets
        .filter((a) => a.startsWith("assets/images/") && isImg(a))
        .sort()
        .map((a) => assetUrl(workId, a));
    } catch {}
  }

  async function saveArticle() {
    if (!articleId) return;
    articleSaving = true;
    try {
      const res = await fetch(`/api/articles/${articleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: articleTitle, content: articleContent }),
      });
      showMessage(res.ok ? "success" : "error", res.ok ? "文章已保存" : "文章保存失败");
    } catch (err) {
      showMessage("error", "文章保存失败: " + String(err));
    } finally {
      articleSaving = false;
    }
  }

  function selectWork(workId: string) {
    selectedWorkId = workId;
    reviewComment = "";
    rejectStage = "assembly";
    showArticle = false;
    if (kind === "image-text") {
      loadArticle(workId);
      loadImageTextAssets(workId);
    }
  }

  function backToBoard() {
    selectedWorkId = "";
  }

  /** 审核通过：reviewing → approved（进入待发布栏），不再直接置为 published */
  async function handleApprove() {
    if (!selectedWorkId || approving) return;
    approving = true;
    try {
      const res = await fetch(`/api/works/${selectedWorkId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showMessage("success", "审核通过，作品已进入「待发布」栏");
      selectedWorkId = "";
      await loadWorks();
    } catch (err) {
      showMessage("error", "操作失败: " + String(err));
    } finally {
      approving = false;
    }
  }

  async function handleReject() {
    if (!selectedWorkId || !reviewComment.trim()) {
      showMessage("error", "请填写审核意见");
      return;
    }
    rejecting = true;
    try {
      const result = await rejectWork(selectedWorkId, rejectStage, reviewComment.trim());
      const stageLabel = REJECT_STAGES.find((s) => s.key === rejectStage)?.label ?? rejectStage;
      showMessage("success",
        result.delivery === "queued"
          ? `已打回到「${stageLabel}」，已加入任务队列，将按审核意见自动重做`
          : `已打回到「${stageLabel}」，审核意见已保存（AI 会话未在线，将在作品页手动继续）`);
      reviewComment = "";
      selectedWorkId = "";
      await loadWorks();
    } catch (err) {
      showMessage("error", "打回失败: " + String(err));
    } finally {
      rejecting = false;
    }
  }

  /** 单平台发布。返回是否成功（供一键全发布统计）。 */
  async function publishOne(workId: string, platform: string, label: string): Promise<boolean> {
    const busyKey = `${workId}:${platform}`;
    publishing = { ...publishing, [busyKey]: true };
    try {
      const result = await publishWorkToPlatform(workId, platform, {});
      const ok = result.status === "published";
      if (!ok) {
        showMessage("error", `${label} 发布失败：${result.error ?? "未知错误"}`);
      }
      return ok;
    } catch (err) {
      showMessage("error", `${label} 发布失败: ${String(err)}`);
      return false;
    } finally {
      publishing = { ...publishing, [busyKey]: false };
      await loadRecordsFor([workId]);
      // 任一平台发布成功后后端会把作品置为 published，刷新使其进入已发布栏
      await loadWorks();
    }
  }

  async function handlePublishClick(workId: string, platform: string, label: string) {
    const ok = await publishOne(workId, platform, label);
    if (ok) showMessage("success", `${label} 发布成功`);
  }

  /** 一键全发布：向所有已配置且未发布的平台依次发布 */
  async function handlePublishAll(workId: string) {
    if (publishAllBusy) return;
    const targets = pendingPlatforms(workId);
    if (targets.length === 0) {
      showMessage("error", configuredPlatforms.length === 0
        ? "尚未配置任何平台凭证，请先到「视频发布 → 账号管理」完成配置"
        : "所有已配置平台均已发布");
      return;
    }
    publishAllBusy = true;
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const p of targets) {
      const ok = await publishOne(workId, p.key, p.label);
      (ok ? succeeded : failed).push(p.label);
      if (destroyed) return;
    }
    publishAllBusy = false;
    if (failed.length === 0) {
      showMessage("success", `一键全发布完成：${succeeded.join("、")} 全部发布成功`);
    } else {
      showMessage("error", `发布完成：成功 ${succeeded.length > 0 ? succeeded.join("、") : "无"}；失败 ${failed.join("、")}`);
    }
  }

  function fmtTime(iso?: string): string {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  onMount(() => {
    (async () => {
      await Promise.all([loadWorks(), loadCredentialStatus()]);
      if (!destroyed) loading = false;
    })();
    // 轮询刷新：打回重做完成（回 reviewing）、发布状态变化都会自动反映到看板
    const timer = setInterval(() => {
      if (!destroyed && !selectedWorkId) loadWorks();
    }, 10_000);
    return () => { destroyed = true; clearInterval(timer); };
  });
</script>

<div class="board">
  {#if message}
    <div class="msg" class:msg-success={messageType === "success"} class:msg-error={messageType === "error"}>{message}</div>
  {/if}

  {#if loading}
    <div class="loading"><div class="loader"></div><p>加载中...</p></div>
  {:else if !selectedWorkId}
    <!-- 三栏看板 -->
    <div class="lanes">
      <!-- 待审核栏 -->
      <section class="lane">
        <h2 class="lane-title">待审核 <span class="lane-count">{reviewWorks.length}</span></h2>
        {#if reviewWorks.length === 0}
          <p class="lane-empty">暂无待审核{kind === "image-text" ? "图文" : "视频"}。作品完成合成后自动进入此栏。</p>
        {:else}
          {#each reviewWorks as work (work.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="work-card" onclick={() => selectWork(work.id)}>
              {#if work.coverImage}
                <div class="card-cover">
                  {#if work.coverIsVideo}
                    <video src={work.coverImage} muted preload="metadata"></video>
                  {:else}
                    <img src={work.coverImage} alt={work.title} />
                  {/if}
                </div>
              {/if}
              <div class="card-body">
                <h3>{work.title}</h3>
                <span class="badge badge-review">待审核</span>
              </div>
            </div>
          {/each}
        {/if}
      </section>

      <!-- 待发布栏 -->
      <section class="lane">
        <h2 class="lane-title">待发布 <span class="lane-count">{approvedWorks.length}</span></h2>
        {#if approvedWorks.length === 0}
          <p class="lane-empty">暂无待发布作品。审核通过后作品进入此栏。</p>
        {:else}
          {#each approvedWorks as work (work.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="work-card" onclick={() => selectWork(work.id)}>
              {#if work.coverImage}
                <div class="card-cover">
                  {#if work.coverIsVideo}
                    <video src={work.coverImage} muted preload="metadata"></video>
                  {:else}
                    <img src={work.coverImage} alt={work.title} />
                  {/if}
                </div>
              {/if}
              <div class="card-body">
                <h3>{work.title}</h3>
                <div class="plat-chips">
                  {#each platforms as p}
                    {@const st = platformState(work.id, p.key)}
                    <span class="chip" class:chip-ok={st.state === "published"} class:chip-fail={st.state === "failed"} class:chip-dim={!isConfigured(p.key)}>
                      {p.label}{st.state === "published" ? "✓" : st.state === "failed" ? "✗" : ""}
                    </span>
                  {/each}
                </div>
                <button
                  class="btn-publish-all"
                  disabled={publishAllBusy || pendingPlatforms(work.id).length === 0}
                  onclick={(e) => { e.stopPropagation(); handlePublishAll(work.id); }}
                >
                  {publishAllBusy ? "发布中…" : `一键全发布（${pendingPlatforms(work.id).length} 个平台）`}
                </button>
              </div>
            </div>
          {/each}
        {/if}
      </section>

      <!-- 已发布栏 -->
      <section class="lane">
        <h2 class="lane-title">已发布 <span class="lane-count">{publishedWorks.length}</span></h2>
        {#if publishedWorks.length === 0}
          <p class="lane-empty">暂无已发布作品。任一平台发布成功后作品进入此栏。</p>
        {:else}
          {#each publishedWorks as work (work.id)}
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="work-card" onclick={() => selectWork(work.id)}>
              <span class="corner-badge" class:corner-full={fullPublished(work.id)} class:corner-partial={!fullPublished(work.id)}>
                {fullPublished(work.id) ? "全发布" : "未全发布"}
              </span>
              {#if work.coverImage}
                <div class="card-cover">
                  {#if work.coverIsVideo}
                    <video src={work.coverImage} muted preload="metadata"></video>
                  {:else}
                    <img src={work.coverImage} alt={work.title} />
                  {/if}
                </div>
              {/if}
              <div class="card-body">
                <h3>{work.title}</h3>
                <div class="plat-chips">
                  {#each platforms as p}
                    {@const st = platformState(work.id, p.key)}
                    <span class="chip" class:chip-ok={st.state === "published"} class:chip-fail={st.state === "failed"} class:chip-dim={!isConfigured(p.key)}>
                      {p.label}{st.state === "published" ? "✓" : st.state === "failed" ? "✗" : ""}
                    </span>
                  {/each}
                </div>
                {#if pendingPlatforms(work.id).length > 0}
                  <button
                    class="btn-publish-all"
                    disabled={publishAllBusy}
                    onclick={(e) => { e.stopPropagation(); handlePublishAll(work.id); }}
                  >
                    {publishAllBusy ? "发布中…" : `补发剩余平台（${pendingPlatforms(work.id).length}）`}
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        {/if}
      </section>
    </div>
  {:else}
    <!-- 详情视图 -->
    <div class="detail">
      <button class="btn-back" onclick={backToBoard}>← 返回看板</button>

      <div class="detail-header">
        <h2>{selectedWork?.title}</h2>
        <span class="badge" class:badge-review={selectedWork?.status === "reviewing"} class:badge-approved={selectedWork?.status === "approved"} class:badge-published={selectedWork?.status === "published"}>
          {selectedWork?.status === "reviewing" ? "待审核" : selectedWork?.status === "approved" ? "待发布" : "已发布"}
        </span>
      </div>

      <!-- 预览区 -->
      {#if kind === "image-text"}
        <!-- 图文双形态预览:小红书卡片 + 知乎/公众号文内插图文章 -->
        {#if cardImages.length > 0}
          <div class="cards-preview">
            <h3>小红书卡片（{cardImages.length} 张）</h3>
            <div class="cards-strip">
              {#each cardImages as url, i}
                <figure class="card-item">
                  <img src={url} alt="卡片 {i + 1}" />
                  <figcaption>{i === 0 ? "封面" : `卡 ${i}`}</figcaption>
                </figure>
              {/each}
            </div>
          </div>
        {/if}

        <div class="article-preview">
          <h3>知乎 / 公众号图文预览{contentImages.length > 0 ? `（文内插图 ${contentImages.length} 张）` : "（纯文本，无插图）"}</h3>
          {#if articleId}
            <div class="article-render">
              <h4>{articleTitle}</h4>
              {#each articleParagraphs as para, i}
                <p>{para}</p>
                {#if articleIllustrations.has(i)}
                  <img class="inline-img" src={articleIllustrations.get(i)} alt="插图" />
                {/if}
              {/each}
            </div>
          {:else}
            <p class="preview-empty">该作品暂无文章内容</p>
          {/if}
        </div>
      {:else}
        <div class="preview-area">
          {#if selectedWork?.previewUrl}
            <video src={selectedWork.previewUrl} controls></video>
          {:else if selectedWork?.coverImage}
            {#if selectedWork?.coverIsVideo}
              <video src={selectedWork.coverImage} controls></video>
            {:else}
              <img src={selectedWork.coverImage} alt="preview" />
            {/if}
          {:else}
            <p class="preview-empty">暂无预览内容</p>
          {/if}
        </div>
      {/if}

      <!-- 图文：文章查看/编辑 -->
      {#if kind === "image-text" && articleId}
        <div class="article-section">
          <div class="article-header">
            <h3>图文内容</h3>
            <div class="article-header-btns">
              {#if selectedWork?.status === "reviewing"}
                <button class="btn-sm" disabled={articleSaving} onclick={saveArticle}>{articleSaving ? "保存中…" : "保存修改"}</button>
              {/if}
              <button class="btn-sm" onclick={() => showArticle = !showArticle}>{showArticle ? "收起" : "展开"}</button>
            </div>
          </div>
          {#if showArticle}
            <div class="article-body">
              {#if selectedWork?.status === "reviewing"}
                <input class="article-title-input" type="text" bind:value={articleTitle} placeholder="标题" />
                <textarea class="article-content-input" bind:value={articleContent} rows="12"></textarea>
              {:else}
                <h4>{articleTitle}</h4>
                <pre>{articleContent}</pre>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- 审核操作（仅待审核） -->
      {#if selectedWork?.status === "reviewing"}
        <div class="review-actions">
          <textarea bind:value={reviewComment} placeholder="审核意见（如有修改意见请填写并点击打回修改，意见将直达 AI 驱动重做）" rows="3"></textarea>
          <div class="review-btns">
            <label class="reject-stage-label">打回到
              <select bind:value={rejectStage} class="reject-stage-select">
                {#each REJECT_STAGES as s}
                  <option value={s.key}>{s.label}阶段</option>
                {/each}
              </select>
            </label>
            <button class="btn-reject" onclick={handleReject} disabled={!reviewComment.trim() || rejecting}>
              {rejecting ? "打回中…" : "打回修改"}
            </button>
            <button class="btn-approve" onclick={handleApprove} disabled={approving}>
              {approving ? "提交中…" : "审核通过"}
            </button>
          </div>
          {#if selectedWork?.reviewComment}
            <p class="last-review-comment">上次打回意见：{selectedWork.reviewComment}</p>
          {/if}
        </div>
      {/if}

      <!-- 发布操作（待发布 / 已发布） -->
      {#if selectedWork?.status === "approved" || selectedWork?.status === "published"}
        <div class="publish-section">
          <div class="publish-header">
            <h3>发布平台</h3>
            <button
              class="btn-publish-all"
              disabled={publishAllBusy || pendingPlatforms(selectedWork.id).length === 0}
              onclick={() => handlePublishAll(selectedWork!.id)}
            >
              {publishAllBusy ? "发布中…" : `一键全发布（${pendingPlatforms(selectedWork.id).length} 个平台）`}
            </button>
          </div>
          <div class="platform-grid">
            {#each platforms as p}
              {@const st = platformState(selectedWork.id, p.key)}
              {@const busyKey = `${selectedWork.id}:${p.key}`}
              <div class="platform-card" class:platform-done={st.state === "published"}>
                <span class="plat-name">{p.label}</span>
                {#if st.state === "published"}
                  <span class="plat-state state-ok">已发布 {fmtTime(st.record?.publishedAt)}</span>
                  {#if st.record?.postUrl}
                    <a class="plat-link" href={st.record.postUrl} target="_blank">查看链接</a>
                  {/if}
                {:else if !isConfigured(p.key)}
                  <span class="plat-state state-dim">未配置凭证</span>
                {:else if st.state === "publishing"}
                  <span class="plat-state state-busy">发布中…</span>
                {:else}
                  {#if st.state === "failed"}
                    <span class="plat-state state-fail" title={st.record?.error ?? ""}>发布失败，可重试</span>
                  {:else if st.state === "fallback"}
                    <span class="plat-state state-fail">已导出离线包</span>
                  {/if}
                  <button
                    class="btn-publish"
                    disabled={publishing[busyKey] || publishAllBusy}
                    onclick={() => handlePublishClick(selectedWork!.id, p.key, p.label)}
                  >
                    {publishing[busyKey] ? "发布中…" : st.state === "failed" || st.state === "fallback" ? "重新发布" : "发布"}
                  </button>
                {/if}
              </div>
            {/each}
          </div>
          {#if configuredPlatforms.length === 0}
            <p class="hint-warn">尚未配置任何平台凭证。请先到「视频发布 → 账号管理」完成浏览器登录或填写 API 凭证。</p>
          {/if}
        </div>

        <!-- 发布记录 -->
        {#if selectedRecords.length > 0}
          <div class="records-section">
            <h3>发布记录</h3>
            <table class="records-table">
              <thead><tr><th>平台</th><th>状态</th><th>时间</th><th>链接/错误</th></tr></thead>
              <tbody>
                {#each selectedRecords as r}
                  <tr>
                    <td>{platforms.find((p) => p.key === r.platform)?.label ?? r.platform}</td>
                    <td><span class="status-chip chip-{r.status}">{r.status}</span></td>
                    <td>{fmtTime(r.publishedAt ?? r.createdAt)}</td>
                    <td class="record-detail">
                      {#if r.postUrl}<a href={r.postUrl} target="_blank">查看</a>{/if}
                      {#if r.error}<span class="record-error" title={r.error}>{r.error}</span>{/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .board { width: 100%; }
  .msg { padding: 0.65rem 1rem; border-radius: 4px; font-size: 0.82rem; font-weight: 500; margin-bottom: 1rem; }
  .msg-success { background: var(--success-soft); color: var(--success); }
  .msg-error { background: var(--error-soft); color: var(--error); }
  .loading { display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 4rem 0; color: var(--text-dim); }
  .loader { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── 三栏 ── */
  .lanes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; align-items: start; }
  .lane { background: var(--bg-inset); border: 1px solid var(--border-subtle); border-radius: var(--card-radius); padding: 0.75rem; min-height: 200px; }
  .lane-title { font-family: var(--font-display); font-size: 0.95rem; font-weight: 600; margin: 0 0 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
  .lane-count { font-size: 0.7rem; font-weight: 600; background: var(--accent-soft); color: var(--text-secondary); border-radius: 8px; padding: 0.05rem 0.5rem; }
  .lane-empty { color: var(--text-dim); font-size: 0.78rem; padding: 1.5rem 0.5rem; text-align: center; }

  /* ── 卡片 ── */
  .work-card { position: relative; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); overflow: hidden; cursor: pointer; transition: border-color 0.15s; margin-bottom: 0.75rem; }
  .work-card:hover { border-color: var(--accent); }
  .card-cover { aspect-ratio: 16/9; background: var(--bg-inset); overflow: hidden; }
  .card-cover img, .card-cover video { width: 100%; height: 100%; object-fit: cover; }
  .card-body { padding: 0.65rem 0.75rem 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .card-body h3 { font-size: 0.85rem; margin: 0; line-height: 1.35; }
  .badge { font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; width: fit-content; }
  .badge-review { background: rgba(245, 158, 11, 0.12); color: var(--state-running); }
  .badge-approved { background: var(--info-soft); color: var(--info); }
  .badge-published { background: var(--success-soft); color: var(--success); }

  .corner-badge { position: absolute; top: 0; left: 0; z-index: 2; font-size: 0.65rem; font-weight: 700; padding: 0.15rem 0.5rem; border-radius: 0 0 4px 0; }
  .corner-full { background: var(--success); color: #fff; }
  .corner-partial { background: var(--state-running); color: #fff; }

  .plat-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chip { font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 3px; background: var(--accent-soft); color: var(--text-secondary); }
  .chip-ok { background: var(--success-soft); color: var(--success); }
  .chip-fail { background: var(--error-soft); color: var(--error); }
  .chip-dim { opacity: 0.45; }

  .btn-publish-all { padding: 0.45rem 0.8rem; border: none; border-radius: 4px; background: var(--spark-red); color: #fff; cursor: pointer; font-size: 0.78rem; font-weight: 600; }
  .btn-publish-all:disabled { opacity: 0.45; cursor: not-allowed; }

  /* ── 详情 ── */
  .detail { max-width: 760px; }
  .btn-back { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 0.85rem; margin-bottom: 1rem; }
  .btn-back:hover { color: var(--text); }
  .detail-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
  .detail-header h2 { font-size: 1.1rem; margin: 0; }
  .preview-area { background: var(--bg-inset); border-radius: var(--card-radius); overflow: hidden; margin-bottom: 1rem; max-height: 500px; display: flex; justify-content: center; }
  .preview-area video, .preview-area img { max-width: 100%; max-height: 500px; }
  .preview-empty { color: var(--text-dim); padding: 3rem; text-align: center; }

  /* ── 图文产物预览 ── */
  .cards-preview { margin-bottom: 1rem; }
  .cards-preview h3, .article-preview h3 { font-size: 0.9rem; margin: 0 0 0.6rem; }
  .cards-strip { display: flex; gap: 0.6rem; overflow-x: auto; padding-bottom: 0.5rem; }
  .card-item { flex: 0 0 auto; width: 130px; margin: 0; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; overflow: hidden; }
  .card-item img { width: 100%; display: block; aspect-ratio: 3/4; object-fit: cover; }
  .card-item figcaption { font-size: 0.68rem; color: var(--text-dim); text-align: center; padding: 0.25rem; }
  .article-preview { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .article-render { background: #fff; color: #1a1a1a; border-radius: 6px; padding: 1.2rem 1.4rem; max-height: 480px; overflow-y: auto; }
  .article-render h4 { font-size: 1.05rem; margin: 0 0 0.8rem; line-height: 1.4; }
  .article-render p { font-size: 0.88rem; line-height: 1.8; margin: 0 0 0.8rem; white-space: pre-wrap; }
  .article-render .inline-img { width: 100%; border-radius: 6px; margin: 0.2rem 0 1rem; display: block; }

  .article-section { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .article-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .article-header h3 { font-size: 0.9rem; margin: 0; }
  .article-header-btns { display: flex; gap: 0.4rem; }
  .article-body { padding: 0.5rem; background: var(--bg-inset); border-radius: 4px; }
  .article-body h4 { font-size: 1rem; margin: 0 0 0.5rem; }
  .article-body pre { font-size: 0.85rem; line-height: 1.6; color: var(--text-secondary); white-space: pre-wrap; font-family: inherit; max-height: 400px; overflow-y: auto; }
  .article-title-input { width: 100%; background: var(--bg-surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.45rem 0.6rem; font-size: 0.9rem; margin-bottom: 0.5rem; }
  .article-content-input { width: 100%; background: var(--bg-surface); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.6rem; font-size: 0.85rem; line-height: 1.7; resize: vertical; font-family: inherit; }

  .review-actions { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; margin-bottom: 1rem; }
  .review-actions textarea { width: 100%; background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.5rem; font-size: 0.85rem; resize: vertical; }
  .review-btns { display: flex; gap: 0.5rem; margin-top: 0.75rem; align-items: center; }
  .reject-stage-label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: var(--text-secondary); }
  .reject-stage-select { background: var(--bg-inset); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 0.35rem 0.5rem; font-size: 0.78rem; }
  .last-review-comment { margin: 0.6rem 0 0; font-size: 0.75rem; color: var(--text-dim); border-left: 2px solid var(--border); padding-left: 0.5rem; }
  .btn-reject { padding: 0.5rem 1.2rem; border: 1px solid var(--error); border-radius: 4px; background: none; color: var(--error); cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-reject:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-approve { padding: 0.5rem 1.2rem; border: none; border-radius: 4px; background: var(--success); color: #fff; cursor: pointer; font-size: 0.82rem; font-weight: 600; }
  .btn-approve:disabled { opacity: 0.5; cursor: not-allowed; }

  .publish-section { margin-bottom: 1rem; }
  .publish-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
  .publish-header h3 { font-size: 0.95rem; margin: 0; }
  .platform-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.75rem; }
  .platform-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; align-items: center; }
  .platform-card.platform-done { border-color: rgba(34, 197, 94, 0.35); }
  .plat-name { font-weight: 600; font-size: 0.9rem; }
  .plat-state { font-size: 0.7rem; }
  .state-ok { color: var(--success); }
  .state-fail { color: var(--error); }
  .state-dim { color: var(--text-dim); }
  .state-busy { color: var(--state-running); }
  .plat-link { font-size: 0.7rem; color: var(--info); }
  .btn-publish { padding: 0.4rem 1rem; border: none; border-radius: 4px; background: var(--spark-red); color: #fff; cursor: pointer; font-size: 0.8rem; font-weight: 600; }
  .btn-publish:disabled { opacity: 0.5; cursor: not-allowed; }
  .hint-warn { margin-top: 0.75rem; font-size: 0.78rem; color: var(--state-running); }

  .records-section { margin-top: 1.5rem; }
  .records-section h3 { font-size: 0.95rem; margin: 0 0 0.75rem; }
  .records-table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
  .records-table th { text-align: left; padding: 0.5rem; font-weight: 600; color: var(--text-muted); border-bottom: 1px solid var(--border); }
  .records-table td { padding: 0.5rem; border-bottom: 1px solid var(--border-subtle); }
  .status-chip { padding: 0.1rem 0.4rem; border-radius: 3px; font-size: 0.7rem; font-weight: 600; }
  .chip-published { background: var(--success-soft); color: var(--success); }
  .chip-failed { background: var(--error-soft); color: var(--error); }
  .chip-fallback { background: var(--info-soft); color: var(--info); }
  .chip-publishing { background: rgba(245, 158, 11, 0.12); color: var(--state-running); }
  .record-detail { max-width: 220px; }
  .record-error { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--error); font-size: 0.72rem; vertical-align: bottom; }

  .btn-sm { padding: 0.25rem 0.55rem; border: 1px solid var(--border); border-radius: 3px; background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; font-size: 0.72rem; }
  .btn-sm:hover { color: var(--text); }

  @media (max-width: 900px) {
    .lanes { grid-template-columns: 1fr; }
  }
</style>
