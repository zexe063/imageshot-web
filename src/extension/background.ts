import { saveCapture, type CaptureMode, type CaptureRecord, type CaptureTile } from '../lib/capture-store'
import { readCaptureDestination } from './preferences'

const MAX_PIXELS = 48_000_000
const MAX_DIMENSION = 32_760
const MAX_TILES = 40
const MAX_ENCODED_BYTES = 56_000_000
let capturing = false
let lastCaptureAt = 0

interface PageMetrics {
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
  captureWidth: number
  captureHeight: number
  scrollX: number
  scrollY: number
}

interface PageCaptureState {
  fixed: HTMLElement[]
  cancelled: boolean
  cleanup: () => void
}

type CaptureWindow = Window & { __imageshotCaptureState?: PageCaptureState }

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/cannot access|missing host permission|extensions gallery|cannot be scripted|chrome:\/\//i.test(message)) {
    return 'This browser page cannot be captured. Open a regular website and try again.'
  }
  if (/No tab with id|frame was removed|Receiving end does not exist|tab was closed/i.test(message)) {
    return 'The page was closed or changed during capture. Open ImageShot on the page and try again.'
  }
  if (/quota|storage is full/i.test(message)) return 'Local screenshot storage is full. Remove an older screenshot or free some disk space, then try again.'
  return message || 'The screenshot could not be captured. Please try again.'
}

async function activeCaptureTab(): Promise<chrome.tabs.Tab & { id: number }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('Open the webpage you want to capture first.')
  const url = tab.url ?? ''
  if (!/^(https?:|file:)/i.test(url) || /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
    throw new Error('This browser page cannot be captured. Open a regular website and try again.')
  }
  return tab as chrome.tabs.Tab & { id: number }
}

async function assertSameTab(tab: chrome.tabs.Tab & { id: number }): Promise<void> {
  const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
  if (active?.id !== tab.id) throw new Error('Capture stopped because you switched tabs. Keep the page active until the screenshot opens.')
  const current = await chrome.tabs.get(tab.id)
  if (current.url && tab.url && current.url !== tab.url) throw new Error('The page changed during capture. Open ImageShot and try again.')
}

async function captureViewport(tab: chrome.tabs.Tab & { id: number }): Promise<string> {
  // Chromium allows two captureVisibleTab calls per second. Space every call,
  // including separate capture requests, safely beyond that rate limit.
  await delay(Math.max(0, 600 - (Date.now() - lastCaptureAt)))
  await assertSameTab(tab)
  lastCaptureAt = Date.now()
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  await assertSameTab(tab)
  return dataUrl
}

/** PNG dimensions are in IHDR; reading the header avoids decoding in the worker. */
function pngSize(dataUrl: string): { width: number; height: number } {
  const payload = dataUrl.split(',')[1]
  if (!payload || !dataUrl.startsWith('data:image/png;base64,')) throw new Error('The browser returned an unreadable screenshot.')
  const header = atob(payload.slice(0, 44))
  const read = (offset: number) => (((header.charCodeAt(offset) << 24) >>> 0) + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3))
  const width = read(16)
  const height = read(20)
  if (!width || !height) throw new Error('The browser returned an empty screenshot.')
  return { width, height }
}

function checkSize(width: number, height: number): void {
  if (width < 1 || height < 1) throw new Error('This page has no visible content to capture.')
  if (width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('This capture is too large to save (48 megapixels or 32,760 pixels per side). Choose a smaller area and try again.')
  }
}

function recordFor(tab: chrome.tabs.Tab, mode: CaptureMode, id: string): Omit<CaptureRecord, 'width' | 'height'> {
  return {
    id,
    name: (tab.title || 'Untitled screenshot').slice(0, 140),
    sourceUrl: tab.url,
    createdAt: Date.now(),
    mode,
  }
}

async function captureVisible(tab: chrome.tabs.Tab & { id: number }, id: string): Promise<CaptureRecord> {
  const dataUrl = await captureViewport(tab)
  const dimensions = pngSize(dataUrl)
  checkSize(dimensions.width, dimensions.height)
  return { ...recordFor(tab, 'visible', id), ...dimensions, dataUrl }
}

