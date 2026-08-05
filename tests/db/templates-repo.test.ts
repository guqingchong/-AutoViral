import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { createTemplate, getTemplate, listTemplates, updateTemplate, deleteTemplate } from "../../src/db/templates-repo.js";
import { createRenderJob, getRenderJob, updateRenderJob } from "../../src/db/render-jobs-repo.js";

function makeTemplate(overrides: Partial<Parameters<typeof createTemplate>[0]> = {}) {
  return {
    id: "tpl_knowledge_001",
    name: "知识传播口播模板",
    content_form: "knowledge",
    canvas: { width: 1080, height: 1920, fps: 30, backgroundColor: "#000000" },
    variables: [{ name: "title", type: "text" as const, label: "标题", default: "默认标题" }],
    layers: [{ type: "text", content: "{{title}}", start: 0, duration: 5 }],
    audio: [],
    transitions: [],
    status: "draft" as const,
    ...overrides,
  };
}

describe("templates-repo", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("creates and retrieves a template", () => {
    createTemplate(makeTemplate());
    const found = getTemplate("tpl_knowledge_001");
    expect(found?.name).toBe("知识传播口播模板");
    expect(found?.canvas.width).toBe(1080);
  });

  it("lists templates by status and content_form", () => {
    createTemplate(makeTemplate({ id: "a", status: "approved", content_form: "knowledge" }));
    createTemplate(makeTemplate({ id: "b", status: "draft", content_form: "hot_comment" }));
    expect(listTemplates("approved").length).toBe(1);
    expect(listTemplates(undefined, "knowledge").length).toBe(1);
  });

  it("defaults kind to video and filters by kind", () => {
    createTemplate(makeTemplate({ id: "vid" }));
    createTemplate(makeTemplate({ id: "it1", kind: "image-text" }));
    createTemplate(makeTemplate({ id: "it2", kind: "image-text" }));
    // 未显式传 kind 的模板默认 video
    expect(getTemplate("vid")?.kind).toBe("video");
    expect(getTemplate("it1")?.kind).toBe("image-text");
    // kind 过滤
    expect(listTemplates(undefined, undefined, "video").length).toBe(1);
    expect(listTemplates(undefined, undefined, "image-text").length).toBe(2);
    expect(listTemplates(undefined, undefined, undefined).length).toBe(3);
    // kind 与 status 组合过滤
    expect(listTemplates("draft", undefined, "image-text").length).toBe(2);
  });

  it("updates template status", () => {
    createTemplate(makeTemplate());
    const updated = updateTemplate("tpl_knowledge_001", { status: "approved" });
    expect(updated?.status).toBe("approved");
  });

  it("deletes a template", () => {
    createTemplate(makeTemplate());
    expect(deleteTemplate("tpl_knowledge_001")).toBe(true);
    expect(getTemplate("tpl_knowledge_001")).toBeUndefined();
  });

  it("creates and updates render jobs", () => {
    createTemplate(makeTemplate());
    const job = createRenderJob({ id: "job_001", template_id: "tpl_knowledge_001", status: "pending", progress: 0 });
    expect(getRenderJob("job_001")?.status).toBe("pending");
    updateRenderJob("job_001", { status: "running", progress: 0.5, current_time: 30, duration: 60 });
    const updated = getRenderJob("job_001")!;
    expect(updated.status).toBe("running");
    expect(updated.progress).toBe(0.5);
  });
});
