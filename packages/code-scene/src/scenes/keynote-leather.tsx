/**
 * keynote-leather —— 横屏苹果风 × 深色皮革基调 数字人口播模板(2026-08-21)。
 *
 * 布局(1920×1080 设计空间):
 *   顶部:标题区(kicker 金字小标 + 主标题 + 金色发丝线)
 *   中部:数字人窗口(圆角 28、金色辉光描边、macOS 三灯、毛玻璃高光)
 *   底部:中英双语字幕条(中文主字幕 + 英文副字幕,半透明皮革条承托)
 *
 * 风格语言:苹果发布会的"少即是多"——大面积深色留白、单一金色强调、
 * 弹簧物理动效(无线性硬切)、辉光呼吸(光泽缓慢起伏)。
 */

import { makeScene2D, Node, Rect, Txt, Line, Circle, Video } from "@revideo/2d";
import { all, chain, createRef, waitFor } from "@revideo/core";
import { easeInOutCubic, easeOutCubic } from "@revideo/core";
import { spring, SmoothSpring, PlopSpring } from "@revideo/core/lib/tweening/spring";
import { FONT } from "../components";

// 本模板为横屏专场:独立设计空间(不复用竖屏 layout.ts)
const W = 1920;
const H = 1080;

// 深色皮革色系(主基调)+ 金色强调(苹果式单一强调色纪律)
const LEATHER = {
  bgDeep: "#120b08",      // 最深处(近黑的棕)
  bgBase: "#1c120d",      // 皮革底
  panel: "#241812",       // 面板皮革
  panelEdge: "#3a2a1e",   // 皮革缝线色
  gold: "#d4af37",        // 金(强调)
  goldSoft: "#b08d2e",    // 暗金
  text: "#f5efe4",        // 米白(皮革上的烫金字感)
  subText: "#a5917a",     // 次要文字(灰棕)
};

export interface KeynoteLeatherParams {
  title: string;          // 主标题 ≤18 字
  kicker?: string;        // 顶部小标(英文/简短),默认 "KEYNOTE"
  subtitleCn?: string;    // 中文主字幕
  subtitleEn?: string;    // 英文副字幕
  videoSrc?: string;      // 数字人视频路径;缺省渲染占位玻璃窗
  videoRatio?: number;    // 数字人源片宽高比(默认 720/1280 竖屏)
  duration?: number;      // 场景时长(秒),呼吸循环按此计算;默认 5
}

