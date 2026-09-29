import type { Annotation, Point } from './editor-types';
import { annotationBounds, textFrame } from './render';
import { smoothStroke } from './stroke';

export interface Box { x: number; y: number; width: number; height: number }
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export function selectionBounds(items: Annotation[]): Box | null {
  if (!items.length) return null;
  const boxes = items.map(annotationBounds);
  const x = Math.min(...boxes.map(box => box.x));
  const y = Math.min(...boxes.map(box => box.y));
  return { x, y, width: Math.max(...boxes.map(box => box.x + box.width)) - x, height: Math.max(...boxes.map(box => box.y + box.height)) - y };
}

/** Map geometry, keeping the stored path origin distinct from the ink's bounds. */
export function transformAnnotation(annotation: Annotation, from: Box, to: Box): Annotation {
  const sx = to.width / (from.width || 1);
  const sy = to.height / (from.height || 1);
  const map = (point: Point): Point => ({ x: to.x + (point.x - from.x) * sx, y: to.y + (point.y - from.y) * sy });
  if (annotation.type === 'text') {
    const next = { ...annotation, ...map(annotation), fontSize: Math.max(8, (annotation.fontSize || 28) * Math.max(sx, sy)) };
    return { ...next, ...textFrame(next) };
  }
  if (annotation.points?.length) {
    if (sx === 1 && sy === 1) return { ...annotation, ...map(annotation) };
    const box = annotationBounds(annotation);
    const mapped = map(box);
    const centre = smoothStroke(annotation.points).bounds;
    const targetWidth = box.width * sx, targetHeight = box.height * sy;
    let scaleX = centre.width ? Math.max(0, targetWidth - (box.width - centre.width)) / centre.width : 1;
    let scaleY = centre.height ? Math.max(0, targetHeight - (box.height - centre.height)) / centre.height : 1;
    let next = annotation;
    let measured = box;
    // Stroke weight stays constant during resize. Square marker caps change their
    // projected reach as the path tilts, so solve against the actual rendered bounds.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      next = { ...annotation, x: 0, y: 0, width: Math.max(1, annotation.width * scaleX), height: Math.max(1, annotation.height * scaleY),
        points: annotation.points.map(point => ({ x: point.x * scaleX, y: point.y * scaleY })) };
      measured = annotationBounds(next);
      if (Math.abs(measured.width - targetWidth) < 0.001 && Math.abs(measured.height - targetHeight) < 0.001) break;
      const paddingX = measured.width - centre.width * scaleX, paddingY = measured.height - centre.height * scaleY;
      scaleX = centre.width ? Math.max(0, targetWidth - paddingX) / centre.width : 1;
      scaleY = centre.height ? Math.max(0, targetHeight - paddingY) / centre.height : 1;
    }
    return { ...next, x: mapped.x - measured.x, y: mapped.y - measured.y };
  }
  return { ...annotation, ...map(annotation), width: annotation.width * sx, height: annotation.height * sy };
}

export function resizeBox(box: Box, handle: Handle, point: Point, proportional = false, centered = false): Box {
  const anchor = { x: centered ? box.x + box.width / 2 : handle.includes('w') ? box.x + box.width : box.x,
    y: centered ? box.y + box.height / 2 : handle.includes('n') ? box.y + box.height : box.y };
  const horizontal = handle.includes('w') || handle.includes('e');
  const vertical = handle.includes('n') || handle.includes('s');
  let width = horizontal ? Math.max(3, Math.abs(point.x - anchor.x) * (centered ? 2 : 1)) : box.width;
  let height = vertical ? Math.max(3, Math.abs(point.y - anchor.y) * (centered ? 2 : 1)) : box.height;
  if (proportional) {
    const scale = horizontal && vertical ? Math.max(width / box.width, height / box.height) : horizontal ? width / box.width : height / box.height;
    width = box.width * scale; height = box.height * scale;
  }
  return { x: centered ? anchor.x - width / 2 : horizontal ? point.x < anchor.x ? anchor.x - width : anchor.x : box.x,
    y: centered ? anchor.y - height / 2 : vertical ? point.y < anchor.y ? anchor.y - height : anchor.y : box.y, width, height };
}

export function distanceToLine(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length)) : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}
