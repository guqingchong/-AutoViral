// 一次性回填:为 3 个存量双产物作品派生图文子作品
// 用法:node scripts/backfill-image-text-children.mjs
import { deriveDualOutputs } from "../dist/services/dual-output.js";

const IDS = ["w_20260806_1235_7fa", "w_20260806_1238_b7b", "w_20260806_1243_5dd"];
for (const id of IDS) {
  const r = await deriveDualOutputs(id);
  console.log(id, "→", JSON.stringify({ childWorkId: r?.childWorkId, cards: r?.cardFiles.length, articleReady: r?.articleReady }));
}
