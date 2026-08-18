import { makeScene2D, Node, Txt, Rect } from "@revideo/2d";
import { chain, createRef, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, FONT } from "../components";
import { springIn, countUpText, pulse } from "../motion";

export interface BigNumberParams {
  title: string;                    // ≤12 字
  kicker?: string;                  // 眉标,≤10 字
  value: number;                    // 大数字(滚动至此值)
  format?: "plain" | "percent" | "wan" | "yi";  // 数字格式,默认 plain
  unit?: string;                    // 自定义单位后缀(与 format 叠加)
  caption?: string;                 // 数字下方解读,≤20 字
  source?: string;                  // 来源标注
  theme?: string;
}

function fmt(v: number, format: string, unit: string): string {
  const core =
    format === "percent" ? `${v.toFixed(1)}%`
    : format === "wan" ? `${(v / 10000).toFixed(1)}万`
    : format === "yi" ? `${(v / 100000000).toFixed(2)}亿`
    : v >= 10000 ? Math.round(v).toLocaleString("en-US").replaceAll(",", " ") : String(Math.round(v));
  return core + unit;
}

/** 大数字冲击:标题区 → 巨型数字弹簧入场+滚动计数 → 解读行 */
export default function makeBigNumber(params: BigNumberParams) {
  const theme = getSceneTheme(params.theme);
  const accent = theme.palette[0];
  return makeScene2D("big-number", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);

    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);
    const num = createRef<Txt>();
    root().add(
      <Txt ref={num} fontFamily={FONT} text={"0"} fontSize={230} fontWeight={900} fill={accent}
        y={-60} opacity={0} />,
    );
    const cap = createRef<Txt>();
    root().add(
      <Txt ref={cap} fontFamily={FONT} text={params.caption ?? ""} fontSize={40} fill={theme.subTextColor}
        y={180} opacity={0} textAlign={"center"} width={DESIGN_W - 240} />,
    );
    // 数字下方装饰基线
    const underline = createRef<Rect>();
    root().add(<Rect ref={underline} width={0} height={6} fill={accent} y={90} radius={3} opacity={0.8} />);

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.5);
    yield* springIn(num() as unknown as Node, 1);
    yield* chain(
      countUpText(params.value, 1.4, (v) => fmt(v, params.format ?? "plain", params.unit ?? ""), (s) => num().text(s)),
      underline().width(360, 0.8),
    );
    yield* pulse(num() as unknown as Node, 1.05);
    yield* cap().opacity(1, 0.5);
    yield* waitFor(0.8);
  });
}
