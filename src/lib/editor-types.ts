export type Tool =
  | 'select'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'pen'
  | 'text'
  | 'blur'
  | 'spotlight'
  | 'highlight'
  | 'crop'
  | 'number';

export type StepStyle = 'filled' | 'outline';
export type TextPreset = 'standard' | 'rounded' | 'monospaced' | 'outlined' | 'boxed' | 'rounded-boxed' | 'monospaced-boxed';
export interface StepDefaults {
  stepSize: number;
  stepStyle: StepStyle;
}

/** How an arrow's body runs between its two ends. CleanShot-style: straight or curved. */
export type ArrowStyle = 'straight' | 'curved';
/** What the arrow ends in. `chevron` is the open head arrows have always drawn. */
export type ArrowHead = 'chevron' | 'triangle' | 'dot' | 'none';
/** Which ends carry a head. */
export type ArrowEnds = 'head' | 'both';

/** The arrow settings a newly drawn arrow starts with — CleanShot-style: straight line with optional curve via handle. */
export interface ArrowDefaults {
  arrowStyle: ArrowStyle;
  curve: number;
  arrowHead: ArrowHead;
  arrowEnds: ArrowEnds;
  /** 0 keeps the head following the stroke weight. */
  headSize: number;
}

export interface Point {
  x: number;
  y: number;
}

/** All coordinates are in the original screenshot's pixel space. */
export interface Annotation {
  id: string;
  type: Exclude<Tool, 'select' | 'crop'>;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Outline colour, and the text colour for text layers. */
  color: string;
  strokeWidth: number;
  /** Arrow body shape. Defaults to `straight`. curved bows via middle handle. */
  arrowStyle?: ArrowStyle;
  /** -1 to 1. Curved arrow bows this far off its chord. Defaults to 0. */
  curve?: number;
  /** Arrowhead shape. Defaults to `chevron`. */
  arrowHead?: ArrowHead;
  /** `both` puts a head on the tail as well. Defaults to `head`. */
  arrowEnds?: ArrowEnds;
  /** Head length in screenshot pixels. Defaults to the stroke-weight scale. */
  headSize?: number;
  /** Shape background colour. `null` keeps the shape outline only. */
  fill?: string | null;
  text?: string;
  /** Preset treatment shared by text editing, preview, and export. */
  textPreset?: TextPreset;
  textBackground?: string;
  textOutline?: string;
  /** Missing mode preserves pixelation in older documents. */
  blurMode?: 'blur' | 'pixelate';
  /** Blur radius or pixel block size, in screenshot pixels. */
  blurAmount?: number;
  spotlightShape?: 'rectangle' | 'ellipse';
  /** Percentage darkness outside the spotlight. */
  spotlightDim?: number;
  highlightMode?: 'text' | 'freehand';
  /** Typography, shared by the canvas preview, the inline editor and the export. */
  fontSize?: number;
  /** One of `TEXT_FAMILIES`, defaults to Inter. */
  fontFamily?: string;
  /** 400-700, defaults to 600. */
  fontWeight?: number;
  /** Unitless multiple of the font size, defaults to 1.3. */
  lineHeight?: number;
  /** Pixels added between characters, defaults to 0. */
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right';
  /** Pen points are local to the annotation's x/y. */
  points?: Point[];
  number?: number;
  /** Numbered step badge treatment. Older saved steps use the filled treatment. */
  stepStyle?: StepStyle;
  hidden?: boolean;
  locked?: boolean;
  /** 0-100, defaults to 100. */
  opacity?: number;
  /** Rectangle corner radius, defaults to 3. */
  radius?: number;
  /** Defaults to the annotation colour. */
  strokeColor?: string;
}

export interface CompositionStyle {
  /** Solid colour, CSS gradient, or `transparent`. */
  background: string;
  /** Space around the screenshot, in screenshot pixels. */
  padding: number;
  /** Corner radius of the background and screenshot. */
  radius: number;
  strokeColor: string;
  strokeWidth: number;
  /** Retained to read older saved documents. */
  frame: 'none' | 'browser';
}

export interface CompositionSize {
  width: number;
  height: number;
  imageX: number;
  imageY: number;
  imageWidth: number;
  imageHeight: number;
}

/**
 * The plate starts bare: no padding, no rounding, no background. A capture should
 * look like the screenshot on its own, and every one of those is the user's decision
 * to make in the Layout section.
 */
export const DEFAULT_STYLE: CompositionStyle = {
  background: 'transparent',
  padding: 0,
  radius: 0,
  strokeColor: '#1e1e1e',
  strokeWidth: 0,
  frame: 'none',
};
