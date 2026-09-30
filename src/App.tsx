import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './components/Icon';
import EditorCanvas from './components/EditorCanvas';
import LayersPanel from './components/LayersPanel';
import PropertiesPanel from './components/PropertiesPanel';
import TopBar, { TOOLS } from './components/TopBar';
import ExportMenu from './components/ExportMenu';
import { IconButton } from './components/ui';
import { DEFAULT_STYLE, type Annotation, type ArrowEnds, type ArrowHead, type ArrowStyle, type CompositionStyle, type Tool } from './lib/editor-types';
import { annotationBounds, getCompositionSize, renderComposition } from './lib/render';
import { selectionBounds, transformAnnotation } from './lib/selection';
import { layerDisplayName, layerLabel } from './lib/naming';
import { captureFitScale, getCapture, listCaptures, materializeCapture, type CaptureRecord } from './lib/capture-store';
import { readDraft, writeDraft, type ShotDocument } from './lib/document-store';
import { createExportBlob, type ExportFormat, type PdfPageSize } from './lib/export';

const toolIcons = TOOLS.reduce<Record<string, IconName>>((map, tool) => ({ ...map, [tool.id]: tool.icon }), {});



/** Captures larger than one browser canvas open reduced, so report the real size. */
function captureDimensions(capture: CaptureRecord): string {
  const scale = captureFitScale(capture.width, capture.height);
  return `${Math.round(capture.width * scale)} × ${Math.round(capture.height * scale)}`;
}
function reducedCaptureNotice(capture: CaptureRecord): string {
  const scale = captureFitScale(capture.width, capture.height);
  if (scale >= 1) return '';
  return `This capture is ${(capture.width * capture.height / 1e6).toFixed(0)} megapixels, so ImageShot opened it at ${Math.round(scale * 100)}% scale to fit your browser's canvas limit. Use Select area for full-resolution crops.`;
}
const initialDocument: ShotDocument = { name: 'A little more clarity', imageSrc: './sample-workspace.svg', annotations: [], style: DEFAULT_STYLE, sample: true };
type Dialog = 'capture' | 'shortcuts' | 'recent' | null;

/** How long an editor that was opened mid-capture waits for its record. */
const PENDING_CAPTURE_TIMEOUT = 60_000;
const PENDING_CAPTURE_INTERVAL = 60;

/**
 * The editor tab is opened while the screenshot is still being taken, so a pending id
 * has to be waited for rather than reported as missing. The background worker closes
 * that tab outright if the capture fails, so this only has to outlast a worker that
 * died mid-capture.
 */
async function waitForCapture(id: string): Promise<CaptureRecord | undefined> {
  const deadline = Date.now() + PENDING_CAPTURE_TIMEOUT;
  for (;;) {
    const capture = await getCapture(id);
    if (capture || Date.now() > deadline) return capture;
    await new Promise(resolve => setTimeout(resolve, PENDING_CAPTURE_INTERVAL));
  }
}

