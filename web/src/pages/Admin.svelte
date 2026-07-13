<script lang="ts">
  import { exportBackup, restoreBackup, runMigration } from "../lib/api";

  let message = $state("");
  let restorePath = $state("");
  let overwrite = $state(false);

  async function doBackup() {
    message = "正在导出备份…";
    try {
      const res = await exportBackup();
      message = `备份已保存：${res.path}`;
    } catch (e) {
      message = `导出失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function doRestore() {
    if (!restorePath) {
      message = "请填写备份文件路径";
      return;
    }
    message = "正在恢复…";
    try {
      const res = await restoreBackup(restorePath, overwrite);
      message = `已恢复：${res.restored.join(", ")}。请重启 AutoViral。`;
    } catch (e) {
      message = `恢复失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function doMigrate() {
    message = "正在迁移…";
    try {
      const res = await runMigration(false);
      message = `迁移完成：${res.migrated ?? 0} 条旧作品已导入。`;
    } catch (e) {
      message = `迁移失败：${e instanceof Error ? e.message : String(e)}`;
    }
  }
</script>

<div class="admin-page">
  <header class="page-header">
    <h1>运维管理</h1>
    <p class="page-desc">数据库备份、恢复与旧数据迁移工具。</p>
  </header>

  <section class="card">
    <h2>数据备份 / 恢复</h2>
    <p>备份包含 SQLite 数据库、配置文件、skills 和本地作品数据。</p>
    <div class="row">
      <button class="btn-primary" onclick={doBackup}>导出备份</button>
    </div>
    <div class="row">
      <input type="text" placeholder="备份 zip 文件完整路径" bind:value={restorePath} />
      <label class="checkbox-label">
        <input type="checkbox" bind:checked={overwrite} />
        <span>覆盖现有文件</span>
      </label>
      <button class="btn-secondary" onclick={doRestore}>导入恢复</button>
    </div>
  </section>

  <section class="card">
    <h2>旧数据迁移</h2>
    <p>将旧版 YAML 作品一次性导入 SQLite 数据库。</p>
    <button class="btn-secondary" onclick={doMigrate}>开始迁移</button>
  </section>

  {#if message}
    <div class="toast">{message}</div>
  {/if}
</div>

<style>
  .admin-page { padding: 1rem 0; max-width: 720px; }
  .page-header { margin-bottom: 1.5rem; }
  .page-header h1 { font-family: var(--font-display); font-size: var(--size-xl); margin-bottom: 0.25rem; }
  .page-desc { font-size: var(--size-sm); color: var(--text-muted); }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--card-radius);
    padding: 1.25rem;
    margin-bottom: 1rem;
  }
  .card h2 { margin-top: 0; font-size: var(--size-lg); font-weight: 600; }
  .card p { font-size: var(--size-sm); color: var(--text-secondary); margin-bottom: 0.75rem; }
  .row { display: flex; gap: 0.75rem; align-items: center; margin-top: 0.75rem; flex-wrap: wrap; }
  input[type="text"] {
    flex: 1; min-width: 260px;
    padding: 0.45rem 0.65rem;
    border-radius: 4px;
    border: 1px solid var(--card-border);
    background: var(--bg-inset);
    color: var(--text-primary, var(--text));
    font-family: var(--font-body);
    font-size: var(--size-sm);
  }
  .checkbox-label {
    display: flex; align-items: center; gap: 0.35rem;
    font-size: var(--size-sm); color: var(--text-secondary);
    cursor: pointer;
  }
  .btn-primary {
    background: var(--text);
    color: var(--bg);
    border: none; border-radius: 4px;
    padding: 0.5rem 1.1rem;
    font-family: var(--font-body); font-size: var(--size-sm); font-weight: 600;
    cursor: pointer; transition: opacity 0.15s;
  }
  .btn-primary:hover { opacity: 0.8; }
  .btn-secondary {
    background: var(--bg-surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0.5rem 1.1rem;
    font-family: var(--font-body); font-size: var(--size-sm); font-weight: 500;
    cursor: pointer; transition: border-color 0.15s;
  }
  .btn-secondary:hover { border-color: var(--text-dim); }
  .toast {
    margin-top: 1rem; padding: 0.75rem 1rem;
    border-radius: var(--card-radius);
    background: var(--bg-inset); color: var(--text-secondary);
    font-size: var(--size-sm);
  }
</style>
