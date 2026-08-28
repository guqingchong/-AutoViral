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
  duration?: number;                // 目标片长(服务层按渲染时长注入),短镜头自动压缩动画
}

function fmt(v: number, format: string, unit: string): string {
  // 防御性归一(2026-08-26 评审实证):agent 把"5.4万"传成 value=5.4+format=wan,
  // 二次换算渲染出"0.0万"。wan/yi 格式下 |v|<1000 视为已按万/亿换算过的值,直接采用;
  // ≥1000 才按原始数值换算。两类调用方("54000"与"5.4")都得到正确显示。
  const abs = Math.abs(v);
  const core =
    format === "percent" ? `${v.toFixed(1)}%`
    : format === "wan" ? `${(abs < 1000 ? v : v / 10000).toFixed(1)}万`
    : format === "yi" ? `${(abs < 1000 ? v : v / 100000000).toFixed(2)}亿`
    : v >= 10000 ? Math.round(v).toLocaleString("en-US").replaceAll(",", " ") : String(Math.round(v));
  return core + unit;
}

/** 大数字冲击:标题区 → 巨型数字弹簧入场+滚动计数 → 解读行 */
export default function makeBigNumber(params: BigNumberParams) {
  const theme = getSceneTheme(params.theme, params.themeTokens);
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
        y={180} opacity={0} textAlign={"center"} width={DESIGN_W - 240} textWrap={true} />,
    );
    // 数字下方装饰基线
    const underline = createRef<Rect>();
    root().add(<Rect ref={underline} width={0} height={6} fill={accent} y={90} radius={3} opacity={0.8} />);

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    // 短镜头自适应(2026-08-26 评审实证):Hook 镜头常 ≤4s,完整版动画
    // (标题0.5+弹簧1+计数1.4+脉冲1+解读0.5)要 4s+ 才出最终值,评审抽帧全程
    // 只见中间值(3.1万/5.1万)判"核心数据错误"。短镜头压缩为:标题0.25+淡入0.25
    // +计数0.7(从60%起滚,压缩中间值窗口),约 1.2s 出最终值,余量全是正确画面。
    const shortMode = (params.duration ?? 6) <= 4.5;
    const fmtFn = (v: number) => fmt(v, params.format ?? "plain", params.unit ?? "");
    if (shortMode) {
      yield* title().opacity(1, 0.25);
      yield* num().opacity(1, 0.25);
      yield* chain(
        countUpText(params.value, 0.7, fmtFn, (s) => num().text(s), 0.6),
        underline().width(360, 0.4),
      );
      yield* cap().opacity(1, 0.3);
      yield* waitFor(0.3);
      return;
    }

    yield* title().opacity(1, 0.5);
    yield* springIn(num() as unknown as Node, 1);
    yield* chain(
      countUpText(params.value, 1.4, fmtFn, (s) => num().text(s)),
      underline().width(360, 0.8),
    );
    yield* pulse(num() as unknown as Node, 1.05);
    yield* cap().opacity(1, 0.5);
    yield* waitFor(0.8);
  });
}
