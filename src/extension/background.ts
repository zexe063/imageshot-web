import { saveCapture, type CaptureMode, type CaptureRecord, type CaptureTile } from '../lib/capture-store'
import { readAutoCopy, readCaptureDestination, readFileFormat, readFreezeScreen, readTheme } from './preferences'
import geistFontData from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?inline'

const MAX_PIXELS = 48_000_000
const MAX_DIMENSION = 32_760
const MAX_TILES = 80
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
  offsetX: number
  offsetY: number
}

interface PageCaptureState {
  cancelled: boolean
  measure: () => PageMetrics
  move: (x: number, y: number, hideFixed: boolean) => Promise<PageMetrics>
  cleanup: () => void
}

type CaptureWindow = Window & { __imageshotCaptureState?: PageCaptureState }

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/** Load the same bundled UI face in pages that do not have the editor stylesheet. */
async function loadCaptureFont(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async (data: string) => {
      const family = 'ImageShot Geist'
      if ([...document.fonts].some(font => font.family === family && font.status === 'loaded')) return
      // A binary FontFace avoids depending on the website's font URLs or font-src policy.
      const bytes = Uint8Array.from(atob(data.slice(data.indexOf(',') + 1)), character => character.charCodeAt(0))
      const face = new FontFace(family, bytes, { style: 'normal', weight: '100 900' })
      document.fonts.add(await face.load())
    },
    args: [geistFontData],
  })
}

function readableError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/Capture cancelled\./.test(message)) return 'Capture cancelled.'
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
  await delay(Math.max(0, 520 - (Date.now() - lastCaptureAt)))
  await assertSameTab(tab)
  lastCaptureAt = Date.now()
  let dataUrl: string
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  } catch (error) {
    // Other extension activity can consume the browser quota. Retry once, without
    // moving the page or losing the frame that has already finished painting.
    if (!/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|captureVisibleTab.*quota|too many.*capture|rate limit/i.test(String(error))) throw error
    await delay(550)
    await assertSameTab(tab)
    lastCaptureAt = Date.now()
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  }
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

interface AreaViewport {
  viewportWidth: number
  viewportHeight: number
  pixelRatio: number
  viewportScale: number
}

interface FrozenAreaFrame extends AreaViewport {
  dataUrl: string
}

/** Runs before the frozen image is taken, without adding any selection UI. */
function measureAreaViewport(): AreaViewport {
  const viewportScale = window.visualViewport?.scale ?? 1
  if (Math.abs(viewportScale - 1) > 0.01) throw new Error('Reset pinch zoom before using Freeze screen capture.')
  return { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, pixelRatio: window.devicePixelRatio, viewportScale }
}