export default function makeKeynoteLeather(params: KeynoteLeatherParams) {
  const kicker = params.kicker ?? "KEYNOTE";
  const subCn = params.subtitleCn ?? "";
  const subEn = params.subtitleEn ?? "";
  const ratio = params.videoRatio ?? 720 / 1280;

  // 数字人窗口几何:横屏画面中的悬浮"应用窗口"
  const WIN_W = 880;
  const WIN_H = 620;
  const WIN_Y = 40;

  return makeScene2D("keynote-leather", function* (view) {
    view.fill(LEATHER.bgDeep);

    const root = createRef<Node>();
    view.add(<Node ref={root} />);

    // ── 背景:皮革底 + 顶部暖金氛围光(阴影发光技法,无需 blur 滤镜) ──
    root().add(<Rect width={W} height={H} fill={LEATHER.bgBase} />);
    const ambient = createRef<Circle>();
    root().add(
      <Circle
        ref={ambient}
        size={1500}
        fill={LEATHER.gold}
        opacity={0.05}
        y={-H / 2 - 300}
        shadowColor={LEATHER.gold}
        shadowBlur={300}
      />,
    );
    // 细网格(工程图质感,3% 白)
    for (let i = 1; i < 10; i++) {
      const x = -W / 2 + (W / 10) * i;
      root().add(<Line points={[[x, -H / 2], [x, H / 2]]} stroke={"#ffffff"} opacity={0.03} lineWidth={1} />);
    }
    for (let i = 1; i < 6; i++) {
      const y = -H / 2 + (H / 6) * i;
      root().add(<Line points={[[-W / 2, y], [W / 2, y]]} stroke={"#ffffff"} opacity={0.03} lineWidth={1} />);
    }
    // 四角取景框角标(暗金)
    const m = 56;
    const L = 44;
    for (const c of [
      { x: -W / 2 + m, y: -H / 2 + m, sx: 1, sy: 1 },
      { x: W / 2 - m, y: -H / 2 + m, sx: -1, sy: 1 },
      { x: -W / 2 + m, y: H / 2 - m, sx: 1, sy: -1 },
      { x: W / 2 - m, y: H / 2 - m, sx: -1, sy: -1 },
    ]) {
      root().add(
        <Line points={[[0, L * c.sy], [0, 0], [L * c.sx, 0]]} position={[c.x, c.y]}
          stroke={LEATHER.goldSoft} lineWidth={3} opacity={0.45} />,
      );
    }

    // ── 标题区(顶部) ──
    const kickerRef = createRef<Txt>();
    const titleRef = createRef<Txt>();
    const hairline = createRef<Rect>();
    root().add(
      <Txt ref={kickerRef} fontFamily={FONT} text={kicker} fontSize={26} fontWeight={500}
        fill={LEATHER.gold} y={-H / 2 + 108} opacity={0} letterSpacing={6} />,
    );
    root().add(
      <Txt ref={titleRef} fontFamily={FONT} text={params.title} fontSize={64} fontWeight={700}
        fill={LEATHER.text} y={-H / 2 + 178} opacity={0} />,
    );
    root().add(
      <Rect ref={hairline} width={0} height={2} fill={LEATHER.gold} y={-H / 2 + 236} opacity={0.7} />,
    );

    // ── 数字人窗口(圆角 + 辉光 + macOS 三灯) ──
    const winGlow = createRef<Rect>();
    const winFrame = createRef<Rect>();
    root().add(
      // 辉光层:比窗口略大的金色矩形,靠大半径 shadow 形成四边光晕
      <Rect ref={winGlow} width={WIN_W + 8} height={WIN_H + 8} radius={36} y={WIN_Y}
        fill={LEATHER.gold} opacity={0.16}
        shadowColor={LEATHER.gold} shadowBlur={90} />,
    );
    root().add(
      // 窗框:深皮革面 + 细金描边
      <Rect ref={winFrame} width={WIN_W} height={WIN_H} radius={30} y={WIN_Y}
        fill={LEATHER.panel} stroke={LEATHER.goldSoft} lineWidth={2} opacity={0} />,
    );

    // 窗体内容(clip 圆角裁切)
    const winClip = createRef<Rect>();
    root().add(
      <Rect ref={winClip} width={WIN_W - 16} height={WIN_H - 16} radius={24} y={WIN_Y}
        fill={"#0e0906"} clip={true} opacity={0} />,
    );
    if (params.videoSrc) {
      // cover 适配:按源片比例放大铺满窗口,竖屏源片向上偏 12% 保住面部构图
      const coverH = Math.max(WIN_H - 16, (WIN_W - 16) / ratio);
      const coverW = coverH * ratio;
      const overflow = coverH - (WIN_H - 16);
      const videoRef = createRef<Video>();
      winClip().add(
        <Video ref={videoRef} src={params.videoSrc} width={coverW} height={coverH}
          y={-overflow * 0.12} />,
      );
      videoRef().play();
    } else {
      // 占位:毛玻璃 + 播放符(无样片时的预览形态)
      winClip().add(<Rect width={WIN_W - 16} height={WIN_H - 16} fill={"#ffffff"} opacity={0.03} />);
      winClip().add(
        <Circle size={110} fill={"#ffffff"} opacity={0.08} />,
      );
      winClip().add(
        <Line points={[[-16, -26], [-16, 26], [28, 0]]} closed={true} fill={LEATHER.gold} opacity={0.85} />,
      );
    }
    // macOS 三灯(左上, muted)
    const tl: Array<[number, string]> = [[0, "#5f4a3a"], [26, "#6e5636"], [52, "#4c5a3c"]];
    for (const [dx, color] of tl) {
      winClip().add(
        <Circle size={13} fill={color} x={-WIN_W / 2 + 34 + dx} y={-WIN_H / 2 + 30} opacity={0.9} />,
      );
    }
    // 顶部毛玻璃高光发丝
    winClip().add(
      <Rect width={WIN_W - 60} height={1.5} y={-WIN_H / 2 + 58} fill={"#ffffff"} opacity={0.10} />,
    );

    // ── 中英双语字幕条(底部) ──
    const subBar = createRef<Rect>();
    const subCnRef = createRef<Txt>();
    const subEnRef = createRef<Txt>();
    root().add(
      <Rect ref={subBar} width={W} height={170} y={H / 2 - 85} fill={"#000000"} opacity={0} />,
    );
    root().add(
      <Line points={[[-W / 2, H / 2 - 170], [W / 2, H / 2 - 170]]} stroke={LEATHER.gold}
        lineWidth={1.5} opacity={0.35} />,
    );
    root().add(
      <Txt ref={subCnRef} fontFamily={FONT} text={subCn} fontSize={46} fontWeight={700}
        fill={LEATHER.text} y={H / 2 - 128} opacity={0} />,
    );
    root().add(
      <Txt ref={subEnRef} fontFamily={FONT} text={subEn} fontSize={26} fontWeight={400}
        fill={LEATHER.subText} y={H / 2 - 62} opacity={0} letterSpacing={1.5} />,
    );

    // ══ 时间线(5s):苹果式弹簧入场,无线性硬切 ══
    // 0.0s 氛围光淡入
    yield* chain(
      // 0.1s kicker → 标题 → 发丝线,错峰 0.12s
      chain(
        waitFor(0.1),
        all(
          spring(SmoothSpring, 0, 1, 0.01, (v) => {
            kickerRef().opacity(v);
            kickerRef().position.y(-H / 2 + 108 + 24 * (1 - v));
          }),
          chain(
            waitFor(0.12),
            spring(SmoothSpring, 0, 1, 0.01, (v) => {
              titleRef().opacity(v);
              titleRef().position.y(-H / 2 + 178 + 36 * (1 - v));
            }),
          ),
          chain(waitFor(0.3), hairline().width(560, 0.7, easeOutCubic)),
        ),
      ),
    );

    // 0.5s 数字人窗口弹簧入场(带回弹)+ 辉光同步亮起;
    // 字幕条不再等窗口完全落定,提前 0.6s 并行入场(2026-08-24 时序修复:
    // 串行时中文字幕 ~4.1s 才稳定、英文 ~4.3s,5s 短片英文刚出现就结束)
    yield* all(
      spring(PlopSpring, 0, 1, 0.01, (v) => {
        winFrame().opacity(Math.min(1, v * 1.6));
        winFrame().scale(0.92 + 0.08 * v);
        winClip().opacity(Math.min(1, v * 1.6));
        winClip().scale(0.92 + 0.08 * v);
      }),
      winGlow().opacity(0.16, 1.0, easeInOutCubic),
      // 字幕条升起:底条淡入 → 中文 → 英文(错峰 0.15s),与窗口入场尾部并行
      chain(
        waitFor(0.6),
        subBar().opacity(0.38, 0.4),
        all(
          spring(SmoothSpring, 0, 1, 0.01, (v) => {
            subCnRef().opacity(v);
            subCnRef().position.y(H / 2 - 128 + 22 * (1 - v));
          }),
          chain(
            waitFor(0.15),
            spring(SmoothSpring, 0, 1, 0.01, (v) => {
              subEnRef().opacity(v);
              subEnRef().position.y(H / 2 - 62 + 16 * (1 - v));
            }),
          ),
        ),
      ),
    );

    // 入场落定后:辉光呼吸(光泽缓慢起伏,苹果式"活着的静帧")
    // 注意:revideo ffmpeg 渲染器在装载阶段会跑完整个生成器 —— 禁止 while(true)
    // 无限循环(2026-08-21 实测 navigation timeout 根因),呼吸轮数按时长封顶。
    const total = params.duration ?? 5;
    const cycles = Math.max(1, Math.ceil((total - 2.0) / 3.2));
    for (let i = 0; i < cycles; i++) {
      yield* winGlow().opacity(0.24, 1.6, easeInOutCubic);
      yield* winGlow().opacity(0.14, 1.6, easeInOutCubic);
    }
  });
}
