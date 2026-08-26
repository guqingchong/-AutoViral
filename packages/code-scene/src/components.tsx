/**
 * 共享版式件（2026-08-18 03 方案）：背景网格/角标/来源标注/进度点。
 * 信息设计层的"图层叙事"——精致感来自这些不抢戏但始终在場的结构件。
 */

import { Node, Rect, Txt, Line, Circle } from "@revideo/2d";
import { createRef } from "@revideo/core";
import type { SceneTheme } from "./themes";
import { DESIGN_W, DESIGN_H } from "./layout";

export const FONT = "Noto Sans CJK SC";

/** 全局背景层：底色 + 细网格 + 四角装饰标（所有模板统一挂载,视觉一致性的底座） */
export function addBackdrop(root: Node, theme: SceneTheme): void {
  const accent = theme.palette[0];
  // 细网格(5% 透明度,只为画面增加"工程图"质感)
  const grid: ReturnType<typeof createRef<Line>>[] = [];
  const cols = 6;
  const rows = 10;
  const points: [number, number][][] = [];
  for (let i = 1; i < cols; i++) {
    const x = -DESIGN_W / 2 + (DESIGN_W / cols) * i;
    points.push([[x, -DESIGN_H / 2], [x, DESIGN_H / 2]]);
  }
  for (let i = 1; i < rows; i++) {
    const y = -DESIGN_H / 2 + (DESIGN_H / rows) * i;
    points.push([[-DESIGN_W / 2, y], [DESIGN_W / 2, y]]);
  }
  for (const pts of points) {
    const r = createRef<Line>();
    grid.push(r);
    root.add(<Line ref={r} points={pts} stroke={"#ffffff"} opacity={0.04} lineWidth={1} />);
  }
  // 四角 L 形角标(取景框语言)
  const m = 56;  // 边距
  const L = 44;  // 角标臂长
  const corners: Array<{ x: number; y: number; sx: number; sy: number }> = [
    { x: -DESIGN_W / 2 + m, y: -DESIGN_H / 2 + m, sx: 1, sy: 1 },
    { x: DESIGN_W / 2 - m, y: -DESIGN_H / 2 + m, sx: -1, sy: 1 },
    { x: -DESIGN_W / 2 + m, y: DESIGN_H / 2 - m, sx: 1, sy: -1 },
    { x: DESIGN_W / 2 - m, y: DESIGN_H / 2 - m, sx: -1, sy: -1 },
  ];
  for (const c of corners) {
    root.add(
      <Line
        points={[[0, L * c.sy], [0, 0], [L * c.sx, 0]]}
        position={[c.x, c.y]}
        stroke={accent}
        lineWidth={3}
        opacity={0.5}
      />,
    );
  }
}

/** 底部来源标注行(回形针式"材料可查"语言):左小圆点+文字 */
export function addSourceNote(root: Node, theme: SceneTheme, text: string): void {
  if (!text) return;
  const y = DESIGN_H / 2 - 96;
  root.add(<Circle size={10} fill={theme.palette[0]} x={-DESIGN_W / 2 + 76} y={y} opacity={0.9} />);
  root.add(
    <Txt
      fontFamily={FONT}
      text={text}
      fontSize={26}
      fill={theme.subTextColor}
      x={-DESIGN_W / 2 + 96 + (DESIGN_W - 192) / 2}
      y={y}
      textAlign={"left"}
      width={DESIGN_W - 192}
      textWrap={true}
    />,
  );
}

/** 顶部进度点(多步场景用):当前步实心高亮,其余半透明 */
export function addProgressDots(root: Node, theme: SceneTheme, total: number): ReturnType<typeof createRef<Circle>>[] {
  const dots = Array.from({ length: total }, () => createRef<Circle>());
  const gap = 28;
  const startX = -((total - 1) * gap) / 2;
  const y = -DESIGN_H / 2 + 96;
  dots.forEach((d, i) => {
    root.add(<Circle ref={d} size={12} fill={theme.palette[0]} x={startX + i * gap} y={y} opacity={0.25} />);
  });
  return dots;
}

/** 进度点当前态切换 */
export function setProgress(dots: Array<ReturnType<typeof createRef<Circle>>>, current: number): void {
  dots.forEach((d, i) => {
    d().opacity(i === current ? 1 : i < current ? 0.6 : 0.25);
    d().size(i === current ? 16 : 12);
  });
}

/** 标题区标准件:眉线(小色条+kicker)+主标题,返回主标题 ref 供动画 */
export function addTitleBlock(
  root: Node,
  theme: SceneTheme,
  kicker: string,
  title: string,
): { title: ReturnType<typeof createRef<Txt>> } {
  const titleRef = createRef<Txt>();
  const topY = -DESIGN_H / 2 + 150;
  root.add(
    <Rect width={56} height={8} fill={theme.palette[0]} x={-DESIGN_W / 2 + 96} y={topY - 26} radius={4} />,
  );
  if (kicker) {
    root.add(
      <Txt fontFamily={FONT} text={kicker} fontSize={28} fontWeight={500} fill={theme.palette[0]}
        x={-DESIGN_W / 2 + 170 + (DESIGN_W - 260) / 2} y={topY - 26} textAlign={"left"} width={DESIGN_W - 260} textWrap={true} />,
    );
  }
  root.add(
    <Txt ref={titleRef} fontFamily={FONT} text={title} fontSize={64} fontWeight={700} fill={theme.textColor}
      x={-DESIGN_W / 2 + 96 + (DESIGN_W - 192) / 2} y={topY + 36} textAlign={"left"} width={DESIGN_W - 192} opacity={0} textWrap={true} />,
  );
  return { title: titleRef };
}
