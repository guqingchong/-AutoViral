import { makeScene2D, Rect, Txt, Line, Circle, Layout } from "@revideo/2d";
import { all, chain, createRef, easeInOutCubic, easeOutBack, waitFor } from "@revideo/core";

/**
 * PoC:结构图生长动画 —— 「专项债资金闭环」
 * 中心节点弹入 → 三个分支节点错峰弹入 → 连线生长 → 标签淡入 → 循环箭头收尾
 */
export default makeScene2D("structure", function* (view) {
  view.fill("#0f1b2d"); // 深蓝底

  const W = 1080;
  const H = 1920;

  // 标题
  const title = createRef<Txt>();
  view.add(
    <Txt
      ref={title}
      text={"专项债资金闭环"}
      fontSize={72}
      fontWeight={700}
      fill={"#ffffff"}
      y={-H / 2 + 160}
      opacity={0}
    />,
  );

  // 中心节点
  const center = createRef<Rect>();
  const centerPos = { x: 0, y: -80 };
  view.add(
    <Rect
      ref={center}
      width={360}
      height={160}
      radius={24}
      fill={"#1d4ed8"}
      position={[centerPos.x, centerPos.y]}
      scale={0}
      shadowBlur={40}
      shadowColor={"#1d4ed8aa"}
    >
      <Txt text={"专项债券"} fontSize={56} fontWeight={700} fill={"#ffffff"} />
    </Rect>,
  );

  // 三个分支节点
  const branchData = [
    { text: "项目建设", color: "#0ea5e9", x: -320, y: 420 },
    { text: "运营收益", color: "#10b981", x: 0, y: 560 },
    { text: "还本付息", color: "#f59e0b", x: 320, y: 420 },
  ];
  const branches = branchData.map(() => createRef<Rect>());
  const lines = branchData.map(() => createRef<Line>());
  const labels = branchData.map(() => createRef<Txt>());
  const labelTexts = ["资金投入", "收益归集", "本息偿付"];

  branchData.forEach((b, i) => {
    // 连线:中心节点底边 → 分支节点顶边
    view.add(
      <Line
        ref={lines[i]}
        points={[
          [centerPos.x, centerPos.y + 80],
          [b.x, b.y - 70],
        ]}
        stroke={"#94a3b8"}
        lineWidth={6}
        end={0}
        radius={40}
      />,
    );
    view.add(
      <Rect
        ref={branches[i]}
        width={280}
        height={140}
        radius={20}
        fill={b.color}
        position={[b.x, b.y]}
        scale={0}
        shadowBlur={30}
        shadowColor={b.color + "88"}
      >
        <Txt text={b.text} fontSize={48} fontWeight={700} fill={"#ffffff"} />
      </Rect>,
    );
    // 连线中点标签
    const midX = (centerPos.x + b.x) / 2;
    const midY = (centerPos.y + 80 + b.y - 70) / 2;
    view.add(
      <Txt
        ref={labels[i]}
        text={labelTexts[i]}
        fontSize={34}
        fill={"#cbd5e1"}
        position={[midX, midY - 30]}
        opacity={0}
      />,
    );
  });

  // 循环箭头(收益 → 偿付的回流示意)
  const loopArrow = createRef<Line>();
  view.add(
    <Line
      ref={loopArrow}
      points={[
        [0, 560 + 70],
        [0, 800],
        [centerPos.x, centerPos.y + 160],
      ]}
      stroke={"#10b981"}
      lineWidth={5}
      lineDash={[16, 12]}
      endArrow
      end={0}
      radius={30}
    />,
  );

  // ── 动画编排 ──
  yield* title().opacity(1, 0.6, easeInOutCubic);
  yield* center().scale(1, 0.5, easeOutBack);
  yield* chain(
    ...branchData.flatMap((_, i) => [
      all(
        lines[i]().end(1, 0.45, easeInOutCubic),
        branches[i]().scale(1, 0.45, easeOutBack),
      ),
      labels[i]().opacity(1, 0.3),
    ]),
  );
  yield* loopArrow().end(1, 0.8, easeInOutCubic);
  // 收尾:中心节点脉冲强调
  yield* chain(
    center().scale(1.08, 0.25, easeInOutCubic),
    center().scale(1, 0.25, easeInOutCubic),
  );
  yield* waitFor(0.5);
});
