import type { Annotation } from './editor-types';

const finite = (value: number | undefined, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** An absent mode belongs to documents made when this tool only pixelated. */
export function blurMode(annotation: Pick<Annotation, 'blurMode'>) {
  return annotation.blurMode === 'blur' ? 'blur' : 'pixelate';
}

export function blurAmount(annotation: Pick<Annotation, 'blurMode' | 'blurAmount' | 'strokeWidth'>) {
  const blurred = blurMode(annotation) === 'blur';
  return clamp(finite(annotation.blurAmount, blurred ? 12 : Math.max(10, finite(annotation.strokeWidth, 4) * 4)), blurred ? 1 : 2, blurred ? 60 : 240);
}

interface EffectBitmap { image: HTMLImageElement; source: string; key: string; canvas: HTMLCanvasElement }
const blurBitmaps = new WeakMap<Annotation, EffectBitmap>();
const MAX_BLUR_SIDE = 16_384;
const MAX_BLUR_PIXELS = 8_000_000;

/** Extend the nearest edge pixel when a blur reaches beyond the screenshot. */
function sampleAxis(start: number, length: number, limit: number) {
  const segments: { source: number; sourceSize: number; target: number; size: number }[] = [];
  const before = Math.min(length, Math.max(0, -start));
  const after = Math.min(length, Math.max(0, start + length - limit));
  const middle = length - before - after;
  if (before > 0) segments.push({ source: 0, sourceSize: 1, target: 0, size: before });
  if (middle > 0) segments.push({ source: Math.max(0, start), sourceSize: middle, target: before, size: middle });
  if (after > 0) segments.push({ source: limit - 1, sourceSize: 1, target: length - after, size: after });
  return segments;
}

/** Filters original pixels once, so zoom and export scale never change the strength. */
export function drawBlur(ctx: CanvasRenderingContext2D, annotation: Annotation, image: HTMLImageElement) {
  const imageWidth = image.naturalWidth || image.width, imageHeight = image.naturalHeight || image.height;
  const left = Math.min(annotation.x, annotation.x + annotation.width), top = Math.min(annotation.y, annotation.y + annotation.height);
  const x = Math.max(0, left), y = Math.max(0, top);
  const width = Math.min(imageWidth, left + Math.abs(annotation.width)) - x;
  const height = Math.min(imageHeight, top + Math.abs(annotation.height)) - y;
  if (width <= 0 || height <= 0) return;
  const mode = blurMode(annotation), amount = blurAmount(annotation);
  const source = image.currentSrc || image.src;
  const key = `${x},${y},${width},${height},${mode},${amount}`;
  let cached = blurBitmaps.get(annotation);
  if (!cached || cached.image !== image || cached.source !== source || cached.key !== key) {
    const canvas = document.createElement('canvas');
    if (mode === 'pixelate') {
      canvas.width = Math.max(1, Math.ceil(width / amount));
      canvas.height = Math.max(1, Math.ceil(height / amount));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    } else {
      // Include neighbouring screenshot pixels before filtering; clipping first would
      // produce a dark/transparent halo around the selected area.
      const nativePadding = Math.ceil(amount * 3);
      const paddedWidth = Math.ceil(width) + nativePadding * 2, paddedHeight = Math.ceil(height) + nativePadding * 2;
      // A maximum-length screenshot still needs neighbouring pixels. Bound the
      // working bitmap and scale its radius together so padding cannot push it
      // beyond browser canvas limits or allocate several full-size screenshots.
      const samplingScale = Math.min(1, MAX_BLUR_SIDE / Math.max(paddedWidth, paddedHeight), Math.sqrt(MAX_BLUR_PIXELS / (paddedWidth * paddedHeight)));
      const padding = Math.ceil(amount * samplingScale * 3);
      canvas.width = Math.max(1, Math.ceil(width * samplingScale)); canvas.height = Math.max(1, Math.ceil(height * samplingScale));
      const sample = document.createElement('canvas');
      sample.width = canvas.width + padding * 2; sample.height = canvas.height + padding * 2;
      const sampleContext = sample.getContext('2d'), context = canvas.getContext('2d');
      if (!sampleContext || !context) return;
      sampleContext.imageSmoothingEnabled = samplingScale < 1;
      sampleContext.imageSmoothingQuality = 'high';
      sampleContext.scale(samplingScale, samplingScale);
      for (const horizontal of sampleAxis(x - padding / samplingScale, sample.width / samplingScale, imageWidth)) {
        for (const vertical of sampleAxis(y - padding / samplingScale, sample.height / samplingScale, imageHeight)) {
          sampleContext.drawImage(image, horizontal.source, vertical.source, horizontal.sourceSize, vertical.sourceSize, horizontal.target, vertical.target, horizontal.size, vertical.size);
        }
      }
      context.filter = `blur(${amount * samplingScale}px)`;
      context.drawImage(sample, -padding, -padding);
    }
    cached = { image, source, key, canvas };
    blurBitmaps.set(annotation, cached);
  }
  ctx.save();
  ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
  ctx.imageSmoothingEnabled = mode === 'blur';
  ctx.drawImage(cached.canvas, 0, 0, cached.canvas.width, cached.canvas.height, x, y, width, height);
  ctx.restore();
}

/** All openings share one shade, so a second spotlight cannot darken the first. */
export function drawSpotlights(ctx: CanvasRenderingContext2D, annotations: Annotation[], width: number, height: number) {
  const visible = annotations.filter(annotation => annotation.type === 'spotlight' && !annotation.hidden && finite(annotation.opacity, 100) > 0 && finite(annotation.spotlightDim, 65) > 0 && annotation.width && annotation.height);
  if (!visible.length) return;
  ctx.save();
  for (const annotation of visible) {
    const x = Math.min(annotation.x, annotation.x + annotation.width), y = Math.min(annotation.y, annotation.y + annotation.height);
    const w = Math.abs(annotation.width), h = Math.abs(annotation.height);
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    if (annotation.spotlightShape === 'ellipse') {
      ctx.moveTo(x + w, y + h / 2);
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else ctx.rect(x, y, w, h);
    ctx.clip('evenodd');
  }
  ctx.globalAlpha *= Math.max(...visible.map(annotation => clamp(finite(annotation.spotlightDim, 65), 0, 100) / 100 * clamp(finite(annotation.opacity, 100), 0, 100) / 100));
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}
