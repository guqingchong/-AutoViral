/**
 * 模板要素体系（Template DNA）—— 2026-08-03 模板库优化 Phase A。
 *
 * 把"做一个什么样的模板"从一段模糊的自然语言，分解为 5 个可点选的要素维度。
 * 每个维度选项自带一段 prompt 注入文本：前端只需把用户选择的 key 传过来，
 * 生成器拼出结构化、无歧义的设计需求，配合黄金范例 few-shot 让 LLM
 * 「生成即是精品」。
 */

export interface TemplateElements {
  /** 内容形式 */
  contentForm?: string;
  /** 版式结构 */
  layout?: string;
  /** 配色方案 */
  palette?: string;
  /** 动效节奏 */
  motion?: string;
  /** 装饰元素（多选） */
  decorations?: string[];
  /** 用户自然语言补充描述（可空） */
  freeText?: string;
}

export interface DnaOption {
  key: string;
  label: string;
  /** 注入生成 prompt 的设计指令 */
  prompt: string;
}

export const CONTENT_FORMS: DnaOption[] = [
  { key: "knowledge", label: "知识卡片", prompt: "知识科普卡片：信息密度高但层级清晰，主标题点明一个知识点，3 张卡片承载递进式要点，结尾一个金句或数据收口" },
  { key: "hot_comment", label: "热点评论", prompt: "热点评论：态度鲜明，主标题即观点（短促有力），正文区像弹幕一样分段抛出论据，强调色用于情绪词" },
  { key: "industry", label: "行业动态", prompt: "行业动态：冷静专业的新闻感，报头式设计（顶部栏目条 + 日期期号），数据区突出关键指标，正文克制" },
  { key: "insight", label: "深度洞察", prompt: "深度洞察：杂志式高级感，大留白，主标题引人思考，观点逐层展开，引用块突出核心论断" },
  { key: "data_show", label: "数据展示", prompt: "数据展示：数字是主角，超大字号核心数据居中或置顶，辅助数据用小卡片分组，图表化的视觉暗示（进度条/占比块）" },
  { key: "listicle", label: "清单盘点", prompt: "清单盘点：「N 个 XX」式结构，序号是视觉锚点，每个条目一张卡片等距排布，节奏均匀适合快速扫读" },
];

export const LAYOUTS: DnaOption[] = [
  { key: "magazine_left", label: "左对齐杂志风", prompt: "左对齐杂志风：所有文字严格左对齐在 x=70 的轴线上，靠字号和留白拉开层级，右侧可留呼吸空间，高级感来自克制" },
  { key: "big_number", label: "居中大数字风", prompt: "居中大数字风：视觉中心是一个超大号元素（数字/关键词，96-160px），其余内容围绕它上下对称排布，所有文字居中" },
  { key: "top_block", label: "顶部色块标题风", prompt: "顶部色块标题风：画面上 1/3 是一整块强调色色块承载标题，下 2/3 为内容区，色块与内容区形成强烈分割" },
  { key: "split_screen", label: "上下分屏风", prompt: "上下分屏风：画面明确分为上下两个区域（如上图下文/上结论下论据），中间用分隔线或色彩过渡，两区视觉重量均衡" },
  { key: "card_stack", label: "卡片堆叠风", prompt: "卡片堆叠风：内容全部装进圆角卡片，卡片等宽（940px）垂直等距堆叠，靠卡片底色与页面底色区分层级，整齐有秩序感" },
  { key: "fullscreen_caption", label: "全屏字幕风", prompt: "全屏字幕风：极简，整屏只承载 1-2 行大字（60-90px），靠文字本身的排版节奏（分行/错位/强调色关键词）制造张力，大量留白" },
];