/** Runs in the tab's isolated world. Keep every browser dependency inside it. */
async function selectArea(): Promise<{ x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null> {
  if (document.querySelector('[data-imageshot-selector]')) throw new Error('An area selection is already open. Press Escape to close it.')
  return new Promise((resolve, reject) => {
    const host = document.createElement('div')
    host.setAttribute('data-imageshot-selector', '')
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;'
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `<style>
      :host { color-scheme:light; }
      * { box-sizing:border-box; }
      .overlay { position:fixed;inset:0;background:rgba(23,24,40,.32);cursor:crosshair;touch-action:none;font-family:Inter,system-ui,-apple-system,sans-serif;user-select:none; }
      .tip { position:fixed;top:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;white-space:nowrap;background:white;color:#27243b;border:1px solid #eeeaf4;border-radius:14px;padding:13px 17px;box-shadow:0 8px 32px #19132e26;font-size:13px;line-height:20px;pointer-events:none; }
      .mark { width:24px;height:24px;display:grid;place-items:center;color:#7755dc;background:#f1ecff;border-radius:7px;font-size:16px; }
      .tip strong { font-weight:600; }
      .key { border:1px solid #e5e3ec;border-radius:5px;padding:1px 5px;font-size:11px;color:#8a8798; }
      .selection { display:none;position:fixed;border:1.5px solid #fff;outline:1px solid #8162e8;box-shadow:0 0 0 99999px rgba(23,24,40,.40);pointer-events:none; }
      .dimensions { position:absolute;bottom:calc(100% + 9px);left:0;border-radius:6px;background:#292336;color:white;padding:4px 8px;font-size:11px;font-weight:500;white-space:nowrap; }
    </style><div class="overlay"><div class="tip"><span class="mark">⌗</span><strong>Drag to capture an area</strong><span class="key">esc</span><span>to cancel</span></div><div class="selection"><span class="dimensions"></span></div></div>`
    const overlay = shadow.querySelector('.overlay') as HTMLDivElement
    const selection = shadow.querySelector('.selection') as HTMLDivElement
    const dimensions = shadow.querySelector('.dimensions') as HTMLSpanElement
    const tip = shadow.querySelector('.tip') as HTMLDivElement
    let start: { x: number; y: number } | null = null
    let rectangle = { x: 0, y: 0, width: 0, height: 0 }
    let finished = false
    const stopScroll = (event: Event) => event.preventDefault()
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', stopScroll, true)
      host.remove()
    }
    const finish = async (cancelled: boolean) => {
      if (finished) return
      finished = true
      const result = { ...rectangle, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }
      cleanup()
      // Wait for the compositor to remove selection UI before taking the image.
      await new Promise<void>((done) => {
        const fallback = setTimeout(done, 120)
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); done() }))
      })
      await new Promise<void>((done) => setTimeout(done, 80))
      resolve(cancelled ? null : result)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void finish(true)
      } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.preventDefault()
    }
    const update = (event: PointerEvent) => {
      if (!start) return
      const endX = Math.max(0, Math.min(window.innerWidth, event.clientX))
      const endY = Math.max(0, Math.min(window.innerHeight, event.clientY))
      rectangle = { x: Math.min(start.x, endX), y: Math.min(start.y, endY), width: Math.abs(endX - start.x), height: Math.abs(endY - start.y) }
      Object.assign(selection.style, { display: 'block', left: `${rectangle.x}px`, top: `${rectangle.y}px`, width: `${rectangle.width}px`, height: `${rectangle.height}px` })
      dimensions.textContent = `${Math.round(rectangle.width)} × ${Math.round(rectangle.height)}`
      dimensions.style.bottom = rectangle.y < 35 ? 'auto' : 'calc(100% + 9px)'
      dimensions.style.top = rectangle.y < 35 ? 'calc(100% + 9px)' : 'auto'
    }
    overlay.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return
      event.preventDefault()
      start = { x: Math.max(0, Math.min(window.innerWidth, event.clientX)), y: Math.max(0, Math.min(window.innerHeight, event.clientY)) }
      overlay.setPointerCapture(event.pointerId)
      overlay.style.background = 'transparent'
      tip.style.display = 'none'
      update(event)
    })
    overlay.addEventListener('pointermove', update)
    overlay.addEventListener('pointerup', (event) => {
      if (!start) return
      update(event)
      if (rectangle.width < 6 || rectangle.height < 6) {
        start = null
        selection.style.display = 'none'
        tip.style.display = 'flex'
        overlay.style.background = 'rgba(23,24,40,.32)'
        return
      }
      void finish(false)
    })
    overlay.addEventListener('pointercancel', () => void finish(true))
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', stopScroll, { capture: true, passive: false })
    const timeout = setTimeout(() => {
      if (finished) return
      finished = true
      cleanup()
      reject(new Error('Area selection timed out. Open ImageShot to try again.'))
    }, 120_000)
    document.documentElement.appendChild(host)
  })
}

