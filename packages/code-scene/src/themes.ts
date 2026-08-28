/** 场景主题:与主仓 src/services/chart-render.ts 的 CHART_THEMES 保持一致(有意复制,依赖隔离)
 *
 * 2026-08-28 批次8.2(v2-M4 令牌注入的最小切片):模版可携带 designTokens 覆盖具名主题
 * (layers[0].designTokens → 渲染 params.themeTokens),实现"模版=设计令牌注入主题系统";
 * footage 级皮肤(调色/转场覆盖真人素材)不在本切片范围。 */
export interface SceneTheme {
  key: string;
  background: string;
  palette: string[];
  textColor: string;
  subTextColor: string;
}

/** 模版级设计令牌覆盖(全部可选,浅覆盖在具名主题之上) */
export interface ThemeTokenOverrides {
  background?: string;
  palette?: string[];
  textColor?: string;
  subTextColor?: string;
}

export const SCENE_THEMES: SceneTheme[] = [
  { key: "finance_dark", background: "#0f1b2d", palette: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"], textColor: "#f1f5f9", subTextColor: "#94a3b8" },
  { key: "warm_gold", background: "#161311", palette: ["#d4af37", "#e8c56b", "#b8860b", "#f5deb3", "#cd853f", "#8b6914"], textColor: "#f5efe0", subTextColor: "#a89968" },
  { key: "ink_green", background: "#0d1f1a", palette: ["#3fd68f", "#2dd4bf", "#84cc16", "#facc15", "#fb923c", "#38bdf8"], textColor: "#e8f5ee", subTextColor: "#8fbc9f" },
  { key: "minimal_light", background: "#fafaf7", palette: ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"], textColor: "#1c1917", subTextColor: "#78716c" },
];

export function getSceneTheme(key?: string, overrides?: ThemeTokenOverrides): SceneTheme {
  const base = SCENE_THEMES.find((t) => t.key === key) ?? SCENE_THEMES[0];
  if (!overrides) return base;
  return {
    ...base,
    ...(overrides.background ? { background: overrides.background } : {}),
    ...(overrides.palette?.length ? { palette: overrides.palette } : {}),
    ...(overrides.textColor ? { textColor: overrides.textColor } : {}),
    ...(overrides.subTextColor ? { subTextColor: overrides.subTextColor } : {}),
  };
}