export const PALETTES: DnaOption[] = [
  { key: "tech_blue", label: "深蓝科技", prompt: "深蓝科技配色：bg=#0B1B33 卡片=#16283F 强调=#4D8DFF 主文=#FFFFFF 次文=#9FB4D0" },
  { key: "warm_gold", label: "暖黑金", prompt: "暖黑金配色：bg=#16130E 卡片=#241F16 强调=#F0B64C 主文=#FFF7E8 次文=#B8A88A" },
  { key: "ink_green", label: "墨绿知识", prompt: "墨绿知识配色：bg=#0C1F17 卡片=#173024 强调=#3FD68F 主文=#EFFFF5 次文=#8FC7A8" },
  { key: "deep_purple", label: "深紫洞察", prompt: "深紫洞察配色：bg=#1A1030 卡片=#271B45 强调=#A98BFF 主文=#F5F0FF 次文=#B3A3D9" },
  { key: "minimal_white", label: "米白简约", prompt: "米白简约配色：bg=#F5F1E8 卡片=#FFFFFF 强调=#E85D4A 主文=#241F16 次文=#8A8070" },
  { key: "mist_cyan", label: "雾蓝清爽", prompt: "雾蓝清爽配色：bg=#101820 卡片=#1C2836 强调=#5AC8D8 主文=#FFFFFF 次文=#8FA5B3" },
  { key: "ai_choice", label: "让 AI 发挥", prompt: "配色由你自定，但必须达到上述方案同等水准：深色或浅色底 + 一个高辨识强调色 + 主次文字两档明度，对比度保证可读" },
];

export const MOTIONS: DnaOption[] = [
  { key: "none", label: "无动效", prompt: "无动效：所有图层 start=0，靠排版本身取胜" },
  { key: "fade", label: "淡入", prompt: "淡入节奏：各组元素按 0.2s 间隔依次淡入（animations: [{type:\"fadein\",duration:0.4}]），柔和不抢戏" },
  { key: "slide", label: "滑入", prompt: "滑入节奏：各组元素按 0.3s 间隔从底部依次滑入（animations: [{type:\"slidein\",duration:0.4,direction:\"bottom\"}]），有推进感" },
  { key: "bounce", label: "弹性", prompt: "弹性节奏：关键元素（标题/数字）用弹性入场（animations: [{type:\"bouncein\",duration:0.5}]），活泼有网感，装饰元素保持淡入" },
];

export const DECORATIONS: DnaOption[] = [
  { key: "accent_bar", label: "顶部装饰条", prompt: "顶部装饰条：y≈64 处一条 120-200px 宽、8-12px 高的强调色矩条，作为视觉起点" },
  { key: "serial_number", label: "序号", prompt: "序号系统：内容卡片带 01/02/03 序号（24-30px 强调色），增强清单感" },
  { key: "divider", label: "分隔线", prompt: "分隔线：主要区域之间用 1-2px 细分隔线（卡片色或次文色）划分开" },
  { key: "texture", label: "底纹", prompt: "底纹：背景上加一层极低对比度的几何底纹（大号半透明感形状，用比 bg 略亮/略暗 5% 的实色），增加质感但不干扰阅读" },
  { key: "corner_marks", label: "角标", prompt: "角标：四角或卡片角落加小尺寸强调色角标/刻度线，营造相机取景器或杂志裁切感" },
];

/** 各维度的默认选择（用户不选时） */
export const DEFAULT_ELEMENTS: Required<Omit<TemplateElements, "freeText" | "decorations">> & { decorations: string[] } = {
  contentForm: "knowledge",
  layout: "card_stack",
  palette: "ai_choice",
  motion: "slide",
  decorations: ["accent_bar", "serial_number"],
};

function findOption(options: DnaOption[], key: string | undefined): DnaOption | undefined {
  return options.find((o) => o.key === key);
}

/**
 * 把要素选择翻译成 prompt 段落。用户没选的维度回退到默认值，
 * freeText 原样附带（权重最高，放最后强调）。
 */
