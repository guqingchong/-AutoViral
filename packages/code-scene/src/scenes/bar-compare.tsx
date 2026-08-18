import { makeScene2D, Node, Txt, Rect } from "@revideo/2d";
import { all, createRef, waitFor } from "@revideo/core";
import { easeOutCubic } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, FONT } from "../components";
import { stagger } from "../motion";

export interface BarCompareParams {
  title: string;                                // ≤12 字
  kicker?: string;
  bars: { label: string; value: number }[];     // 2-5 条,label ≤10 字
  unit?: string;                                // 数值单位(如 "亿元")
  highlightIndex?: number;                      // 高亮条(默认最大值)
  source?: string;
  theme?: string;
}

/** 条形对比:柱条弹簧生长+数值随动滚动,最高项高亮。比 chart 端点更"设计感"的轻量数据卡 */
export default function makeBarCompare(params: BarCompareParams) {
  const theme = getSceneTheme(params.theme);
  const bars = params.bars.slice(0, 5);
  const n = bars.length;
  const maxV = Math.max(...bars.map((b) => b.value), 1);
  const hi = params.highlightIndex ?? bars.findIndex((b) => b.value === maxV);
  return makeScene2D("bar-compare", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);
    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);

    const topY = -DESIGN_H / 2 + 420;
    const rowH = Math.min(220, 1000 / n);
    const labelX = -DESIGN_W / 2 + 110;
    const barX = labelX + 190;
    const barMaxW = DESIGN_W - 190 - 320;

    const barRefs = bars.map(() => createRef<Rect>());
    const valRefs = bars.map(() => createRef<Txt>());
    bars.forEach((b, i) => {
      const y = topY + i * rowH;
      const color = i === hi ? theme.palette[0] : `${theme.palette[1] ?? theme.palette[0]}66`;
      root().add(
        <Txt fontFamily={FONT} text={b.label} fontSize={36} fill={theme.textColor}
          x={labelX + 90} y={y} textAlign={"left"} width={180} />,
      );
      root().add(
        <Rect ref={barRefs[i]} width={0} height={rowH * 0.52} x={barX} y={y}
          fill={color} radius={8} />,
      );
      root().add(
        <Txt ref={valRefs[i]} fontFamily={FONT} text={"0"} fontSize={34} fontWeight={700}
          fill={i === hi ? theme.palette[0] : theme.subTextColor}
          x={barX + 60} y={y} textAlign={"left"} width={120} opacity={0} />,
      );
    });

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.45);
    yield* stagger(bars.map((_, i) => i), 0.22, function* (i) {
      const w = Math.max(24, (bars[i].value / maxV) * barMaxW);
      yield* all(
        barRefs[i]().width(w, 0.7, easeOutCubic),
        // 数值文本跟随条尾
        valRefs[i]().opacity(1, 0.3),
      );
      valRefs[i]().text(`${bars[i].value}${params.unit ?? ""}`);
      valRefs[i]().x(barX + w + 24 + 60);
    });
    yield* waitFor(0.7);
  });
}
