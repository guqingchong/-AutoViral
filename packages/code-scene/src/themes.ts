/** 场景主题:与主仓 src/services/chart-render.ts 的 CHART_THEMES 保持一致(有意复制,依赖隔离) */
export interface SceneTheme {
  key: string;
  background: string;
  palette: string[];
  textColor: string;
  subTextColor: string;
}

export const SCENE_THEMES: SceneTheme[] = [
  { key: "finance_dark", background: "#0f1b2d", palette: ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"], textColor: "#f1f5f9", subTextColor: "#94a3b8" },
  { key: "warm_gold", background: "#161311", palette: ["#d4af37", "#e8c56b", "#b8860b", "#f5deb3", "#cd853f", "#8b6914"], textColor: "#f5efe0", subTextColor: "#a89968" },
  { key: "ink_green", background: "#0d1f1a", palette: ["#3fd68f", "#2dd4bf", "#84cc16", "#facc15", "#fb923c", "#38bdf8"], textColor: "#e8f5ee", subTextColor: "#8fbc9f" },
  { key: "minimal_light", background: "#fafaf7", palette: ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"], textColor: "#1c1917", subTextColor: "#78716c" },
];

export function getSceneTheme(key?: string): SceneTheme {
  return SCENE_THEMES.find((t) => t.key === key) ?? SCENE_THEMES[0];
}