async function captureArea(tab: chrome.tabs.Tab & { id: number }, id: string): Promise<CaptureRecord> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectArea })
  const selection = injection?.result
  if (!selection) throw new Error('Capture cancelled.')
  const dataUrl = await captureViewport(tab)
  const bitmap = pngSize(dataUrl)
  const scaleX = bitmap.width / selection.viewportWidth
  const scaleY = bitmap.height / selection.viewportHeight
  const sourceX = Math.round(selection.x * scaleX)
  const sourceY = Math.round(selection.y * scaleY)
  const width = Math.min(bitmap.width - sourceX, Math.round(selection.width * scaleX))
  const height = Math.min(bitmap.height - sourceY, Math.round(selection.height * scaleY))
  checkSize(width, height)
  return { ...recordFor(tab, 'area', id), width, height, tiles: [{ dataUrl, sourceX, sourceY, sourceWidth: width, sourceHeight: height, x: 0, y: 0, width, height }] }
}

async function beginPageCapture(): Promise<PageMetrics> {
  const scope = window as CaptureWindow
  if (scope.__imageshotCaptureState) throw new Error('This page is already being captured.')
  if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) throw new Error('Reset pinch zoom before taking a full-page screenshot.')
  const originalScroll = { x: window.scrollX, y: window.scrollY }
  const style = document.createElement('style')
  style.textContent = 'html,body,*{scroll-behavior:auto!important;overflow-anchor:none!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}'
  document.documentElement.appendChild(style)
  const originals: { element: HTMLElement; properties: { name: string; value: string; priority: string }[] }[] = []
  const fixed: HTMLElement[] = []
  const remember = (element: HTMLElement, names: string[]) => originals.push({ element, properties: names.map((name) => ({ name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })) })
  const stopScroll = (event: Event) => event.preventDefault()
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      state.cancelled = true
      event.preventDefault()
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.preventDefault()
  }
  let watchdog = 0
  const state: PageCaptureState = {
    fixed,
    cancelled: false,
    cleanup: () => {
      clearTimeout(watchdog)
      for (const entry of originals) {
        for (const property of entry.properties) {
          if (property.value) entry.element.style.setProperty(property.name, property.value, property.priority)
          else entry.element.style.removeProperty(property.name)
        }
      }
      window.removeEventListener('wheel', stopScroll, true)
      window.removeEventListener('touchmove', stopScroll, true)
      window.removeEventListener('keydown', onKey, true)
      window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: 'instant' })
      style.remove()
      delete scope.__imageshotCaptureState
    },
  }
  scope.__imageshotCaptureState = state
  // Recover page styles even if the extension is reloaded or the worker exits.
  watchdog = window.setTimeout(() => state.cleanup(), 90_000)
  try {
    for (const element of document.querySelectorAll<HTMLElement>('body, body *')) {
      const position = getComputedStyle(element).position
      if (position === 'fixed') {
        remember(element, ['visibility'])
        fixed.push(element)
      } else if (position === 'sticky') {
        // Keep sticky content in its natural document position exactly once.
        remember(element, ['position', 'top', 'right', 'bottom', 'left'])
        element.style.setProperty('position', 'relative', 'important')
        for (const side of ['top', 'right', 'bottom', 'left']) element.style.setProperty(side, 'auto', 'important')
      }
    }
    window.addEventListener('wheel', stopScroll, { capture: true, passive: false })
    window.addEventListener('touchmove', stopScroll, { capture: true, passive: false })
    window.addEventListener('keydown', onKey, true)
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    await new Promise<void>((resolve) => {
      const fallback = setTimeout(resolve, 120)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve() }))
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 160))
    const root = document.documentElement
    const body = document.body
    return {
      width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth),
      height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight),
      viewportWidth: root.clientWidth || window.innerWidth,
      viewportHeight: root.clientHeight || window.innerHeight,
      captureWidth: window.innerWidth,
      captureHeight: window.innerHeight,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    }
  } catch (error) {
    state.cleanup()
    throw error
  }
}

