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

import { existsSync, readFileSync } from "node:fs";
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
      `政策/网页原文快照 POST /api/assets/snapshot-card;图标 GET /api/assets/icons。数据来源必须署名。` +
      `快照卡必须传 highlights 红框标注关键条款/段落(禁止整页裸截,截正文区避开广告与侧栏);` +
      `图表数值与旁白口径必须一致——旁白说"超六成",图表须标">60%"或"超60%",禁止写成精确值 60%;` +
      `结构/流程/逻辑镜头调用 POST /api/assets/code-scene 生成程序化动画(模板清单与参数先 GET /api/assets/code-scene/templates,竖屏 9 款+横屏 11 款 -wide 按成片画幅选);` +
      `**多个镜头必须批量提交(2026-09-01 起,消灭轮询空等)**: 把全部镜头 spec 写进一个 JSON,` +
      `\`curl -X POST http://localhost:3271/api/assets/code-scene/batch --data-binary @renders.json\` 一次提交(renders.json: {"workId":"本作品id","renders":[{...镜头1},{...镜头2}]}),` +
      `立即返回 taskId;服务端 2 路并发渲染,完成时系统会推送通知;其间你去做别的事(写文案/备字幕),` +
      `收到完成通知或 60s 后查一次 GET /api/long-tasks/<taskId> 即可。禁止单条渲染循环、禁止 sleep 轮询渲染产物;` +
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
  // programmatic 全程序化档(D4 新增):零版权零 GPU——结构/数据/政策/图表镜头全走本地程序化,
  // 明确禁止 stock/AI 生图/云端视频/H3(依赖 AutoDL 离线也可产出)
  if (assetSource === "programmatic") {
    lines.push(
      `- 全程序化铁律(programmatic): 所有镜头一律用本地程序化素材(data-card/chart/snapshot-card/icons/code-scene),` +
        `**禁止 stock 素材库下载、禁止 AI 生图、禁止云端视频(Seedance/即梦)、禁止 H3(依赖 GPU)**——零版权零 GPU 成本,` +
        `完全不受 AutoDL/H3 离线影响,满足"全 web 渲染程序化动画"作品(数据科普/投资解读类)。`,
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

/** 批次7.3:评审标准按作品类型分文件——图文作品读 criteria/image-text/<step>.md
 *  (此前图文被要求交付 final.mp4,幻觉打分根源),缺省回落通用 <step>.md */
export function readCriteriaForStep(step: string, workType?: string): string {
  const typed = workType === "image-text" ? join(CRITERIA_DIR, "image-text", `${step}.md`) : null;
  if (typed && existsSync(typed)) return readFileSync(typed, "utf-8").trim();
  return readFileSync(join(CRITERIA_DIR, `${step}.md`), "utf-8").trim();
}

/** 同上的路径版(评审 prompt 告诉 agent 读哪个文件) */
export function readCriteriaPathForStep(step: string, workType?: string): string {
  const typed = workType === "image-text" ? join(CRITERIA_DIR, "image-text", `${step}.md`) : null;
  if (typed && existsSync(typed)) return typed;
  return join(CRITERIA_DIR, `${step}.md`);
}

/**
 * 阶段契约段:素材三维约束 + 本阶段验收标准(评审拿同一份 criteria/<step>.md 评分,
 * 创作者拿它自检)。把"闭卷考试"变成"开卷自检",目标一次通过、减少驳回反复。
 * includeAssets=false 用于会话启动 prompt(素材约束已在开场注入,避免重复)。
 */
export function buildStepContractSection(
  step: string,
  work: { assetForm?: string; assetSource?: string; assetBudget?: string; digitalHumanId?: string | null; type?: string },
  opts: { includeAssets?: boolean } = {},
): string {
  const parts: string[] = [];
  if (opts.includeAssets !== false) {
    const assetSection = buildAssetConstraintSection(work.assetForm, work.assetSource, work.assetBudget, !!work.digitalHumanId);
    if (assetSection) parts.push(assetSection);
  }
  try {
    const criteria = readCriteriaForStep(step, work.type);
    if (criteria) {
      parts.push(`## 本阶段验收标准(评审将逐条核对;交付前请逐条自检,目标一次通过)\n\n${criteria}`);
    }
  } catch {
    // 该阶段无标准文件 → 跳过(与评审侧"文件不存在则用通用标准"的行为一致)
  }
  return parts.join("\n\n");
}

/**
 * 联网搜索规程(2026-08-28 批次3.1)——research 阶段确定性子契约。
 * 背景:开放式"用 WebSearch 搜索热点"指令实测退化为 curl 逐站抓 HTML(4 作品 509:8,
 * 作品目录散落 20+ 抓站残片)。本规程把"怎么搜、失败怎么办"确定性化。
 */
export const SEARCH_PROTOCOL = [
  `## 联网搜索规程(必须严格遵守)`,
  ``,
  `1. **搜索通道(2026-09-03 起,所有模型可用)**:` +
    `用 \`WebSearch\` 工具(客户端执行,Bing 国内版)。` +
    `**禁止用 curl/wget 抓取搜索引擎或网站 HTML 页面**——系统已在工具层拦截,此类调用必然失败。`,
  `2. **信源核查**:引用政策/数据/案例前,必须用 \`WebFetch\` 抓取来源 URL 原文核对;` +
    `查中文视频场景案例可用 \`PlatformSearch\`(bilibili/youtube)。`,
  `3. **查询词构造**:用"主题关键词 + 限定词"组合(如「数字孪生城市 政策」「城市更新 案例」)。` +
    `每组词只搜 1 次,最多 6 组;逐次换词,禁止同词重搜(重复调用会被系统拦截不再执行)。`,
  `4. **结果不相关时的改写顺序**:① 去掉限定词只留主题词 → ② 换同义词/近义表达 → ③ 换角度(政策→案例→数据→争议)。`,
  `5. **信源硬要求**:产出中引用的每条趋势/数据/案例必须附可访问的来源 URL;无法给出来源的内容禁止写入产出(评审将逐条核对,无 URL = fail)。`,
  `6. **搜索全部不可用时的降级**(报错/无结果):改用本地已采集热搜 ` +
    `\`curl -s http://localhost:3271/api/trends/douyin\`(可按需换平台),并在产出开头显式声明` +
    `「本次调研无联网搜索,基于本地热搜缓存」——禁止退化为任何形式的外网抓取。`,
  `7. **信源复用(F5)**: 引用的权威信源系统会自动沉淀(data_sources 表),同主题二次调研时优先复用——` +
    `可 \`curl -s http://localhost:3271/api/data-sources\` 查询已沉淀的固定信源(被反复引用的权威源),主题相关时优先直接引用/抓取。`,
].join("\n");

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
    `**默认优先级(与 assets 阶段一致):合规素材库(Pexels→Pixabay)优先,找不到合适的才走全网视频。**`,
    `唯一例外:题材含具体地名/机构/事件等专有实体(如"上海张园""北京劲松")时,通用素材库几乎没有`,
    `中国特定地标素材,此时通道 1(全网真实视频)为主力——硬用通用素材凑数必被评审打回(2026-08-26 五轮实证)。`,
    `1. **全网真实视频**: 用 WebSearch 搜索;命中后用 yt-dlp 下载(必须音视频合并,禁止裸 curl):`,
    `   \`yt-dlp -f "bestvideo[height<=720]+bestaudio/best[height<=720]" --merge-output-format mp4 -o "clips/option-NN.mp4" "URL"\``,
    `   ⚠️ 题材含具体地名/机构/事件等专有实体(如"上海张园""北京劲松")时,本通道是主力——`,
    `   通用素材库几乎没有中国特定地标素材,硬用通用素材凑数必被评审打回(2026-08-26 五轮实证)。`,
    `   ⚠️ 本机网络只保证 B站/抖音等国内源可达;YouTube 不可达——不要对 youtube.com 链接跑 yt-dlp(每次空探白等 65s 超时),搜到油管结果直接换源。`,
    `2. **合规素材库(Pexels 优先,英文关键词命中最好)**:`,
    `   搜索: \`curl -s "http://localhost:3271/api/stock-assets/search?q=英文关键词&type=video&perPage=10"\`(要图片则 type=image)`,
    `   **批量下载(必选,2026-09-01 起)**: 多个候选写进一个 JSON 数组,一次调用全下完:`,
    `   \`curl -X POST http://localhost:3271/api/stock-assets/download-batch -H "Content-Type: application/json" --data-binary @downloads.json\``,
    `   (downloads.json 内容: {"items":[{"url":"ITEM_URL","provider":"pexels","mediaType":"video","category":"scenes","name":"shot-NN.mp4","description":"...","author":"...","license":"...","duration":12}, ...]},服务端 3 路并发)`,
    `   单个下载端点 /api/stock-assets/download 仍在但仅限补单条;禁止逐条循环调用。`,
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
    `6. **机器可读台账(P1 契约化,2026-09)**: 同时产出 \`assets/registry.json\`(素材库索引): {"sources":[{"name":"shot-01.mp4","path":"clips/shot-01.mp4","type":"video","source_url":"...","duration":12,"tier":"..."}]}——plan 阶段机器预检据此校验素材引用存在性`,
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

// ════════════════════════════════════════════════════════════════════════════
// 流水线 v2(2026-09-07 重构,业主拍板):新四步 content-research → plan-assets → assets → assembly
// 设计意图:article 是唯一事实源(消灭脚本三道转手的口径漂移);素材探查需求驱动
// (消灭盲下载);整段缺素材经 /pipeline/regress 契约化回退(消灭硬凑)。
// ════════════════════════════════════════════════════════════════════════════

/** 研究深度档(与 purpose-presets.resolveResearchDepth 的档位一一对应) */
export type ResearchDepth = "full" | "standard" | "quick";

/**
 * 深度档约束段(批次3 buildResearchDepthSection)——评审 criteria/content-research.md 的
 * depth_compliance 维度按本段核对动作是否做足,两边措辞必须一致。
 */
export function buildResearchDepthSection(depth: ResearchDepth): string {
  if (depth === "full") {
    return [
      `## 研究深度档:完整深度研究(full)`,
      `- ≥6 组查询词(政策原文/权威数据/案例/争议/竞品/国际对照等不同角度),每组记录命中情况;`,
      `- ≥3 篇权威原文用 WebFetch 抓取全文核对(政策文件库/统计局/官方公告优先);`,
      `- 文章必须含论证链(论点→证据→推论),禁止观点堆砌;`,
      `- 争议/不确定性必须显式呈现,禁止单边叙述。`,
    ].join("\n");
  }
  if (depth === "quick") {
    return [
      `## 研究深度档:精简研究(quick)`,
      `- 1-2 组查询词即可;本地热搜缓存(/api/trends/*)可直接作为趋势依据;`,
      `- 只核查将进入口播的事实断言(文号/年份/百分比/机构名),其余从简;`,
      `- 时效优先于深度;在 article.json 显式声明 depth="quick"。`,
    ].join("\n");
  }
  return [
    `## 研究深度档:标准研究(standard)`,
    `- 2-3 组查询词;核心事实断言(将进入口播的)逐条联网核查并附来源 URL;`,
    `- ≥1 篇权威原文用 WebFetch 抓取核对;论证链可以简短但必须有证据支撑。`,
  ].join("\n");
}

/**
 * 内容研究阶段指令(流水线 v2 第一步)——趋势调研成果 → 事实核查 → 可行性论证
 * → 深度研究 → 最终作品文章落盘(research/article.md + research/article.json)。
 * article 是后续所有阶段(分镜/口播/素材/发布)的唯一事实源。
 */
export function buildContentResearchInstruction(
  work: { id: string; title: string; topicHint?: string; purpose?: string; contentForm?: string },
  depth: ResearchDepth,
  isAutoMode: boolean,
): string {
  return [
    `Execute the "内容研究" step(流水线 v2 第一步)。目标:把选题做成一篇**可直接发布的最终作品文章**,并完成事实核查与可行性论证。`,
    `选题: "${work.title}"${work.topicHint ? `\n选题提示: ${work.topicHint}` : ""}`,
    ``,
    `## 输入`,
    `- 趋势调研成果(若存在): \`research/draft-from-topic.md\`——它是素材,不是成品,其中事实必须重新核查;`,
    `- 本地热搜缓存: \`curl -s http://localhost:3271/api/trends/douyin\`(可换平台)获取当下热点佐证;`,
    `- 已沉淀权威信源: \`curl -s http://localhost:3271/api/data-sources\`(同主题优先复用)。`,
    ``,
    `## 流程(四步,顺序不可跳)`,
    `1. **事实核查**: 拆解选题中必须核验的断言清单(文号/年份/百分比/机构名),逐项 WebSearch + WebFetch 抓原文核验,逐条打「已核验(附 URL)/待核」;`,
    `2. **可行性论证**: 评估 ①素材可得性(哪些场景素材库可能没有,记入 feasibility.materialRisks) ②合规风险 ③时长适配(文章字数 ÷ 语速 4.5 字/秒 ≈ 目标片长);`,
    `3. **深度研究**: 按下方深度档执行;`,
    `4. **成文落盘**(两个文件都必须写):`,
    `   - \`research/article.md\`: 最终作品文章(可直接发布的中文成稿,非调研笔记);`,
    `   - \`research/article.json\`: 机器可读契约,结构如下(所有字段必填):`,
    ``,
    "```json",
    `{`,
    `  "version": 1,`,
    `  "title": "最终标题",`,
    `  "purpose": "${work.purpose ?? ""}",`,
    `  "contentForm": "${work.contentForm ?? ""}",`,
    `  "depth": "${depth}",`,
    `  "wordCount": 1450,`,
    `  "speechBudget": { "charsPerSec": 4.5, "targetDurationS": 180, "maxChars": 810 },`,
    `  "facts": [{ "text": "断言原文", "type": "文号|年份|百分比|机构", "verify_status": "已核验|待核", "source_url": "https://…" }],`,
    `  "feasibility": { "verdict": "feasible|conditional|infeasible", "materialRisks": ["…"], "notes": "…" },`,
    `  "sections": [{ "heading": "小节标题", "summary": "小节摘要", "anchor": "sec-1" }]`,
    `}`,
    "```",
    ``,
    buildResearchDepthSection(depth),
    ``,
    `## 铁律`,
    `- **article 是唯一事实源**: 后续分镜/口播/素材全部从这里派生,禁止在后续阶段新造事实;`,
    `- **待核断言禁进口播**: verify_status=待核 的内容只允许画面披露+"以官方发布为准"(机器门禁会拦);`,
    `- **可行性 verdict=infeasible 时不许硬写**: 在 article.json 如实标注并在文章内给出替代叙事角度;`,
    ``,
    isAutoMode
      ? `## 自动化模式: 自主拍板,禁止向用户提问。完成后直接调用 advance 推进。`
      : `## 交互模式: 成文后向用户简要展示文章结构与可行性结论,确认后再推进。`,
    ``,
    `完成后推进: \`curl -X POST http://localhost:3271/api/works/${work.id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"content-research","nextStep":"plan-assets"}'\``,
  ].join("\n");
}

/**
 * 分镜与素材探查阶段指令(流水线 v2 第二步)——依据作品文章,同时探查素材,
 * 形成脚本/分镜规划。探查是需求驱动(逐镜要什麼查什么),禁止无需求盲下载。
 */
export function buildPlanAssetsInstruction(
  work: { id: string; title: string },
  isAutoMode: boolean,
): string {
  return [
    `Execute the "分镜与素材探查" step(流水线 v2 第二步)。目标:以 \`research/article.md\` 为唯一事实源,产出脚本 + 分镜 + 逐镜素材需求台账。`,
    ``,
    `## 输入(先全部读完再动手)`,
    `- \`research/article.md\`(作品文章,唯一事实源)与 \`research/article.json\`(含 facts/feasibility/sections 锚点);`,
    `- 可行性结论中的 feasibility.materialRisks——标记过风险的场景,探查时优先验证。`,
    ``,
    `## 流程`,
    `1. **成稿脚本**: 从 article 一次成稿 \`assets/script.json\`(scenes 数组:每句旁白带 \`source_section\` 锚定 article.json 的 sections[].anchor;字数 × 语速 4.5 字/秒 ≈ 目标时长,超预算先精简文章语句,禁止塞入文章之外的新事实);`,
    `2. **分镜规划**: 写 \`plan/plan.md\` 分镜表(表头:镜号/时长/旁白/景别/制作方式/素材——旁白列逐句引 script.json,素材列填素材文件名或"程序化:模板名");`,
    `3. **需求驱动素材探查**(与盲下载的本质区别:先有镜头需求,再检索):`,
    `   - 逐镜列出"本镜需要什么素材"(主体/场景/情绪/规格);`,
    `   - 按需求检索:素材库 \`curl -s "http://localhost:3271/api/stock-assets/search?q=英文关键词&type=video"\` / WebSearch / PlatformSearch;`,
    `   - **只登记元数据**(名称/来源 URL/时长/分辨率/授权/tier),禁止下载媒体文件——下载是素材准备阶段的事;`,
    `   - 登记到 \`assets/registry.json\`(\`{"sources":[{"name":"shot-01.mp4","type":"video","source_url":"…","duration":12,"tier":"…"}]}\`)与 \`assets/material-candidates.md\`(人读版,含查询组与命中情况);`,
    `4. **缺口处理**(合法出口,不扣分):`,
    `   - 单镜缺素材 → material-candidates.md 写"缺口声明"+ 替代方案(AI 生成/程序化/换写法);`,
    `   - **整段场景缺素材** → 写 \`assets/material-gaps.json\`(\`{"gaps":[{"scene":"…","needed":"…","triedQueries":["…"],"conclusion":"…"}],"requestedAt":"ISO"}\`),然后调用回退端点修订文章:`,
    `     \`curl -X POST http://localhost:3271/api/works/${work.id}/pipeline/regress -H "Content-Type: application/json" -d '{"fromStep":"plan-assets","toStep":"content-research","reason":"整段场景缺素材","gapsRef":"assets/material-gaps.json"}'\``,
    `     **禁止硬凑不贴合素材充数**(ae0 教堂/币圈画面事故的根因)。`,
    ``,
    `## 铁律`,
    `- 分镜引用素材必须在 registry.json 里有登记(机器门禁逐条核验,引用不存在素材直接 400);`,
    `- 旁白逐句必须能溯源到 article 的某个 section;文章没有的事实禁止进旁白;`,
    `- 待核断言(article.json 里 verify_status=待核)不得进旁白口播;`,
    ``,
    isAutoMode
      ? `## 自动化模式: 自主拍板,禁止向用户提问。完成后直接调用 advance 推进。`
      : `## 交互模式: 分镜表与素材需求清单展示给用户确认后再推进。`,
    ``,
    `完成后推进: \`curl -X POST http://localhost:3271/api/works/${work.id}/pipeline/advance -H "Content-Type: application/json" -d '{"completedStep":"plan-assets","nextStep":"assets"}'\``,
  ].join("\n");
}
