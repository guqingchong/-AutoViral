import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../src/services/llm-json.js", () => ({
  runJsonPrompt: vi.fn(),
}));

import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createTemplate, getTemplate } from "../../src/db/templates-repo.js";
import { runJsonPrompt } from "../../src/services/llm-json.js";
import { refineTemplate } from "../../src/services/template-refine.js";

const baseLayers = [
  { id: "bg", type: "video", source: "{{clip}}", start: 0, duration: 5, position: "center", size: { width: 1080, height: 1920 } },
  { id: "t1", type: "text", content: "{{title}}", start: 0, duration: 3, position: "top", fontSize: 64, color: "#FFFFFF" },
];

function seedTemplate(id = "tpl_r1") {
  return createTemplate({
    id,
    name: "原模板",
    canvas: { width: 1080, height: 1920, fps: 30 },
    variables: [{ name: "clip", type: "video" }, { name: "title", type: "text" }],
    layers: baseLayers,
    audio: [],
    transitions: [],
    status: "approved",
    kind: "video",
  } as any);
}

function refinedJson(name = "原模板") {
  return {
    name,
    canvas: { width: 1080, height: 1920, fps: 30 },
    variables: [{ name: "clip", type: "video" }, { name: "title", type: "text" }],
    layers: [
      baseLayers[0],
      { ...baseLayers[1], fontSize: 96, color: "#00FF00" },
    ],
    audio: [],
    transitions: [],
  };
}

describe("template-refine 二次加工", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });
  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it("覆盖写回:LLM 产出校验通过后更新原模板", async () => {
    seedTemplate();
    (runJsonPrompt as any).mockResolvedValue(refinedJson());

    const r = await refineTemplate("tpl_r1", "标题字号加大变绿");
    expect(r.templateId).toBe("tpl_r1");
    expect(r.copied).toBe(false);
    expect(r.diffSummary).toContain("图层内容已调整");

    const t = getTemplate("tpl_r1")!;
    expect((t.layers[1] as any).fontSize).toBe(96);
    expect(t.status).toBe("approved"); // 状态保留
  });

  it("saveAsCopy:另存新模板,原模板不动", async () => {
    seedTemplate();
    (runJsonPrompt as any).mockResolvedValue(refinedJson());

    const r = await refineTemplate("tpl_r1", "换个风格", true);
    expect(r.copied).toBe(true);
    expect(r.templateId).not.toBe("tpl_r1");

    const copy = getTemplate(r.templateId)!;
    expect(copy.name).toContain("改版");
    expect(copy.status).toBe("draft");
    expect((copy.layers[1] as any).fontSize).toBe(96);

    const orig = getTemplate("tpl_r1")!;
    expect((orig.layers[1] as any).fontSize).toBe(64);
  });

  it("校验失败 → 带错误重试一次 → 成功", async () => {
    seedTemplate();
    (runJsonPrompt as any)
      .mockResolvedValueOnce({ name: "x", layers: [{ id: "bad", type: "hologram" }] })  // 非法 layer type
      .mockResolvedValueOnce(refinedJson());

    const r = await refineTemplate("tpl_r1", "改配色");
    expect(r.templateId).toBe("tpl_r1");
    expect(runJsonPrompt).toHaveBeenCalledTimes(2);
    // 第二次 prompt 带上了校验错误
    const secondPrompt = (runJsonPrompt as any).mock.calls[1][0];
    expect(secondPrompt).toContain("上一次输出未通过校验");
  });

  it("两次校验都失败 → 抛错,不写库", async () => {
    seedTemplate();
    (runJsonPrompt as any).mockResolvedValue({ name: "x", layers: [] });
    await expect(refineTemplate("tpl_r1", "改配色")).rejects.toThrow("未通过校验");
    expect(getTemplate("tpl_r1")!.name).toBe("原模板");
  });

  it("模板不存在 → 抛错", async () => {
    await expect(refineTemplate("tpl_nope", "x")).rejects.toThrow("模板不存在");
  });

  it("空指令 → 抛错", async () => {
    seedTemplate();
    await expect(refineTemplate("tpl_r1", "  ")).rejects.toThrow("不能为空");
  });

  it("图文模板:缺 content 页 → 校验失败重试", async () => {
    createTemplate({
      id: "tpl_it",
      name: "图文模板",
      canvas: { width: 1080, height: 1440, fps: 30 },
      variables: [],
      layers: [
        { id: "cover", type: "image-text-layout", page: "cover", layout: "big_title_center", font: "Noto Sans SC", fontSize: 96, colorScheme: { background: "#FFF", primary: "#000", text: "#333", accent: "#F00" }, decorations: [] },
        { id: "content-page", type: "image-text-layout", page: "content", layout: "card_stack", font: "Noto Sans SC", fontSize: 56, colorScheme: { background: "#FFF", primary: "#000", text: "#333", accent: "#F00" }, decorations: [] },
      ],
      audio: [],
      transitions: [],
      status: "candidate",
      kind: "image-text",
    } as any);
    const valid = getTemplate("tpl_it")!;
    (runJsonPrompt as any)
      .mockResolvedValueOnce({ name: "x", layers: [valid.layers[0]] })  // 缺 content 页
      .mockResolvedValueOnce({ name: "图文模板", canvas: valid.canvas, variables: [], layers: valid.layers, audio: [], transitions: [] });

    const r = await refineTemplate("tpl_it", "封面字再大一点");
    expect(r.templateId).toBe("tpl_it");
    expect(runJsonPrompt).toHaveBeenCalledTimes(2);
  });
});
