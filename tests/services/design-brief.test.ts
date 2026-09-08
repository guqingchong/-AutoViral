import { describe, it, expect } from "vitest";
import {
  buildBriefPrompt,
  buildBriefRevisePrompt,
  getBriefSession,
  normalizeBrief,
  type DesignBrief,
} from "../../src/services/design-brief.js";

const sampleBrief: DesignBrief = {
  styleSummary: "深色底赛博霓虹,克制不堆砌",
  palette: [
    { hex: "#0a0e17", role: "背景" },
    { hex: "#00e5ff", role: "强调" },
    { hex: "#ff2d95", role: "辅助" },
    { hex: "#f2f7fb", role: "文字" },
  ],
  layout: [
    { region: "顶部小标", content: "kicker", position: "距顶 8%,居中" },
    { region: "标题区", content: "title 主标题", position: "距顶 14%,居中" },
    { region: "主视觉区", content: "圆角面板+网格", position: "画面中下部" },
    { region: "字幕区", content: "subtitleCn/subtitleEn", position: "底部 10%" },
  ],
  elements: ["青色辉光", "品红霓虹网格", "圆角面板"],
  motion: { entrance: "kicker 0s → 标题 0.12s → 主视觉 0.24s → 字幕 0.4s", loop: "主视觉辉光 3s 呼吸" },
  sourceText: "赛博朋克霓虹、深色底、青色辉光、品红网格",
};

describe("buildBriefPrompt(意图稿生成纪律)", () => {
  it("包含白名单语义/配色上限/动效落定时限/原始描述", () => {
    const p = buildBriefPrompt({ style: "赛博朋克霓虹、深色底", orientation: "portrait" });
    expect(p).toContain("赛博朋克霓虹、深色底");
    expect(p).toContain("逐条来自用户描述");
    expect(p).toContain("≤3 彩色");
    expect(p).toContain("2s 内全部落定");
  });
  it("有参考图拆解要点时注入 referenceNotes", () => {
    const p = buildBriefPrompt({ style: "极简", orientation: "landscape" }, "参考图大量留白,金色点缀");
    expect(p).toContain("参考图大量留白,金色点缀");
  });
});

describe("buildBriefRevisePrompt(微调纪律)", () => {
  it("只改用户点名部分,携带当前 brief 与历史", () => {
    const p = buildBriefRevisePrompt(sampleBrief, "标题再大点", [
      { message: "换青色", diffSummary: "强调色改为青色" },
    ]);
    expect(p).toContain("只改用户点名的部分");
    expect(p).toContain("标题再大点");
    expect(p).toContain("#00e5ff"); // 当前 brief 随 prompt 注入
    expect(p).toContain("换青色"); // 历史随 prompt 注入
  });
});

describe("brief 会话存取", () => {
  it("未存在的 sessionId 返回 undefined", () => {
    expect(getBriefSession("brief_不存在")).toBeUndefined();
  });
});

describe("normalizeBrief(形状防御)", () => {
  it("缺 palette/motion 的畸形对象被收敛为完整形状", () => {
    const out = normalizeBrief({ styleSummary: "极简", motion: "淡入" });
    expect(Array.isArray(out.palette)).toBe(true);
    expect(Array.isArray(out.layout)).toBe(true);
    expect(Array.isArray(out.elements)).toBe(true);
    expect(typeof out.motion.entrance).toBe("string");
    expect(typeof out.motion.loop).toBe("string");
    expect(out.styleSummary).toBe("极简");
    expect(out.sourceText).toBe("");
  });
  it("数组项缺字段/元素非字符串时补空串", () => {
    const out = normalizeBrief({ palette: [{ hex: "#fff" }], layout: [{}], elements: [1, "辉光"] });
    expect(out.palette[0]).toEqual({ hex: "#fff", role: "" });
    expect(out.layout[0]).toEqual({ region: "", content: "", position: "" });
    expect(out.elements).toEqual(["", "辉光"]);
  });
  it("完全合法的 brief 字段原样保留", () => {
    const out = normalizeBrief(sampleBrief);
    expect(out).toEqual(sampleBrief);
  });
});

describe("分页设计稿(2026-09-02 分页模板)", () => {
  it("multiPage 时 prompt 携带 pages 形状与三页纪律", async () => {
    const { buildBriefPrompt } = await import("../../src/services/design-brief.js");
    const p = buildBriefPrompt({ style: "深蓝科技", orientation: "portrait", multiPage: true });
    expect(p).toContain('"pages"');
    expect(p).toContain("cover/content/ending");
    expect(p).toContain("分页纪律");
    const single = buildBriefPrompt({ style: "深蓝科技", orientation: "portrait" });
    expect(single).not.toContain("分页纪律");
  });

  it("normalizeBrief 收敛 pages:非法 role 丢弃,layout 逐条规范化", async () => {
    const { normalizeBrief } = await import("../../src/services/design-brief.js");
    const out = normalizeBrief({
      pages: [
        { role: "cover", goal: "抓眼球", layout: [{ region: "标题", content: "title", position: "居中" }], motionOverride: "弹入" },
        { role: "junk", goal: "坏页", layout: [] },
        { role: "ending", layout: [{ region: 1 }] },
      ],
    });
    expect(out.pages).toHaveLength(2);
    expect(out.pages![0].role).toBe("cover");
    expect(out.pages![0].motionOverride).toBe("弹入");
    expect(out.pages![1].layout[0]).toEqual({ region: "", content: "", position: "" });
  });

  it("无 pages 字段时不输出 pages 键(向后兼容)", async () => {
    const { normalizeBrief } = await import("../../src/services/design-brief.js");
    const out = normalizeBrief({ styleSummary: "x" });
    expect("pages" in out).toBe(false);
  });
});
