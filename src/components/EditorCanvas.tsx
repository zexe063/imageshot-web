import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import type { Annotation, ArrowDefaults, CompositionStyle, Point, Tool } from '../lib/editor-types';
import { annotationBounds, arrowBendPoint, arrowCurveAt, arrowGeometry, getCompositionSize, markerWidth, renderComposition, strokePath, textFrame } from '../lib/render';
import { distanceToLine, resizeBox, selectionBounds, transformAnnotation } from '../lib/selection';
import type { Box, Handle } from '../lib/selection';
import InlineTextEditor from './InlineTextEditor';

export interface EditorCanvasProps {
  image: HTMLImageElement | null;
  annotations: Annotation[];
  onChange: (annotations: Annotation[]) => void;
  selectedId: string | null;
  selectedIds?: string[];
  onSelect: (id: string | null) => void;
  onSelectionChange?: (ids: string[]) => void;
  tool: Tool;
  color: string;
  strokeWidth: number;
  arrow: ArrowDefaults;
  onArrowChange?: (patch: Partial<Annotation>) => void;
  textSize: number;
  textStyle?: Partial<Annotation>;
  style: CompositionStyle;
  zoom: number;
  onToolChange?: (tool: Tool) => void;
  onCrop?: (dataUrl: string, annotations: Annotation[]) => void;
  onStatus?: (message: string) => void;
  loadingMessage?: string;
  onZoomChange?: (actualZoom: number) => void;
}
interface Gesture {
  mode: 'draw' | 'move' | 'resize' | 'bend' | 'endpoint' | 'crop' | 'marquee';
  pointerId: number; start: Point; rect: DOMRect; scale: number;
  base: Annotation[]; bounds?: Box; handle?: Handle; endpoint?: 'tail' | 'tip';
  points?: Point[]; anchor?: Point; snapped?: boolean;
  initialSelection: string[]; freehand?: boolean; moved?: boolean;
}
interface TextEditor { annotation: Annotation; value: string; isNew: boolean }
interface Guide { from: Point; to: Point }
const ACCENT = '#6244e0';
const CANVAS_INSET = 48;

function contains(a: Annotation, point: Point, tolerance: number) {
  if (a.hidden || a.locked) return false;
  if (a.type === 'arrow' || (a.points?.length && ['pen', 'highlight'].includes(a.type))) {
    const path = a.type === 'arrow' ? arrowGeometry(a).path : strokePath(a);
    const reach = Math.max(tolerance, a.type === 'highlight' ? markerWidth(a) / 2 : a.strokeWidth / 2);
    return path.some((p, i) => distanceToLine(point, path[Math.max(0, i - 1)], p) <= reach);
  }
  const b = annotationBounds(a);
  if (a.type === 'ellipse') return ((point.x - b.x - b.width / 2) / (b.width / 2 + tolerance)) ** 2 + ((point.y - b.y - b.height / 2) / (b.height / 2 + tolerance)) ** 2 <= 1;
  return point.x >= b.x - tolerance && point.x <= b.x + b.width + tolerance && point.y >= b.y - tolerance && point.y <= b.y + b.height + tolerance;
}
function tracedAnnotation(base: Annotation, points: Point[]): Annotation {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { ...base, x: minX, y: minY, width: maxX - minX, height: maxY - minY, points: points.map(p => ({ x: p.x - minX, y: p.y - minY })) };
}
function snapAngle(start: Point, point: Point): Point {
  const angle = Math.round(Math.atan2(point.y - start.y, point.x - start.x) / (Math.PI / 4)) * Math.PI / 4;
  const length = Math.hypot(point.x - start.x, point.y - start.y);
  return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length };
}