export function buildElementsPrompt(elements: TemplateElements = {}): string {
  const form = findOption(CONTENT_FORMS, elements.contentForm) ?? findOption(CONTENT_FORMS, DEFAULT_ELEMENTS.contentForm)!;
  const layout = findOption(LAYOUTS, elements.layout);
  const palette = findOption(PALETTES, elements.palette) ?? findOption(PALETTES, DEFAULT_ELEMENTS.palette)!;
  const motion = findOption(MOTIONS, elements.motion);
  const decorations = (elements.decorations ?? [])
    .map((k) => findOption(DECORATIONS, k))
    .filter((o): o is DnaOption => !!o);

  const lines = [
    `内容形式（必须严格遵守）：${form.prompt}`,
    layout ? `版式结构（必须严格遵守）：${layout.prompt}` : `版式结构：多个模板之间版式必须明显不同（左对齐杂志风 / 居中大数字风 / 顶部色块标题风 / 上下分屏风 / 卡片堆叠风 / 全屏字幕风），不允许只换配色`,
    `配色方案（必须严格遵守）：${palette.prompt}`,
    motion ? `动效节奏：${motion.prompt}` : `动效节奏：多模板之间动效风格错开（淡入/滑入/弹性），非 bg 图层 duration 补足到 10 秒`,
  ];
  if (decorations.length > 0) {
    lines.push(`装饰元素（全部使用）：${decorations.map((d) => d.prompt).join("；")}`);
  }
  if (elements.freeText?.trim()) {
    lines.push(`用户的特别要求（优先级最高，与前述要素冲突时以本条为准）：${elements.freeText.trim()}`);
  }
  return lines.join("\n");
}

/**
 * 黄金范例：一个手工调校的精品模板（墨绿知识 + 卡片堆叠 + 滑入）。
 * 作为 few-shot 注入 prompt —— 让 LLM 模仿"满分答案"的结构密度和
 * 参数精度，比任何规则描述都有效。生成其他版式/配色时要求同水准变换。
 */
