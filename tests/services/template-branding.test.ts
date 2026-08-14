import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resetInMemoryDb, closeDb } from "../../src/db/connection.js";
import { migrate } from "../../src/db/migrate.js";
import { sanitizeBranding } from "../../src/db/templates-repo.js";
import { brandingPixelPosition, brandingToImageLayer, brandingAssetPath } from "../../src/video/branding.js";
import { buildCardHtml } from "../../src/services/dual-output.js";
import { dataDir } from "../../src/config.js";

const canvas = { width: 1080, height: 1920, fps: 30 };
const base = { logoAsset: "branding/logo.png", position: "top-right" as const, margin: 48, width: 160, opacity: 1 };

describe("branding 九宫格坐标", () => {
  it("top-right", () => {
    expect(brandingPixelPosition(base, canvas)).toEqual({ x: 1080 - 160 - 48, y: 48 });
  });
  it("top-left / bottom-right / center", () => {
    expect(brandingPixelPosition({ ...base, position: "top-left" }, canvas)).toEqual({ x: 48, y: 48 });
    expect(brandingPixelPosition({ ...base, position: "bottom-right" }, canvas)).toEqual({ x: 1080 - 160 - 48, y: 1920 - 160 - 48 });
    expect(brandingPixelPosition({ ...base, position: "center" }, canvas)).toEqual({ x: (1080 - 160) / 2, y: (1920 - 160) / 2 });
  });
  it("缺省 margin/width 用默认值", () => {
    expect(brandingPixelPosition({ logoAsset: "branding/a.png", position: "top-left" }, canvas)).toEqual({ x: 48, y: 48 });
  });
});

describe("brandingToImageLayer", () => {
  it("生成覆盖内容时长的 image layer,source 为本地绝对路径", () => {
    const layer = brandingToImageLayer(base, canvas, 42);
    expect(layer.type).toBe("image");
    expect(layer.start).toBe(0);
    expect(layer.duration).toBe(42); // 与内容时长一致,不拖长成片
    expect(layer.source).toBe(brandingAssetPath("branding/logo.png"));
    expect(layer.size).toEqual({ width: 160, height: 160 }); // decrease scale 自动等比
    expect(layer.opacity).toBe(1);
  });
});

describe("sanitizeBranding", () => {
  it("合法输入原样通过", () => {
    expect(sanitizeBranding(base)).toEqual(base);
  });
  it("非法 position 回退 top-right;opacity 截断到 0-1", () => {
    const b = sanitizeBranding({ logoAsset: "branding/a.png", position: "somewhere", opacity: 5 });
    expect(b?.position).toBe("top-right");
    expect(b?.opacity).toBe(1);
  });
  it("缺 logoAsset / 非对象 → undefined", () => {
    expect(sanitizeBranding({ position: "top-left" })).toBeUndefined();
    expect(sanitizeBranding("x")).toBeUndefined();
    expect(sanitizeBranding(null)).toBeUndefined();
  });
});

describe("buildCardHtml logo 叠加", () => {
  const spec = {
    layout: "big_title_center",
    font: "Noto Sans SC",
    fontSize: 96,
    colorScheme: { background: "#FFFFFF", primary: "#1A1A1A", text: "#333333", accent: "#FF2E4D" },
    decorations: [],
  };
  const cardCanvas = { width: 1080, height: 1440 };
  const logoDir = join(dataDir, "shared-assets", "branding");

  beforeEach(() => {
    resetInMemoryDb();
    migrate();
    mkdirSync(logoDir, { recursive: true });
    // 1x1 透明 PNG
    writeFileSync(join(logoDir, "test-logo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  });
  afterEach(() => {
    closeDb();
    try { rmSync(join(logoDir, "test-logo.png")); } catch {}
  });

  it("有 branding → 含 brand-logo img(data URI)与九宫格 CSS", () => {
    const html = buildCardHtml({
      spec, canvas: cardCanvas, kind: "cover", title: "测试",
      branding: { logoAsset: "branding/test-logo.png", position: "bottom-right", margin: 40, width: 120, opacity: 0.8 },
    });
    expect(html).toContain('class="brand-logo"');
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("right:40px");
    expect(html).toContain("bottom:40px");
    expect(html).toContain("width:120px");
    expect(html).toContain("opacity:0.8");
  });

  it("无 branding → 不含 brand-logo", () => {
    const html = buildCardHtml({ spec, canvas: cardCanvas, kind: "cover", title: "测试" });
    expect(html).not.toContain("brand-logo");
  });

  it("logo 文件缺失 → 静默降级不出 logo,不抛错", () => {
    const html = buildCardHtml({
      spec, canvas: cardCanvas, kind: "cover", title: "测试",
      branding: { logoAsset: "branding/missing.png", position: "top-left" },
    });
    expect(html).not.toContain("brand-logo");
    expect(html).toContain("测试");
  });
});
