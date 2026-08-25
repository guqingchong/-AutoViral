import { describe, it, expect } from "vitest";
import {
  buildBriefPrompt,
  buildBriefRevisePrompt,
  getBriefSession,
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