/** Runs in the tab's isolated world. Keep every browser dependency inside it. */
async function selectArea(theme: 'light' | 'dark' | 'system', frozenFrame: FrozenAreaFrame | null): Promise<{ x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number } | null> {
  if (document.querySelector('[data-imageshot-selector]')) throw new Error('An area selection is already open. Press Escape to close it.')
  const viewport = frozenFrame ?? { viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, pixelRatio: window.devicePixelRatio, viewportScale: window.visualViewport?.scale ?? 1 }
  const viewportChanged = () => window.innerWidth !== viewport.viewportWidth || window.innerHeight !== viewport.viewportHeight || window.devicePixelRatio !== viewport.pixelRatio || Math.abs((window.visualViewport?.scale ?? 1) - viewport.viewportScale) > 0.01
  const viewportError = 'The window size or zoom changed during capture. Start a new area capture.'
  if (viewportChanged()) throw new Error(viewportError)
  return new Promise((resolve, reject) => {
    const host = document.createElement('div')
    host.setAttribute('data-imageshot-selector', '')
    host.dataset.theme = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;display:block!important;'
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `<style>
      :host { color-scheme:light; --panel:#fff; --ink:#27243b; --border:#eeeaf4; --muted:#8a8798; --accent:#7755dc; --accent-bg:#f1ecff; }
      :host([data-theme="dark"]) { color-scheme:dark; --panel:#24242c; --ink:#f0f0f6; --border:#464650; --muted:#b5b5c5; --accent:#b7a4ff; --accent-bg:#39304e; }
      * { box-sizing:border-box; }
      .frozen-frame { position:fixed;inset:0;width:100%;height:100%;pointer-events:none; }
      .overlay { position:fixed;inset:0;background:rgba(23,24,40,.32);cursor:crosshair;touch-action:none;font-family:'ImageShot Geist',sans-serif;user-select:none; }
      .tip { position:fixed;top:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;white-space:nowrap;background:var(--panel);color:var(--ink);border:1px solid var(--border);border-radius:14px;padding:13px 17px;box-shadow:0 8px 32px #19132e26;font-size:13px;line-height:20px;pointer-events:none; }
      .mark { width:24px;height:24px;display:grid;place-items:center;color:var(--accent);background:var(--accent-bg);border-radius:7px;font-size:16px; }
      .tip strong { font-weight:600; }
      .key { border:1px solid var(--border);border-radius:5px;padding:1px 5px;font-size:11px;color:var(--muted); }
      .selection { display:none;position:fixed;border:1.5px solid #fff;outline:1px solid #8162e8;box-shadow:0 0 0 99999px rgba(23,24,40,.40);pointer-events:none; }
      .dimensions { position:absolute;bottom:calc(100% + 9px);left:0;border-radius:6px;background:#292336;color:white;padding:4px 8px;font-size:11px;font-weight:500;white-space:nowrap; }
    </style><div class="overlay"><div class="tip"><span class="mark">⌗</span><strong>Drag to capture an area</strong><span class="key">esc</span><span>to cancel</span></div><div class="selection"><span class="dimensions"></span></div></div>`
    const overlay = shadow.querySelector('.overlay') as HTMLDivElement
    const selection = shadow.querySelector('.selection') as HTMLDivElement
    const dimensions = shadow.querySelector('.dimensions') as HTMLSpanElement
    const tip = shadow.querySelector('.tip') as HTMLDivElement
    if (frozenFrame) tip.querySelector('strong')!.textContent = 'Screen frozen. Drag to capture'
    let start: { x: number; y: number } | null = null
    let rectangle = { x: 0, y: 0, width: 0, height: 0 }
    let finished = false
    let frameCanvas: HTMLCanvasElement | null = null
    const stopScroll = (event: Event) => event.preventDefault()
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', stopScroll, true)
      window.removeEventListener('resize', onResize)
      window.visualViewport?.removeEventListener('resize', onResize)
      host.remove()
      if (frameCanvas) { frameCanvas.width = 0; frameCanvas.height = 0; frameCanvas = null }
    }
    const fail = (error: unknown) => {
      if (finished) return
      finished = true
      cleanup()
      reject(error)
    }
    const onResize = () => {
      if (viewportChanged()) fail(new Error(viewportError))
    }
    const finish = async (cancelled: boolean) => {
      if (finished) return
      if (!cancelled && viewportChanged()) { fail(new Error(viewportError)); return }
      finished = true
      const result = { ...rectangle, viewportWidth: viewport.viewportWidth, viewportHeight: viewport.viewportHeight }
      cleanup()
      // A live capture must wait for the compositor to remove selection UI. A
      // frozen capture already owns its pixels and never takes a second frame.
      if (!cancelled && !frozenFrame) {
        await new Promise<void>((done) => {
          const fallback = setTimeout(done, 120)
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); done() }))
        })
        await new Promise<void>((done) => setTimeout(done, 80))
      }
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
    window.addEventListener('resize', onResize)
    window.visualViewport?.addEventListener('resize', onResize)
    const timeout = setTimeout(() => fail(new Error('Area selection timed out. Open ImageShot to try again.')), 120_000)
    const show = async () => {
      if (frozenFrame) {
        // Decode bytes directly so a website's img-src policy cannot block the
        // frozen background. Canvas also avoids another encoded image copy.
        const bytes = Uint8Array.from(atob(frozenFrame.dataUrl.split(',')[1]), character => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
        try {
          if (finished) return
          frameCanvas = document.createElement('canvas')
          frameCanvas.className = 'frozen-frame'
          frameCanvas.setAttribute('aria-hidden', 'true')
          frameCanvas.width = bitmap.width
          frameCanvas.height = bitmap.height
          const context = frameCanvas.getContext('2d')
          if (!context) throw new Error('The frozen screen could not be displayed. Try capturing again.')
          context.drawImage(bitmap, 0, 0)
          shadow.insertBefore(frameCanvas, overlay)
        } finally { bitmap.close() }
        if (viewportChanged()) throw new Error(viewportError)
      }
      if (!finished) document.documentElement.appendChild(host)
    }
    void show().catch(fail)
  })
}

