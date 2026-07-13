import type { Timeline, TimelineLayer, VideoTemplate, AudioTrack, SubtitleTrack, Transition, TemplateVariable } from "./types.js";

export class TimelineValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelineValidationError";
  }
}

function assertNumber(value: unknown, name: string, min?: number, max?: number): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TimelineValidationError(`${name} must be a number`);
  }
  if (min !== undefined && value < min) throw new TimelineValidationError(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new TimelineValidationError(`${name} must be <= ${max}`);
  return value;
}

function assertString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TimelineValidationError(`${name} must be a non-empty string`);
  }
  return value;
}

export function validateLayer(layer: unknown): TimelineLayer {
  if (!layer || typeof layer !== "object") throw new TimelineValidationError("layer must be an object");
  const l = layer as Record<string, unknown>;
  const id = assertString(l.id, "layer.id");
  const type = assertString(l.type, "layer.type");
  const start = assertNumber(l.start as number, "layer.start", 0);
  const duration = assertNumber(l.duration as number, "layer.duration", 0.1);

  const base = { id, type, start, duration, position: l.position ?? "center", opacity: l.opacity ?? 1 };

  switch (type) {
    case "video":
    case "image":
      return {
        ...base,
        type,
        source: assertString(l.source, "layer.source"),
        size: validateSize(l.size),
        animations: validateAnimations(l.animations),
      } as TimelineLayer;
    case "text":
      return {
        ...base,
        type: "text",
        content: assertString(l.content, "layer.content"),
        fontSize: assertNumber((l.fontSize as number) ?? 48, "layer.fontSize", 8, 512),
        color: (l.color as string) ?? "#FFFFFF",
        align: (l.align as "left" | "center" | "right") ?? "center",
        animations: validateAnimations(l.animations),
      } as TimelineLayer;
    case "shape":
      return {
        ...base,
        type: "shape",
        shape: (l.shape as "rect" | "circle") ?? "rect",
        fill: (l.fill as string) ?? "#FFFFFF",
        size: validateSize(l.size),
        animations: validateAnimations(l.animations),
      } as TimelineLayer;
    default:
      throw new TimelineValidationError(`Unsupported layer type: ${type}`);
  }
}

function validateSize(size: unknown): { width: number; height: number } {
  if (!size || typeof size !== "object") throw new TimelineValidationError("size must be an object");
  const s = size as Record<string, unknown>;
  return {
    width: assertNumber(s.width as number, "size.width", 1),
    height: assertNumber(s.height as number, "size.height", 1),
  };
}

function validateAnimations(animations: unknown): { type: string; duration: number }[] | undefined {
  if (!animations) return undefined;
  if (!Array.isArray(animations)) throw new TimelineValidationError("animations must be an array");
  return animations.map((a, i) => {
    if (!a || typeof a !== "object") throw new TimelineValidationError(`animation[${i}] must be an object`);
    return {
      type: assertString((a as Record<string, unknown>).type, `animation[${i}].type`),
      duration: assertNumber((a as Record<string, unknown>).duration as number, `animation[${i}].duration`, 0),
    };
  });
}

export function validateTimeline(timeline: unknown): Timeline {
  if (!timeline || typeof timeline !== "object") throw new TimelineValidationError("timeline must be an object");
  const t = timeline as Record<string, unknown>;
  const canvas = t.canvas as Record<string, unknown>;
  if (!canvas) throw new TimelineValidationError("timeline.canvas is required");
  const layers = t.layers;
  if (!Array.isArray(layers)) throw new TimelineValidationError("timeline.layers must be an array");
  const audio = t.audio;
  if (!Array.isArray(audio)) throw new TimelineValidationError("timeline.audio must be an array");

  return {
    canvas: {
      width: assertNumber(canvas.width as number, "canvas.width", 1),
      height: assertNumber(canvas.height as number, "canvas.height", 1),
      fps: assertNumber(canvas.fps as number, "canvas.fps", 1, 120),
      backgroundColor: (canvas.backgroundColor as string) ?? "#000000",
    },
    layers: layers.map(validateLayer),
    audio: audio.map((a, i) => validateAudio(a, i)) as AudioTrack[],
    subtitles: t.subtitles ? validateSubtitles(t.subtitles) : undefined,
    transitions: t.transitions ? (t.transitions as Transition[]) : undefined,
  };
}

function validateAudio(audio: unknown, index: number): AudioTrack {
  if (!audio || typeof audio !== "object") throw new TimelineValidationError(`audio[${index}] must be an object`);
  const a = audio as Record<string, unknown>;
  return {
    type: assertString(a.type, `audio[${index}].type`),
    source: assertString(a.source, `audio[${index}].source`),
    volume: a.volume !== undefined ? assertNumber(a.volume as number, `audio[${index}].volume`, 0, 10) : undefined,
    start: a.start !== undefined ? assertNumber(a.start as number, `audio[${index}].start`, 0) : undefined,
    duration: a.duration !== undefined ? assertNumber(a.duration as number, `audio[${index}].duration`, 0) : undefined,
    loop: a.loop !== undefined ? Boolean(a.loop) : undefined,
  } as AudioTrack;
}

function validateSubtitles(subs: unknown): SubtitleTrack {
  if (!subs || typeof subs !== "object") throw new TimelineValidationError("subtitles must be an object");
  const s = subs as Record<string, unknown>;
  return { source: assertString(s.source, "subtitles.source"), style: (s.style as string) ?? "default" };
}

export function validateTemplate(template: unknown): VideoTemplate {
  if (!template || typeof template !== "object") throw new TimelineValidationError("template must be an object");
  const t = template as Record<string, unknown>;
  const id = assertString(t.id, "template.id");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new TimelineValidationError("template.id must contain only letters, numbers, underscores, or hyphens");
  }
  return {
    id,
    name: assertString(t.name, "template.name"),
    contentForm: (t.contentForm as string) || undefined,
    canvas: validateTimeline({ canvas: t.canvas, layers: t.layers ?? [], audio: t.audio ?? [] }).canvas,
    variables: Array.isArray(t.variables) ? t.variables.map((v, i) => validateVariable(v, i)) : [],
    timeline: validateTimeline({ canvas: t.canvas, layers: t.layers ?? [], audio: t.audio ?? [], subtitles: t.subtitles, transitions: t.transitions }),
  };
}

function validateVariable(v: unknown, index: number): TemplateVariable {
  if (!v || typeof v !== "object") throw new TimelineValidationError(`variables[${index}] must be an object`);
  const variable = v as Record<string, unknown>;
  return {
    name: assertString(variable.name, `variables[${index}].name`),
    type: assertString(variable.type, `variables[${index}].type`) as TemplateVariable["type"],
    default: variable.default as string | number | undefined,
    label: (variable.label as string) || (variable.name as string),
  };
}
