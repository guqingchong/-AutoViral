import { makeScene2D, Node, Txt, Rect, Line } from "@revideo/2d";
import { all, createRef, waitFor } from "@revideo/core";
import { easeOutCubic } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, addProgressDots, setProgress, FONT } from "../components";
import { PlopSpring } from "@revideo/core/lib/tweening/spring";
import { spring } from "@revideo/core/lib/tweening/spring";

export interface ChecklistParams {
  title: string;                    // ≤12 字
  kicker?: string;
  items: string[];                  // 2-6 项,每项 ≤18 字
  source?: string;
  theme?: string;
}

/** 清单打勾:逐项弹入 + 对勾描边动画,进度点同步推进 */
export default function makeChecklist(params: ChecklistParams) {
  const theme = getSceneTheme(params.theme);
  const accent = theme.palette[1] ?? theme.palette[0];
  const items = params.items.slice(0, 6);
  const n = items.length;
  return makeScene2D("checklist", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);
    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);
    const dots = addProgressDots(root(), theme, n);

    const topY = -DESIGN_H / 2 + 400;
    const rowH = Math.min(190, 1050 / n);
    const rows = items.map(() => createRef<Rect>());
    const checks = items.map(() => createRef<Line>());
    const texts = items.map(() => createRef<Txt>());
    items.forEach((it, i) => {
      const y = topY + i * rowH;
      root().add(
        <Rect ref={rows[i]} width={880} height={rowH - 30} y={y} radius={16}
          fill={"#ffffff08"} opacity={0} />,
      );
      // 对勾:两段折线,strokeEnd 动画描出
      root().add(
        <Line ref={checks[i]}
          points={[[-26, 0], [-8, 18], [26, -20]]}
          x={-350} y={y} stroke={accent} lineWidth={8} lineCap={"round"} lineJoin={"round"}
          end={0} />,
      );
      root().add(
        <Txt ref={texts[i]} fontFamily={FONT} text={it} fontSize={40} fontWeight={600} fill={theme.textColor}
          x={-270 + 320} y={y} textAlign={"left"} width={640} opacity={0} />,
      );
    });

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.45);
    for (let i = 0; i < n; i++) {
      setProgress(dots, i);
      yield* all(
        rows[i]().opacity(1, 0.25),
        texts[i]().opacity(1, 0.25),
        spring(PlopSpring, 0, 1, 0.01, (v) => rows[i]().scale(0.96 + 0.04 * v)),
      );
      yield* checks[i]().end(1, 0.3, easeOutCubic);
    }
    setProgress(dots, n - 1);
    yield* waitFor(0.8);
  });
}
