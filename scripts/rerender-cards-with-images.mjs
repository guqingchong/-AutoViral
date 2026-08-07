// 一次性:3 个存量双产物作品强制重渲染卡片(图+文形态)
import { deriveDualOutputs } from "../dist/services/dual-output.js";

const IDS = ["w_20260806_1235_7fa", "w_20260806_1238_b7b", "w_20260806_1243_5dd"];
for (const id of IDS) {
  const r = await deriveDualOutputs(id, { forceRender: true });
  console.log(id, "→", JSON.stringify({ childWorkId: r?.childWorkId, cards: r?.cardFiles.length }));
}