function Modal({ title, subtitle, children, onClose }: { title: string; subtitle: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog
      ref={ref}
      className="m-auto w-[min(440px,calc(100vw-32px))] p-0 border-0 rounded-xl bg-surface text-ink shadow-[0_24px_64px_rgba(15,12,30,.24),0_0_0_1px_rgba(0,0,0,.06)] backdrop:bg-[rgba(24,20,38,.32)] backdrop:blur-[2px]"
      onCancel={onClose}
      onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="flex flex-col gap-3.5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-[550] tracking-[-.2px]">{title}</h2>
            <p className="mt-[3px] text-app text-ink-2 leading-[1.5]">{subtitle}</p>
          </div>
          <IconButton icon="close" label="Close dialog" onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [doc, setDoc] = useState<ShotDocument>(() => {
    const captureId = new URLSearchParams(window.location.search).get('capture');
    return captureId ? { ...initialDocument, name: 'Screenshot', imageSrc: '', sample: false, captureId } : initialDocument;
  });
  const docRef = useRef(doc); docRef.current = doc;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  /** The capture image, decoded and waiting to be adopted by the load effect. */
  const decoded = useRef<{ src: string; image: HTMLImageElement } | null>(null);
  const [ready, setReady] = useState(false);
  const [waiting, setWaiting] = useState(() => !!new URLSearchParams(window.location.search).get('capture'));
  const [past, setPast] = useState<ShotDocument[]>([]);
  const [future, setFuture] = useState<ShotDocument[]>([]);
  const [tool, setToolState] = useState<Tool>('select');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectedId = selectedIds[selectedIds.length - 1] ?? null;
  const setSelectedId = useCallback((id: string | null) => setSelectedIds(id ? [id] : []), []);
  const changeSelection = useCallback((ids: string[]) => setSelectedIds([...new Set(ids)]), []);
  const nudgeDocument = useRef<ShotDocument | null>(null);
  const [defaults, setDefaults] = useState({ color: '#000000', strokeWidth: 4, fontSize: 32, fontFamily: 'Inter', fontWeight: 600, lineHeight: 1.3, letterSpacing: 0, align: 'left' as NonNullable<Annotation['align']>, fill: null as string | null, radius: 3, opacity: 100, arrowStyle: 'straight' as ArrowStyle, curve: 0, arrowHead: 'chevron' as ArrowHead, arrowEnds: 'head' as ArrowEnds, headSize: 0 });
  const toolDefaults = useRef(new Map<Tool, typeof defaults>());
  function setTool(next: Tool) {
    if (next === tool) return;
    if (tool !== 'select' && tool !== 'crop') toolDefaults.current.set(tool, defaults);
    if (next !== 'select' && next !== 'crop') setDefaults(toolDefaults.current.get(next) ?? { ...defaults, color: next === 'highlight' ? '#FFE45E' : '#000000', strokeWidth: 4 });
    setToolState(next);
  }
  const [zoom, setZoom] = useState(1);
  const [actualZoom, setActualZoom] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [format, setFormat] = useState<ExportFormat>('png');
  const [exportScale, setExportScale] = useState(1);
  const [pdfPageSize, setPdfPageSize] = useState<PdfPageSize>('auto');
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const [exportPreview, setExportPreview] = useState('');
  const [recent, setRecent] = useState<CaptureRecord[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const selected = doc.annotations.find(a => a.id === selectedId) ?? null;
  const selectedLayers = doc.annotations.filter(annotation => selectedIds.includes(annotation.id));
  const editableLayers = selectedLayers.filter(annotation => !annotation.locked && !annotation.hidden);
  const selectedBounds = selectionBounds(editableLayers) ?? (selected ? annotationBounds(selected) : null);
  useEffect(() => {
    const ids = new Set(doc.annotations.map(annotation => annotation.id));
    setSelectedIds(current => current.every(id => ids.has(id)) ? current : current.filter(id => ids.has(id)));
  }, [doc.annotations]);
  const size = useMemo(() => (image ? getCompositionSize(image, doc.style) : { width: 0, height: 0 }), [image, doc.style]);
  const selectedIndex = useMemo(() => {
    if (!selected) return 1;
    let counter = 0;
    let found = 0;
    [...doc.annotations].reverse().forEach(annotation => {
      if (annotation.id === selected.id) { found = counter + 1; return; }
      if (annotation.type === selected.type) counter += 1;
    });
    return found || 1;
  }, [doc.annotations, selected]);
  // With nothing selected the panel is describing the tool in hand, not the image, so
  // the header has to name that tool rather than fall back to the screenshot.
  const selectedName = selectedLayers.length > 1 ? `${selectedLayers.length} layers` : selected ? layerDisplayName(selected, selectedIndex) : tool === 'select' || tool === 'crop' ? 'Screenshot' : layerLabel(tool);

  /** Steps the on-screen scale by whole percentage points (5% per click). */
  const zoomBy = useCallback((delta: number) => {
    setZoom(current => {
      const shown = Math.max(0.05, actualZoom) || 1;
      const next = Math.max(0.1, Math.min(4, actualZoom + delta));
      return Math.max(0.1, Math.min(4, current * (next / shown)));
    });
  }, [actualZoom]);

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4200);
  }, []);

  const commit = useCallback((change: Partial<ShotDocument> | ((d: ShotDocument) => ShotDocument)) => {
    nudgeDocument.current = null;
    const current = docRef.current;
    const next = typeof change === 'function' ? change(current) : { ...current, ...change };
    if (next === current) return;
    setPast(p => [...p.slice(-39), current]);
    setFuture([]);
    docRef.current = next;
    setDoc(next);
  }, []);

  const changeStyle = (change: Partial<CompositionStyle>) => commit(d => ({ ...d, style: { ...d.style, ...change } }));

  function undo() {
    if (!past.length) return;
    const previous = past[past.length - 1];
    setFuture(f => [docRef.current, ...f]);
    setPast(p => p.slice(0, -1));
    docRef.current = previous;
    setDoc(previous);
    setSelectedId(null);
  }
  function redo() {
    if (!future.length) return;
    const next = future[0];
    setPast(p => [...p, docRef.current]);
    setFuture(f => f.slice(1));
    docRef.current = next;
    setDoc(next);
    setSelectedId(null);
  }
  function updateAnnotation(id: string, change: Partial<Annotation>) {
    commit(d => ({ ...d, annotations: d.annotations.map(a => (a.id === id ? { ...a, ...change } : a)) }));
  }
  function deleteSelected() {
    const ids = new Set(editableLayers.map(annotation => annotation.id));
    if (!ids.size) return;
    commit(d => ({ ...d, annotations: d.annotations.filter(a => !ids.has(a.id)) }));
    setSelectedIds(current => current.filter(id => !ids.has(id)));
  }
  function duplicateSelected() {
    if (!editableLayers.length) return;
    const copies = editableLayers.map(annotation => ({ ...annotation, id: crypto.randomUUID(), x: annotation.x + 20, y: annotation.y + 20 }));
    commit(d => ({ ...d, annotations: [...d.annotations, ...copies] }));
    setSelectedIds(copies.map(annotation => annotation.id));
  }
  function nudgeSelected(key: string, distance: number, repeat: boolean) {
    const ids = new Set(editableLayers.map(annotation => annotation.id));
    if (!ids.size) return;
    const dx = key === 'ArrowLeft' ? -distance : key === 'ArrowRight' ? distance : 0;
    const dy = key === 'ArrowUp' ? -distance : key === 'ArrowDown' ? distance : 0;
    const current = docRef.current;
    const next = { ...current, annotations: current.annotations.map(annotation => ids.has(annotation.id) ? { ...annotation, x: annotation.x + dx, y: annotation.y + dy } : annotation) };
    // Holding a key is one gesture, with a single undo for the entire selection.
    if (repeat && nudgeDocument.current === current) { docRef.current = next; setDoc(next); }
    else commit(next);
    nudgeDocument.current = next;
  }
  function patchLayer(patch: Partial<Annotation>) {
    const ids = new Set(editableLayers.map(annotation => annotation.id));
    if (!ids.size) return;
    if (selected && !['x', 'y', 'width', 'height', 'text'].some(key => key in patch)) {
      const nextDefaults = { ...(toolDefaults.current.get(selected.type) ?? defaults), ...patch } as typeof defaults;
      toolDefaults.current.set(selected.type, nextDefaults);
      if (tool === selected.type) setDefaults(nextDefaults);
    }
    const boxKeys = ['x', 'y', 'width', 'height'];
    const geometryChanged = boxKeys.some(key => key in patch);
    commit(d => {
      const current = selectionBounds(d.annotations.filter(annotation => ids.has(annotation.id)));
      if (!current) return d;
      const box = { x: patch.x ?? current.x, y: patch.y ?? current.y, width: Math.max(1, patch.width ?? current.width), height: Math.max(1, patch.height ?? current.height) };
      return { ...d, annotations: d.annotations.map(annotation => {
        if (!ids.has(annotation.id)) return annotation;
        const compatible = Object.fromEntries(Object.entries(patch).filter(([key]) => {
          if (boxKeys.includes(key)) return false;
          if (['fontSize', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'align', 'text'].includes(key)) return annotation.type === 'text';
          if (['arrowStyle', 'curve', 'arrowHead', 'arrowEnds', 'headSize'].includes(key)) return annotation.type === 'arrow';
          if (key === 'fill') return annotation.type === 'rectangle' || annotation.type === 'ellipse';
          if (key === 'radius') return annotation.type === 'rectangle';
          return ['color', 'strokeColor', 'strokeWidth', 'opacity'].includes(key);
        }));
        const transformed = geometryChanged ? transformAnnotation(annotation, current, box) : annotation;
        return { ...transformed, ...compatible };
      }) };
    });
  }

  /**
   * An arrow setting applies to the arrow in hand, and otherwise sets the style the
   * next arrow is drawn with, which is what the keyboard shortcuts rely on.
   */
  function sendArrow(patch: Partial<Annotation>) {
    if (selected?.type === 'arrow') patchLayer(patch);
    else setDefaults(current => ({ ...current, ...patch }));
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const id = params.get('capture');
        if (id) {
          const pending = params.get('pending') === '1';
          if (pending && live) {
            // Show an empty artboard straight away rather than the sample image, and
            // say why, so the tab is ready to receive the capture it was opened for.
            setDoc({ ...initialDocument, name: 'Screenshot', imageSrc: '', sample: false, captureId: id });
            setWaiting(true);
          }
          const [draft, capture] = await Promise.all([readDraft(`capture:${id}`), pending ? waitForCapture(id) : getCapture(id)]);
          if (!live) return;
          // A draft taken from a capture keeps no image of its own, so it is rebuilt
          // from the capture record and only the annotations and style are reused.
          if (draft && (draft.imageSrc || !draft.captureId)) { if (live) setDoc({ ...draft, style: { ...DEFAULT_STYLE, ...draft.style } }); return; }
          if (!capture) throw new Error('This capture is no longer available. Import an image or take a new screenshot.');
          const { src, image: composed } = await materializeCapture(capture);
          if (!live) { URL.revokeObjectURL(src); return; }
          decoded.current = { src, image: composed };
          if (live) setDoc({
            ...initialDocument,
            name: capture.name,
            imageSrc: src,
            sample: false,
            captureId: id,
            ...(draft ? { annotations: draft.annotations, style: { ...DEFAULT_STYLE, ...draft.style } } : {}),
          });
          const reduced = reducedCaptureNotice(capture);
          if (live && reduced) notify(reduced);
        } else {
          const draft = await readDraft();
          if (draft && live) setDoc({ ...draft, style: { ...DEFAULT_STYLE, ...draft.style } });
        }
      } catch (error) {
        if (live) notify(error instanceof Error ? error.message : 'Could not load the previous capture.');
      } finally {
        if (live) { setWaiting(false); setReady(true); }
      }
    })();
    return () => { live = false; };
  }, [notify]);

  useEffect(() => {
    let live = true;
    if (!doc.imageSrc) { setImage(null); return; }
    // A capture arrives already decoded, so hand that one over rather than parsing the
    // same multi-megabyte image a second time.
    const preloaded = decoded.current;
    if (preloaded && preloaded.src === doc.imageSrc) { decoded.current = null; setImage(preloaded.image); return; }
    const next = new Image();
    next.src = doc.imageSrc;
    // decode() settles on the decoded bitmap, a frame or two sooner than load, which
    // is the difference between seeing the screenshot and seeing it on a long page.
    next.decode().then(
      () => { if (live) setImage(next); },
      () => { if (live) { setImage(null); notify('This image could not be opened. Try a PNG, JPG, or WebP.'); } },
    );
    return () => { live = false; };
  }, [doc.imageSrc, notify]);

  useEffect(() => {
    if (!ready) return;
    const url = new URL(window.location.href);
    if (doc.captureId) url.searchParams.set('capture', doc.captureId); else url.searchParams.delete('capture');
    window.history.replaceState(null, '', url);
    const timer = setTimeout(() => { void writeDraft(doc); }, 650);
    return () => clearTimeout(timer);
  }, [doc, ready]);

  useEffect(() => {
    if (dialog === 'recent') listCaptures(12).then(setRecent).catch(() => notify('Could not load recent captures.'));
  }, [dialog, notify]);

  useEffect(() => {
    if (!exportOpen || !image) return;
    let live = true;
    void (async () => {
      let preview: HTMLCanvasElement | undefined;
      try {
        await document.fonts.ready;
        if (!live) return;
        preview = renderComposition(image, doc.annotations, doc.style, Math.min(1, 420 / size.width, 260 / size.height));
        setExportPreview(preview.toDataURL('image/png'));
      } catch {
        if (live) setExportPreview('');
      } finally {
        if (preview) { preview.width = 1; preview.height = 1; }
      }
    })();
    return () => { live = false; };
  }, [exportOpen, image, doc.annotations, doc.style, size.width, size.height]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || target?.isContentEditable || target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || dialog) return;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelectedIds(doc.annotations.filter(annotation => !annotation.hidden && !annotation.locked).map(annotation => annotation.id)); setTool('select'); return; }
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return; }
      if (mod && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return; }
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); setExportOpen(value => !value); return; }
      if (mod && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicateSelected(); return; }
      if (mod && event.key.toLowerCase() === 'o') { event.preventDefault(); fileInput.current?.click(); return; }
      if (mod) return;
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && editableLayers.length) {
        event.preventDefault();
        nudgeSelected(event.key, event.shiftKey ? 10 : 1, event.repeat);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelected(); }
      if (event.key === 'Escape') { setTool('select'); setSelectedId(null); setMenuOpen(false); setExportOpen(false); }

      const match = TOOLS.find(tool => tool.key.toLowerCase() === event.key.toLowerCase());
      if (match) { event.preventDefault(); if (match.id !== 'select') setSelectedId(null); setTool(match.id); }
      if (event.key === '0') setZoom(1);
      if (event.key === '+' || event.key === '=') zoomBy(0.05);
      if (event.key === '-') zoomBy(-0.05);
      if (event.key === '?') setDialog('shortcuts');
    }
    function endNudge(event: KeyboardEvent) {
      if (event.key.startsWith('Arrow')) nudgeDocument.current = null;
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', endNudge);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', endNudge); };
  });

  async function importFile(file?: File) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) { notify('Choose a PNG, JPG, WebP, or GIF image.'); return; }
    if (file.size > 40 * 1024 * 1024) { notify('Choose an image smaller than 40 MB.'); return; }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const probe = new Image();
      probe.src = dataUrl;
      await probe.decode();
      if (probe.naturalWidth * probe.naturalHeight > 48_000_000 || Math.max(probe.naturalWidth, probe.naturalHeight) > 32760) {
        throw new Error('This image is too large. Keep it under 48 megapixels and 32,760 pixels on either side.');
      }
      commit({ imageSrc: dataUrl, name: file.name.replace(/\.[^.]+$/, ''), annotations: [], sample: false, captureId: undefined });
      setSelectedId(null);
      setZoom(1);
      notify('Image imported.');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'This image could not be imported.');
    }
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input,textarea')) return;
      const file = [...(event.clipboardData?.files ?? [])].find(item => item.type.startsWith('image/'));
      if (file) { event.preventDefault(); void importFile(file); }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  async function exportImage(copy = false) {
    if (!image || exportBusy.current) return;
    exportBusy.current = true;
    setExporting(true);
    try {
      const outputSize = getCompositionSize(image, doc.style);
      const scale = copy ? 1 : exportScale;
      if (outputSize.width * outputSize.height * scale ** 2 > 64_000_000 || Math.max(outputSize.width, outputSize.height) * scale > 32760) {
        throw new Error('This export is too large. Reduce the export scale or the canvas padding.');
      }
      const encode = async (outputFormat: ExportFormat) => {
        let canvas: HTMLCanvasElement | undefined;
        try {
          await document.fonts.ready;
          if (outputFormat === 'pdf') {
            // Give the working indicator a paint before rendering and encoding.
            await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
          }
          canvas = renderComposition(image, doc.annotations, doc.style, scale);
          return await createExportBlob(canvas, outputFormat, { pageSize: pdfPageSize, originalSize: outputSize });
        } finally {
          if (canvas) { canvas.width = 1; canvas.height = 1; }
        }
      };
      if (copy) {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard is unavailable here. Download your image instead.');
        // Call write during the click; the PNG promise can await fonts and render.
        const blobPromise = encode('png');
        void blobPromise.catch(() => undefined);
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        notify('Image copied to clipboard.');
      } else {
        const blob = await encode(format);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${doc.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').trim() || 'imageshot'}.${format}`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setExportOpen(false);
        notify('Export started.');
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Export failed. Try PNG at 1×.');
    } finally {
      exportBusy.current = false;
      setExporting(false);
    }
  }

  async function openRecent(capture: CaptureRecord) {
    try {
      const saved = await readDraft(`capture:${capture.id}`);
      // A saved draft may hold no image, because a capture's is rebuilt on open.
      const imageSrc = saved?.imageSrc || (await materializeCapture(capture)).src;
      commit(saved ? { ...saved, imageSrc, style: { ...DEFAULT_STYLE, ...saved.style } } : { imageSrc, name: capture.name, annotations: [], style: DEFAULT_STYLE, sample: false, captureId: capture.id });
      const reduced = reducedCaptureNotice(capture);
      if (reduced) notify(reduced);
      setDialog(null);
      setZoom(1);
    } catch {
      notify('Could not open this capture.');
    }
  }

  function reorderLayer(from: string, to: string) {
    const source = doc.annotations.findIndex(item => item.id === from);
    const target = doc.annotations.findIndex(item => item.id === to);
    if (source < 0 || source === target) return;
    commit(d => {
      const next = [...d.annotations];
      const [moved] = next.splice(source, 1);
      next.splice(target, 0, moved);
      return { ...d, annotations: next };
    });
  }

  return (
    <div
      className={`relative flex flex-col h-dvh bg-canvas ${
        dragging ? "after:content-[''] after:absolute after:inset-1.5 after:z-[60] after:border-2 after:border-dashed after:border-accent after:rounded-[10px] after:bg-accent/5 after:pointer-events-none" : ''}`}
      onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); setDragging(false); void importFile(event.dataTransfer.files[0]); } }}
    >
      <input
        type="file"
        ref={fileInput}
        className="sr-only"
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ''; }}
      />

      <TopBar
        menuOpen={menuOpen}
        tool={tool}
        exportOpen={exportOpen}
        exporting={exporting}
        onToggleMenu={() => setMenuOpen(value => !value)}
        onImport={() => fileInput.current?.click()}
        onCapture={() => { setDialog('capture'); setMenuOpen(false); }}
        onRecent={() => { setDialog('recent'); setMenuOpen(false); }}
        onSample={() => { commit(initialDocument); setMenuOpen(false); setZoom(1); }}
        onShortcuts={() => { setDialog('shortcuts'); setMenuOpen(false); }}
        onTool={next => { if (next !== 'select') setSelectedId(null); setTool(next); }}
        zoom={zoom}
        actualZoom={actualZoom}
        onZoomIn={() => zoomBy(0.05)}
        onZoomOut={() => zoomBy(-0.05)}
        onFit={() => setZoom(1)}
        onCopy={() => exportImage(true)}
        onToggleExport={() => setExportOpen(value => !value)}
        exportMenu={(
          <ExportMenu
            format={format}
            scale={exportScale}
            pageSize={pdfPageSize}
            width={size.width}
            height={size.height}
            preview={exportPreview}
            exporting={exporting}
            ready={!!image}
            onFormat={next => { setFormat(next); if (next === 'pdf') setExportScale(current => Math.max(1, current)); }}
            onScale={setExportScale}
            onPageSize={setPdfPageSize}
            onDownload={() => exportImage(false)}
            onCopy={() => exportImage(true)}
            onClose={() => setExportOpen(false)}
          />
        )}
      />

      <div className="flex flex-1 min-h-0">
        <LayersPanel
          annotations={doc.annotations}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onSelect={id => { setSelectedId(id); setTool('select'); }}
          onSelectionChange={ids => { changeSelection(ids); setTool('select'); }}
          onToggleHidden={annotation => updateAnnotation(annotation.id, { hidden: !annotation.hidden })}
          onToggleLock={annotation => updateAnnotation(annotation.id, { locked: !annotation.locked })}
          onReorder={reorderLayer}
          imageSrc={doc.imageSrc}
          dimensions={image ? `${image.naturalWidth} × ${image.naturalHeight}` : 'Loading…'}
          toolIcons={toolIcons}
        />

        <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-canvas">
          <div className="relative flex-1 min-h-0 bg-canvas bg-[radial-gradient(circle,rgba(0,0,0,.09)_1px,transparent_1px)] bg-[length:16px_16px] bg-[position:-1px_-1px]">
            <EditorCanvas
              image={image}
              annotations={doc.annotations}
              onChange={annotations => commit({ annotations })}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onSelect={setSelectedId}
              onSelectionChange={changeSelection}
              tool={tool}
              color={defaults.color}
              strokeWidth={defaults.strokeWidth}
              arrow={defaults}
              onArrowChange={sendArrow}
              textSize={defaults.fontSize}
              textStyle={defaults}
              style={doc.style}
              zoom={zoom}
              onToolChange={setTool}
              onZoomChange={setActualZoom}
              onCrop={(imageSrc, annotations) => { commit({ imageSrc, annotations }); setZoom(1); notify('Image cropped. Undo restores the original.'); }}
              onStatus={notify}
              loadingMessage={waiting ? 'Finishing your screenshot…' : undefined}
            />
          </div>
        </main>

        <PropertiesPanel
          selected={selected}
          selectedName={selectedName}
          style={doc.style}
          bounds={selectedBounds}
          tool={tool}
          defaults={defaults}
          onStyle={changeStyle}
          onLayer={patchLayer}
          onDefaults={patch => setDefaults(current => ({ ...current, ...patch }))}
          onDuplicate={duplicateSelected}
          onDelete={deleteSelected}
        />
      </div>

      {dialog === 'capture' && (
        <Modal title="Capture a screenshot" subtitle="Capture a webpage with ImageShot, or import an image." onClose={() => setDialog(null)}>
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-panel">
            <Icon name="camera" size={20} className="mt-0.5 text-ink-2" />
            <div>
              <strong className="text-[12px] font-medium">Start from the webpage</strong>
              <p className="mt-1 text-[11px] leading-[1.6] text-ink-2">Switch to the page you want to capture, then click ImageShot in your browser toolbar or press <kbd className="whitespace-nowrap font-ui">Alt + Shift + S</kbd>.</p>
            </div>
          </div>
          <p className="px-3 text-[10px] leading-[1.6] text-ink-2">Webpage capture requires the ImageShot extension in Chrome or Edge. Browser settings pages and extension stores cannot be captured. Keep the page active while capturing.</p>
          <button type="button" className="flex items-center gap-2.5 p-3 rounded-lg bg-panel text-left hover:bg-accent-soft" onClick={() => fileInput.current?.click()}>
            <Icon name="upload" size={20} className="text-ink-2" />
            <span className="flex flex-1 flex-col gap-1">
              <strong className="text-[12px] font-medium">Import an image</strong>
              <span className="text-[10px] leading-[1.5] text-ink-2">PNG, JPG, WebP or GIF</span>
            </span>
            <Icon name="right" size={16} className="text-ink-3" />
          </button>
        </Modal>
      )}

      {dialog === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" subtitle="Everything you need, without the mouse." onClose={() => setDialog(null)}>
          <div className="flex flex-col gap-px max-h-[46vh] overflow-y-auto scrollbar-none">
            {TOOLS.map(tool => (
              <div key={tool.id} className="flex items-center justify-between h-7 px-2 rounded-[5px] odd:bg-panel">
                <span className="inline-flex items-center gap-2"><Icon name={tool.icon} size={15} className="text-ink-3" />{tool.label}</span>
                <kbd className="font-ui text-[10px] font-[450] px-1 py-0.5 rounded-[4px] whitespace-nowrap bg-field text-ink-2 shadow-[inset_0_0_0_1px_rgba(0,0,0,.05)]">{tool.key}</kbd>
              </div>
            ))}
            {[['Select multiple layers', 'Shift click / drag'], ['Select all unlocked layers', 'Ctrl A'], ['Nudge selection', 'Arrow keys'], ['Nudge by 10 px', 'Shift Arrow'], ['Square / circle', 'Shift drag'], ['From center', 'Alt drag'], ['Highlight a text row', 'Drag to snap'], ['Freehand highlighter', 'Alt drag'], ['45° line', 'Shift drag'], ['Undo', 'Ctrl Z'], ['Redo', 'Ctrl Shift Z'], ['Export', 'Ctrl S'], ['Import image', 'Ctrl O'], ['Duplicate selection', 'Ctrl D'], ['Delete selection', 'Delete'], ['Fit canvas', '0']].map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between h-7 px-2 rounded-[5px] odd:bg-panel"><span>{label}</span><kbd className="font-ui text-[10px] font-[450] px-1 py-0.5 rounded-[4px] whitespace-nowrap bg-field text-ink-2 shadow-[inset_0_0_0_1px_rgba(0,0,0,.05)]">{keys}</kbd></div>
            ))}
          </div>
        </Modal>
      )}

      {dialog === 'recent' && (
        <Modal title="Recent captures" subtitle="Stored privately in this browser." onClose={() => setDialog(null)}>
          {recent.length ? (
            <div className="flex flex-col gap-0.5 max-h-[46vh] overflow-y-auto scrollbar-none">
              {recent.map(capture => (
                <button key={capture.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-[6px] text-left hover:bg-panel" onClick={() => openRecent(capture)}>
                  <span className="grid place-items-center w-7 h-7 rounded-[6px] bg-field text-ink-3"><Icon name="image" size={18} /></span>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <strong className="text-app font-medium overflow-hidden whitespace-nowrap text-ellipsis">{capture.name}</strong>
                    <small className="text-[10px] text-ink-3">{captureDimensions(capture)} · {new Date(capture.createdAt).toLocaleDateString()}</small>
                  </div>
                  <Icon name="right" size={15} className="text-ink-3 ml-auto" />
                </button>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5 py-5 px-3 text-center text-ink-3">
              <Icon name="camera" size={26} />
              <h3 className="text-[13px] font-medium text-ink">No captures yet</h3>
              <p className="text-app">Take a screenshot or import an image to get started.</p>
              <button className="mt-1.5 inline-flex items-center justify-center gap-1.5 h-[30px] px-2.5 rounded-control text-app font-medium bg-accent text-white whitespace-nowrap enabled:hover:bg-accent-hover" onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} /><span>Import an image</span></button>
            </div>
          )}
        </Modal>
      )}

      {toast && (
        <div role="status" className="fixed left-1/2 bottom-11 -translate-x-1/2 z-[300] flex items-center gap-2 max-w-[min(520px,calc(100vw-24px))] py-2 pl-3 pr-2 rounded-lg bg-ink text-white text-app shadow-[0_10px_28px_rgba(0,0,0,.28)]">
          <Icon name="info" size={16} className="text-[#b9b4cc]" />
          <span>{toast}</span>
          <IconButton icon="close" label="Dismiss notification" size={22} iconSize={13} tone="inverse" onClick={() => setToast('')} />
        </div>
      )}


    </div>
  );
}
