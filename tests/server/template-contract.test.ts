import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createTemplate } from "../../src/db/templates-repo.js";
import { buildTemplateSection } from "../../src/server/api.js";

describe("buildTemplateSection 模板契约注入", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => closeDb());

  it("无 templateId → 空串", () => {
    expect(buildTemplateSection(undefined)).toBe("");
  });

  it("模板不存在 → 降级警告,不抛错", () => {
    const out = buildTemplateSection("tpl_missing");
    expect(out).toContain("模板不存在");
    expect(out).toContain("tpl_missing");
  });

  it("视频模板 → 含变量槽位/结构摘要/渲染引擎规则", () => {
    createTemplate({
      id: "tpl_v1",
      name: "数字人口播模板",
      canvas: { width: 1080, height: 1920, fps: 30 },
      variables: [
        { name: "host_video", type: "video", label: "口播视频" },
        { name: "title", type: "text", default: "标题" },
      ],
      layers: [
        { id: "bg", type: "video", source: "{{host_video}}", start: 0, duration: 30, position: "center" },
        { id: "t1", type: "text", content: "{{title}}", start: 0, duration: 3, position: "top" },
      ],
      audio: [],
      transitions: [],
      status: "approved",
      kind: "video",
    } as any);

    const out = buildTemplateSection("tpl_v1");
    expect(out).toContain("模板契约");
    expect(out).toContain("数字人口播模板");
    expect(out).toContain("1080x1920");
    expect(out).toContain("{{host_video}}");
    expect(out).toContain("{{title}}");
    expect(out).toContain("结构摘要");
    expect(out).toContain("bg [video]");
    expect(out).toContain("POST /api/works/{workId}/render");
    // 2026-08-16 混合制契约：模板只管文字信息卡镜头，其余走专门管线混排
    expect(out).toContain("文字信息卡");
    expect(out).toContain("code-scene");
    expect(out).toContain("concat 混排");
  });

  it("图文模板 → LayoutSpec 摘要 + dual-output 自动套用说明", () => {
    createTemplate({
      id: "tpl_it1",
      name: "知识卡片版式",
      canvas: { width: 1080, height: 1440, fps: 30 },
      variables: [],
      layers: [
        { id: "cover", type: "image-text-layout", page: "cover", layout: "big_title_center", font: "Noto Sans SC", fontSize: 96, colorScheme: { background: "#FFFFFF", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" }, decorations: ["accent_bar"] },
        { id: "content-page", type: "image-text-layout", page: "content", layout: "card_stack", font: "Noto Sans SC", fontSize: 56, colorScheme: { background: "#FFFFFF", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" }, decorations: [] },
      ],
      audio: [],
      transitions: [],
      status: "candidate",
      kind: "image-text",
    } as any);

    const out = buildTemplateSection("tpl_it1");
    expect(out).toContain("知识卡片版式");
    expect(out).toContain("big_title_center");
    expect(out).toContain("card_stack");
    expect(out).toContain("自动套用");
    expect(out).not.toContain("render");
  });
});
