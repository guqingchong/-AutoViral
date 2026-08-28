import { makeScene2D, Node, Rect, Txt, Line } from "@revideo/2d";
import { all, chain, createRef, easeInOutCubic, easeOutBack, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_H, designScale } from "../layout";

export interface LogicChainParams {
  title: string;                 // ≤12 字
  chain: string[];               // 2-4 节,每节 ≤10 字
  theme?: string;
}

/** 逻辑链条:标题淡入 → 节点逐节弹入 → 箭头连线生长 */
export default function makeLogicChain(params: LogicChainParams) {
  const theme = getSceneTheme(params.theme, params.themeTokens);
  const H = DESIGN_H;
  const items = params.chain.slice(0, 4);
  const n = items.length;
  const areaH = 1200;
  const gap = areaH / n;
  const topY = -areaH / 2 + gap / 2;

  return makeScene2D("logic-chain", function* (view) {
    view.fill(theme.background);
    // 内容挂在按实际分辨率缩放的容器下,布局数学保持在设计空间(1080x1920)
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    const title = createRef<Txt>();
    root().add(<Txt fontFamily="Noto Sans CJK SC" ref={title} text={params.title} fontSize={72} fontWeight={700} fill={theme.textColor} y={-H / 2 + 160} opacity={0} />);

    const nodes = items.map(() => createRef<Rect>());
    const arrows = items.slice(0, -1).map(() => createRef<Line>());
    items.forEach((text, i) => {
      const y = topY + i * gap;
      const color = theme.palette[i % theme.palette.length];
      root().add(
        <Rect ref={nodes[i]} width={760} height={140} radius={70} fill={color}
          position={[0, y]} scale={0} shadowBlur={30} shadowColor={color + "88"}>
          <Txt fontFamily="Noto Sans CJK SC" text={text} fontSize={46} fontWeight={700} fill={"#ffffff"} />
        </Rect>,
      );
      if (i < n - 1) {
        root().add(<Line ref={arrows[i]} points={[[0, y + 70], [0, y + gap - 70]]}
          stroke={theme.subTextColor} lineWidth={8} endArrow end={0} />);
      }
    });

    yield* title().opacity(1, 0.6, easeInOutCubic);
    yield* chain(
      ...items.flatMap((_, i) => [
        nodes[i]().scale(1, 0.4, easeOutBack),
        ...(i < n - 1 ? [arrows[i]().end(1, 0.3, easeInOutCubic)] : []),
      ]),
    );
    yield* all(...nodes.map((r) => r().scale(1.03, 0.5, easeInOutCubic).to(1, 0.5, easeInOutCubic)));
    yield* waitFor(0.4);
  });
}
