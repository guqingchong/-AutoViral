import { makeScene2D, Node, Rect, Txt, Circle } from "@revideo/2d";
import { chain, createRef, easeInOutCubic, easeOutCubic, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";

export interface FlowStepsParams {
  title: string;                                  // ≤12 字
  steps: { title: string; desc?: string }[];      // 2-5 步,title ≤8 字,desc ≤16 字
  theme?: string;
}

/** 流程步骤推进:标题淡入 → 步骤自右滑入 → 当前步脉冲强调逐步推进 */
export default function makeFlowSteps(params: FlowStepsParams) {
  const theme = getSceneTheme(params.theme);
  const H = DESIGN_H;
  const steps = params.steps.slice(0, 5);
  const n = steps.length;
  const areaH = 1150;
  const stepGap = areaH / n;
  const topY = -areaH / 2 + stepGap / 2;

  return makeScene2D("flow-steps", function* (view) {
    view.fill(theme.background);
    // 内容挂在按实际分辨率缩放的容器下,布局数学保持在设计空间(1080x1920)
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    const title = createRef<Txt>();
    root().add(<Txt fontFamily="Noto Sans CJK SC" ref={title} text={params.title} fontSize={72} fontWeight={700} fill={theme.textColor} y={-H / 2 + 160} opacity={0} />);

    const cards = steps.map(() => createRef<Rect>());
    steps.forEach((s, i) => {
      const y = topY + i * stepGap;
      const accent = theme.palette[i % theme.palette.length];
      root().add(
        <Rect ref={cards[i]} width={920} height={stepGap - 40} radius={24}
          fill={"#ffffff10"} stroke={accent} lineWidth={3}
          position={[DESIGN_W, y]} opacity={0}>
          <Circle size={96} fill={accent} x={-360}>
            <Txt fontFamily="Noto Sans CJK SC" text={String(i + 1)} fontSize={52} fontWeight={700} fill={"#ffffff"} />
          </Circle>
          <Txt fontFamily="Noto Sans CJK SC" text={s.title} fontSize={52} fontWeight={700} fill={theme.textColor} x={0} y={s.desc ? -28 : 0} textAlign={"left"} width={560} />
          {s.desc ? <Txt fontFamily="Noto Sans CJK SC" text={s.desc} fontSize={32} fill={theme.subTextColor} x={0} y={36} textAlign={"left"} width={560} /> : null}
        </Rect>,
      );
    });

    yield* title().opacity(1, 0.6, easeInOutCubic);
    for (let i = 0; i < n; i++) {
      const y = topY + i * stepGap;
      yield* cards[i]().opacity(1, 0.01);
      yield* cards[i]().position([40, y], 0.45, easeOutCubic);
      // 当前步脉冲
      yield* chain(cards[i]().scale(1.04, 0.2, easeInOutCubic), cards[i]().scale(1, 0.2, easeInOutCubic));
    }
    yield* waitFor(0.6);
  });
}
