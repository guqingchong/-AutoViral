<script lang="ts">
  /**
   * 图文发布页：图文作品的三栏发布看板（待审核/待发布/已发布）。
   * 审核详情内可直接编辑文章标题与正文；看板逻辑与视频发布页共用 PublishBoard。
   */
  import PublishBoard from "../components/PublishBoard.svelte";

  /** 图文发布平台 */
  const IMAGE_TEXT_PLATFORMS = [
    { key: "xiaohongshu", label: "小红书" },
    { key: "wechat_mp", label: "公众号" },
    { key: "zhihu", label: "知乎" },
  ];
</script>

<div class="image-text-publish">
  <header class="page-header">
    <h1>图文发布</h1>
    <p class="page-subtitle">图文作品完成合成后进入待审核栏；审核通过后可一键全发布或单平台发布。平台凭证在「视频发布 → 账号管理」中配置。</p>
  </header>

  <PublishBoard kind="image-text" platforms={IMAGE_TEXT_PLATFORMS} />
</div>

<style>
  .image-text-publish { padding: 1rem 0; max-width: 1400px; }
  .page-header { margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); }
  .page-subtitle { font-size: 0.82rem; color: var(--text-dim); margin-top: 0.25rem; }
</style>