async function captureArea(tab: chrome.tabs.Tab & { id: number }, id: string): Promise<CaptureRecord> {
  const [theme, freezeScreen] = await Promise.all([readTheme(), readFreezeScreen()])
  let frozenFrame: FrozenAreaFrame | null = null
  if (freezeScreen) {
    const [measurement] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: measureAreaViewport })
    if (!measurement?.result) throw new Error('The page changed during capture. Try capturing again.')
    const dataUrl = await captureViewport(tab)
    const dimensions = pngSize(dataUrl)
    checkSize(dimensions.width, dimensions.height)
    frozenFrame = { ...measurement.result, dataUrl }
  }
  await loadCaptureFont(tab.id)
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: selectArea, args: [theme, frozenFrame] })
  const selection = injection?.result
  if (!selection) throw new Error('Capture cancelled.')
  if (frozenFrame) await assertSameTab(tab)
  const dataUrl = frozenFrame?.dataUrl ?? await captureViewport(tab)
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
  const root = document.documentElement
  const body = document.body
  // Only the scrolling element defines the reachable document. A body's own
  // scroll size can include clipped carousel/decorative content (e.g. CleanShot)
  // or space shifted outside the page by negative margins.
  const documentScroller = document.scrollingElement ?? root
  const originalScroll = { x: window.scrollX, y: window.scrollY }
  const originals: { element: HTMLElement; properties: { name: string; value: string; priority: string }[] }[] = []
  const fixed: HTMLElement[] = []
  const sticky: HTMLElement[] = []
  const remember = (element: HTMLElement, names: string[]) => originals.push({ element, properties: names.map((name) => ({ name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) })) })

  // Choose one surface once. Mixing window coordinates with an arbitrary inner
  // scroller loses whole rows on apps whose document never scrolls.
  let scroller: HTMLElement | null = null
  let largestArea = 0
  const windowHeight = root.clientHeight || window.innerHeight
  const windowWidth = root.clientWidth || window.innerWidth
  const documentHeight = Math.max(documentScroller.scrollHeight, windowHeight)
  const canUseInnerScroller = documentHeight <= windowHeight + 2 || getComputedStyle(root).overflowY === 'hidden' || (body && getComputedStyle(body).overflowY === 'hidden')
  // Read layout in a single pass, before changing sticky styles.
  for (const element of document.querySelectorAll<HTMLElement>('body, body *')) {
    const computed = getComputedStyle(element)
    if (computed.position === 'fixed') fixed.push(element)
    else if (computed.position === 'sticky') sticky.push(element)
    if (!canUseInnerScroller || !/(auto|scroll|overlay)/.test(computed.overflowY) || element.scrollHeight <= element.clientHeight + 2) continue
    const rect = element.getBoundingClientRect()
    const left = rect.left + element.clientLeft
    const top = rect.top + element.clientTop
    // A sidebar or a clipped/off-screen box is not the page's primary content.
    if (element.clientWidth < windowWidth * .45 || element.clientHeight < windowHeight * .4 || left < -1 || top < -1 || left + element.clientWidth > windowWidth + 1 || top + element.clientHeight > windowHeight + 1) continue
    // Scaling/rotating a scroll surface changes CSS-to-screen coordinates.
    if (Math.abs(rect.width - element.offsetWidth) > 2 || Math.abs(rect.height - element.offsetHeight) > 2) continue
    const area = element.clientWidth * element.clientHeight
    if (area > largestArea) { largestArea = area; scroller = element }
  }
  const originalInnerScroll = scroller ? { x: scroller.scrollLeft, y: scroller.scrollTop } : null
  const style = document.createElement('style')
  style.textContent = 'html,body,*{scroll-behavior:auto!important;scroll-snap-type:none!important;overflow-anchor:none!important}*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}'
  root.appendChild(style)
  const stopScroll = (event: Event) => event.preventDefault()
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      state.cancelled = true
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) event.preventDefault()
  }
  let watchdog = 0
  let cleaned = false
  let fixedHidden = false
  const afterPaint = () => new Promise<void>((resolve) => {
    const fallback = setTimeout(resolve, 100)
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve() }))
  })
  const measure = (): PageMetrics => {
    if (scroller && !scroller.isConnected) throw new Error('The page changed during capture. Wait for it to finish loading and try again.')
    const rect = scroller?.getBoundingClientRect()
    return {
      width: scroller ? scroller.scrollWidth : Math.max(documentScroller.scrollWidth, windowWidth),
      height: scroller ? scroller.scrollHeight : Math.max(documentScroller.scrollHeight, windowHeight),
      viewportWidth: scroller ? scroller.clientWidth : root.clientWidth || window.innerWidth,
      viewportHeight: scroller ? scroller.clientHeight : root.clientHeight || window.innerHeight,
      captureWidth: window.innerWidth,
      captureHeight: window.innerHeight,
      scrollX: scroller ? scroller.scrollLeft : window.scrollX,
      scrollY: scroller ? scroller.scrollTop : window.scrollY,
      offsetX: rect ? rect.left + scroller!.clientLeft : 0,
      offsetY: rect ? rect.top + scroller!.clientTop : 0,
    }
  }
  const state: PageCaptureState = {
    cancelled: false,
    measure,
    move: async (x, y, hideFixed) => {
      if (state.cancelled) throw new Error('Capture cancelled.')
      clearTimeout(watchdog)
      watchdog = window.setTimeout(() => state.cleanup(), 90_000)
      if (hideFixed && !fixedHidden) {
        for (const element of fixed) {
          // A fixed app shell can contain the chosen scroller; hiding it would
          // hide the entire screenshot, including all of its descendants.
          if (!scroller || (!element.contains(scroller) && scroller.contains(element))) element.style.setProperty('visibility', 'hidden', 'important')
        }
        fixedHidden = true
      }
      if (scroller) scroller.scrollTo({ left: x, top: y, behavior: 'instant' })
      else window.scrollTo({ left: x, top: y, behavior: 'instant' })
      await afterPaint()
      // Let IntersectionObserver/scroll handlers commit visible lazy content.
      // Actual image decoding is bounded; a broken image must never stall a page.
      await new Promise<void>((resolve) => setTimeout(resolve, 40))
      const metrics = measure()
      const pendingImages = [...document.images].filter((image) => {
        if (image.complete || (scroller && !scroller.contains(image))) return false
        const rect = image.getBoundingClientRect()
        return rect.bottom > metrics.offsetY && rect.top < metrics.offsetY + metrics.viewportHeight && rect.right > metrics.offsetX && rect.left < metrics.offsetX + metrics.viewportWidth
      })
      if (pendingImages.length) {
        await Promise.race([
          Promise.allSettled(pendingImages.map((image) => image.decode())),
          new Promise<void>((resolve) => setTimeout(resolve, 450)),
        ])
        await afterPaint()
      }
      if (state.cancelled) throw new Error('Capture cancelled.')
      return measure()
    },
    cleanup: () => {
      if (cleaned) return
      cleaned = true
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
      if (scroller && originalInnerScroll) scroller.scrollTo({ left: originalInnerScroll.x, top: originalInnerScroll.y, behavior: 'instant' })
      window.scrollTo({ left: originalScroll.x, top: originalScroll.y, behavior: 'instant' })
      style.remove()
      delete scope.__imageshotCaptureState
    },
  }
  scope.__imageshotCaptureState = state
  try {
    for (const element of fixed) remember(element, ['visibility'])
    for (const element of sticky) {
      if (scroller && !scroller.contains(element)) continue
      remember(element, ['position', 'top', 'right', 'bottom', 'left'])
      element.style.setProperty('position', 'relative', 'important')
      for (const side of ['top', 'right', 'bottom', 'left']) element.style.setProperty(side, 'auto', 'important')
    }
    window.addEventListener('wheel', stopScroll, { capture: true, passive: false })
    window.addEventListener('touchmove', stopScroll, { capture: true, passive: false })
    window.addEventListener('keydown', onKey, true)
    return await state.move(0, 0, false)
  } catch (error) {
    state.cleanup()
    throw error
  }
}

