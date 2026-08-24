import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { getTemplate, updateTemplate, listTemplates } from "../../src/db/templates-repo.js";
import { ensureBuiltinCodeTemplates, KEYNOTE_LEATHER_TEMPLATE_ID } from "../../src/services/code-templates.js";

describe("ensureBuiltinCodeTemplates(内置 code 模板种子)", () => {
  beforeEach(() => { resetInMemoryDb(); migrate(); });
  afterEach(() => closeDb());

  it("首次调用注册 keynote-leather 为 approved code 模板", () => {
    ensureBuiltinCodeTemplates();
    const tpl = getTemplate(KEYNOTE_LEATHER_TEMPLATE_ID);
    expect(tpl).toBeDefined();
    expect(tpl!.kind).toBe("code");
    expect(tpl!.status).toBe("approved");
    expect(tpl!.canvas.width).toBe(1920);
    expect(tpl!.canvas.height).toBe(1080);
    // 场景配置约定:layers[0].scene
    expect((tpl!.layers[0] as { scene?: string }).scene).toBe("keynote-leather");
    // host_video 变量声明(渲染端点据此强制 digitalHumanVideo)
    expect(tpl!.variables.some((v) => v.name === "host_video")).toBe(true);
  });

  it("幂等:重复调用不重复创建,且保留用户编辑", () => {
    ensureBuiltinCodeTemplates();
    updateTemplate(KEYNOTE_LEATHER_TEMPLATE_ID, { status: "candidate" });
    ensureBuiltinCodeTemplates();
    const tpl = getTemplate(KEYNOTE_LEATHER_TEMPLATE_ID);
    expect(tpl!.status).toBe("candidate"); // 用户停用不被种子翻回
    const all = listTemplates(undefined, undefined, "code");
    expect(all.filter((t) => t.id === KEYNOTE_LEATHER_TEMPLATE_ID)).toHaveLength(1);
  });
});
