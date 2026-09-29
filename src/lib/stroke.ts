import type { Point } from './editor-types';

interface Segment { from: Point; to: Point; control?: Point }
interface StrokeGeometry {
  start: Point;
  segments: Segment[];
  path: Point[];
  bounds: { x: number; y: number; width: number; height: number };
}

// Committed layers keep the same points array while moving or changing colour.
const geometryCache = new WeakMap<Point[], StrokeGeometry>();
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Smooth without overshooting the samples; flatten the same curves for picking. */
export function smoothStroke(samples: Point[]): StrokeGeometry {
  const cached = geometryCache.get(samples);
  if (cached) return cached;
  const points = samples.filter((point, index) => Number.isFinite(point.x) && Number.isFinite(point.y)
    && (index === 0 || point.x !== samples[index - 1].x || point.y !== samples[index - 1].y));
  const start = points[0] || { x: 0, y: 0 };
  const segments: Segment[] = [];
  let previous = start;
  for (let index = 1; index < points.length - 1; index += 1) {
    const to = midpoint(points[index], points[index + 1]);
    segments.push({ from: previous, control: points[index], to });
    previous = to;
  }
  if (points.length > 1) segments.push({ from: previous, to: points[points.length - 1] });

  const path = [start];
  let minX = start.x, maxX = start.x, minY = start.y, maxY = start.y;
  const include = (point: Point) => {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  };
  const flatten = (from: Point, control: Point, to: Point, depth = 0) => {
    // Distance of the control point to the chord, including folded-back curves.
    const dx = to.x - from.x, dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.max(0, Math.min(1, ((control.x - from.x) * dx + (control.y - from.y) * dy) / lengthSquared)) : 0;
    if (depth >= 10 || Math.hypot(control.x - from.x - t * dx, control.y - from.y - t * dy) <= 0.3) {
      path.push(to);
      return;
    }
    const left = midpoint(from, control), right = midpoint(control, to), centre = midpoint(left, right);
    flatten(from, left, centre, depth + 1);
    flatten(centre, right, to, depth + 1);
  };
  for (const segment of segments) {
    include(segment.to);
    const { from, control, to } = segment;
    if (!control) { path.push(to); continue; }
    // A quadratic's extrema need not pass through a pointer sample.
    for (const axis of ['x', 'y'] as const) {
      const denominator = from[axis] - 2 * control[axis] + to[axis];
      const t = denominator ? (from[axis] - control[axis]) / denominator : -1;
      if (t > 0 && t < 1) {
        const inverse = 1 - t;
        include({ x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
          y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y });
      }
    }
    flatten(from, control, to);
  }
  const geometry = { start, segments, path, bounds: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } };
  geometryCache.set(samples, geometry);
  return geometry;
}

/** One native stroke operation gives translucent crossings uniform coverage. */
export function traceStroke(ctx: CanvasRenderingContext2D, points: Point[], x: number, y: number) {
  const geometry = smoothStroke(points);
  ctx.beginPath();
  ctx.moveTo(x + geometry.start.x, y + geometry.start.y);
  for (const segment of geometry.segments) {
    if (segment.control) ctx.quadraticCurveTo(x + segment.control.x, y + segment.control.y, x + segment.to.x, y + segment.to.y);
    else ctx.lineTo(x + segment.to.x, y + segment.to.y);
  }
}
