import makeStructureGrowth from "./structure-growth";
import makeFlowSteps from "./flow-steps";
import makeLogicChain from "./logic-chain";

/** 场景模板注册表:模板名 → 参数化工厂(参数 → Revideo 场景) */
export const SCENE_REGISTRY: Record<string, (params: any) => any> = {
  "structure-growth": makeStructureGrowth,
  "flow-steps": makeFlowSteps,
  "logic-chain": makeLogicChain,
};

export function getSceneFactory(name: string): (params: any) => any {
  const f = SCENE_REGISTRY[name];
  if (!f) throw new Error(`unknown scene template: ${name}`);
  return f;
}
