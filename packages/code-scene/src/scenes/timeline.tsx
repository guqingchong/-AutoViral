import { makeScene2D, Node, Txt, Line, Circle } from "@revideo/2d";
import { all, chain, createRef, waitFor } from "@revideo/core";
import { easeInOutCubic } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, FONT } from "../components";

export interface TimelineParams {
  title: string;                                   // ≤12 字
  kicker?: string;
  events: { time: string; label: string }[];       // 2-5 个节点,time ≤8 字,label ≤16 字
  source?: string;
  theme?: string;
}

/** 时间轴:纵轴主线生长 → 节点逐个激活(圆点弹跳+标签划入) */
export default function makeTimeline(params: TimelineParams) {
  const theme = getSceneTheme(params.theme, params.themeTokens);
  const accent = theme.palette[0];
  const events = params.events.slice(0, 5);
  const n = events.length;
  return makeScene2D("timeline", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);
    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);

    const axisX = -DESIGN_W / 2 + 190;
    const topY = -DESIGN_H / 2 + 380;
    const span = 1150;
    const stepY = span / n;

    const axis = createRef<Line>();
    root().add(<Line ref={axis} points={[[axisX, topY], [axisX, topY]]} stroke={accent} lineWidth={4} lineCap={"round"} />);

    const dots = events.map(() => createRef<Circle>());
    const times = events.map(() => createRef<Txt>());
    const labels = events.map(() => createRef<Txt>());
    events.forEach((ev, i) => {
      const y = topY + stepY * i + stepY / 2;
      const color = theme.palette[i % theme.palette.length];
      root().add(<Circle ref={dots[i]} size={0} fill={color} x={axisX} y={y} />);
      root().add(
        <Txt ref={times[i]} fontFamily={FONT} text={ev.time} fontSize={36} fontWeight={700} fill={color}
          x={axisX + 50 + 110} y={y - 28} textAlign={"left"} width={220} opacity={0} />,
      );
      root().add(
        <Txt ref={labels[i]} fontFamily={FONT} text={ev.label} fontSize={34} fill={theme.textColor}
          x={axisX + 50 + (DESIGN_W - 330) / 2} y={y + 18} textAlign={"left"} width={DESIGN_W - 330} opacity={0} textWrap={true} />,
      );
    });

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.45);
    // 主轴生长
    yield* axis().points([[axisX, topY], [axisX, topY + span]], 0.9, easeInOutCubic);
    // 节点逐个激活
    for (let i = 0; i < n; i++) {
      yield* all(
        dots[i]().size(28, 0.3, easeInOutCubic),
        times[i]().opacity(1, 0.3),
        labels[i]().opacity(1, 0.35),
      );
    }
    yield* waitFor(0.7);
  });
}
