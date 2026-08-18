<script lang="ts">
  /**
   * 大模型直连设置区块（2026-08-18 修复：P1-T7 的 LLM 配置此前只进了
   * 未被路由的 SettingsPanel.svelte，实际设置抽屉（App.svelte）没有 API key 入口，
   * 打包分发后新电脑无法填 key。抽出为共享组件，两处共用）。
   *
   * 包含：三家 provider 卡片（API Key/Base URL/视觉模型/启用/连通性测试）
   *     + 默认 provider + 六阶段模型路由（P3-T3）。
   */

  export interface LlmProviderForm { apiKey: string; baseUrl: string; visionModel: string; enabled: boolean; }

  interface Props {
    providers: Record<string, LlmProviderForm>;
    defaultProvider: string;
    models: Record<string, string>;
    modelSuggestions: Record<string, string[]>;
  }
  let {
    providers = $bindable(),
    defaultProvider = $bindable(),
    models = $bindable(),
    modelSuggestions = $bindable(),
  }: Props = $props();

  const PROVIDER_META = [
    { key: "deepseek", name: "DeepSeek", hint: "策划/合成/评审主力" },
    { key: "kimi", name: "Kimi Coding Plan", hint: "调研(联网搜索)" },
    { key: "glm", name: "GLM Coding Plan", hint: "视觉看图(glm-4v)" },
  ];

  const STAGE_META = [
    { key: "research", label: "调研", hint: "话题调研/素材搜索(联网)" },
    { key: "plan", label: "策划", hint: "分镜规划/脚本" },
    { key: "assets", label: "素材", hint: "素材准备/生图提示" },
    { key: "assembly", label: "合成", hint: "视频合成/字幕" },
    { key: "eval", label: "评审", hint: "阶段质量评审" },
    { key: "script", label: "文案", hint: "发布文案/杂项 JSON" },
  ] as const;

  let showKey = $state<Record<string, boolean>>({});
  let ping = $state<Record<string, { state: "idle" | "testing" | "ok" | "fail"; latencyMs?: number; error?: string }>>({});

  async function pingProvider(key: string) {
    const p = providers[key];
    ping[key] = { state: "testing" };
    try {
      const res = await fetch("/api/llm/ping", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // apiKey 为掩码回显(含 ***)时服务端自动回落到已保存的 key
        body: JSON.stringify({ provider: key, baseUrl: p.baseUrl, apiKey: p.apiKey }),
      });
      const data = await res.json();
      ping[key] = data.ok
        ? { state: "ok", latencyMs: data.latencyMs }
        : { state: "fail", latencyMs: data.latencyMs, error: data.error ?? `HTTP ${res.status}` };
    } catch (err) {
      ping[key] = { state: "fail", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 某阶段下拉的可选项:所有启用 provider 的建议模型,格式 "provider:model";当前值不在清单时保留显示 */
  function stageOptions(stageKey: string): { value: string; label: string }[] {
    const opts: { value: string; label: string }[] = [];
    for (const meta of PROVIDER_META) {
      if (!providers[meta.key]?.enabled) continue;
      for (const m of modelSuggestions[meta.key] ?? []) {
        opts.push({ value: `${meta.key}:${m}`, label: `${meta.name} / ${m}` });
      }
    }
    const cur = models[stageKey];
    if (cur && !opts.some((o) => o.value === cur)) {
      opts.push({ value: cur, label: `${cur}(自定义)` });
    }
    return opts;
  }
</script>

<div class="llm-settings">
  {#each PROVIDER_META as meta}
    {@const p = providers[meta.key]}
    {@const pingState = ping[meta.key]}
    {#if p}
      <div class="llm-card" class:llm-off={!p.enabled}>
        <div class="llm-card-head">
          <div class="llm-card-title">
            <span class="llm-card-name">{meta.name}</span>
            <span class="llm-card-hint">{meta.hint}</span>
          </div>
          <button
            class="llm-toggle"
            class:on={p.enabled}
            onclick={() => p.enabled = !p.enabled}
            role="switch"
            aria-checked={p.enabled}
            aria-label={`启用 ${meta.name}`}
          >
            <span class="llm-toggle-thumb"></span>
          </button>
        </div>
        <label class="llm-field">
          API Key
          <div class="llm-input-row">
            <input
              type={showKey[meta.key] ? "text" : "password"}
              class="llm-input"
              bind:value={p.apiKey}
              placeholder="sk-..."
            />
            <button class="llm-vis" onclick={() => showKey[meta.key] = !showKey[meta.key]} aria-label="切换可见">
              {showKey[meta.key] ? "隐藏" : "显示"}
            </button>
          </div>
        </label>
        <label class="llm-field">
          Base URL
          <input type="text" class="llm-input" bind:value={p.baseUrl} placeholder="https://..." />
        </label>
        <label class="llm-field">
          视觉模型（可选）
          <input type="text" class="llm-input" bind:value={p.visionModel} placeholder="如 glm-4v" />
        </label>
        <div class="llm-card-foot">
          <button class="llm-ping" disabled={pingState?.state === "testing"} onclick={() => pingProvider(meta.key)}>
            {pingState?.state === "testing" ? "测试中..." : "测试连通性"}
          </button>
          {#if pingState?.state === "ok"}
            <span class="llm-ping-result llm-ping-ok">✓ 连通 {pingState.latencyMs}ms</span>
          {:else if pingState?.state === "fail"}
            <span class="llm-ping-result llm-ping-fail" title={pingState.error}>✗ {pingState.error}</span>
          {/if}
        </div>
      </div>
    {/if}
  {/each}

  <div class="llm-routing">
    <label class="llm-field llm-default-row">
      默认 provider
      <select class="llm-input" bind:value={defaultProvider}>
        {#each PROVIDER_META as meta}
          <option value={meta.key}>{meta.name}（{meta.hint}）</option>
        {/each}
      </select>
    </label>
    <p class="llm-hint">阶段路由未单独设置的阶段走默认 provider 的默认模型。</p>
    <h4 class="llm-routing-title">阶段模型路由</h4>
    {#each STAGE_META as stage}
      <label class="llm-field llm-stage-row">
        <span class="llm-stage-name">{stage.label}<span class="llm-stage-hint">{stage.hint}</span></span>
        <select class="llm-input llm-stage-select" bind:value={models[stage.key]}>
          <option value="">默认（defaultProvider）</option>
          {#each stageOptions(stage.key) as opt}
            <option value={opt.value}>{opt.label}</option>
          {/each}
        </select>
      </label>
    {/each}
  </div>
</div>

<style>
  .llm-settings {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .llm-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.65rem;
    border-radius: 10px;
    border: 1px solid rgba(128, 128, 128, 0.2);
    transition: opacity 0.15s ease;
  }

  .llm-card.llm-off {
    opacity: 0.45;
  }

  .llm-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .llm-card-title {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
  }

  .llm-card-name {
    font-size: 0.82rem;
    font-weight: 600;
  }

  .llm-card-hint {
    font-size: 0.65rem;
    opacity: 0.5;
  }

  .llm-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
  }

  .llm-input-row {
    display: flex;
    gap: 0.4rem;
  }

  .llm-input {
    width: 100%;
    padding: 0.4rem 0.55rem;
    border-radius: 7px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    background: transparent;
    color: inherit;
    font-size: 0.78rem;
  }

  .llm-input:focus {
    outline: none;
    border-color: #3b82f6;
  }

  .llm-vis, .llm-ping {
    padding: 0.35rem 0.6rem;
    border-radius: 7px;
    border: 1px solid rgba(128, 128, 128, 0.3);
    background: transparent;
    color: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }

  .llm-vis:hover, .llm-ping:hover {
    border-color: #3b82f6;
  }

  .llm-ping:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .llm-toggle {
    position: relative;
    width: 34px;
    height: 19px;
    border-radius: 999px;
    border: none;
    background: rgba(128, 128, 128, 0.35);
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .llm-toggle.on {
    background: #3b82f6;
  }

  .llm-toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 15px;
    height: 15px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }

  .llm-toggle.on .llm-toggle-thumb {
    transform: translateX(15px);
  }

  .llm-card-foot {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .llm-ping-result {
    font-size: 0.68rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .llm-ping-ok { color: #4ade80; }
  .llm-ping-fail { color: #f87171; }

  .llm-routing {
    margin-top: 0.35rem;
    padding-top: 0.55rem;
    border-top: 1px dashed rgba(128, 128, 128, 0.25);
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .llm-routing-title {
    font-size: 0.78rem;
    font-weight: 600;
    margin: 0.2rem 0 0;
  }

  .llm-hint {
    font-size: 0.65rem;
    opacity: 0.5;
    margin: 0;
  }

  .llm-stage-row {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }

  .llm-stage-name {
    min-width: 6.8rem;
    font-size: 0.75rem;
    display: flex;
    flex-direction: column;
  }

  .llm-stage-hint {
    font-size: 0.62rem;
    opacity: 0.45;
  }

  .llm-stage-select {
    flex: 1;
  }
</style>
