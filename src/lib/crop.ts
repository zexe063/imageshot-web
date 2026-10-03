import type { Annotation, Point } from './editor-types';
import { annotationBounds } from './render';
import type { Box, Handle } from './selection';

export const MIN_CROP_SIZE = 8;

export function clampCropBox(box: Box, imageWidth: number, imageHeight: number): Box {
  const x = Math.max(0, Math.min(imageWidth, Math.min(box.x, box.x + box.width)));
  const y = Math.max(0, Math.min(imageHeight, Math.min(box.y, box.y + box.height)));
  const right = Math.max(x, Math.min(imageWidth, Math.max(box.x, box.x + box.width)));
  const bottom = Math.max(y, Math.min(imageHeight, Math.max(box.y, box.y + box.height)));
  return { x, y, width: right - x, height: bottom - y };
}

/** Round both edges, so raster bounds and rebased layer origins agree exactly. */
export function cropPixelBounds(box: Box, imageWidth: number, imageHeight: number): Box {
  const bounded = clampCropBox(box, imageWidth, imageHeight);
  const x = Math.floor(bounded.x), y = Math.floor(bounded.y);
  return { x, y, width: Math.min(imageWidth, Math.ceil(bounded.x + bounded.width)) - x, height: Math.min(imageHeight, Math.ceil(bounded.y + bounded.height)) - y };
}

export function moveCropBox(box: Box, dx: number, dy: number, imageWidth: number, imageHeight: number): Box {
  return { ...box, x: Math.max(0, Math.min(imageWidth - box.width, box.x + dx)), y: Math.max(0, Math.min(imageHeight - box.height, box.y + dy)) };
}

/** Keep the opposite edge anchored and allow crossing it when adjusting corners. */
export function resizeCropBox(box: Box, handle: Handle, point: Point, imageWidth: number, imageHeight: number): Box {
  const x = Math.max(0, Math.min(imageWidth, point.x)), y = Math.max(0, Math.min(imageHeight, point.y));
  const left = handle.includes('w') ? x : box.x, right = handle.includes('e') ? x : box.x + box.width;
  const top = handle.includes('n') ? y : box.y, bottom = handle.includes('s') ? y : box.y + box.height;
  return clampCropBox({ x: left, y: top, width: right - left, height: bottom - top }, imageWidth, imageHeight);
}

/** Local path points stay intact; only the screenshot-space origin changes. */
export function cropAnnotations(annotations: Annotation[], box: Box): Annotation[] {
  return annotations.filter(annotation => {
    const bounds = annotationBounds(annotation);
    // Spotlight darkens outside its focus area, including when that area is cropped away.
    return annotation.type === 'spotlight' || (bounds.x + bounds.width > box.x && bounds.x < box.x + box.width && bounds.y + bounds.height > box.y && bounds.y < box.y + box.height);
  }).map(annotation => ({ ...annotation, x: annotation.x - box.x, y: annotation.y - box.y }));
}
