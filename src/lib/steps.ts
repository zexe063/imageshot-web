import type { Annotation } from './editor-types';
import { parseColor } from './color';

export const DEFAULT_STEP_SIZE = 44;

export function stepNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(Number.MAX_SAFE_INTEGER - 1, Math.round(value))) : 1;
}

/** Old drafts have no sequence cursor; continue after their largest existing step. */
export function nextStepNumber(annotations: Annotation[], requested?: number): number {
  if (requested !== undefined && Number.isFinite(requested)) return stepNumber(requested);
  return annotations.reduce((next, annotation) => annotation.type === 'number' ? Math.max(next, stepNumber(annotation.number) + 1) : next, 1);
}

/** A step stays circular, including older documents with non-square stored frames. */
export function stepBounds(annotation: Annotation) {
  const diameter = Math.max(1, Math.abs(annotation.width), Math.abs(annotation.height));
  return { x: annotation.x + annotation.width / 2 - diameter / 2, y: annotation.y + annotation.height / 2 - diameter / 2, width: diameter, height: diameter };
}

/** Keep the digit legible when a light badge colour is chosen. */
export function stepTextColor(color: string): string {
  const parsed = parseColor(color);
  if (!parsed) return '#ffffff';
  const [r, g, b] = [parsed.r, parsed.g, parsed.b].map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.179 ? '#171717' : '#ffffff';
}