async function movePageCapture(x: number, y: number, hideFixed: boolean): Promise<PageMetrics> {
  const state = (window as CaptureWindow).__imageshotCaptureState
  if (!state) throw new Error('Capture timed out. Please try a smaller area.')
  return state.move(x, y, hideFixed)
}

function readPageCapture(): PageMetrics {
  const state = (window as CaptureWindow).__imageshotCaptureState
  if (!state) throw new Error('Capture timed out. Please try a smaller area.')
  if (state.cancelled) throw new Error('Capture cancelled.')
  return state.measure()
}

function finishPageCapture(): void {
  ;(window as CaptureWindow).__imageshotCaptureState?.cleanup()
}

async function captureProgress(tabId: number, completed: number, total: number): Promise<void> {
  if (!chrome.action) return
  const progress = Math.min(99, Math.round(completed / Math.max(1, total) * 100))
  try {
    await Promise.all([
      chrome.action.setBadgeText({ tabId, text: `${progress}%` }),
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#7755dc' }),
      chrome.action.setTitle({ tabId, title: `ImageShot: capturing ${completed} of ${total} sections. Press Escape on the page to cancel.` }),
    ])
  } catch { /* A closed tab has no toolbar to update. */ }
}

async function captureFullPage(tab: chrome.tabs.Tab & { id: number }, id: string): Promise<CaptureRecord> {
  const tiles: CaptureTile[] = []
  let prepared = false
  try {
    const [begin] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: beginPageCapture })
    const initial = begin?.result
    if (!initial) throw new Error('Could not prepare this webpage for capture.')
    prepared = true
    if (initial.viewportWidth < 1 || initial.viewportHeight < 1) throw new Error('This page has no visible content to capture.')
    let height = initial.height
    const width = initial.width
    let scaleX = 0
    let scaleY = 0
    let totalBytes = 0
    let y = 0
    const expectedTiles = () => Math.ceil(width / initial.viewportWidth) * Math.ceil(height / initial.viewportHeight)
    await captureProgress(tab.id, 0, expectedTiles())
    while (y < height) {
      let rowHeight = Math.min(initial.viewportHeight, height - y)
      let latestMetrics = initial
      for (let x = 0; x < width; x += initial.viewportWidth) {
        if (tiles.length >= MAX_TILES || expectedTiles() > MAX_TILES) throw new Error('This page is too long or keeps loading new content. Capture a smaller area or the visible page instead.')
        await assertSameTab(tab)
        // Preparation already scrolled and painted the first frame.
        const [step] = tiles.length === 0 ? [{ result: initial }] : await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: movePageCapture, args: [x, y, true] })
        const metrics = step?.result
        if (!metrics) throw new Error('The page stopped responding during capture.')
        if (metrics.captureWidth !== initial.captureWidth || metrics.captureHeight !== initial.captureHeight || metrics.viewportWidth !== initial.viewportWidth || metrics.viewportHeight !== initial.viewportHeight || Math.abs(metrics.offsetX - initial.offsetX) > 1 || Math.abs(metrics.offsetY - initial.offsetY) > 1) {
          throw new Error('The browser or page was resized during capture. Keep its size unchanged and try again.')
        }
        if (Math.abs(metrics.width - width) > 2 || metrics.height < height - 2) throw new Error('This page changed its layout during capture. Wait for it to finish loading, then try again.')
        height = Math.max(height, metrics.height)
        if (x === 0) rowHeight = Math.min(initial.viewportHeight, height - y)
        const pieceWidth = Math.min(initial.viewportWidth, width - x)
        const sourceCssX = x - metrics.scrollX
        const sourceCssY = y - metrics.scrollY
        // A blocked/custom scroll handler must fail explicitly rather than save
        // an apparently successful image with missing or duplicated sections.
        if (sourceCssX < -1 || sourceCssY < -1 || sourceCssX + pieceWidth > metrics.viewportWidth + 1 || sourceCssY + rowHeight > metrics.viewportHeight + 1) {
          throw new Error('This page prevented scrolling to the next section. Use Select area or capture the visible page instead.')
        }
        const dataUrl = await captureViewport(tab)
        const [settled] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageCapture })
        if (!settled?.result) throw new Error('The page stopped responding during capture.')
        latestMetrics = settled.result
        if (Math.abs(latestMetrics.scrollX - metrics.scrollX) > 1 || Math.abs(latestMetrics.scrollY - metrics.scrollY) > 1) {
          throw new Error('This page moved while taking a screenshot. Keep the page still and try again.')
        }
        const bitmap = pngSize(dataUrl)
        const currentScaleX = bitmap.width / initial.captureWidth
        const currentScaleY = bitmap.height / initial.captureHeight
        if (scaleX && (Math.abs(scaleX - currentScaleX) > 0.01 || Math.abs(scaleY - currentScaleY) > 0.01)) throw new Error('Display scaling changed during capture. Keep the browser on the same display and try again.')
        scaleX = currentScaleX
        scaleY = currentScaleY
        // The editor scales oversized output safely, while preserving the source tiles.
        totalBytes += dataUrl.length * 0.75
        if (totalBytes > MAX_ENCODED_BYTES) throw new Error('This image-heavy page is too large to capture at once. Choose a smaller area instead.')
        const slotX = Math.round(x * scaleX)
        const slotY = Math.round(y * scaleY)
        const slotWidth = Math.round((x + pieceWidth) * scaleX) - slotX
        const slotHeight = Math.round((y + rowHeight) * scaleY) - slotY
        const sourceX = Math.max(0, Math.round((metrics.offsetX + sourceCssX) * scaleX))
        const sourceY = Math.max(0, Math.round((metrics.offsetY + sourceCssY) * scaleY))
        if (sourceX + slotWidth > bitmap.width + 1 || sourceY + slotHeight > bitmap.height + 1) throw new Error('This page moved outside the visible capture area. Keep the page still and try again.')
        tiles.push({
          dataUrl,
          sourceX, sourceY,
          sourceWidth: Math.min(slotWidth, bitmap.width - sourceX),
          sourceHeight: Math.min(slotHeight, bitmap.height - sourceY),
          x: slotX, y: slotY, width: slotWidth, height: slotHeight,
        })
        await captureProgress(tab.id, tiles.length, expectedTiles())
      }
      y += rowHeight
      // Lazy content can extend either the document or the chosen inner scroller
      // while PNG encoding runs. Also catch Escape on the final frame.
      if (Math.abs(latestMetrics.width - width) > 2 || latestMetrics.height < height - 2 || latestMetrics.captureWidth !== initial.captureWidth || latestMetrics.captureHeight !== initial.captureHeight || latestMetrics.viewportWidth !== initial.viewportWidth || latestMetrics.viewportHeight !== initial.viewportHeight || Math.abs(latestMetrics.offsetX - initial.offsetX) > 1 || Math.abs(latestMetrics.offsetY - initial.offsetY) > 1) {
        throw new Error('The browser or page changed its layout during capture. Keep it still and try again.')
      }
      height = Math.max(height, latestMetrics.height)
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
    try {
      await Promise.all([
        chrome.action?.setBadgeText({ tabId: tab.id, text: '' }),
        chrome.action?.setTitle({ tabId: tab.id, title: 'Capture with ImageShot' }),
      ])
    } catch { /* The tab may have closed while restoring the toolbar. */ }
  }
}

