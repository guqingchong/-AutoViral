<script lang="ts">
  import { onMount } from "svelte";
  import { fetchTopics, convertTopicToWork, type Topic } from "../lib/api.js";
  import { t, getLanguage } from "../lib/i18n.js";

  let topics = $state<Topic[]>([]);
  let loading = $state(true);
  let platform = $state<string>("");
  let lang = $state(getLanguage());

  const platforms = [
    { value: "", label: "全部平台" },
    { value: "douyin", label: "抖音" },
    { value: "xiaohongshu", label: "小红书" },
    { value: "kuaishou", label: "快手" },
    { value: "bilibili", label: "B站" },
    { value: "zhihu", label: "知乎" },
  ];

  async function load() {
    loading = true;
    try {
      topics = await fetchTopics(platform || undefined);
    } finally {
      loading = false;
    }
  }

  async function convert(topic: Topic) {
    try {
      const { workId } = await convertTopicToWork(topic.id, { platforms: [topic.platform || "douyin"], type: "short-video" });
      // parent can open studio via event; here we just mark status
      topic.status = "converted";
    } catch {
      alert("转换失败");
    }
  }

  onMount(load);
</script>

<div class="topics-page">
  <header class="page-header">
    <h1>选题中心</h1>
    <div class="filters">
      <select bind:value={platform} onchange={load}>
        {#each platforms as p}
          <option value={p.value}>{p.label}</option>
        {/each}
      </select>
      <button class="btn-primary" onclick={load}>刷新</button>
    </div>
  </header>

  {#if loading}
    <p class="empty">加载中…</p>
  {:else if topics.length === 0}
    <p class="empty">暂无选题，点击刷新或前往设置开启自动调研。</p>
  {:else}
    <div class="topic-grid">
      {#each topics as topic}
        <article class="topic-card">
          <div class="topic-meta">
            <span class="platform">{topic.platform ?? "通用"}</span>
            <span class="heat">热度 {topic.heat ?? 0}</span>
            <span class="opportunity">{topic.opportunity ?? ""}</span>
          </div>
          <h3>{topic.title}</h3>
          {#if topic.description}
            <p class="desc">{topic.description}</p>
          {/if}
          {#if topic.example_hook}
            <p class="hook">{topic.example_hook}</p>
          {/if}
          <div class="tags">
            {#each topic.tags as tag}
              <span class="tag">#{tag}</span>
            {/each}
          </div>
          <button class="btn-primary" disabled={topic.status === "converted"} onclick={() => convert(topic)}>
            {topic.status === "converted" ? "已转换" : "转为作品"}
          </button>
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .topics-page { padding: 1rem 0; }
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .filters { display: flex; gap: 0.75rem; align-items: center; }
  .empty { color: var(--text-muted); padding: 2rem 0; }
  .topic-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 1rem; }
  .topic-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 1rem; display: flex; flex-direction: column; gap: 0.6rem; }
  .topic-meta { display: flex; gap: 0.5rem; font-size: var(--size-xs); color: var(--text-muted); }
  .heat { color: var(--spark-red); }
  .topic-card h3 { font-size: var(--size-lg); margin: 0; }
  .desc, .hook { font-size: var(--size-sm); color: var(--text-secondary); margin: 0; }
  .hook { color: var(--spark-red); }
  .tags { display: flex; flex-wrap: wrap; gap: 0.35rem; }
  .tag { font-size: var(--size-xs); color: var(--text-muted); background: var(--bg-inset); padding: 0.15rem 0.4rem; border-radius: 3px; }
  .btn-primary { margin-top: auto; }
</style>
