/**
 * 阶段契约(step contract)——创作侧 prompt 与评审 rubric 的单一事实源(2026-08-19)。
 *
 * 背景:w_20260819_1634_cd5 在素材搜索阶段空转 40+ 分钟、两轮驳回的根因是
 * 「指令与评分两套标准」——步骤 prompt(交互时代 yt-dlp 找片基+用户三选一)与
 * 评审标准(criteria/material-search.md:多组查询/素材库 API/下载校验/结构化留痕)
 * 完全脱节;agent 也从未被告知 /api/stock-assets 端点,直连 Pexels 无 key 误判"未配置"。
 *
 * 本模块三个函数分别解决:
 * - buildAssetConstraintSection  素材三维(形态/来源/成本)→ prompt 约束段(原 api.ts 迁出)
 * - buildStepContractSection     素材约束 + 本阶段验收标准(与评审同读一份 criteria 文件)
 * - buildMaterialSearchInstruction 素材搜索阶段指令(与 criteria/material-search.md 逐条对齐)
 *
 * 注入点(api.ts):/step 端点、会话启动 prompt、advance 自动续命消息——三处共用本模块。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库 skills 目录(单一事实源,2026-08-28 批次2.1)——此前 criteria 运行时读
 *  ~/.claude/skills 副本,双副本靠 rsync 同步而 Windows 无 rsync,从未生效已实测漂移。
 *  dist/server/ 与 src/server/ 上溯两级均为项目根,dev/生产同构。 */
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CRITERIA_DIR = join(PROJECT_ROOT, "skills", "content-evaluator", "criteria");

const ASSET_FORM_LABELS: Record<string, string> = {
  "video-mix": "以真实视频混剪为主",
  "image-carousel": "图片轮播配讲解",
  slides: "AI 生成讲解幻灯片",
  auto: "不限制",
};
const ASSET_SOURCE_LABELS: Record<string, string> = {
  stock: "仅用素材库真实素材",
  ai: "仅 AI 生成",
  user: "仅用用户指定素材",
  auto: "不限制",
  smart: "精品混合(按镜头内容自动路由:数据→程序化素材、氛围→AI、真实画面→素材库)",
};
const ASSET_BUDGET_LABELS: Record<string, string> = {
  eco: "仅使用本地 H3 生成视频（provider=local-h3），禁用一切云端视频生成（即梦/Seedance/Dreamina 均不可用）。若 local-h3 不可用（AutoDL 实例离线），不得改用云端视频，应阻塞并显著提醒用户开机 AutoDL 实例",
  premium: "不限制",
};

