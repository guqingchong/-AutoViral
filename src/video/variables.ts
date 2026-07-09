import type { TemplateVariable } from "./types.js";

export function applyVariables(template: Record<string, unknown>, values: Record<string, string | number>): Record<string, unknown> {
  const json = JSON.stringify(template);
  let result = json;
  for (const [key, value] of Object.entries(values)) {
    const placeholder = `{{${key}}}`;
    const replacement = String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/\x08/g, "\\b")
      .replace(/\f/g, "\\f");
    result = result.split(placeholder).join(replacement);
  }
  return JSON.parse(result);
}

export function fillDefaults(variables: TemplateVariable[]): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  for (const v of variables) {
    if (v.default !== undefined) values[v.name] = v.default;
    else values[v.name] = v.type === "number" ? 0 : "";
  }
  return values;
}

export function validateVariableValues(variables: TemplateVariable[], values: Record<string, string | number>): Record<string, string | number> {
  const result = fillDefaults(variables);
  for (const [key, value] of Object.entries(values)) {
    const variable = variables.find(v => v.name === key);
    if (!variable) continue;
    if (variable.type === "number") {
      const num = Number(value);
      result[key] = Number.isNaN(num) ? (variable.default ?? 0) : num;
    } else {
      result[key] = String(value);
    }
  }
  return result;
}
