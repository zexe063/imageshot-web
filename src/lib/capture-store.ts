/** Captures stay in this extension's IndexedDB; no screenshot leaves the device. */
export type CaptureMode = 'area' | 'visible' | 'full'

export interface CaptureTile {
  dataUrl: string
  /** Source rectangle in the captured viewport bitmap. */
  sourceX: number
  sourceY: number
  sourceWidth: number
  sourceHeight: number
  /** Destination rectangle in the final bitmap. */
  x: number
  y: number
  width: number
  height: number
}

export interface CaptureRecord {
  id: string
  name: string
  sourceUrl?: string
  createdAt: number
  mode: CaptureMode
  width: number
  height: number
  dataUrl?: string
  tiles?: CaptureTile[]
}

const DATABASE_NAME = 'imageshot-local'
const STORE_NAME = 'captures'
const KEEP_CAPTURES = 12

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'id' })
      store.createIndex('createdAt', 'createdAt')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local screenshot storage.'))
    request.onblocked = () => reject(new Error('Local screenshot storage is busy. Close other ImageShot tabs and try again.'))
  })
}

export async function saveCapture(record: CaptureRecord): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      store.put(record)
      // Keep a bounded history without reading every screenshot back into memory.
      let count = 0
      const cursor = store.index('createdAt').openKeyCursor(null, 'prev')
      cursor.onsuccess = () => {
        const entry = cursor.result
        if (!entry) return
        count += 1
        if (count > KEEP_CAPTURES) store.delete(entry.primaryKey)
        entry.continue()
      }
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save the screenshot locally.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Screenshot storage is full. Remove an older screenshot and try again.'))
    })
  } finally {
    database.close()
  }
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  const database = await openDatabase()
  try {
    return await new Promise<CaptureRecord | undefined>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
      request.onsuccess = () => resolve(request.result as CaptureRecord | undefined)
      request.onerror = () => reject(request.error ?? new Error('Could not load this screenshot.'))
    })
  } finally {
    database.close()
  }
}

export async function listCaptures(limit = 8): Promise<CaptureRecord[]> {
  const database = await openDatabase()
  const boundedLimit = Math.max(0, Math.min(KEEP_CAPTURES, Math.floor(limit)))
  try {
    return await new Promise<CaptureRecord[]>((resolve, reject) => {
      const records: CaptureRecord[] = []
      if (!boundedLimit) return resolve(records)
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).index('createdAt').openCursor(null, 'prev')
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || records.length >= boundedLimit) return resolve(records)
        records.push(cursor.value as CaptureRecord)
        cursor.continue()
      }
      request.onerror = () => reject(request.error ?? new Error('Could not load recent screenshots.'))
    })
  } finally {
    database.close()
  }
}

export async function deleteCapture(id: string): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(id)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not remove the screenshot.'))
    })
  } finally {
    database.close()
  }
}

/**
 * Chrome refuses a 2D canvas past 32,767 px on a side, and past roughly 48 megapixels
 * it runs the tab out of memory. `MAX_OUTPUT_SIDE` leaves headroom for composition
 * padding. A capture that does not fit is shrunk rather than refused, so a very long
 * page still opens.
 */
const MAX_OUTPUT_PIXELS = 48_000_000
const MAX_OUTPUT_SIDE = 32_000

/** The scale a capture is reduced by to fit one canvas. 1 means it fits as captured. */
export function captureFitScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return 1
  return Math.min(1, Math.sqrt(MAX_OUTPUT_PIXELS / (width * height)), MAX_OUTPUT_SIDE / width, MAX_OUTPUT_SIDE / height)
}

/** A capture opened for editing: where to point an <img> at, and the pixels behind it. */
export interface MaterializedCapture {
  /**
   * An object URL for the composed image. The browser keys its decoded copy on this,
   * so the canvas and the layer thumbnail share one decode instead of repeating it,
   * and nothing pays to base64 the PNG. It is meaningless after a reload, which is
   * why the draft store never keeps it.
   */
  src: string;
  /** The same image, already decoded, so opening a capture never decodes it twice. */
  image: HTMLImageElement;
}

const pendingCaptures = new Map<string, Promise<MaterializedCapture>>()

/** Share in-flight loads when startup effects request the same capture together. */
export function materializeCapture(record: CaptureRecord): Promise<MaterializedCapture> {
  const existing = pendingCaptures.get(record.id)
  if (existing) return existing
  const pending = openCapture(record).finally(() => pendingCaptures.delete(record.id))
  pendingCaptures.set(record.id, pending)
  return pending
}

async function openCapture(record: CaptureRecord): Promise<MaterializedCapture> {
  const blob = record.dataUrl
    // A single-tile capture is already one image, so it only has to be decoded.
    ? await (await fetch(record.dataUrl)).blob()
    : composeTiles(record);
  const src = URL.createObjectURL(blob);
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(src);
    throw new Error('This screenshot could not be opened.');
  }
  return { src, image };
}

/** Read the browser's PNG dimensions without decoding a tile a second time. */
function tileSize(dataUrl: string): { width: number; height: number } {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('One of the screenshot images could not be decoded.')
  const header = atob(dataUrl.slice(22, 66))
  const read = (offset: number) => (((header.charCodeAt(offset) << 24) >>> 0) + (header.charCodeAt(offset + 1) << 16) + (header.charCodeAt(offset + 2) << 8) + header.charCodeAt(offset + 3))
  const width = read(16)
  const height = read(20)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new Error('One of the screenshot images could not be decoded.')
  return { width, height }
}

/**
 * A lossless image container lets the browser draw the original PNG tiles directly.
 * Flattening to PNG here used to compress the entire page and decode it again before
 * Studio could show anything. The editor still receives a normal, origin-clean image
 * and only its eventual copy/export needs to encode a new PNG.
 */
function composeTiles(record: CaptureRecord): Blob {
  if (!record.tiles?.length) throw new Error('This screenshot has no image data.');
  if (!Number.isFinite(record.width) || !Number.isFinite(record.height) || record.width < 1 || record.height < 1) throw new Error('This screenshot has no image data.');
  // The tiles keep their full resolution, so reducing the composed image costs export
  // detail rather than discarding the capture.
  const scale = captureFitScale(record.width, record.height)
  const width = Math.max(1, Math.floor(record.width * scale))
  const height = Math.max(1, Math.floor(record.height * scale))
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>`]
  for (const tile of record.tiles) {
    const dimensions = tileSize(tile.dataUrl)
    const x = Math.round(tile.x * scale)
    const y = Math.round(tile.y * scale)
    const tileWidth = Math.max(1, Math.round((tile.x + tile.width) * scale) - x)
    const tileHeight = Math.max(1, Math.round((tile.y + tile.height) * scale) - y)
    // The viewport crops area captures and overlapping browser-edge tiles before
    // placing them. Rounding destination edges keeps neighbouring tiles flush.
    const dataUrl = tile.dataUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    parts.push(`<svg x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" viewBox="${tile.sourceX} ${tile.sourceY} ${tile.sourceWidth} ${tile.sourceHeight}" preserveAspectRatio="none" overflow="hidden"><image width="${dimensions.width}" height="${dimensions.height}" href="${dataUrl}"/></svg>`)
  }
  parts.push('</svg>')
  return new Blob(parts, { type: 'image/svg+xml' })
}
