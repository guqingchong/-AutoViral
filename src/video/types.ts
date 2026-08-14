export interface TimelineCanvas {
  width: number;
  height: number;
  fps: number;
  backgroundColor?: string;
}

export interface TimelinePosition {
  x: number;
  y: number;
}

export interface TimelineSize {
  width: number;
  height: number;
}

export interface TimelineAnimation {
  type: "fadein" | "fadeout" | "slidein" | "slideout" | "scale" | "rotate";
  duration: number;
  easing?: "linear" | "ease" | "ease-in" | "ease-out";
  direction?: "left" | "right" | "top" | "bottom";
  from?: number;
  to?: number;
}

export interface BaseLayer {
  id: string;
  type: string;
  start: number;
  duration: number;
  position: TimelinePosition | "center" | "top" | "bottom" | "left" | "right";
  size?: TimelineSize;
  opacity?: number;
  animations?: TimelineAnimation[];
}

export interface VideoLayer extends BaseLayer {
  type: "video";
  source: string;
  size: TimelineSize;
  /** 素材截取起点(秒)。缺省时沿用历史语义:从 layer.start 处截取素材 */
  sourceStart?: number;
}

export interface ImageLayer extends BaseLayer {
  type: "image";
  source: string;
  size: TimelineSize;
  /** 素材截取起点(秒)。缺省时沿用历史语义:从 layer.start 处截取素材 */
  sourceStart?: number;
}

export interface TextLayer extends BaseLayer {
  type: "text";
  content: string;
  fontFamily?: string;
  fontSize?: number;
  color?: string;
  align?: "left" | "center" | "right";
  stroke?: { width: number; color: string };
  background?: { color: string; padding: number; radius?: number };
}

export interface ShapeLayer extends BaseLayer {
  type: "shape";
  shape: "rect" | "circle";
  fill?: string;
  stroke?: { width: number; color: string };
  size: TimelineSize;
}

export type TimelineLayer = VideoLayer | ImageLayer | TextLayer | ShapeLayer;

export interface AudioTrack {
  type: "voice" | "bgm" | "sfx";
  source: string;
  volume?: number;
  start?: number;
  duration?: number;
  loop?: boolean;
}

export interface SubtitleTrack {
  source: string;
  style?: string;
}

/**
 * Transition between layers.
 * Supported types: fade (crossfade), slide (slide right), wipe (wipe left).
 */
export interface Transition {
  type: "fade" | "slide" | "wipe";
  duration: number;
}

export interface Timeline {
  canvas: TimelineCanvas;
  layers: TimelineLayer[];
  audio: AudioTrack[];
  subtitles?: SubtitleTrack;
  /** Transitions between sequential media layers (rendered via xfade). */
  transitions?: Transition[];
}

export interface TemplateVariable {
  name: string;
  type: "text" | "image" | "video" | "audio" | "number" | "color";
  default?: string | number;
  label?: string;
}

export interface VideoTemplate {
  id: string;
  name: string;
  contentForm?: string;
  canvas: TimelineCanvas;
  variables: TemplateVariable[];
  timeline: Timeline;
}
