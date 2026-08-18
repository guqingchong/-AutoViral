import { makeScene2D, Node, Rect, Txt, Line } from "@revideo/2d";
import { all, chain, createRef, easeInOutCubic, easeOutBack, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";

export interface StructureGrowthParams {
  title: string;                 // ≤12 字
  center: string;                // ≤6 字
  branches: { text: string; label: string; color?: string }[];  // 2-4 个,text ≤6 字,label ≤8 字
  theme?: string;
  loopArrow?: boolean;           // 收尾循环箭头(默认 true)
}

/** 中心辐射结构图:中心弹入 → 分支错峰弹入 → 连线生长 → 标签淡入 → 循环箭头 → 中心脉冲 */
export default function makeStructureGrowth(params: StructureGrowthParams) {
  const theme = getSceneTheme(params.theme);
  const W = DESIGN_W, H = DESIGN_H;
  const items = params.branches.slice(0, 4);
  const n = items.length;
  const stepX = Math.min(360, 820 / Math.max(n - 1, 1));
  const centerPos = { x: 0, y: -80 };
  const branchPos = items.map((_, i) => ({
    x: (i - (n - 1) / 2) * stepX,
    y: i % 2 === 0 ? 420 : 560,
  }));

  return makeScene2D("structure-growth", function* (view) {
    view.fill(theme.background);
    // 内容挂在按实际分辨率缩放的容器下,布局数学保持在设计空间(1080x1920)
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    const title = createRef<Txt>();
    root().add(<Txt fontFamily="Noto Sans CJK SC" ref={title} text={params.title} fontSize={72} fontWeight={700} fill={theme.textColor} y={-H / 2 + 160} opacity={0} />);

    const center = createRef<Rect>();
    root().add(
      <Rect ref={center} width={360} height={160} radius={24} fill={theme.palette[0]}
        position={[centerPos.x, centerPos.y]} scale={0} shadowBlur={40} shadowColor={theme.palette[0] + "aa"}>
        <Txt fontFamily="Noto Sans CJK SC" text={params.center} fontSize={56} fontWeight={700} fill={"#ffffff"} />
      </Rect>,
    );

    const branches = items.map(() => createRef<Rect>());
    const lines = items.map(() => createRef<Line>());
    const labels = items.map(() => createRef<Txt>());
    items.forEach((b, i) => {
      const color = b.color ?? theme.palette[(i + 1) % theme.palette.length];
      const pos = branchPos[i];
      root().add(<Line ref={lines[i]} points={[[centerPos.x, centerPos.y + 80], [pos.x, pos.y - 70]]}
        stroke={theme.subTextColor} lineWidth={6} end={0} radius={40} />);
      root().add(
        <Rect ref={branches[i]} width={280} height={140} radius={20} fill={color}
          position={[pos.x, pos.y]} scale={0} shadowBlur={30} shadowColor={color + "88"}>
          <Txt fontFamily="Noto Sans CJK SC" text={b.text} fontSize={48} fontWeight={700} fill={"#ffffff"} />
        </Rect>,
      );
      root().add(<Txt fontFamily="Noto Sans CJK SC" ref={labels[i]} text={b.label} fontSize={34} fill={theme.subTextColor}
        position={[(centerPos.x + pos.x) / 2, (centerPos.y + 80 + pos.y - 70) / 2 - 30]} opacity={0} />);
    });

    let loopArrow: ReturnType<typeof createRef<Line>> | null = null;
    if (params.loopArrow !== false) {
      loopArrow = createRef<Line>();
      const lastY = branchPos[n - 1].y;
      root().add(<Line ref={loopArrow} points={[[0, lastY + 70], [0, 800], [centerPos.x, centerPos.y + 160]]}
        stroke={theme.palette[1]} lineWidth={5} lineDash={[16, 12]} endArrow end={0} radius={30} />);
    }

    yield* title().opacity(1, 0.6, easeInOutCubic);
    yield* center().scale(1, 0.5, easeOutBack);
    yield* chain(
      ...items.flatMap((_, i) => [
        all(lines[i]().end(1, 0.45, easeInOutCubic), branches[i]().scale(1, 0.45, easeOutBack)),
        labels[i]().opacity(1, 0.3),
      ]),
    );
    if (loopArrow) yield* loopArrow().end(1, 0.8, easeInOutCubic);
    yield* chain(center().scale(1.08, 0.25, easeInOutCubic), center().scale(1, 0.25, easeInOutCubic));
    yield* waitFor(0.5);
  });
}