async function showCaptureError(tabId: number, message: string): Promise<void> {
  try {
    const theme = await readTheme()
    await loadCaptureFont(tabId)
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (text: string, preference: 'light' | 'dark' | 'system') => {
        document.querySelector('[data-imageshot-notice]')?.remove()
        const host = document.createElement('div')
        host.setAttribute('data-imageshot-notice', '')
        const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
        host.dataset.theme = dark ? 'dark' : 'light'
        host.style.cssText = 'all:initial!important;position:fixed!important;bottom:24px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;max-width:calc(100vw - 48px)!important;'
        const shadow = host.attachShadow({ mode: 'closed' })
        const box = document.createElement('div')
        box.setAttribute('role', 'alert')
        box.style.cssText = `font:13px/1.6 'ImageShot Geist',sans-serif;color:${dark ? '#f0f0f6' : '#322b40'};background:${dark ? '#24242c' : '#ffffff'};border:1px solid ${dark ? '#464650' : '#e7e2ee'};color-scheme:${dark ? 'dark' : 'light'};border-radius:12px;box-shadow:0 8px 35px #25184325;padding:14px 20px;max-width:460px;`
        const heading = document.createElement('strong')
        heading.textContent = 'ImageShot · '
        box.append(heading, document.createTextNode(text))
        shadow.appendChild(box)
        document.documentElement.appendChild(host)
        setTimeout(() => host.remove(), 8500)
      },
      args: [message, theme],
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
  theme?: 'system' | 'light' | 'dark'
  fileFormat?: 'png' | 'jpg'
  autoCopy?: boolean
}

/**
 * Runs in the tab's isolated world and puts the finished screenshot on the page, so a
 * capture can be copied without leaving what was captured. Keep every browser
 * dependency inside it, and nothing from this module: it is sent as source text.
 */

async function showCapturePanel(payload: CapturePanelPayload): Promise<void> {
  document.querySelector('[data-imageshot-capture]')?.dispatchEvent(new Event('imageshot-dismiss'))
  const host = document.createElement('div')
  host.setAttribute('data-imageshot-capture', '')
  host.style.cssText = 'all:initial!important;position:fixed!important;right:20px!important;bottom:20px!important;z-index:2147483647!important;'
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
<style>
  :host { color-scheme:light; --panel:#ffffff; --stage:#f1f2f5; --ink:#20212a; --muted:#626775; --button:#f1f0f6; --hover:#e6e3f1; --border:#dedee6; }
  :host([data-theme="dark"]) { color-scheme:dark; --panel:#24242c; --stage:#17171e; --ink:#f0f0f6; --muted:#b5b5c5; --button:#363641; --hover:#454552; --border:#464650; }
  * { box-sizing:border-box; }
  .wrap{
    width:252px; border-radius:12px; overflow:hidden; background:var(--panel); color:var(--ink);
    border:1px solid var(--border);
    box-shadow: 0 0 0 0.5px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.24), 0 12px 28px rgba(0,0,0,0.32);
    font-family:'ImageShot Geist',sans-serif; -webkit-font-smoothing:antialiased;
  }
  .shot{position:relative; width:250px; height:200px; display:grid; place-items:center; background:var(--stage); line-height:0;}
  .picture{position:relative; width:250px; height:200px; display:grid; place-items:center; line-height:0;}
  .picture canvas{display:block; max-width:250px; max-height:200px; width:auto; height:auto; object-fit:contain;}
  .overlay{
    position:absolute;inset:0;display:grid;place-items:center;
    background:rgba(12,12,16,0.44); opacity:0; pointer-events:none; transition:opacity .18s ease;
  }
  .wrap:hover .overlay,.wrap:focus-within .overlay{opacity:1;pointer-events:auto}
  button:focus-visible{outline:2px solid #a78bfa;outline-offset:3px}
  .stack{display:flex;flex-direction:column;gap:8px;align-items:center;}
  .pill{
    height:30px; min-width:84px; padding:0 18px; border-radius:99px;
    background:var(--button); color:var(--ink); border:none;
    font-family:inherit;
    font-size:13px; font-weight:500; letter-spacing:-0.01em;
    box-shadow:0 1px 2px rgba(0,0,0,0.14), 0 2px 6px rgba(0,0,0,0.12);
    cursor:pointer; display:inline-flex; align-items:center; justify-content:center;
    transition: background .15s ease;
  }
  .pill:hover{background:var(--hover);}
  .pill[data-copy]{background:#6244e0;color:#fff;}
  .pill[data-copy]:hover{background:#7456ed;}
  .pill:disabled{opacity:.6; cursor:not-allowed;}
  .corner{
    position:absolute;width:24px;height:24px;display:grid;place-items:center;
    border-radius:50%; background:var(--button); color:var(--ink); border:none;
    box-shadow:0 1px 3px rgba(0,0,0,0.22); cursor:pointer; transition: background .15s ease;
  }
  .corner:hover{background:var(--hover);}
  .corner.tl{top:8px;left:8px} .corner.tr{top:8px;right:8px}
  .working{width:250px; height:200px; display:grid; place-items:center; font-size:12.5px; font-weight:500; color:var(--muted); background:var(--stage)}
  .more{position:absolute; left:0; right:0; bottom:0; padding:16px 10px 8px; background:linear-gradient(transparent,rgba(16,12,32,.72)); color:#fff; font-size:10px; text-align:center;}
  .more[hidden]{display:none;}
  .note{margin:0; padding:6px 10px; font-size:11px; line-height:1.4; color:var(--ink); background:var(--panel);}
  .note[hidden]{display:none;}
</style>
<div class="wrap" role="dialog" aria-label="ImageShot capture">
  <div class="shot">
    <div class="picture">
      <div class="working">Preparing your screenshot…</div>
      <div class="more" hidden>Top of a long page</div>
    </div>
    <div class="overlay">
      <button class="corner tl close" type="button" data-close aria-label="Close">
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
      </button>
      <button class="corner tr" type="button" data-studio aria-label="Open in Studio" title="Open in Studio">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3 h5.5 v5.5"/><path d="M8.2 7.8L12.8 3.2"/><path d="M12.8 9.2V12.8H3.2V3.2H6.8"/></svg>
      </button>
      <div class="stack">
        <button class="pill" type="button" data-copy>Copy</button>
        <button class="pill" type="button" data-save-main>Save</button>
      </div>
    </div>
  </div>
  <p class="note" role="status" hidden></p>
</div>`
  document.documentElement.appendChild(host)

  const panel = shadow.querySelector('.wrap') as HTMLDivElement
  const working = shadow.querySelector('.working') as HTMLDivElement
  const more = shadow.querySelector('.more') as HTMLDivElement
  const note = shadow.querySelector('.note') as HTMLParagraphElement
  const copyButton = shadow.querySelector('[data-copy]') as HTMLButtonElement
  const saveButton = shadow.querySelector('[data-save-main]') as HTMLButtonElement
  const studioButton = shadow.querySelector('[data-studio]') as HTMLButtonElement
  let theme = payload.theme ?? 'system'
  let fileFormat = payload.fileFormat ?? 'png'
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)')
  const applyTheme = () => { host.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme }
  const onPreferences = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
    if (area !== 'local') return
    if (changes['imageshot:theme']) {
      const next = changes['imageshot:theme'].newValue
      theme = next === 'dark' || next === 'light' ? next : 'system'
      applyTheme()
    }
    if (changes['imageshot:fileFormat']) fileFormat = changes['imageshot:fileFormat'].newValue === 'jpg' ? 'jpg' : 'png'
  }
  applyTheme()
  systemTheme.addEventListener('change', applyTheme)
  chrome.storage?.onChanged?.addListener(onPreferences)

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
    systemTheme.removeEventListener('change', applyTheme)
    chrome.storage?.onChanged?.removeListener(onPreferences)
    host.remove()
  }
  host.addEventListener('imageshot-dismiss', close, { once: true })
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
  const compose = async (format: 'png' | 'jpg' = 'png'): Promise<Blob> => {
    if (payload.dataUrl && format === 'png') return await (await fetch(payload.dataUrl)).blob()
    const tiles = payload.tiles ?? []
    if (!payload.dataUrl && !tiles.length) throw new Error('This screenshot has no image data.')
    const scale = fitScale(payload.width, payload.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(payload.width * scale))
    canvas.height = Math.max(1, Math.floor(payload.height * scale))
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('The browser could not create the screenshot canvas.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    try {
      if (payload.dataUrl) {
        const image = await decode(payload.dataUrl)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        image.src = ''
      }
      for (const tile of tiles) {
        const image = await decode(tile.dataUrl)
        drawTile(context, image, tile, scale)
        image.src = ''
      }
      const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95))
      if (!blob) throw new Error('The browser could not render this screenshot.')
      return blob
    } finally {
      canvas.width = 1
      canvas.height = 1
    }
  }

  const copyCapture = async (automatic = false) => {
    if (!canCopy) return
    armDismiss(120000)
    copyButton.disabled = true
    copyButton.textContent = 'Copying…'
    try {
      const pending = compose()
      void pending.catch(() => undefined)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pending })])
      copyButton.textContent = 'Copied'
      if (automatic) {
        note.hidden = false
        note.textContent = 'Screenshot copied to your clipboard.'
        copyButton.disabled = false
        armDismiss(30000)
      } else armDismiss(900)
    } catch {
      copyButton.disabled = false
      copyButton.textContent = 'Copy'
      note.hidden = false
      note.textContent = automatic ? 'Automatic copy was blocked. Click Copy, or open in Studio.' : 'The browser would not copy this image. Open in Studio to copy it there.'
    }
  }
  copyButton.addEventListener('click', () => { void copyCapture() })

  saveButton.addEventListener('click', async () => {
    armDismiss(120000)
    saveButton.disabled = true
    saveButton.textContent = 'Saving…'
    try {
      const format = fileFormat
      const blob = await compose(format)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'imageshot-' + Date.now() + '.' + format
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      saveButton.textContent = 'Saved'
      window.setTimeout(close, 800)
    } catch (error) {
      saveButton.disabled = false
      saveButton.textContent = 'Save'
      note.hidden = false
      note.textContent = error instanceof Error ? error.message : 'The image could not be saved. Open in Studio to try again.'
    }
  })

  if (payload.autoCopy) void copyCapture(true)
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
async function openCapturePanel(tabId: number, record: CaptureRecord): Promise<boolean> {
  const [theme, fileFormat, autoCopy] = await Promise.all([readTheme(), readFileFormat(), readAutoCopy()])
  const payload: CapturePanelPayload = {
    id: record.id,
    width: record.width,
    height: record.height,
    theme, fileFormat, autoCopy,
    ...(record.dataUrl ? { dataUrl: record.dataUrl } : {}),
    ...(record.tiles ? { tiles: record.tiles } : {}),
  }
  try {
    await loadCaptureFont(tabId)
    await chrome.scripting.executeScript({ target: { tabId }, func: showCapturePanel, args: [payload] })
    return true
  } catch {
    // The screenshot is already saved. Open it in Studio if its page disappeared.
    return false
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
    // A second screenshot must never contain the previous pinned preview or error.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const previous = document.querySelectorAll('[data-imageshot-capture], [data-imageshot-notice]')
        if (!previous.length) return
        previous.forEach(element => {
          element.dispatchEvent(new Event('imageshot-dismiss'))
          element.remove()
        })
        await new Promise<void>((resolve) => {
          const fallback = setTimeout(resolve, 100)
          requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve() }))
        })
      },
    })
    const record = mode === 'area' ? await captureArea(tab, id) : mode === 'full' ? await captureFullPage(tab, id) : await captureVisible(tab, id)
    await saveCapture(record)
    stored = true
    const panelOpened = destination === 'panel' && await openCapturePanel(tab.id, record)
    if (!panelOpened) {
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

// Chrome dispatches these command names for the user's current shortcut bindings.
chrome.commands?.onCommand?.addListener((command) => {
  const mode: CaptureMode | null = command === 'capture-area' ? 'area' : command === 'capture-full' ? 'full' : command === 'capture-display' ? 'visible' : null
  if (!mode) return
  void performCapture(mode).catch(()=>{})
})