/** 素材三维 → prompt 约束段（三维全空时返回空串）；hasDigitalHuman=false 时口播路由禁用数字人 */
export function buildAssetConstraintSection(assetForm?: string, assetSource?: string, assetBudget?: string, hasDigitalHuman?: boolean): string {
  const lines: string[] = [];
  if (assetForm) lines.push(`- 素材形态: ${ASSET_FORM_LABELS[assetForm] ?? assetForm}`);
  if (assetSource) lines.push(`- 素材来源: ${ASSET_SOURCE_LABELS[assetSource] ?? assetSource}`);
  if (assetBudget) lines.push(`- 成本档: ${ASSET_BUDGET_LABELS[assetBudget] ?? assetBudget}`);
  // 程序化精确素材铁律(2026-08-14):任何获取策略下都生效。
  // 程序化素材本地程序化渲染(零生成成本、秒级出图),不属于"外部素材来源",
  // 因此 stock/user 等受限策略下同样允许且必须使用——它替代的是"AI 生图伪造数据"这条死路。
  lines.push(
    `- 程序化素材铁律(无条件生效): 凡涉及精确数据(数值/对比/趋势/占比)、政策文件/新闻原文、结构关系的镜头,禁止 AI 生图(数字必错、文字乱码)。` +
      `必须调用本地程序化素材 API: 数据图表 POST /api/assets/data-card(简单数据)或 /api/assets/chart(复杂 ECharts);` +
      `政策/网页原文快照 POST /api/assets/snapshot-card;图标 GET /api/assets/icons。主题配色须与作品模板一致,数据来源必须署名。` +
      `快照卡必须传 highlights 红框标注关键条款/段落(禁止整页裸截,截正文区避开广告与侧栏);` +
      `图表数值与旁白口径必须一致——旁白说"超六成",图表须标">60%"或"超60%",禁止写成精确值 60%;` +
      `结构/流程/逻辑镜头调用 POST /api/assets/code-scene 生成程序化动画(十模板:structure-growth/flow-steps/logic-chain/big-number/compare-split/timeline/pyramid/quote-card/checklist/bar-compare,先 GET /api/assets/code-scene/templates 查参数);` +
      `凡 POST body 含中文(code-scene/chart/snapshot-card 的参数都含),必须先把 JSON 写成 UTF-8 文件再 --data-binary @file,禁止 curl -d 内联(Windows 下必乱码);`,
  );
  // smart 精品混合:按镜头内容路由到最优来源,是"出品即精品"的默认策略
  if (assetSource === "smart") {
    lines.push(
      `- 镜头路由(smart): 数据/对比/趋势→程序化素材(data-card/chart);政策/文件原文→snapshot-card;` +
        `氛围/场景感画面→AI 生图后 i2v;真实事件/实拍画面→素材库搜索(优先 Pexels 竖版视频),搜不到再 AI 生成;` +
        (hasDigitalHuman === false
          ? `口播/讲解内容→配音+字幕卡/图解呈现(本作品未选数字人,禁用数字人镜头)`
          : `口播/讲解人→数字人或 H3 t2v(dialogue)`),
    );
  }
  // AI 生成来源下的 H3 本地生成路由规则（MiniMax H3,成本约 ¥0.13/条,远低于云端)
  if (assetSource === "ai" || assetSource === "auto" || assetSource === "smart") {
    lines.push(
      `- 视频生成路由: AI 生成的视频镜头优先走本地 H3(provider=local-h3,调 /api/generate/video 时显式传 provider:"local-h3")。` +
        `broll 氛围/空镜、narration 解说配图、dialogue 对白播报等常规镜头一律用 H3;` +
        (assetBudget === "eco"
          ? `eco 档下 hero 精品镜头也用 H3;H3 离线时不得改用云端,阻塞并提醒用户开机 AutoDL 实例`
          : `仅 hero 精品镜头(海报级画面)可用云端 Seedance/即梦;H3 离线时常规镜头可降级: broll 用素材库搜索补位,其余用云端 provider`),
    );
  }
  // 口播类长视频的质量底线:纯图片轮播观感廉价,video-mix/auto 下必须以真实视频混剪为主
  if (assetForm === "video-mix" || assetForm === "auto" || !assetForm) {
    lines.push(`- 质量底线: 超过 60 秒的口播类视频必须以真实视频混剪为主(优先 Pexels 竖版视频,type=video 搜索),禁止全片纯图片轮播+Ken Burns;图片仅作为信息补充(数据卡/示意图),占比不超过 30%`);
  }
  return lines.length ? `素材约束:\n${lines.join("\n")}` : "";
}

/**
 * 阶段契约段:素材三维约束 + 本阶段验收标准(评审拿同一份 criteria/<step>.md 评分,
 * 创作者拿它自检)。把"闭卷考试"变成"开卷自检",目标一次通过、减少驳回反复。
 * includeAssets=false 用于会话启动 prompt(素材约束已在开场注入,避免重复)。
 */
export function buildStepContractSection(
  step: string,
  work: { assetForm?: string; assetSource?: string; assetBudget?: string; digitalHumanId?: string | null },
  opts: { includeAssets?: boolean } = {},
): string {
  const parts: string[] = [];
  if (opts.includeAssets !== false) {
    const assetSection = buildAssetConstraintSection(work.assetForm, work.assetSource, work.assetBudget, !!work.digitalHumanId);
    if (assetSection) parts.push(assetSection);
  }
  try {
    const criteria = readFileSync(join(CRITERIA_DIR, `${step}.md`), "utf-8").trim();
    if (criteria) {
      parts.push(`## 本阶段验收标准(评审将逐条核对;交付前请逐条自检,目标一次通过)\n\n${criteria}`);
    }
  } catch {
    // 该阶段无标准文件 → 跳过(与评审侧"文件不存在则用通用标准"的行为一致)
  }
  return parts.join("\n\n");
}

/**
 * 素材搜索阶段指令(与 criteria/material-search.md 逐条对齐)。
 * 旧版是交互时代的"yt-dlp 找片基视频+用户三选一",与评审标准完全脱节。
 * autoMode 下候选选优由 agent 自行拍板,禁止问用户。
 */
