/**
 * 六用途预设（2026-08-18 批量选项卡用途驱动重设计 04-1）。
 * 设计文档：docs/desigen/04-批量制作选项卡-用途驱动重设计方案.md
 *
 * 一处定义前后端共用：前端批量弹窗从 GET /api/purposes 拉取本表渲染；
 * 后端 batch-convert 按 purpose 注入 prompt 约束段 + 技能包 + 评审关注点。
 *
 * 用途是"用户意图"入口：决定内容形式推荐、时长/素材/配音默认值、
 * agent 策划 prompt 的结构要求、评审差异化关注点。
 */

export interface PurposePreset {
  key: string;
  label: string;
  icon: string;
  /** 一句话目标 */
  goal: string;
  /** 内容策略概述（UI 展示用） */
  strategy: string;
  /** 推荐内容形式（key 列表，按推荐度排序；见 CONTENT_FORMS） */
  forms: string[];
  /** 默认制作参数（进入高级选项的默认值） */
  defaults: {
    duration: number;
    assetForm: string;
    assetSource: string;
    assetBudget: string;
  };
  /** 注入 agent 策划/制作 prompt 的用途约束段 */
  promptBlock: string;
  /** 评审差异化关注点（追加进 eval prompt） */
  evalFocus: string[];
  /** 该用途声明需要的工具/插件能力（UI 自检提示用） */
  requiredTools?: string[];
}

/** 内容形式全集（13 种，04 方案）。desc 供 UI 展示 */
export const CONTENT_FORMS: Record<string, { label: string; desc: string }> = {
  knowledge: { label: "知识科普", desc: "动画讲解·边讲边画" },
  industry: { label: "行业洞察", desc: "数据图表·动态流动" },
  policy: { label: "政策解读", desc: "文件原文+动画拆解" },
  insight: { label: "观点输出", desc: "大字金句·视觉冲击" },
  hot_comment: { label: "热点评述", desc: "快讯演播室·严肃时效" },
  review: { label: "测评对比", desc: "实测演示·逐项 PK" },
  tutorial: { label: "教程实操", desc: "步骤演示·操作特写" },
  goodlist: { label: "好物清单", desc: "清单盘点·利益点直击" },
  mystery: { label: "悬念揭秘", desc: "暗黑纪录·抽丝剥茧" },
  checklist: { label: "干货清单", desc: "图文快闪·密集信息量" },
  story: { label: "故事叙述", desc: "电影分镜·场景演绎" },
  emotion: { label: "情感共鸣", desc: "生活胶片·真实温度" },
  short_drama: { label: "短剧分集", desc: "竖屏连续剧·钩子留扣" },
};

