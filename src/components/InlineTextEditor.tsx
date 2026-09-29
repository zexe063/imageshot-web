import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Annotation } from '../lib/editor-types';
import { textFrame, textMetrics, textStack } from '../lib/render';

interface InlineTextEditorProps {
  annotation: Annotation;
  value: string;
  isNew: boolean;
  scale: number;
  imageX: number;
  imageY: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

let measuringContext: CanvasRenderingContext2D | null | undefined;

/** Align the CSS line box with the canvas renderer's `top` text baseline. */
function lineBoxOffset(font: string, lineStep: number) {
  if (measuringContext === undefined) measuringContext = document.createElement('canvas').getContext('2d');
  if (!measuringContext) return 0;
  measuringContext.font = font;
  measuringContext.textBaseline = 'alphabetic';
  const alphabetic = measuringContext.measureText('Hg');
  measuringContext.textBaseline = 'top';
  const top = measuringContext.measureText('Hg');
  const fontHeight = alphabetic.fontBoundingBoxAscent + alphabetic.fontBoundingBoxDescent;
  return Number.isFinite(fontHeight) ? (fontHeight - lineStep) / 2 - top.fontBoundingBoxAscent : 0;
}

/** A native caret and text selection, positioned directly on the artwork. */
export default function InlineTextEditor({
  annotation, value, isNew, scale, imageX, imageY, onChange, onCommit, onCancel,
}: InlineTextEditorProps) {
  const input = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const blurredDuringComposition = useRef(false);
  const finished = useRef(false);
  const helpId = useId();
  const [, fontsLoaded] = useState(0);
  const metrics = textMetrics({ ...annotation, text: value });
  const frame = textFrame({ ...annotation, text: value || 'Text' });
  const zoom = Math.max(0.01, scale);
  const caretSpace = Math.max(2 / zoom, metrics.letterSpacing, 0);
  const topOffset = lineBoxOffset(metrics.font, metrics.lineStep);

  useEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => { if (active) fontsLoaded(version => version + 1); });
    return () => { active = false; };
  }, []);

  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    if (isNew) element.setSelectionRange(element.value.length, element.value.length);
    else element.select();
  }, [annotation.id, isNew]);

  useLayoutEffect(() => {
    // The frame grows with every line and character. Never scroll the text away
    // from its actual canvas position while the browser brings the caret in view.
    if (input.current) {
      input.current.scrollTop = 0;
      input.current.scrollLeft = 0;
    }
  }, [value, frame.width, frame.height, zoom]);

  const finish = (cancel = false) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel) onCancel();
    else onCommit();
  };

  return (
    <div
      data-testid="inline-text-editor"
      style={{
        position: 'absolute',
        left: (imageX + annotation.x) * zoom,
        top: (imageY + annotation.y) * zoom,
        width: frame.width,
        height: frame.height,
        transform: `scale(${zoom})`,
        transformOrigin: 'top left',
        outline: `${1 / zoom}px solid var(--color-accent, #6244e0)`,
        outlineOffset: `${2 / zoom}px`,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <textarea
        ref={input}
        aria-label="Annotation text"
        aria-describedby={helpId}
        placeholder="Text"
        value={value}
        rows={1}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        className="placeholder:opacity-40 placeholder:text-current selection:bg-accent/20"
        onChange={event => onChange(event.target.value)}
        onPointerDown={event => event.stopPropagation()}
        onPointerMove={event => event.stopPropagation()}
        onPointerUp={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={event => {
          composing.current = false;
          onChange(event.currentTarget.value);
          if (blurredDuringComposition.current) finish();
        }}
        onBlur={() => {
          if (composing.current) blurredDuringComposition.current = true;
          else finish();
        }}
        onKeyDown={event => {
          event.stopPropagation();
          if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            finish();
          }
        }}
        style={{
          position: 'absolute',
          left: 0,
          top: topOffset,
          display: 'block',
          width: frame.width,
          height: frame.height + Math.max(0, -topOffset),
          minWidth: 0,
          minHeight: 0,
          margin: 0,
          padding: `0 ${caretSpace}px 0 0`,
          boxSizing: 'content-box',
          resize: 'none',
          appearance: 'none',
          border: 0,
          borderRadius: 0,
          outline: 'none',
          background: 'transparent',
          boxShadow: 'none',
          color: annotation.color,
          opacity: (annotation.opacity ?? 100) / 100,
          caretColor: 'var(--color-accent, #6244e0)',
          fontFamily: textStack(annotation.fontFamily),
          fontSize: metrics.size,
          fontWeight: metrics.weight,
          fontKerning: metrics.letterSpacing ? 'none' : 'normal',
          fontVariantLigatures: metrics.letterSpacing ? 'none' : 'normal',
          lineHeight: `${metrics.lineStep}px`,
          letterSpacing: metrics.letterSpacing,
          textAlign: metrics.align,
          whiteSpace: 'pre',
          overflow: 'hidden',
          userSelect: 'text',
          pointerEvents: 'auto',
          cursor: 'text',
        }}
      />
      <span id={helpId} className="sr-only">Enter for a new line. Control or Command and Enter to finish. Escape to cancel.</span>
    </div>
  );
}
