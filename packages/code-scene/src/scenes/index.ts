import makeStructureGrowth from "./structure-growth";
import makeFlowSteps from "./flow-steps";
import makeLogicChain from "./logic-chain";
// 2026-08-18 03 方案:模板库 3→9,新增大数字/对比/时间轴/金字塔/金句/清单/条形
import makeBigNumber from "./big-number";
import makeCompareSplit from "./compare-split";
import makeTimeline from "./timeline";
import makePyramid from "./pyramid";
import makeQuoteCard from "./quote-card";
import makeChecklist from "./checklist";
import makeBarCompare from "./bar-compare";
import makeKeynoteLeather from "./keynote-leather";

/** 场景模板注册表:模板名 → 参数化工厂(参数 → Revideo 场景) */
export const SCENE_REGISTRY: Record<string, (params: any) => any> = {
  "structure-growth": makeStructureGrowth,
  "flow-steps": makeFlowSteps,
  "logic-chain": makeLogicChain,
  "big-number": makeBigNumber,
  "compare-split": makeCompareSplit,
  "timeline": makeTimeline,
  "pyramid": makePyramid,
  "quote-card": makeQuoteCard,
  "checklist": makeChecklist,
  "bar-compare": makeBarCompare,
  // 2026-08-21:横屏苹果风×深色皮革 数字人口播模板(代码渲染整片形态验证)
  "keynote-leather": makeKeynoteLeather,
};

export function getSceneFactory(name: string): (params: any) => any {
  const f = SCENE_REGISTRY[name];
  if (!f) throw new Error(`unknown scene template: ${name}`);
  return f;
}
