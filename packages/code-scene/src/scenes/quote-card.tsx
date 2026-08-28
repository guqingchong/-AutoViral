import { makeScene2D, Node, Txt } from "@revideo/2d";
import { chain, createRef, waitFor } from "@revideo/core";
import { easeInOutCubic } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, designScale } from "../layout";
import { addBackdrop, addSourceNote, FONT } from "../components";

export interface QuoteCardParams {
  quote: string;        // 金句正文,≤40 字
  author?: string;      // 署名/出处
  source?: string;
  theme?: string;
}

/** 金句卡:引号装饰 → 逐词显现(阅读节奏感) → 署名淡入。回形针式留白设计 */
export default function makeQuoteCard(params: QuoteCardParams) {
  const theme = getSceneTheme(params.theme, params.themeTokens);
  const accent = theme.palette[0];
  const words = params.quote.split(/(?<=，|。|、|!|？|,|\s)/).filter(Boolean); // 按标点分词组,逐组显现
  return makeScene2D("quote-card", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);

    const mark = createRef<Txt>();
    root().add(
      <Txt ref={mark} fontFamily={FONT} text={"“"} fontSize={260} fontWeight={900} fill={accent}
        x={-DESIGN_W / 2 + 130} y={-460} opacity={0} />,
    );
    const quote = createRef<Txt>();
    root().add(
      <Txt ref={quote} fontFamily={FONT} text={""} fontSize={56} fontWeight={700} fill={theme.textColor}
        y={-40} textAlign={"left"} width={DESIGN_W - 260} lineHeight={88} textWrap={true} />,
    );
    const author = createRef<Txt>();
    root().add(
      <Txt ref={author} fontFamily={FONT} text={params.author ? `—— ${params.author}` : ""} fontSize={34}
        fill={theme.subTextColor} y={320} opacity={0} />,
    );

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* mark().opacity(0.9, 0.5, easeInOutCubic);
    // 逐词组显现:模拟朗读节奏
    for (const w of words) {
      const prev = quote().text();
      quote().text(prev + w);
      yield* waitFor(0.16);
    }
    yield* chain(author().opacity(1, 0.5));
    yield* waitFor(0.9);
  });
}