export function buildMaterialSearchInstruction(work: { id: string; title: string; videoSearchQuery?: string }, isAutoMode: boolean): string {
  const query = work.videoSearchQuery || work.title;
  return [
    `Execute the "素材搜索" step. 目标:为分镜预置可用的实拍/素材库候选(本阶段不产出最终素材)。`,
    `搜索主题: "${query}"`,
    ``,
    `## 检索通道(顺序按题材调整;key 由服务端持有,你不需要也不应该去找任何 API key)`,
    `1. **全网真实视频**: 用 WebSearch 搜索;命中后用 yt-dlp 下载(必须音视频合并,禁止裸 curl):`,
    `   \`yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "clips/option-NN.mp4" "URL"\``,
    `   ⚠️ 题材含具体地名/机构/事件等专有实体(如"上海张园""北京劲松")时,本通道是主力——`,
    `   通用素材库几乎没有中国特定地标素材,硬用通用素材凑数必被评审打回(2026-08-26 五轮实证)。`,
    `2. **合规素材库(Pexels 优先,英文关键词命中最好)**:`,
    `   搜索: \`curl -s "http://localhost:3271/api/stock-assets/search?q=英文关键词&type=video&perPage=10"\`(要图片则 type=image)`,
    `   下载: body 含中文,必须先写 JSON 文件再提交(Windows Git Bash 内联 -d 必坏中文):`,
    `   \`curl -X POST http://localhost:3271/api/stock-assets/download -H "Content-Type: application/json" --data-binary @download.json\``,
    `   (download.json 内容: {"url":"ITEM_URL","provider":"pexels","mediaType":"video","category":"scenes","name":"shot-NN.mp4","description":"...","author":"...","license":"...","duration":12})`,
    `   禁止直连 api.pexels.com / api.pixabay.com——你本地没有 key,直连必然 401,走上面两个服务端端点即可。`,
    ``,
    `## 执行要求(与验收标准一一对应)`,
    `1. **多组查询**: 围绕主题拆 3-5 组查询词(主体/场景/情绪/数据意象等不同角度),每组分别检索并记录命中数;一组词搜不到就改写查询,禁止单一宽泛词打天下`,
    `2. **下载并校验 3-5 个候选**到作品 assets 目录(clips/ 或 images/):每个文件必须非 0 字节,视频用 ffprobe 确认可读且含音频流;竖版(height>width)优先,横版标注"需裁剪"`,
    `3. **语义校验(强制,在写描述之前做)**: 每个候选视频必须 ffmpeg 抽 3 帧(首/中/尾)并用 Read 看图,`,
    `   描述与选用理由必须基于你亲眼看到的画面内容——禁止照抄搜索结果元数据/凭文件名脑补画面。`,
    `   ffprobe 只证明"能播",不证明"是你要的画面";评审会独立抽帧逐条核对,描述与画面不符即打回。`,
    `   抽帧: \`ffmpeg -y -i 视频.mp4 -ss 1 -frames:v 1 帧1.jpg -sseof -3 -frames:v 1 帧2.jpg\``,
    `4. **筛选与剔除**: 剔除水印/低清/题材不符项并记录剔除理由;保留候选每条写选用理由`,
    `5. **结构化留痕(强制)**: 写 assets/material-candidates.md,含查询组清单与命中情况、候选列表(路径/来源URL/时长/分辨率/授权/选用理由)、剔除记录——plan 阶段按路径直接引用`,
    `6. **缺口声明(合法出口)**: 某场景两轮检索后确实无贴合素材时,在 material-candidates.md 单开"缺口声明"段,`,
    `   写明"X 场景无合规贴合素材"并给出替代方案(AI 生成/真实视频通道再挖/分镜改用程序化素材)——`,
    `   声明缺口不扣分;硬把不贴合素材标成贴合,是评审必打回的重灾区。`,
    ``,
    `## 收到"素材与描述不符"类评审反馈时的修复策略`,
    `优先**替换素材**(让画面贴合主题),而不是修改描述(让描述迁就画面)。`,
    `描述与画面一致只是底线;画面与主题贴合才是目标。`,
    ``,
    isAutoMode
      ? `## 自动化模式: 候选选优由你自行拍板(语义贴合 > 竖版 > 分辨率 > 时长),禁止向用户提问、罗列候选等挑选。完成后直接调用 pipeline/advance 推进。`
      : `## 交互模式: 把候选以 markdown 链接呈现给用户(\`[标题](/api/works/${work.id}/assets/clips/option-01.mp4)\` 可内联播放),请用户选定主素材后再推进。`,
    ``,
    `完成后推进: \`curl -X POST http://localhost:3271/api/works/${work.id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"material-search","nextStep":"research"}'\``,
  ].join("\n");
}
