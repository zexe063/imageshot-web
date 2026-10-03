import type { Point } from './editor-types';

export interface TextRow {
  top: number;
  bottom: number;
  centerY: number;
  /** Marker thickness, including a little breathing room around the glyphs. */
  height: number;
  confidence: number;
}

interface Pixels { width: number; height: number; data: Uint8ClampedArray }

/**
 * Find a nearby text row on a mostly uniform background. Projection profiles give
 * us the glyph height; separated column runs distinguish letters from solid boxes
 * and horizontal rules. Ambiguous pictures intentionally keep the manual width.
 * The input is a small screenshot tile, never a full scrolling capture.
 */
export function detectTextRow(pixels: Pixels, pointerY: number, maxDistance = 24): TextRow | null {
  const { width, height, data } = pixels;
  if (width < 8 || height < 8 || data.length < width * height * 4) return null;
  const luminance = new Uint8Array(width * height), histogram = new Uint32Array(16);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4, alpha = data[offset + 3] / 255;
    const value = Math.round((data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722) * alpha + 255 * (1 - alpha));
    luminance[index] = value; histogram[Math.min(15, value >> 4)] += 1;
  }
  let backgroundBin = 0;
  for (let index = 1; index < histogram.length; index += 1) if (histogram[index] > histogram[backgroundBin]) backgroundBin = index;
  const backgroundShare = histogram[backgroundBin] / luminance.length;
  if (backgroundShare < 0.4) return null;
  const background = backgroundBin * 16 + 7.5;
  const ink = new Uint8Array(luminance.length), rows = new Uint16Array(height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = y * width + x;
    if (Math.abs(luminance[index] - background) >= 42) { ink[index] = 1; rows[y] += 1; }
  }
  const minimumInk = Math.max(2, Math.min(8, Math.round(width * 0.018)));
  const bands: { top: number; bottom: number }[] = [];
  let top = -1, bottom = -1;
  for (let y = 0; y <= height; y += 1) {
    if (y < height && rows[y] >= minimumInk) { if (top < 0) top = y; bottom = y + 1; }
    else if (top >= 0 && (y === height || y - bottom >= 2)) { bands.push({ top, bottom }); top = -1; }
  }
  let best: TextRow | null = null, bestScore = -Infinity;
  for (const band of bands) {
    const glyphHeight = band.bottom - band.top;
    // A cut-off row cannot supply a trustworthy text size.
    if (glyphHeight < 4 || glyphHeight > 80 || band.top === 0 || band.bottom === height) continue;
    const centerY = (band.top + band.bottom) / 2;
    const distance = Math.abs(centerY - pointerY);
    if (distance > Math.max(maxDistance, glyphHeight * 0.65)) continue;
    const columns: number[] = [];
    let run = 0, totalInk = 0;
    for (let x = 0; x <= width; x += 1) {
      let count = 0;
      if (x < width) for (let y = band.top; y < band.bottom; y += 1) count += ink[y * width + x];
      totalInk += count;
      if (count) run += 1;
      else if (run) { columns.push(run); run = 0; }
    }
    const inkWidth = columns.reduce((sum, length) => sum + length, 0);
    const density = totalInk / Math.max(1, inkWidth * glyphHeight);
    if (columns.length < 3 || Math.max(...columns) > glyphHeight * 3 || density < 0.08 || density > 0.82) continue;
    const confidence = Math.min(1, backgroundShare * 0.45 + Math.min(8, columns.length) / 8 * 0.4 + 0.15);
    const score = confidence - distance / Math.max(12, glyphHeight * 1.8);
    if (score <= bestScore) continue;
    const padding = Math.max(2, Math.round(glyphHeight * 0.16));
    bestScore = score;
    best = { ...band, centerY, height: glyphHeight + padding * 2, confidence };
  }
  return best;
}

/** Reuses one bounded tile canvas; all analysis stays in this browser. */
export function createTextRowDetector(image: HTMLImageElement) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
  return (start: Point, end: Point, fallbackHeight: number): TextRow | null => {
    if (!context) return null;
    const width = Math.min(imageWidth, 640, Math.max(120, Math.abs(end.x - start.x) + 48));
    const height = Math.min(imageHeight, Math.max(96, Math.min(200, fallbackHeight * 5)));
    const x = Math.max(0, Math.min(imageWidth - width, (start.x + end.x) / 2 - width / 2));
    const y = Math.max(0, Math.min(imageHeight - height, start.y - height / 2));
    canvas.width = Math.ceil(width); canvas.height = Math.ceil(height);
    try {
      context.drawImage(image, Math.floor(x), Math.floor(y), canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const row = detectTextRow(context.getImageData(0, 0, canvas.width, canvas.height), start.y - Math.floor(y), Math.max(12, Math.min(32, fallbackHeight)));
      return row ? { ...row, top: row.top + Math.floor(y), bottom: row.bottom + Math.floor(y), centerY: row.centerY + Math.floor(y) } : null;
    } catch {
      // Cross-origin or otherwise unreadable images still support manual marking.
      return null;
    }
  };
}
