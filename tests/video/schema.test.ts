import { describe, it, expect } from "vitest";
import { validateTimeline, validateTemplate, TimelineValidationError } from "../../src/video/schema.js";

function minimalTimeline() {
  return {
    canvas: { width: 1080, height: 1920, fps: 30 },
    layers: [{ id: "l1", type: "text", content: "Hello", start: 0, duration: 3, position: "center", fontSize: 48 }],
    audio: [],
  };
}

describe("schema validation", () => {
  it("validates a minimal timeline", () => {
    const t = validateTimeline(minimalTimeline());
    expect(t.canvas.width).toBe(1080);
    expect(t.layers.length).toBe(1);
  });

  it("rejects missing canvas", () => {
    expect(() => validateTimeline({ layers: [], audio: [] })).toThrow(TimelineValidationError);
  });

  it("rejects invalid layer type", () => {
    const tl = minimalTimeline();
    tl.layers[0].type = "unknown";
    expect(() => validateTimeline(tl)).toThrow(TimelineValidationError);
  });

  it("validates a template", () => {
    const tpl = {
      id: "tpl_1",
      name: "Test",
      canvas: { width: 1080, height: 1920, fps: 30 },
      variables: [{ name: "title", type: "text", label: "标题" }],
      layers: [{ id: "l1", type: "text", content: "{{title}}", start: 0, duration: 3, position: "center" }],
      audio: [],
    };
    const result = validateTemplate(tpl);
    expect(result.variables.length).toBe(1);
  });
});