export const PURPOSE_PRESETS: PurposePreset[] = [
  {
    key: "grow_fans",
    label: "涨粉·打造 IP",
    icon: "🚀",
    goal: "关注转化",
    strategy: "系列化+强人设+信息增量，让观众觉得'关注他能持续学到东西'",
    forms: ["knowledge", "industry", "policy", "insight"],
    defaults: { duration: 180, assetForm: "video-mix", assetSource: "smart", assetBudget: "eco" },
    promptBlock: [
      "用途约束（涨粉·打造 IP）：",
      "- 信息增量密度优先：每 15 秒至少一个新知/新视角，杜绝注水",
      "- 人设一致性：口吻/立场/视觉风格与系列前作保持连贯",
      "- 结尾必带系列预告+关注引导（'下期讲 X，关注我别错过'式），但禁止生硬乞讨关注",
      "- 钩子结构：前 3 秒抛出观众切身利益相关的认知缺口",
    ].join("\n"),
    evalFocus: ["信息增量密度（是否有注水段落）", "结尾关注引导是否自然", "人设/口吻一致性"],
  },
  {
    key: "sell_products",
    label: "带货·促转化",
    icon: "🛒",
    goal: "点击/购买",
    strategy: "信任构建+效果演示+利益点，千川三段式：吸引→信任→引导点击",
    forms: ["review", "tutorial", "goodlist"],
    defaults: { duration: 120, assetForm: "video-mix", assetSource: "smart", assetBudget: "premium" },
    promptBlock: [
      "用途约束（带货·促转化）：",
      "- 前 3 秒痛点或价格钩子（'还在花冤枉钱 X？'式），禁止慢热开场",
      "- 中段效果演示优先用真实画面/对比演示，口播夸大词必须有画面佐证",
      "- 结尾明确 CTA：利益点重复+行动指令（点链接/进橱窗/评论扣 1）",
      "- 信任构建：数据/测评过程/使用场景真实可查，禁止伪造效果",
    ].join("\n"),
    evalFocus: ["前 3 秒钩子强度", "效果演示可信度", "结尾 CTA 是否明确可执行"],
  },
  {
    key: "drive_traffic",
    label: "引流·导私域",
    icon: "🔗",
    goal: "私信/主页点击",
    strategy: "强钩子+信息差+资料包诱导，关键信息留一半",
    forms: ["mystery", "checklist", "knowledge"],
    defaults: { duration: 90, assetForm: "image-carousel", assetSource: "smart", assetBudget: "eco" },
    promptBlock: [
      "用途约束（引流·导私域）：",
      "- 钩子前置：第一帧即抛悬念/利益点（'整理了 3 天的 X 资料'式）",
      "- 信息差设计：核心干货只说结论不说全，完整版/资料包引导主页/私信获取",
      "- 引导话术自然嵌入内容流，禁止全片硬广口吻",
      "- 清单类内容宁多勿少（'7 个''10 条'数字钩子在标题就要出现）",
    ].join("\n"),
    evalFocus: ["钩子是否足够前置", "信息差是否成立（真的留了悬念）", "引流话术是否过硬是广告腔"],
  },
  {
    key: "brand_exposure",
    label: "品宣·扩曝光",
    icon: "📢",
    goal: "播放/转发",
    strategy: "情绪共鸣+热点借势，传播性优先于信息量",
    forms: ["hot_comment", "emotion", "story"],
    defaults: { duration: 120, assetForm: "video-mix", assetSource: "smart", assetBudget: "eco" },
    promptBlock: [
      "用途约束（品宣·扩曝光）：",
      "- 情绪曲线优先：共鸣点/爽点/泪点明确，传播靠情绪不靠干货",
      "- 热点借势时观点要鲜明但不越合规线（不造谣/不引战/不贬损特定群体）",
      "- 品牌/账号露出控制在结尾 3 秒内或角标式轻植入，禁止全片硬广",
      "- 转发钩子：给观众一个'转发给朋友看'的理由（身份认同/实用收藏/情绪共鸣）",
    ].join("\n"),
    evalFocus: ["情绪曲线是否有明确峰值", "转发理由是否成立", "品牌露出是否克制"],
  },
  {
    key: "authority",
    label: "专业影响力",
    icon: "📈",
    goal: "行业认可",
    strategy: "深度解读+数据支撑，回形针式'材料可查'原则",
    forms: ["policy", "industry", "knowledge"],
    // 2026-08-26:300→180——plan 评审标准将"总时长超过3分钟"列为 Critical(短视频
    // 平台限制),300s 默认导致每个 authority 作品的 plan 评审首轮必挂(实测两连中)
    defaults: { duration: 180, assetForm: "video-mix", assetSource: "smart", assetBudget: "eco" },
    promptBlock: [
      "用途约束（专业影响力）：",
      "- 来源引用规范：关键数据/政策条文必须标注可查来源（文件名/发布时间/条款号），"
        + "图表数值与官方口径严格一致——遵循'我们展示材料，所以说我们知道'原则",
      "- 深度优先于广度：一个议题讲透（背景→机制→影响→预判），拒绝百科式罗列",
      "- 专业术语必须配通俗解释，但不降智（目标观众是从业者/深度爱好者）",
      "- 结论给出明确判断与逻辑链，禁止'两头堵'式和稀泥",
    ].join("\n"),
    evalFocus: ["数据/引文是否标注可查来源", "论证链完整性", "专业准确性（硬伤零容忍）"],
    requiredTools: ["data-card/chart 程序化图表", "snapshot-card 原文快照", "code-scene 程序化动画"],
  },
  {
    key: "short_drama",
    label: "短剧制作",
    icon: "🎬",
    goal: "追剧/付费",
    strategy: "钩子×反转×卡点，每集结尾留扣子逼看下一集",
    forms: ["short_drama", "story"],
    defaults: { duration: 90, assetForm: "video-mix", assetSource: "ai", assetBudget: "premium" },
    promptBlock: [
      "用途约束（短剧制作）：",
      "- 黄金结构：前 3 秒冲突锚定（强刺激开场）→ 30 秒内第一次情绪爆破 → 结尾留扣子",
      "- 单集四拍：60-90 秒拆四拍（钩子→升级→反转→留扣），每拍只干一件事",
      "- 短剧不是把长剧压短：把'想追下去的理由'塞进每集结尾，本集给一个小回报+留一个大悬念",
      "- 角色记忆点 = 反差设定 × 情绪杠杆；反派极致恶行+阶段性胜利制造焦虑缺口",
      "- 系列剧：本集开头 3 秒内回扣上集扣子，结尾埋新扣子",
    ].join("\n"),
    evalFocus: ["前 3 秒冲突强度", "每拍节奏是否干净", "结尾扣子强度（是否有'必看下一集'冲动）", "角色一致性"],
    requiredTools: ["角色一致性参考图", "分幕/分集结构管理"],
  },
];

export function getPurpose(key?: string): PurposePreset | undefined {
  return PURPOSE_PRESETS.find((p) => p.key === key);
}

/** 评审关注点注入文本（评估 prompt 追加段） */
export function purposeEvalFocusBlock(purposeKey?: string): string {
  const p = getPurpose(purposeKey);
  if (!p) return "";
  return `\n\n【用途差异化评审点（${p.label}）】\n${p.evalFocus.map((f) => `- ${f}`).join("\n")}`;
}