async function movePageCapture(x: number, y: number, hideFixed: boolean): Promise<PageMetrics> {
  const state = (window as CaptureWindow).__imageshotCaptureState
  if (!state) throw new Error('Capture timed out. Please try a smaller area.')
  if (state.cancelled) throw new Error('Capture cancelled.')
  if (hideFixed) for (const element of state.fixed) element.style.setProperty('visibility', 'hidden', 'important')
  // Document may not scroll — inner scroller might. Try both.
  const tryScroll = (tx: number, ty: number) => {
    window.scrollTo({ left: tx, top: ty, behavior: 'instant' })
    if (Math.abs(window.scrollX - tx) > 1 || Math.abs(window.scrollY - ty) > 1) window.scrollTo({ left: tx, top: ty, behavior: 'instant' })
    let sx = tx - window.scrollX, sy = ty - window.scrollY
    if (Math.abs(sx) > 1 || Math.abs(sy) > 1) {
      for (const el of document.querySelectorAll<HTMLElement>('body, body *')) {
        if (Math.abs(sx) <= 1 && Math.abs(sy) <= 1) break
        const st = getComputedStyle(el)
        if (!/(auto|scroll|overlay)/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`)) continue
        if (Math.abs(sy) > 1 && el.scrollHeight > el.clientHeight + 1) { const b = el.scrollTop; el.scrollTop = b + sy; sy -= el.scrollTop - b }
        if (Math.abs(sx) > 1 && el.scrollWidth > el.clientWidth + 1) { const b = el.scrollLeft; el.scrollLeft = b + sx; sx -= el.scrollLeft - b }
      }
    }
  }
  tryScroll(x, y)
  await new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 120)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve() }))
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 160))
  if (state.cancelled) throw new Error('Capture cancelled.')
  const root = document.documentElement
  const body = document.body
  return {
    width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, root.clientWidth),
    height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, root.clientHeight),
    viewportWidth: root.clientWidth || window.innerWidth,
    viewportHeight: root.clientHeight || window.innerHeight,
    captureWidth: window.innerWidth,
    captureHeight: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  }
}

function finishPageCapture(): void {
  ;(window as CaptureWindow).__imageshotCaptureState?.cleanup()
}

async function captureFullPage(tab: chrome.tabs.Tab & { id: number }, id: string): Promise<CaptureRecord> {
  const tiles: CaptureTile[] = []
  let prepared = false
  try {
    const [begin] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: beginPageCapture })
    const initial = begin?.result
    if (!initial) throw new Error('Could not prepare this webpage for capture.')
    prepared = true
    let height = initial.height
    const width = initial.width
    let scaleX = 0
    let scaleY = 0
    let totalBytes = 0
    let y = 0
    while (y < height) {
      let rowHeight = Math.min(initial.viewportHeight, height - y)
      for (let x = 0; x < width; x += initial.viewportWidth) {
        if (tiles.length >= MAX_TILES) throw new Error('This page is too long or keeps loading new content. Capture a smaller area or the visible page instead.')
        await assertSameTab(tab)
        const [step] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: movePageCapture, args: [x, y, tiles.length > 0] })
        const metrics = step?.result
        if (!metrics) throw new Error('The page stopped responding during capture.')
        if (metrics.captureWidth !== initial.captureWidth || metrics.captureHeight !== initial.captureHeight || metrics.viewportWidth !== initial.viewportWidth || metrics.viewportHeight !== initial.viewportHeight) {
          throw new Error('The browser was resized during capture. Keep its size unchanged and try again.')
        }
        if (Math.abs(metrics.width - width) > 2) throw new Error('This page changed its layout during capture. Wait for it to finish loading, then try again.')
        height = Math.max(height, metrics.height)
        if (x === 0) rowHeight = Math.min(initial.viewportHeight, height - y)
        const dataUrl = await captureViewport(tab)
        const bitmap = pngSize(dataUrl)
        const currentScaleX = bitmap.width / initial.captureWidth
        const currentScaleY = bitmap.height / initial.captureHeight
        if (scaleX && (Math.abs(scaleX - currentScaleX) > 0.01 || Math.abs(scaleY - currentScaleY) > 0.01)) throw new Error('Display scaling changed during capture. Keep the browser on the same display and try again.')
        scaleX = currentScaleX
        scaleY = currentScaleY
        // No canvas exists yet: the editor shrinks the composed image to fit, so an
        // over-long page is captured at full resolution instead of being refused.
        totalBytes += dataUrl.length * 0.75
        if (totalBytes > MAX_ENCODED_BYTES) throw new Error('This image-heavy page is too large to capture at once. Choose a smaller area instead.')
        const pieceWidth = Math.min(initial.viewportWidth, width - x)
        // Slot = where this row belongs in the finished image. Source = where it is in the frame we just shot.
        // They differ when the page didn't scroll exactly as asked — clip & stitch, don't bail.
        const slotX = Math.round(x * scaleX)
        const slotY = Math.round(y * scaleY)
        const slotW = Math.round((x + pieceWidth) * scaleX) - slotX
        const slotH = Math.round((y + rowHeight) * scaleY) - slotY
        const rawSX = Math.round((x - metrics.scrollX) * scaleX)
        const rawSY = Math.round((y - metrics.scrollY) * scaleY)
        const left = Math.max(0, Math.min(bitmap.width, rawSX))
        const top = Math.max(0, Math.min(bitmap.height, rawSY))
        const right = Math.max(left, Math.min(bitmap.width, rawSX + slotW))
        const bottom = Math.max(top, Math.min(bitmap.height, rawSY + slotH))
        const w = Math.min(slotW, right - left), h = Math.min(slotH, bottom - top)
        if (w > 0 && h > 0) {
          tiles.push({
            dataUrl,
            sourceX: left, sourceY: top, sourceWidth: w, sourceHeight: h,
            x: slotX + Math.max(0, left - rawSX), y: slotY + Math.max(0, top - rawSY),
            width: w, height: h,
          })
        }
      }
      y += rowHeight
      // Re-check after capture: lazy content may extend the document while the
      // browser encodes the PNG. Advancing by rowHeight keeps partial rows gapless.
      const [latest] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
      })
      height = Math.max(height, latest?.result ?? height)
    }
    return { ...recordFor(tab, 'full', id), width: Math.round(width * scaleX), height: Math.round(height * scaleY), tiles }
  } finally {
    if (prepared) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: finishPageCapture })
      } catch {
        // Navigation removes the old document, including its temporary styles.
      }
    }
  }
}

async function showCaptureError(tabId: number, message: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text: string) => {
        document.querySelector('[data-imageshot-notice]')?.remove()
        const host = document.createElement('div')
        host.setAttribute('data-imageshot-notice', '')
        host.style.cssText = 'all:initial!important;position:fixed!important;bottom:24px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;max-width:calc(100vw - 48px)!important;'
        const shadow = host.attachShadow({ mode: 'closed' })
        const box = document.createElement('div')
        box.setAttribute('role', 'alert')
        box.style.cssText = 'font:13px/1.6 system-ui,sans-serif;color:#322b40;background:white;border:1px solid #e7e2ee;border-radius:12px;box-shadow:0 8px 35px #25184325;padding:14px 20px;max-width:460px;'
        const heading = document.createElement('strong')
        heading.textContent = 'ImageShot · '
        box.append(heading, document.createTextNode(text))
        shadow.appendChild(box)
        document.documentElement.appendChild(host)
        setTimeout(() => host.remove(), 8500)
      },
      args: [message],
    })
  } catch {
    // The popup also receives the error if the page cannot be scripted.
  }
}

/** What the in-page panel needs to show a capture and copy it. */
interface CapturePanelPayload {
  id: string
  width: number
  height: number
  dataUrl?: string
  tiles?: CaptureTile[]
}

/**
 * Runs in the tab's isolated world and puts the finished screenshot on the page, so a
 * capture can be copied without leaving what was captured. Keep every browser
 * dependency inside it, and nothing from this module: it is sent as source text.
 */

async function showCapturePanel(payload: CapturePanelPayload): Promise<void> {
  document.querySelector('[data-imageshot-capture]')?.remove()
  const host = document.createElement('div')
  host.setAttribute('data-imageshot-capture', '')
  host.style.cssText = 'all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Geist:wght@500;600&display=swap" rel="stylesheet">
<style>
  :host { color-scheme:light; }
  * { box-sizing:border-box; }
  .wrap{
    width:250px; height:200px; border-radius:12px; overflow:hidden; background:#1a1a1f;
    border:1px solid rgba(255,255,255,0.08);
    box-shadow: 0 0 0 0.5px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.24), 0 12px 28px rgba(0,0,0,0.32);
    -webkit-font-smoothing:antialiased;
  }
  .shot{position:relative; width:250px; height:200px; display:grid; place-items:center; background:#0B0B12; line-height:0;}
  .picture{position:relative; width:250px; height:200px; display:grid; place-items:center; line-height:0;}
  .picture canvas{display:block; max-width:250px; max-height:200px; width:auto; height:auto; object-fit:contain;}
  .overlay{
    position:absolute;inset:0;display:grid;place-items:center;
    background:rgba(12,12,16,0.44); opacity:0; pointer-events:none; transition:opacity .18s ease;
  }
  .wrap:hover .overlay{opacity:1;pointer-events:auto}
  .stack{display:flex;flex-direction:column;gap:8px;align-items:center;}
  .pill{
    height:30px; min-width:84px; padding:0 18px; border-radius:99px;
    background:#f0f0f3; color:#111113; border:none;
    font-family:'Geist','Inter',-apple-system,system-ui,sans-serif;
    font-size:13px; font-weight:500; letter-spacing:-0.01em;
    box-shadow:0 1px 2px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.12);
    cursor:pointer; display:inline-flex; align-items:center; justify-content:center;
    transition: background .15s ease;
  }
  .pill:hover{background:#ffffff;}
  .pill:disabled{opacity:.6; cursor:not-allowed;}
  .corner{
    position:absolute;width:24px;height:24px;display:grid;place-items:center;
    border-radius:50%; background:#f0f0f3; color:#111113; border:none;
    box-shadow:0 1px 3px rgba(0,0,0,0.22); cursor:pointer; transition: background .15s ease;
  }
  .corner:hover{background:#fff;}
  .corner.tl{top:8px;left:8px} .corner.tr{top:8px;right:8px}
  .working{width:250px; height:200px; display:grid; place-items:center; font-family:'Geist','Inter',sans-serif; font-size:12.5px; font-weight:500; color:#8e8e93; background:#14141a}
  .more{position:absolute; left:0; right:0; bottom:0; padding:16px 10px 8px; background:linear-gradient(transparent,rgba(16,12,32,.72)); color:#fff; font-family:'Geist','Inter',sans-serif; font-size:10px; text-align:center;}
  .more[hidden]{display:none;}
  .note{margin:0; padding:6px 10px; font-family:'Geist','Inter',sans-serif; font-size:10.5px; color:#a9a6b4; background:#fff;}
  .note[hidden]{display:none;}
</style>
<div class="wrap" role="dialog" aria-label="ImageShot capture">
  <div class="shot">
    <div class="picture">
      <div class="working">Preparing your screenshot…</div>
      <div class="more" hidden>Top of a long page</div>
    </div>
    <div class="overlay">
      <button class="corner tl" type="button" data-close aria-label="Close">
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
      <button class="corner tr" type="button" data-studio aria-label="Expand">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 h5.5 v5.5"/><path d="M8.2 7.8L12.8 3.2"/><path d="M12.8 9.2V12.8H3.2V3.2H6.8"/></svg>
      </button>
      <div class="stack">
        <button class="pill" type="button" data-copy>Copy</button>
        <button class="pill" type="button" data-save-main>Save</button>
      </div>
    </div>
  </div>
  <p class="note" hidden></p>
</div>`
  document.documentElement.appendChild(host)

  const panel = shadow.querySelector('.wrap') as HTMLDivElement
  const working = shadow.querySelector('.working') as HTMLDivElement
  const more = shadow.querySelector('.more') as HTMLDivElement
  const note = shadow.querySelector('.note') as HTMLParagraphElement
  const copyButton = shadow.querySelector('[data-copy]') as HTMLButtonElement
  const saveButton = shadow.querySelector('[data-save-main]') as HTMLButtonElement
  const studioButton = shadow.querySelector('[data-studio]') as HTMLButtonElement

  const canCopy = window.isSecureContext && typeof navigator.clipboard?.write === 'function'
  if (!canCopy) {
    copyButton.disabled = true
    note.hidden = false
    note.textContent = 'Copying needs an HTTPS page. Open the Studio to copy this one.'
  }

  let dismissTimer = 0
  const close = () => {
    clearTimeout(dismissTimer)
    document.removeEventListener('keydown', onKey, true)
    host.remove()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
    close()
  }
  const armDismiss = (delay: number) => {
    clearTimeout(dismissTimer)
    dismissTimer = window.setTimeout(close, delay)
  }
  document.addEventListener('keydown', onKey, true)
  panel.addEventListener('pointerenter', () => armDismiss(120000))
  panel.addEventListener('pointerleave', () => armDismiss(9000))
  armDismiss(30000)
  shadow.querySelector('[data-close]')?.addEventListener('click', close)

  const openStudio = () => {
    close()
    chrome.runtime.sendMessage({ type: 'IMAGESHOT_OPEN_STUDIO', id: payload.id })?.catch?.(() => undefined)
  }
  studioButton.addEventListener('click', openStudio)

  const fitScale = (width: number, height: number) => {
    if (!(width > 0) || !(height > 0)) return 1
    return Math.min(1, Math.sqrt(48_000_000 / (width * height)), 32_000 / width, 32_000 / height)
  }
  const drawTile = (context: CanvasRenderingContext2D, image: CanvasImageSource, tile: { sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number; x: number; y: number; width: number; height: number }, scale: number) => {
    const x = Math.round(tile.x * scale)
    const y = Math.round(tile.y * scale)
    context.drawImage(image, tile.sourceX, tile.sourceY, tile.sourceWidth, tile.sourceHeight, x, y, Math.max(1, Math.round((tile.x + tile.width) * scale) - x), Math.max(1, Math.round((tile.y + tile.height) * scale) - y))
  }
  const decode = async (dataUrl: string) => {
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    return image
  }
  const compose = async (): Promise<Blob> => {
    if (payload.dataUrl) return await (await fetch(payload.dataUrl)).blob()
    const tiles = payload.tiles ?? []
    if (!tiles.length) throw new Error('This screenshot has no image data.')
    const scale = fitScale(payload.width, payload.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(payload.width * scale))
    canvas.height = Math.max(1, Math.floor(payload.height * scale))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('The browser could not create the screenshot canvas.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    try {
      for (const tile of tiles) {
        const image = await decode(tile.dataUrl)
        drawTile(context, image, tile, scale)
        image.src = ''
      }
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, 'image/png'))
      if (!blob) throw new Error('The browser could not render this screenshot.')
      return blob
    } finally {
      canvas.width = 1
      canvas.height = 1
    }
  }

  copyButton.addEventListener('click', () => {
    copyButton.disabled = true
    copyButton.textContent = 'Copying…'
    const pending = compose()
    navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })]).then(
      () => {
        copyButton.textContent = 'Copied'
        window.setTimeout(close, 900)
      },
      () => {
        copyButton.disabled = false
        copyButton.textContent = 'Copy'
        note.hidden = false
        note.textContent = 'The browser would not copy this image. Open in Studio to copy it there.'
      },
    )
  })

  saveButton.addEventListener('click', async () => {
    saveButton.disabled = true
    saveButton.textContent = 'Saving…'
    try {
      const blob = await compose()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'imageshot-' + Date.now() + '.png'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      saveButton.textContent = 'Saved'
      window.setTimeout(close, 800)
    } catch {
      saveButton.disabled = false
      saveButton.textContent = 'Save'
    }
  })

  try {
    const FRAME_W = 250
    const FRAME_H = 200
    const scale = Math.min(FRAME_W / payload.width, FRAME_H / payload.height, 1)
    const displayWidth = Math.max(1, Math.floor(payload.width * scale))
    const displayHeight = Math.max(1, Math.floor(payload.height * scale))
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(displayWidth * pixelRatio))
    canvas.height = Math.max(1, Math.round(displayHeight * pixelRatio))
    canvas.style.width = displayWidth + 'px'
    canvas.style.height = displayHeight + 'px'
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('The browser could not create the screenshot canvas.')
    context.imageSmoothingQuality = 'high'
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const renderScale = canvas.width / payload.width
    if (payload.dataUrl) {
      const image = await decode(payload.dataUrl)
      if (!host.isConnected) { image.src = ''; return }
      context.drawImage(image, 0, 0, payload.width, payload.height, 0, 0, canvas.width, canvas.height)
      image.src = ''
    } else {
      for (const tile of payload.tiles ?? []) {
        if (tile.y * renderScale >= canvas.height || tile.x * renderScale >= canvas.width) continue
        const image = await decode(tile.dataUrl)
        if (!host.isConnected) { image.src = ''; return }
        drawTile(context, image, tile, renderScale)
        image.src = ''
      }
    }
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', 'Screenshot, ' + payload.width + ' by ' + payload.height + ' pixels')
    working.replaceWith(canvas)
  } catch {
    working.textContent = 'The preview could not be drawn.'
  }
}


