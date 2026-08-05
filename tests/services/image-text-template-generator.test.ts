import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { getTemplate, listTemplates } from "../../src/db/templates-repo.js";
import {
  generateImageTextTemplates,
  normalizeLayoutSpec,
  normalizeImageTextTemplate,
} from "../../src/services/image-text-template-generator.js";
import * as llmJson from "../../src/services/llm-json.js";

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    layout: "big_title_center",
    font: "Noto Sans SC",
    fontSize: 96,
    colorScheme: { background: "#ffffff", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" },
    decorations: ["accent_bar"],
    ...overrides,
  };
}

function validTemplate(name = "极简白底大字报") {
  return { name, cover: validSpec(), contentPage: validSpec({ layout: "magazine_left", fontSize: 56 }) };
}

describe("image-text-template-generator", () => {
  beforeEach(() => {
    resetInMemoryDb();
    migrate();
  });

  afterEach(() => {
    closeDb();
    vi.restoreAllMocks();
  });

  describe("normalizeLayoutSpec", () => {
    it("accepts a valid spec and normalizes colors to uppercase", () => {
      const spec = normalizeLayoutSpec(validSpec());
      expect(spec).not.toBeNull();
      expect(spec!.layout).toBe("big_title_center");
      expect(spec!.colorScheme.background).toBe("#FFFFFF");
      expect(spec!.decorations).toEqual(["accent_bar"]);
    });

    it("rejects spec without layout", () => {
      expect(normalizeLayoutSpec({ font: "x" })).toBeNull();
      expect(normalizeLayoutSpec(null)).toBeNull();
      expect(normalizeLayoutSpec("big_title_center")).toBeNull();
      expect(normalizeLayoutSpec({ layout: "  " })).toBeNull();
    });

    it("applies defaults for missing optional fields and drops invalid colors", () => {
      const spec = normalizeLayoutSpec({ layout: "card_stack", colorScheme: { background: "red", accent: "#00FF00" } });
      expect(spec).not.toBeNull();
      expect(spec!.font).toBe("Noto Sans SC");
      expect(spec!.fontSize).toBe(64);
      expect(spec!.colorScheme.background).toBe("#FFFFFF"); // 非法色值回退默认
      expect(spec!.colorScheme.accent).toBe("#00FF00");
      expect(spec!.decorations).toEqual([]);
    });
  });

  describe("normalizeImageTextTemplate", () => {
    it("requires both cover and contentPage", () => {
      expect(normalizeImageTextTemplate(validTemplate())).not.toBeNull();
      expect(normalizeImageTextTemplate({ name: "x", cover: validSpec() })).toBeNull();
      expect(normalizeImageTextTemplate({ name: "x", contentPage: validSpec() })).toBeNull();
    });

    it("falls back to a default name", () => {
      const t = normalizeImageTextTemplate({ cover: validSpec(), contentPage: validSpec() });
      expect(t!.name).toBe("未命名图文模板");
    });
  });

  describe("generateImageTextTemplates", () => {
    it("stores LLM-produced templates with kind=image-text and layout layers", async () => {
      vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
        templates: [validTemplate("模板A"), validTemplate("模板B")],
      });

      const created = await generateImageTextTemplates({ count: 2 });
      expect(created.length).toBe(2);

      const tpl = getTemplate(created[0].id)!;
      expect(tpl.kind).toBe("image-text");
      expect(tpl.status).toBe("candidate");
      expect(tpl.content_form).toBe("image-text");
      expect(tpl.canvas.width).toBe(1080);
      expect(tpl.canvas.height).toBe(1440);

      const cover = tpl.layers.find((l) => l.id === "cover") as Record<string, unknown>;
      const content = tpl.layers.find((l) => l.id === "content-page") as Record<string, unknown>;
      expect(cover.type).toBe("image-text-layout");
      expect(cover.layout).toBe("big_title_center");
      expect(content.layout).toBe("magazine_left");
      expect((cover.colorScheme as Record<string, string>).accent).toBe("#FF2E4D");

      // repo kind 过滤能捞出它们
      const imageText = listTemplates(undefined, undefined, "image-text");
      expect(imageText.length).toBe(2);
      expect(listTemplates(undefined, undefined, "video").length).toBe(0);
    });

    it("skips invalid entries and keeps valid ones", async () => {
      vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
        templates: [
          validTemplate("好的"),
          { name: "缺封面", contentPage: validSpec() },
          { cover: validSpec({ layout: "" }), contentPage: validSpec() },
        ],
      });
      const created = await generateImageTextTemplates({ count: 3 });
      expect(created.length).toBe(1);
      expect(created[0].name).toBe("好的");
    });

    it("throws when nothing valid was produced", async () => {
      vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({ templates: [{ name: "bad" }] });
      await expect(generateImageTextTemplates({ count: 1 })).rejects.toThrow("图文模板生成失败");
    });

    it("clamps count to [1, 5]", async () => {
      const spy = vi.spyOn(llmJson, "runJsonPrompt").mockResolvedValue({
        templates: Array.from({ length: 8 }, (_, i) => validTemplate(`T${i}`)),
      });
      const created = await generateImageTextTemplates({ count: 99 });
      expect(created.length).toBe(5);
      expect(spy).toHaveBeenCalledOnce();
    });
  });
});