export function EditorCanvas({ image, annotations, onChange, selectedId, selectedIds, onSelect, onSelectionChange, tool, color, strokeWidth, arrow, onArrowChange, textSize, textStyle, style, zoom, onToolChange, onCrop, onStatus, loadingMessage, onZoomChange }: EditorCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null), artboardRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<Gesture | null>(null), draftsRef = useRef<Annotation[]>([]), draftFrame = useRef(0), textEditorRef = useRef<TextEditor | null>(null);
  const [viewport, setViewport] = useState({ width: 1000, height: 700 });
  const [drafts, setDraftState] = useState<Annotation[]>([]);
  const [crop, setCrop] = useState<Box | null>(null), [marquee, setMarquee] = useState<Box | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null), [textEditor, setTextEditorState] = useState<TextEditor | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const ids = selectedIds ?? (selectedId ? [selectedId] : []);
  const selectIds = (next: string[]) => onSelectionChange ? onSelectionChange(next) : onSelect(next.at(-1) ?? null);
  const setDrafts = (next: Annotation[], immediate = false) => {
    draftsRef.current = next;
    if (immediate) { cancelAnimationFrame(draftFrame.current); draftFrame.current = 0; setDraftState(next); }
    else if (!draftFrame.current) draftFrame.current = requestAnimationFrame(() => { draftFrame.current = 0; setDraftState(draftsRef.current); });
  };
  const setTextEditor = (next: TextEditor | null) => { textEditorRef.current = next; setTextEditorState(next); };
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { const width = Math.round(rect.width), height = Math.round(rect.height); setViewport(c => c.width === width && c.height === height ? c : { width, height }); });
    });
    observer.observe(element);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); cancelAnimationFrame(draftFrame.current); };
  }, []);
  const size = useMemo(() => image ? getCompositionSize(image, style) : null, [image, style]);
  const fit = size ? Math.min(1, Math.max(80, viewport.width - CANVAS_INSET * 2 - 17) / size.width, size.height > size.width * 2 ? 1 : Math.max(80, viewport.height - CANVAS_INSET * 2 - 17) / size.height) : 1;
  const displayScale = fit * Math.max(0.1, zoom);
  useEffect(() => { onZoomChange?.(displayScale); }, [displayScale, onZoomChange]);
  const visibleAnnotations = useMemo(() => {
    const replacements = new Map(drafts.map(a => [a.id, a]));
    return [...annotations.filter(a => a.id !== textEditor?.annotation.id).map(a => replacements.get(a.id) || a), ...drafts.filter(a => !annotations.some(old => old.id === a.id))];
  }, [annotations, drafts, textEditor?.annotation.id]);
  useEffect(() => {
    if (!image || !size || !canvasRef.current) return;
    const scale = Math.min(1, displayScale * Math.min(window.devicePixelRatio || 1, 2), 16000 / Math.max(size.width, size.height), Math.sqrt(12000000 / (size.width * size.height)));
    // Drafts are already frame-coalesced. A second RAF would delay visible ink.
    renderComposition(image, visibleAnnotations, style, scale, canvasRef.current);
  }, [image, visibleAnnotations, style, displayScale, size]);
  const cancelGesture = () => {
    const gesture = gestureRef.current; gestureRef.current = null;
    if (gesture && artboardRef.current?.hasPointerCapture(gesture.pointerId)) artboardRef.current.releasePointerCapture(gesture.pointerId);
    setDrafts([], true); setCrop(null); setMarquee(null); setGuides([]);
    if (gesture) selectIds(gesture.initialSelection);
  };
  useEffect(() => { gestureRef.current = null; setDrafts([], true); setCrop(null); setMarquee(null); setTextEditor(null); setGuides([]); }, [image]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && gestureRef.current) { event.preventDefault(); event.stopImmediatePropagation(); cancelGesture(); } };
    window.addEventListener('keydown', onKey, true); return () => window.removeEventListener('keydown', onKey, true);
  });
  useEffect(() => { if (gestureRef.current) cancelGesture(); setHoveredId(null); }, [tool]);
  const coordinates = (event: { clientX: number; clientY: number }, clamp = false): Point => {
    const gesture = gestureRef.current, rect = gesture?.rect ?? artboardRef.current!.getBoundingClientRect(), scale = gesture?.scale ?? displayScale;
    const x = (event.clientX - rect.left) / scale - (size?.imageX || 0), y = (event.clientY - rect.top) / scale - (size?.imageY || 0);
    return clamp && size ? { x: Math.max(0, Math.min(size.imageWidth, x)), y: Math.max(0, Math.min(size.imageHeight, y)) } : { x, y };
  };
  const commitText = (value?: string) => {
    const editor = textEditorRef.current;
    if (!editor) return;
    if (value !== undefined) editor.value = value;
    setTextEditor(null);
    if (!editor.value.trim()) { if (!editor.isNew) onChange(annotations.filter(a => a.id !== editor.annotation.id)); onSelect(null); return; }
    const annotation = { ...editor.annotation, text: editor.value, ...textFrame({ ...editor.annotation, text: editor.value }) };
    if (editor.isNew || annotation.text !== editor.annotation.text) onChange(editor.isNew ? [...annotations, annotation] : annotations.map(a => a.id === annotation.id ? annotation : a));
    onSelect(annotation.id); onToolChange?.('select');
  };
  useEffect(() => {
    const editor = textEditorRef.current;
    if (!editor) return;
    const source = editor.isNew ? { ...editor.annotation, color: textStyle?.color ?? '#000000', fontSize: textSize,
      fontFamily: textStyle?.fontFamily, fontWeight: textStyle?.fontWeight, lineHeight: textStyle?.lineHeight,
      letterSpacing: textStyle?.letterSpacing, align: textStyle?.align } : annotations.find(a => a.id === editor.annotation.id);
    const keys: (keyof Annotation)[] = ['color', 'fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'align', 'opacity', 'x', 'y'];
    if (source && keys.some(key => source[key] !== editor.annotation[key])) setTextEditor({ ...editor, annotation: source });
  }, [annotations, textStyle, textSize]);
  useEffect(() => {
    const edit = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || textEditorRef.current || gestureRef.current || (event.target as HTMLElement)?.closest('input,textarea,select,[contenteditable="true"]')) return;
      const target = annotations.find(a => a.id === selectedId && a.type === 'text' && !a.hidden && !a.locked);
      if (target) { event.preventDefault(); setTextEditor({ annotation: target, value: target.text || '', isNew: false }); }
    };
    window.addEventListener('keydown', edit);
    return () => window.removeEventListener('keydown', edit);
  }, [annotations, selectedId]);
  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!image || !size || event.button !== 0 || textEditorRef.current || gestureRef.current) return;
    const point = coordinates(event), target = event.target as Element;
    const selected = annotations.filter(a => ids.includes(a.id) && !a.hidden && !a.locked);
    const start = (mode: Gesture['mode'], base: Annotation[] = [], extra: Partial<Gesture> = {}) => {
      event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setHoveredId(null);
      gestureRef.current = { mode, pointerId: event.pointerId, start: point, rect: event.currentTarget.getBoundingClientRect(), scale: displayScale, base, initialSelection: [...ids], ...extra };
    };
    const handle = target.getAttribute('data-handle') as Handle | null, endpoint = target.getAttribute('data-endpoint') as 'tail' | 'tip' | null;
    if (handle && selected.length && !selected.some(a => a.type === 'highlight')) { start('resize', selected, { handle, bounds: selectionBounds(selected)! }); setDrafts(selected); return; }
    if (endpoint && selected.length === 1 && selected[0].type === 'arrow') { start('endpoint', selected, { endpoint }); setDrafts(selected); return; }
    if (target.hasAttribute('data-bend') && selected.length === 1 && selected[0].type === 'arrow') { start('bend', selected); setDrafts(selected); return; }
    if (point.x < 0 || point.y < 0 || point.x > size.imageWidth || point.y > size.imageHeight) { onSelect(null); return; }
    if (tool === 'select') {
      const hit = [...annotations].reverse().find(a => contains(a, point, 5 / displayScale)), additive = event.shiftKey || event.metaKey || event.ctrlKey;
      if (hit) {
        const next = additive ? ids.includes(hit.id) ? ids.filter(id => id !== hit.id) : [...ids, hit.id] : ids.includes(hit.id) ? ids : [hit.id];
        selectIds(next); if (!next.includes(hit.id)) return;
        const base = annotations.filter(a => next.includes(a.id) && !a.locked && !a.hidden);
        start('move', base, { bounds: selectionBounds(base)! }); setDrafts(base);
      } else {
        start('marquee', [], { initialSelection: additive ? [...ids] : [] }); if (!additive) selectIds([]); setMarquee({ ...point, width: 0, height: 0 });
      }
      return;
    }
    if (tool === 'crop') { if (!onCrop) { onStatus?.('Cropping is unavailable for this image.'); return; } start('crop'); onSelect(null); setCrop({ ...point, width: 0, height: 0 }); return; }
    const annotation: Annotation = { id: crypto.randomUUID(), type: tool, x: point.x, y: point.y, width: 0, height: 0, color, strokeWidth };
    if (tool === 'arrow') Object.assign(annotation, arrow);
    if (tool === 'text') {
      event.preventDefault();
      Object.assign(annotation, { color: textStyle?.color ?? '#000000', fontSize: textSize, fontFamily: textStyle?.fontFamily, fontWeight: textStyle?.fontWeight, lineHeight: textStyle?.lineHeight, letterSpacing: textStyle?.letterSpacing, align: textStyle?.align });
      Object.assign(annotation, textFrame(annotation)); setTextEditor({ annotation, value: '', isNew: true }); onSelect(null); return;
    }
    if (tool === 'number') {
      const diameter = Math.max(36, textSize * 1.4);
      Object.assign(annotation, { x: point.x - diameter / 2, y: point.y - diameter / 2, width: diameter, height: diameter, number: 1 + Math.max(0, ...annotations.filter(a => a.type === 'number').map(a => a.number || 0)) });
      onChange([...annotations, annotation]); onSelect(annotation.id); return;
    }
    const traced = tool === 'pen' || tool === 'highlight';
    if (traced) annotation.points = [{ x: 0, y: 0 }];
    start('draw', [annotation], { points: traced ? [point] : undefined, freehand: event.altKey }); setDrafts([annotation]); onSelect(annotation.id);
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (!size) return;
    if (!gesture) { if (tool === 'select' && !textEditor) setHoveredId([...annotations].reverse().find(a => contains(a, coordinates(event), 5 / displayScale))?.id ?? null); return; }
    if (event.pointerId !== gesture.pointerId) return;
    const point = coordinates(event, gesture.mode === 'draw' || gesture.mode === 'crop'), dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
    gesture.moved ||= Math.hypot(dx, dy) * gesture.scale > 2;
    setGuides([]);
    if (gesture.mode === 'marquee' || gesture.mode === 'crop') {
      const box = { x: Math.min(gesture.start.x, point.x), y: Math.min(gesture.start.y, point.y), width: Math.abs(dx), height: Math.abs(dy) };
      if (gesture.mode === 'crop') setCrop(box);
      else { setMarquee(box); const hits = gesture.moved ? annotations.filter(a => { if (a.hidden || a.locked) return false; const b = annotationBounds(a); return b.x >= box.x && b.y >= box.y && b.x + b.width <= box.x + box.width && b.y + b.height <= box.y + box.height; }).map(a => a.id) : []; selectIds([...new Set([...gesture.initialSelection, ...hits])]); }
      return;
    }
    const base = gesture.base[0]; if (!base) return;
    if (gesture.mode === 'move' && gesture.bounds) {
      if (!gesture.moved) return;
      let mx = dx, my = dy;
      if (event.shiftKey) { if (Math.abs(dx) >= Math.abs(dy)) my = 0; else mx = 0; }
      const box = gesture.bounds, guides: Guide[] = [];
      if (!event.altKey) {
        const others = [{ x: 0, y: 0, width: size.imageWidth, height: size.imageHeight }, ...annotations.filter(a => !a.hidden && !gesture.base.some(b => b.id === a.id)).map(annotationBounds)];
        for (const axis of ['x', 'y'] as const) {
          if (event.shiftKey && ((axis === 'x' && mx === 0) || (axis === 'y' && my === 0))) continue;
          const length = axis === 'x' ? 'width' : 'height', origin = box[axis] + (axis === 'x' ? mx : my);
          let best = 5 / gesture.scale, offset = 0, at: number | null = null;
          for (const other of others) for (const target of [other[axis], other[axis] + other[length] / 2, other[axis] + other[length]]) for (const edge of [origin, origin + box[length] / 2, origin + box[length]]) {
            const delta = target - edge; if (Math.abs(delta) < best) { best = Math.abs(delta); offset = delta; at = target; }
          }
          if (axis === 'x') mx += offset; else my += offset;
          if (at !== null) guides.push(axis === 'x' ? { from: { x: at, y: 0 }, to: { x: at, y: size.imageHeight } } : { from: { x: 0, y: at }, to: { x: size.imageWidth, y: at } });
        }
      }
      setGuides(guides); setDrafts(gesture.base.map(a => ({ ...a, x: a.x + mx, y: a.y + my })));
    } else if (gesture.mode === 'resize' && gesture.handle && gesture.bounds) {
      const next = resizeBox(gesture.bounds, gesture.handle, point, event.shiftKey || gesture.base.some(a => a.type === 'text'), event.altKey);
      setDrafts(gesture.base.map(a => transformAnnotation(a, gesture.bounds!, next)));
    } else if (gesture.mode === 'bend') {
      if (!gesture.moved) return;
      // Dragging the middle handle off the chord bows the line, exactly as CleanShot
      // does. A bow too small to see is a straight line again.
      const curve = arrowCurveAt({ ...base, arrowStyle: 'curved' }, point);
      setDrafts([{ ...base, arrowStyle: Math.abs(curve) < 0.02 ? 'straight' : 'curved', curve }]);
    } else if (gesture.mode === 'endpoint') {
      const fixed = gesture.endpoint === 'tail' ? { x: base.x + base.width, y: base.y + base.height } : { x: base.x, y: base.y }, tip = event.shiftKey ? snapAngle(fixed, point) : point;
      setDrafts([gesture.endpoint === 'tail' ? { ...base, x: tip.x, y: tip.y, width: fixed.x - tip.x, height: fixed.y - tip.y } : { ...base, width: tip.x - base.x, height: tip.y - base.y }]);
    } else if (base.type === 'pen' || base.type === 'highlight') {
      const points = gesture.points!;
      if (event.shiftKey) {
        if (!gesture.anchor) { gesture.anchor = points.at(-1)!; gesture.snapped = false; }
        const tip = snapAngle(gesture.anchor, point);
        if (gesture.snapped) points[points.length - 1] = tip; else { points.push(tip); gesture.snapped = true; }
        setGuides([{ from: gesture.anchor, to: tip }]); setDrafts([tracedAnnotation(base, points)]); return;
      }
      gesture.anchor = undefined; gesture.snapped = false; gesture.freehand ||= event.altKey;
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) { const next = coordinates(sample, true), last = points.at(-1)!; if (Math.hypot(next.x - last.x, next.y - last.y) >= 0.6 / gesture.scale) points.push(next); }
      // Keep raw samples: Alt or leaving the row instantly restores freehand ink.
      const row = base.type === 'highlight' && !gesture.freehand && Math.abs(dx) * gesture.scale >= 12 && Math.abs(dy) <= Math.max(6 / gesture.scale, Math.abs(dx) * 0.22) && points.every(p => Math.abs(p.y - gesture.start.y) <= Math.max(8 / gesture.scale, Math.abs(dx) * 0.24));
      const path = row ? [gesture.start, { x: point.x, y: gesture.start.y }] : points;
      if (row) setGuides([{ from: gesture.start, to: path[1] }]);
      setDrafts([tracedAnnotation(base, path)]);
    } else {
      let width = dx, height = dy;
      // Figma-style: Shift = square/circle, Alt = draw from center
      const isShape = ['rectangle', 'ellipse'].includes(base.type);
      if (isShape && event.shiftKey) { const side = Math.max(Math.abs(dx), Math.abs(dy)); width = side * (dx < 0 ? -1 : 1); height = side * (dy < 0 ? -1 : 1); }
      if (event.altKey && isShape) {
        const ax = gesture.start.x - width, ay = gesture.start.y - height;
        setDrafts([{ ...base, x: ax, y: ay, width: width * 2, height: height * 2 }]);
        return;
      }
      if (event.shiftKey && base.type === 'arrow') { const tip = snapAngle(gesture.start, point); width = tip.x - base.x; height = tip.y - base.y; }
      setDrafts([{ ...base, width, height }]);
    }
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current; if (!gesture || gesture.pointerId !== event.pointerId) return;
    pointerMove(event); // Preserve the release position even if the last move was coalesced.
    const end = coordinates(event, gesture.mode === 'crop'); gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGuides([]); setMarquee(null); if (gesture.mode === 'marquee') return;
    if (gesture.mode === 'crop' && image && size) {
      const x = Math.floor(Math.min(gesture.start.x, end.x)), y = Math.floor(Math.min(gesture.start.y, end.y)), width = Math.floor(Math.abs(end.x - gesture.start.x)), height = Math.floor(Math.abs(end.y - gesture.start.y));
      setCrop(null); if (width < 8 || height < 8) return;
      const cropped = document.createElement('canvas'); cropped.width = width; cropped.height = height;
      const context = cropped.getContext('2d'); if (!context) { onStatus?.('Could not crop this image. Please try again.'); return; }
      context.drawImage(image, x, y, width, height, 0, 0, width, height);
      const retained = annotations.filter(a => { const b = annotationBounds(a); return b.x + b.width > x && b.x < x + width && b.y + b.height > y && b.y < y + height; }).map(a => ({ ...a, x: a.x - x, y: a.y - y }));
      onCrop?.(cropped.toDataURL('image/png'), retained); onSelect(null); onToolChange?.('select'); return;
    }
    const completed = draftsRef.current; setDrafts([], true);
    if (!completed.length || (gesture.mode !== 'draw' && !gesture.moved)) return;
    if (gesture.mode === 'draw' && !['pen', 'highlight'].includes(completed[0].type) && Math.hypot(completed[0].width, completed[0].height) < 4 / gesture.scale) { onSelect(null); return; }
    // Stroke bounds include ink thickness; copying them into x/y shifts every point.
    const normalized = completed.map(a => ['rectangle', 'ellipse', 'blur'].includes(a.type) ? { ...a, ...annotationBounds(a) } : a), replacements = new Map(normalized.map(a => [a.id, a]));
    onChange(gesture.mode === 'draw' ? [...annotations, ...normalized] : annotations.map(a => replacements.get(a.id) || a));
    // Professional behaviour (Figma / CleanShot): after placing a shape/arrow, return to Select
    // so the next drag moves the new layer instead of drawing another one. Pen/highlight stay
    // active for continuous strokes.
    if (gesture.mode === 'draw' && ['rectangle', 'ellipse', 'arrow', 'blur', 'text'].includes(completed[0].type)) {
      onToolChange?.('select');
    }
  };
  const selectedItems = visibleAnnotations.filter(a => ids.includes(a.id) && !a.hidden), selected = selectedItems.length === 1 ? selectedItems[0] : undefined;
  const selection = selectionBounds(selectedItems), locked = selectedItems.some(a => a.locked), drawing = gestureRef.current?.mode === 'draw';
  const markerSelected = selected?.type === 'highlight';
  const canResize = !selectedItems.some(a => a.type === 'highlight');
  const showSelection = selection && !textEditor && !crop && !drawing && !marquee;
  const hovered = !gestureRef.current && !ids.includes(hoveredId || '') ? annotations.find(a => a.id === hoveredId && !a.hidden) : undefined, hoverBox = hovered ? annotationBounds(hovered) : null;
  // Only the four corners resize. The mid-edge handles are gone, so a shape is
  // resized from a corner the way CleanShot does it.
  const handlePositions: { key: Handle; x: number; y: number }[] = selection ? [
    { key: 'nw', x: selection.x, y: selection.y },
    { key: 'ne', x: selection.x + selection.width, y: selection.y },
    { key: 'se', x: selection.x + selection.width, y: selection.y + selection.height },
    { key: 'sw', x: selection.x, y: selection.y + selection.height },
  ] : [];
  const selectedArrow = selected?.type === 'arrow' && !locked ? selected : undefined;
  const arrowTail = selectedArrow ? { x: selectedArrow.x, y: selectedArrow.y } : null;
  const arrowTip = selectedArrow ? { x: selectedArrow.x + selectedArrow.width, y: selectedArrow.y + selectedArrow.height } : null;
  const bendHandle = selectedArrow ? arrowBendPoint(selectedArrow) : null;
  const chordMid = selectedArrow ? { x: (selectedArrow.x + selectedArrow.x + selectedArrow.width) / 2, y: (selectedArrow.y + selectedArrow.y + selectedArrow.height) / 2 } : null;
  const overlay: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' };
  const cursor = tool === 'select' ? gestureRef.current ? 'grabbing' : hoveredId ? 'move' : 'default' : tool === 'text' ? 'text' : 'crosshair';
  return (
    <div ref={viewportRef} data-testid="editor-viewport" className="flex-1 w-full h-full min-w-0 min-h-0 overflow-auto scrollbar-none relative overscroll-contain" style={{ overflowAnchor: 'none' }}>
      <div className="flex items-center justify-center w-max min-w-full min-h-full box-border" style={{ padding: CANVAS_INSET }}>
        {image && size ? <div ref={artboardRef} data-testid="editor-artboard" className="relative shrink-0 touch-none select-none" role="application" aria-label="Screenshot canvas. Drag to draw, select a layer, or drag empty space to select several layers."
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gestureRef.current) cancelGesture(); }} onPointerLeave={() => setHoveredId(null)} onDragStart={event => event.preventDefault()}
          onDoubleClick={event => {
            if ((event.target as Element).hasAttribute('data-bend')) {
              // Double-clicking the middle handle takes the bow away, the way
              // double-clicking a modifier resets it elsewhere in the app.
              onChange(annotations.map(a => a.id === selectedArrow?.id ? { ...a, arrowStyle: 'straight', curve: 0 } : a));
              return;
            }
            if (tool !== 'select' || textEditorRef.current) return;
            const target = [...annotations].reverse().find(a => a.type === 'text' && contains(a, coordinates(event), 4 / displayScale));
            if (target) { setTextEditor({ annotation: target, value: target.text || '', isNew: false }); onSelect(target.id); }
          }} style={{ width: size.width * displayScale, height: size.height * displayScale, cursor }}>
          <canvas ref={canvasRef} aria-label="Screenshot composition preview" className="block w-full h-full" />
          <svg style={overlay} viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true"><g transform={`translate(${size.imageX} ${size.imageY})`}>
            {showSelection && selection && <>
              {!markerSelected && <rect data-testid="selection-bounds" {...selection} fill="none" stroke={ACCENT} strokeWidth={1 / displayScale} strokeDasharray={locked ? `${4 / displayScale} ${3 / displayScale}` : undefined} opacity={selectedArrow ? 0.4 : 1} />}
              {markerSelected && tool === 'select' && selected.points?.length && <polyline data-testid="selected-marker" points={strokePath(selected).map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={ACCENT} strokeWidth={1 / displayScale} strokeDasharray={`${3 / displayScale} ${3 / displayScale}`} opacity={0.7} />}
              {selectedItems.length > 1 && selectedItems.map(a => <rect key={a.id} {...annotationBounds(a)} fill="none" stroke={ACCENT} strokeWidth={0.7 / displayScale} opacity={0.5} />)}
              {!locked && !selectedArrow && canResize && handlePositions.map(h => <g key={h.key}>
                <rect data-handle={h.key} x={h.x - 7 / displayScale} y={h.y - 7 / displayScale} width={14 / displayScale} height={14 / displayScale} fill="transparent" style={{ pointerEvents: 'all', cursor: `${h.key}-resize` }} />
                <rect x={h.x - 3 / displayScale} y={h.y - 3 / displayScale} width={6 / displayScale} height={6 / displayScale} fill="white" stroke={ACCENT} strokeWidth={1 / displayScale} />
              </g>)}
              {selectedArrow && arrowTail && arrowTip && (
                <>
                  {([['tail', arrowTail], ['tip', arrowTip]] as const).map(([end, at]) => <g key={end}>
                    <circle data-endpoint={end} cx={at.x} cy={at.y} r={9 / displayScale} fill="transparent" style={{ pointerEvents: 'all', cursor: 'crosshair' }} />
                    <circle cx={at.x} cy={at.y} r={4.5 / displayScale} fill={ACCENT} stroke="white" strokeWidth={1.5 / displayScale} />
                  </g>)}
                  {bendHandle && chordMid && (
                    <>
                      {/* The dashed guide back to the chord is what makes the bow readable. */}
                      <line x1={chordMid.x} y1={chordMid.y} x2={bendHandle.x} y2={bendHandle.y} stroke={ACCENT} strokeWidth={1 / displayScale} strokeDasharray={`${3 / displayScale} ${3 / displayScale}`} opacity={0.7} />
                      <circle data-bend="1" cx={bendHandle.x} cy={bendHandle.y} r={11 / displayScale} fill="transparent" style={{ pointerEvents: 'all', cursor: 'grab' }}><title>Drag to curve the line. Double-click to straighten it.</title></circle>
                      <circle cx={bendHandle.x} cy={bendHandle.y} r={5 / displayScale} fill={ACCENT} stroke="white" strokeWidth={1.5 / displayScale} />
                    </>
                  )}
                </>
              )}
            </>}
            {hoverBox && hovered?.type !== 'highlight' && !textEditor && <rect data-testid="hover-outline" {...hoverBox} fill="none" stroke={ACCENT} strokeWidth={1 / displayScale} opacity={0.65} />}
            {guides.map((g, i) => <line key={i} data-testid="editor-axis-guide" x1={g.from.x} y1={g.from.y} x2={g.to.x} y2={g.to.y} stroke={ACCENT} strokeWidth={1 / displayScale} strokeDasharray={`${4 / displayScale} ${4 / displayScale}`} opacity={0.7} />)}
            {marquee && <rect data-testid="selection-marquee" {...marquee} fill="rgba(98,68,224,0.10)" stroke={ACCENT} strokeWidth={1 / displayScale} />}
            {crop && <><path d={`M 0 0 H ${size.imageWidth} V ${size.imageHeight} H 0 Z M ${crop.x} ${crop.y} V ${crop.y + crop.height} H ${crop.x + crop.width} V ${crop.y} Z`} fill="rgba(30,30,38,0.5)" fillRule="evenodd" /><rect {...crop} fill="none" stroke="white" strokeWidth={1.5 / displayScale} strokeDasharray={`${6 / displayScale} ${4 / displayScale}`} /><path d={`M ${crop.x + crop.width / 3} ${crop.y} V ${crop.y + crop.height} M ${crop.x + crop.width * 2 / 3} ${crop.y} V ${crop.y + crop.height} M ${crop.x} ${crop.y + crop.height / 3} H ${crop.x + crop.width} M ${crop.x} ${crop.y + crop.height * 2 / 3} H ${crop.x + crop.width}`} fill="none" stroke="rgba(255,255,255,.4)" strokeWidth={0.5 / displayScale} /></>}
          </g></svg>
          {showSelection && selection && !selectedArrow && !markerSelected && <div data-testid="selection-size" className="absolute pointer-events-none whitespace-nowrap rounded-[3px] bg-accent px-1.5 py-0.5 text-[10px] text-white" style={{ left: (size.imageX + selection.x + selection.width / 2) * displayScale, top: (size.imageY + selection.y + selection.height) * displayScale + 10, transform: 'translateX(-50%)' }}>{Math.round(selection.width)} × {Math.round(selection.height)}{selectedItems.length > 1 ? ` · ${selectedItems.length} layers` : ''}</div>}

          {textEditor && <InlineTextEditor annotation={textEditor.annotation} value={textEditor.value} isNew={textEditor.isNew} scale={displayScale} imageX={size.imageX} imageY={size.imageY} onChange={value => setTextEditor({ ...textEditor, value })} onCommit={commitText} onCancel={() => { const id = textEditor.isNew ? null : textEditor.annotation.id; setTextEditor(null); onSelect(id); onToolChange?.('select'); }} />}
        </div> : <div className="flex flex-col items-center gap-2 text-center text-ink-3"><strong className="text-[13px] font-medium text-ink">{loadingMessage ? 'Opening your screenshot' : 'No image loaded'}</strong><span className="text-app">{loadingMessage ?? 'Drop a screenshot here, or import one from the file menu.'}</span></div>}
      </div>
      {!textEditor && ['highlight', 'pen', 'select', 'arrow', 'rectangle', 'ellipse', 'text'].includes(tool) && <div className="sticky bottom-3 mx-auto w-fit max-w-[90%] pointer-events-none rounded-md bg-white/90 px-3 py-1.5 text-[10px] text-ink-2 shadow-sm" style={{ marginTop: -30 }}>{tool === 'highlight' ? 'Snap to a row · Alt to draw freely · Shift for 45°' : tool === 'pen' ? 'Draw freely · Shift for a straight stroke · Esc to cancel' : tool === 'arrow' ? 'Drag to draw · Drag the middle dot to curve · Shift for 45°' : tool === 'rectangle' || tool === 'ellipse' ? 'Drag to draw · Shift for square · Alt from center · Esc to cancel' : tool === 'text' ? 'Click to type · Drag a corner to resize · Esc to finish' : 'Drag to select · Shift-click to add · Arrow keys to nudge'}</div>}
    </div>
  );
}
export default EditorCanvas;
