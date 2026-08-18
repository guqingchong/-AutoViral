import { makeScene2D, Node, Txt, Rect } from "@revideo/2d";
import { createRef, waitFor } from "@revideo/core";
import { getSceneTheme } from "../themes";
import { DESIGN_W, DESIGN_H, designScale } from "../layout";
import { addBackdrop, addSourceNote, addTitleBlock, FONT } from "../components";
import { springSlideIn, stagger } from "../motion";

export interface PyramidParams {
  title: string;                    // ≤12 字
  kicker?: string;
  levels: string[];                 // 2-5 层,自下而上堆叠;每层 ≤12 字(数组末位=塔尖)
  source?: string;
  theme?: string;
}

/** 金字塔层级:底层先行弹入,逐层向上堆叠构建,塔尖最后落成 */
export default function makePyramid(params: PyramidParams) {
  const theme = getSceneTheme(params.theme);
  const levels = params.levels.slice(0, 5);
  const n = levels.length;
  return makeScene2D("pyramid", function* (view) {
    view.fill(theme.background);
    const root = createRef<Node>();
    view.add(<Node ref={root} scale={designScale(view.size())} />);
    addBackdrop(root(), theme);
    const { title } = addTitleBlock(root(), theme, params.kicker ?? "", params.title);

    const baseY = 520;                     // 塔底 y
    const layerH = Math.min(200, 980 / n); // 层高随层数自适应
    const maxW = 860;
    const minW = 300;

    const layerRefs = levels.map(() => createRef<Rect>());
    const textRefs = levels.map(() => createRef<Txt>());
    // levels[0] 是塔尖还是塔底?约定:数组顺序 = 自下而上(塔底在前),视觉层 i=0 在最下
    levels.forEach((lv, i) => {
      const y = baseY - i * (layerH + 16);
      const w = maxW - ((maxW - minW) * i) / Math.max(1, n - 1);
      const color = theme.palette[i % theme.palette.length];
      root().add(
        <Rect ref={layerRefs[i]} width={w} height={layerH} y={y} radius={14}
          fill={`${color}22`} stroke={color} lineWidth={3} opacity={0} />,
      );
      root().add(
        <Txt ref={textRefs[i]} fontFamily={FONT} text={lv} fontSize={Math.min(44, layerH * 0.32)} fontWeight={700}
          fill={theme.textColor} y={y} opacity={0} width={w - 60} />,
      );
    });

    if (params.source) addSourceNote(root(), theme, `来源:${params.source}`);

    yield* title().opacity(1, 0.45);
    yield* stagger(
      levels.map((_, i) => i),
      0.4,
      function* (i) {
        const y = baseY - i * (layerH + 16);
        const layer = layerRefs[i]();
        layer.opacity(1);
        yield* springSlideIn(layer as unknown as Node, y, 90);
        textRefs[i]().opacity(1, 0.25);
      },
    );
    yield* waitFor(0.7);
  });
}
