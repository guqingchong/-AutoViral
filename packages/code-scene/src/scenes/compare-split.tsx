import { makeScene2D, Node, Rect, Txt, Line } from "@revideo/2d";
import { all, createRef, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, FONT } from "../components";
import { springSlideIn, stagger } from "../motion";
import { SmoothSpring } from "@revideo/core/lib/tweening/spring";

export interface CompareSplitParams {
  title: string;                                   // ≤12 字
  kicker?: string;
  left: { label: string; points: string[] };       // 各 point ≤14 字,2-4 条
  right: { label: string; points: string[] };
  verdict?: string;                                // 底部结论,≤24 字
  source?: string;
  theme?: string;
}

/** 对比对照:左右双栏自两侧弹簧滑入 → 逐项错峰点亮 → 结论压底 */
export default function makeCompareSplit(params: CompareSplitParams) {
  const theme = getSceneTheme(params.theme);
  const leftColor = theme.palette[1] ?? theme.palette[0];
  const rightColor = theme.palette[0];
  const midX = 20; // 中缝
  const colW = (DESIGN_W - 120) / 2;
  return makeScene2D("compare-split", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);
    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);

    const colTop = -DESIGN_H / 2 + 330;
    const colH = 1080;
    const leftX = -(DESIGN_W / 2) + 60 + colW / 2 - midX;
    const rightX = DESIGN_W / 2 - 60 - colW / 2 + midX;

    const colRefs = [createRef<Rect>(), createRef<Rect>()];
    const headerRefs = [createRef<Txt>(), createRef<Txt>()];
    const columns = [params.left, params.right] as const;
    columns.forEach((col, ci) => {
      const color = ci === 0 ? leftColor : rightColor;
      root().add(
        <Rect ref={colRefs[ci]} width={colW} height={colH} y={colTop + colH / 2}
          x={ci === 0 ? leftX : rightX}
          fill={"#ffffff08"} stroke={color} lineWidth={3} radius={20} opacity={0} />,
      );
      root().add(
        <Txt ref={headerRefs[ci]} fontFamily={FONT} text={col.label} fontSize={44} fontWeight={700}
          fill={color} x={ci === 0 ? leftX : rightX} y={colTop + 56} opacity={0} />,
      );
    });
    // 中缝 VS 线
    const vs = createRef<Txt>();
    root().add(<Line points={[[0, colTop + 90], [0, colTop + colH - 40]]} stroke={"#ffffff20"} lineWidth={2} />);
    root().add(<Txt ref={vs} fontFamily={FONT} text="VS" fontSize={38} fontWeight={900} fill={theme.subTextColor} y={colTop + colH / 2} opacity={0} />);

    // 逐项条目
    const itemRefs: ReturnType<typeof createRef<Txt>>[][] = [[], []];
    columns.forEach((col, ci) => {
      col.points.slice(0, 4).forEach((pt, pi) => {
        const r = createRef<Txt>();
        itemRefs[ci].push(r);
        root().add(
          <Txt ref={r} fontFamily={FONT} text={`· ${pt}`} fontSize={34} fill={theme.textColor}
            x={(ci === 0 ? leftX : rightX) - colW / 2 + 40 + (colW - 80) / 2}
            y={colTop + 150 + pi * 130}
            textAlign={"left"} width={colW - 80} opacity={0} />,
        );
      });
    });

    const verdict = createRef<Txt>();
    if (params.verdict) {
      root().add(
        <Txt ref={verdict} fontFamily={FONT} text={params.verdict} fontSize={38} fontWeight={700}
          fill={theme.textColor} y={colTop + colH + 90} opacity={0} textAlign={"center"} width={DESIGN_W - 200} />,
      );
    }
    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.45);
    yield* all(
      springSlideIn(colRefs[0]() as unknown as Node, colTop + colH / 2, 0, SmoothSpring),
      springSlideIn(colRefs[1]() as unknown as Node, colTop + colH / 2, 0, SmoothSpring),
    );
    yield* all(
      headerRefs[0]().opacity(1, 0.3),
      headerRefs[1]().opacity(1, 0.3),
      vs().opacity(1, 0.3),
    );
    // 逐项交错点亮(左右交替,逐项对照感)
    const maxN = Math.max(itemRefs[0].length, itemRefs[1].length);
    yield* stagger(
      Array.from({ length: maxN }, (_, i) => i),
      0.35,
      function* (i) {
        yield* all(
          ...(itemRefs[0][i] ? [itemRefs[0][i]().opacity(1, 0.3)] : []),
          ...(itemRefs[1][i] ? [itemRefs[1][i]().opacity(1, 0.3)] : []),
        );
      },
    );
    if (params.verdict) yield* verdict().opacity(1, 0.5);
    yield* waitFor(0.7);
  });
}
