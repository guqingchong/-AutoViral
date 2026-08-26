/**
 * 共享动效库（2026-08-18 03 方案：code-scene 质量升级）。
 * 把标杆 motion graphics 的常用手法封装成一行调用：
 * 弹簧入场/错峰揭示/遮罩划入/数字滚动/脉冲强调。
 */

import { all, chain, createRef, waitFor } from "@revideo/core";
import type { ThreadGenerator } from "@revideo/core";
import { spring, SmoothSpring, PlopSpring, BounceSpring } from "@revideo/core/lib/tweening/spring";
import type { Node } from "@revideo/2d";

/** 弹簧缩放入场（0 → 1,带回弹） */
export function* springIn(node: Node, scale = 1, preset = SmoothSpring): ThreadGenerator {
  yield* spring(preset, 0, 1, 0.01, (v) => {
    node.scale(v * scale);
    node.opacity(Math.min(1, v * 1.5));
  });
  node.scale(scale);
  node.opacity(1);
}

/** 从指定 y 偏移弹簧滑入 */
export function* springSlideIn(node: Node, targetY: number, offsetY = 120, preset = SmoothSpring): ThreadGenerator {
  yield* spring(preset, 0, 1, 0.01, (v) => {
    node.position.y(targetY + offsetY * (1 - v));
    node.opacity(Math.min(1, v * 1.8));
  });
  node.position.y(targetY);
  node.opacity(1);
}

/** 错峰执行同一动画：items 依次 delay(step) 启动（stagger 是精致感的最大单一来源） */
export function* stagger<T>(items: T[], step: number, fn: (item: T, i: number) => ThreadGenerator): ThreadGenerator {
  yield* all(...items.map((item, i) => chain(waitFor(i * step), fn(item, i))));
}

/** 数字滚动（0 → target,前快后慢;format 自定义如千分位/百分号/小数位） */
export function* countUpText(target: number, duration: number, format: (v: number) => string, onText: (s: string) => void): ThreadGenerator {
  // 渲染固定 30fps(worker.mjs 未覆盖 revideo 默认值):步数必须按 30fps 换算——
  // 曾按 60fps 换算(2026-08-26 实测),计数动画实际耗时翻倍,挤压后续动画时序,
  // 场景自然时长超出 range 窗口被截断(big-number caption 因此丢帧)
  const steps = Math.max(2, Math.round(duration * 30));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const eased = 1 - Math.pow(1 - t, 3);
    onText(format(target * eased));
    yield;
  }
}

/** 脉冲强调（弹簧式放大回弹,比线性 scale 生动） */
export function* pulse(node: Node, strength = 1.06): ThreadGenerator {
  yield* spring(PlopSpring, 1, strength, 0.01, (v) => node.scale(v));
  yield* spring(SmoothSpring, strength, 1, 0.01, (v) => node.scale(v));
}

/** 弹性抖动强调（用于错误/警示/转折处） */
export function* bounce(node: Node): ThreadGenerator {
  yield* spring(BounceSpring, 0.92, 1, 0.01, (v) => node.scale(v));
}