export const GOLDEN_EXAMPLE = {
  name: "墨绿三卡知识片",
  content_form: "knowledge",
  canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#0C1F17" },
  variables: [
    { name: "topic", type: "text", default: "为什么海是蓝色的", label: "主题" },
    { name: "tag", type: "text", default: "知识卡片", label: "顶部标签" },
    { name: "card1_title", type: "text", default: "光的散射", label: "卡片1标题" },
    { name: "card1_body", type: "text", default: "蓝光波长短，最容易被水分子散射", label: "卡片1正文" },
    { name: "card2_title", type: "text", default: "深度的影响", label: "卡片2标题" },
    { name: "card2_body", type: "text", default: "海水越深，蓝色越浓郁纯粹", label: "卡片2正文" },
    { name: "card3_title", type: "text", default: "天空的映照", label: "卡片3标题" },
    { name: "card3_body", type: "text", default: "阴天时海面会呈现灰绿色", label: "卡片3正文" },
    { name: "stat_value", type: "text", default: "475nm", label: "数据值" },
    { name: "stat_label", type: "text", default: "蓝光的波长范围下限", label: "数据说明" },
    { name: "cta_text", type: "text", default: "关注我，每天一个冷知识", label: "行动号召" },
  ],
  layers: [
    { id: "bg", type: "shape", shape: "rect", fill: "#0C1F17", start: 0, duration: 10, position: { x: 0, y: 0 }, size: { width: 1080, height: 1920 } },
    { id: "accent-bar", type: "shape", shape: "rect", fill: "#3FD68F", start: 0, duration: 10, position: { x: 70, y: 64 }, size: { width: 160, height: 10 } },
    { id: "tag", type: "text", content: "{{tag}}", fontSize: 26, color: "#3FD68F", align: "left", start: 0.2, duration: 9.8, position: { x: 70, y: 100 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "title", type: "text", content: "{{topic}}", fontSize: 68, color: "#EFFFF5", align: "left", start: 0.2, duration: 9.8, position: { x: 70, y: 160 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card1-bg", type: "shape", shape: "rect", fill: "#173024", start: 0.5, duration: 9.5, position: { x: 70, y: 420 }, size: { width: 940, height: 260 } },
    { id: "card1-accent", type: "shape", shape: "rect", fill: "#3FD68F", start: 0.5, duration: 9.5, position: { x: 70, y: 420 }, size: { width: 8, height: 260 } },
    { id: "card1-num", type: "text", content: "01", fontSize: 30, color: "#3FD68F", align: "left", start: 0.5, duration: 9.5, position: { x: 110, y: 452 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card1-title", type: "text", content: "{{card1_title}}", fontSize: 38, color: "#EFFFF5", align: "left", start: 0.5, duration: 9.5, position: { x: 110, y: 500 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card1-body", type: "text", content: "{{card1_body}}", fontSize: 28, color: "#8FC7A8", align: "left", start: 0.5, duration: 9.5, position: { x: 110, y: 570 }, size: { width: 860, height: 90 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card2-bg", type: "shape", shape: "rect", fill: "#173024", start: 0.8, duration: 9.2, position: { x: 70, y: 760 }, size: { width: 940, height: 260 } },
    { id: "card2-accent", type: "shape", shape: "rect", fill: "#3FD68F", start: 0.8, duration: 9.2, position: { x: 70, y: 760 }, size: { width: 8, height: 260 } },
    { id: "card2-num", type: "text", content: "02", fontSize: 30, color: "#3FD68F", align: "left", start: 0.8, duration: 9.2, position: { x: 110, y: 792 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card2-title", type: "text", content: "{{card2_title}}", fontSize: 38, color: "#EFFFF5", align: "left", start: 0.8, duration: 9.2, position: { x: 110, y: 840 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card2-body", type: "text", content: "{{card2_body}}", fontSize: 28, color: "#8FC7A8", align: "left", start: 0.8, duration: 9.2, position: { x: 110, y: 910 }, size: { width: 860, height: 90 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card3-bg", type: "shape", shape: "rect", fill: "#173024", start: 1.1, duration: 8.9, position: { x: 70, y: 1100 }, size: { width: 940, height: 260 } },
    { id: "card3-accent", type: "shape", shape: "rect", fill: "#3FD68F", start: 1.1, duration: 8.9, position: { x: 70, y: 1100 }, size: { width: 8, height: 260 } },
    { id: "card3-num", type: "text", content: "03", fontSize: 30, color: "#3FD68F", align: "left", start: 1.1, duration: 8.9, position: { x: 110, y: 1132 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card3-title", type: "text", content: "{{card3_title}}", fontSize: 38, color: "#EFFFF5", align: "left", start: 1.1, duration: 8.9, position: { x: 110, y: 1180 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "card3-body", type: "text", content: "{{card3_body}}", fontSize: 28, color: "#8FC7A8", align: "left", start: 1.1, duration: 8.9, position: { x: 110, y: 1250 }, size: { width: 860, height: 90 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "stat-value", type: "text", content: "{{stat_value}}", fontSize: 96, color: "#3FD68F", align: "left", start: 1.4, duration: 8.6, position: { x: 70, y: 1450 }, animations: [{ type: "slidein", duration: 0.4, direction: "bottom" }] },
    { id: "stat-label", type: "text", content: "{{stat_label}}", fontSize: 26, color: "#8FC7A8", align: "left", start: 1.4, duration: 8.6, position: { x: 70, y: 1570 } },
    { id: "cta-bg", type: "shape", shape: "rect", fill: "#3FD68F", start: 1.7, duration: 8.3, position: { x: 70, y: 1700 }, size: { width: 940, height: 72 } },
    { id: "cta-text", type: "text", content: "{{cta_text}}", fontSize: 30, color: "#0C1F17", align: "center", start: 1.7, duration: 8.3, position: { x: 70, y: 1718 }, size: { width: 940, height: 40 } },
  ],
  audio: [],
  transitions: [],
};

/** 黄金范例的设计要点说明（随范例一起注入，告诉 LLM 好在哪） */
export const GOLDEN_EXAMPLE_NOTES = [
  "层级：主标题 68px > 卡片标题 38px > 正文 28px = 清晰的三档字号阶梯，比例约 1.5:1",
  "对齐：所有文字严格左对齐在 x=110（卡片内）/ x=70（全局）两条轴线上，没有一个元素随意摆放",
  "色彩纪律：全片只有 4 个颜色（bg/卡片/强调/两档文字色），强调色只用于序号、数据、CTA 等视觉锚点",
  "节奏：标题组 0.2s → 卡片组 0.5/0.8/1.1s → 数据 1.4s → CTA 1.7s，像呼吸一样依次入场",
  "变量：所有会随内容变化的文字都是 {{变量}}，装饰性文字（01/02/03）才是写死的",
  "安全区：左右边距 70px，最底元素 1772px，距画布底 148px",
].join("\n");
