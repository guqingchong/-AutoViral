import { describe, it, expect } from "vitest";
import { applyVariables, fillDefaults, validateVariableValues } from "../../src/video/variables.js";

describe("variable substitution", () => {
  it("replaces placeholders in nested json", () => {
    const tpl = { layers: [{ content: "{{title}}" }], meta: { x: "{{count}}" } };
    const result = applyVariables(tpl, { title: "Hello", count: 42 });
    expect(result.layers[0].content).toBe("Hello");
    expect(result.meta.x).toBe("42");
  });

  it("fills defaults", () => {
    const vars = [{ name: "title", type: "text" as const, default: "默认" }];
    expect(fillDefaults(vars)).toEqual({ title: "默认" });
  });

  it("validates number variables", () => {
    const vars = [{ name: "size", type: "number" as const, default: 48 }];
    expect(validateVariableValues(vars, { size: "abc" })).toEqual({ size: 48 });
    expect(validateVariableValues(vars, { size: "60" })).toEqual({ size: 60 });
  });
});