/** Shows the finished capture on the page it was taken from. */
async function openCapturePanel(tabId: number, record: CaptureRecord): Promise<void> {
  const payload: CapturePanelPayload = {
    id: record.id,
    width: record.width,
    height: record.height,
    ...(record.dataUrl ? { dataUrl: record.dataUrl } : {}),
    ...(record.tiles ? { tiles: record.tiles } : {}),
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showCapturePanel, args: [payload] })
  } catch {
    // A page that cannot be scripted still has its capture saved; the Studio can open it.
  }
}

/** `pending` tells the editor its capture has not been written yet, so it waits. */
function editorUrl(id: string, pending: boolean): string {
  const query = new URLSearchParams({ capture: id })
  if (pending) query.set('pending', '1')
  return chrome.runtime.getURL(`editor.html?${query}`)
}

async function performCapture(mode: CaptureMode): Promise<string> {
  if (capturing) throw new Error('A capture is already in progress. Finish it or press Escape on the page.')
  capturing = true
  let tabId: number | undefined
  let editorTabId: number | undefined
  let stored = false
  try {
    const tab = await activeCaptureTab()
    tabId = tab.id
    const id = crypto.randomUUID()
    const destination = await readCaptureDestination()
    if (destination === 'studio') {
      try { editorTabId = (await chrome.tabs.create({ url: editorUrl(id, true), active: false })).id } catch { editorTabId = undefined }
    }
    const record = mode === 'area' ? await captureArea(tab, id) : mode === 'full' ? await captureFullPage(tab, id) : await captureVisible(tab, id)
    await saveCapture(record)
    stored = true
    if (destination === 'panel') {
      await openCapturePanel(tab.id, record)
    } else {
      if (editorTabId === undefined) editorTabId = (await chrome.tabs.create({ url: editorUrl(id, false) })).id
      else try { await chrome.tabs.update(editorTabId, { active: true }) } catch {}
    }
    return id
  } catch (error) {
    const msg = readableError(error)
    if (tabId && msg !== 'Capture cancelled.') await showCaptureError(tabId, msg)
    if (editorTabId !== undefined && !stored) try { await chrome.tabs.remove(editorTabId) } catch {}
    throw new Error(msg)
  } finally { capturing = false }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false
  if (sender.id !== chrome.runtime.id) return false
  if (message.type === 'IMAGESHOT_OPEN_STUDIO') {
    const id = 'id' in message ? message.id : undefined
    if (typeof id !== 'string') return false
    void chrome.tabs.create({ url: editorUrl(id, false) })
    return false
  }
  if (message.type !== 'IMAGESHOT_CAPTURE') return false
  const mode = 'mode' in message ? message.mode : undefined
  if (mode !== 'area' && mode !== 'visible' && mode !== 'full') {
    sendResponse({ ok: false, error: 'Choose an area, visible page, or full page capture.' })
    return false
  }
  void performCapture(mode as CaptureMode).then(id => sendResponse({ ok: true, id })).catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  return true
})

// Keyboard shortcuts from manifest (Alt+Shift+A / Alt+Shift+F) — full page now truly scrolls the whole site
chrome.commands?.onCommand?.addListener((command) => {
  const mode: CaptureMode | null = command === 'capture-full' ? 'full' : command === 'capture-display' ? 'visible' : null
  if (!mode) return
  void performCapture(mode).catch(()=>{})
})
