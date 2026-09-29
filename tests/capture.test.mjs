import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import ts from 'typescript'
import { chromium } from '@playwright/test'

const backgroundSource = ts.transpileModule(await readFile(new URL('../src/extension/background.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^import .*?;\r?\n/gm, '')
const storeSource = ts.transpileModule(await readFile(new URL('../src/lib/capture-store.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export /gm, '')
const draftSource = ts.transpileModule(await readFile(new URL('../src/lib/document-store.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export /gm, '')

let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function harness(html, options = {}) {
  // An https fixture gives the page a secure context, which is what the in-page copy
  // button checks before it offers to copy.
  const origin = options.secure ? 'https' : 'http'
  const viewport = options.viewport ?? { width: 720, height: 500 }
  const context = await browser.newContext({ viewport, deviceScaleFactor: options.deviceScaleFactor ?? 1, permissions: options.secure ? ['clipboard-read', 'clipboard-write'] : [] })
  const pageMessages = []
  // The panel reaches the worker through the same isolated-world bridge the real
  // extension gets for free, so the messages it sends are recorded here.
  await context.exposeFunction('__imageshotPanelMessage', (message) => { pageMessages.push(message) })
  await context.addInitScript(() => {
    globalThis.chrome = { runtime: { id: 'imageshot-test', sendMessage: message => globalThis.__imageshotPanelMessage(message) } }
  })
  await context.route(`${origin}://capture.test/**`, (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Capture fixture</title></head><body>${html}</body></html>` }))
  const page = await context.newPage()
  await page.goto(`${origin}://capture.test/example`)
  const records = []
  const events = []
  const urls = []
  const captureTimes = []
  const settings = { 'imageshot:quickCopy': options.destination !== 'studio' }
  const tab = { id: 1, windowId: 5, url: options.tabUrl ?? page.url(), title: 'Capture fixture', active: true }
  let listener
  let activeId = 1
  let editorTabId
  const chrome = {
    runtime: {
      id: 'imageshot-test',
      onMessage: { addListener: (callback) => { listener = callback } },
      getURL: (path) => `chrome-extension://imageshot-test/${path}`,
    },
    storage: {
      local: {
        get: async (key) => (key in settings ? { [key]: settings[key] } : {}),
        set: async (values) => { Object.assign(settings, values) },
      },
    },
    tabs: {
      query: async () => [{ ...tab, id: activeId }],
      get: async () => ({ ...tab }),
      captureVisibleTab: async () => {
        captureTimes.push(Date.now())
        events.push('capture')
        if (options.failAtCapture === captureTimes.length) throw new Error('Simulated browser capture failure.')
        const png = await page.screenshot({ type: 'png' })
        if (options.switchAtCapture === captureTimes.length) activeId = 2
        return `data:image/png;base64,${png.toString('base64')}`
      },
      create: async ({ url, active }) => {
        events.push(active === false ? 'open-hidden' : 'open')
        editorTabId = events.filter(event => event.startsWith('open')).length
        urls.push(url)
        return { id: editorTabId, url }
      },
      update: async (id, change) => { events.push('focus'); return { id, ...change } },
      remove: async () => { events.push('close') },
    },
    scripting: {
      executeScript: async ({ func, args = [] }) => [{ result: await page.evaluate(({ source, values }) => {
        return (0, eval)(`(${source})`)(...values)
      }, { source: func.toString(), values: args }) }],
    },
  }
  vm.runInNewContext(backgroundSource, {
    chrome, crypto: webcrypto, atob, setTimeout, clearTimeout, URLSearchParams,
    readCaptureDestination: async () => (settings['imageshot:quickCopy'] === false ? 'studio' : 'panel'),
    saveCapture: async (record) => { records.push(record); events.push('store') },
  })
  const capture = (mode) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Capture test timed out.')), 30_000)
    listener({ type: 'IMAGESHOT_CAPTURE', mode }, { id: 'imageshot-test' }, (response) => { clearTimeout(timeout); resolve(response) })
  })
  const sample = async (record, points) => {
    await page.addScriptTag({ content: `${storeSource}\nwindow.__materializeCapture = materializeCapture;` })
    return page.evaluate(async ({ captureRecord, coordinates }) => {
      // materializeCapture hands back the image already decoded, so the sample does
      // not pay to decode it a second time.
      const { image } = await window.__materializeCapture(captureRecord)
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      return { width: image.width, height: image.height, pixels: coordinates.map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]) }
    }, { captureRecord: record, coordinates: points })
  }
  return {
    page, records, events, urls, pageMessages, settings, captureTimes, capture, sample,
    /** Delivers a message the way a page-side caller would. */
    send: (message) => { listener(message, { id: 'imageshot-test' }, () => {}); return new Promise(done => setTimeout(done, 20)) },
    close: () => context.close(),
  }
}

const fullPageFixture = `<style>
  body { margin:0; }
  .fixed { position:fixed;inset:0 0 auto;height:40px;background:rgb(240,64,64);z-index:2; }
  .sticky { position:sticky;top:0;height:40px;background:rgb(40,170,100); }
  .band { height:700px; }
  .one { background:rgb(70,130,230); } .two { background:rgb(130,80,210); } .three { background:rgb(245,190,70); }
</style><div class="fixed" style="visibility:visible">Header</div><div class="sticky" style="top:13px!important">Sticky content</div><div class="band one"></div><div class="band two"></div><div class="band three"></div>`

test('a finished capture stays on the page with copy and studio actions', async () => {
  const fixture = await harness('<style>body{margin:0;background:rgb(95,65,180)}</style>', { secure: true })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]

    // The whole point of the panel: the page is left alone and no tab is opened.
    assert.deepEqual(fixture.urls, [])
    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    assert.match(await panel.locator('.size').textContent(), /720 × 500/)
    assert.equal(await panel.locator('.shot canvas').count(), 1, 'the panel shows the screenshot it took')

    // A working copy needs a secure context, which this fixture has.
    const copy = panel.locator('button[data-copy]')
    assert.equal(await copy.isDisabled(), false)
    await copy.click()
    await fixture.page.locator('button[data-copy]').getByText('Copied', { exact: true }).waitFor()
    const copied = await fixture.page.evaluate(async () => {
      const items = await navigator.clipboard.read()
      return (await items[0].getType('image/png')).size
    })
    assert.ok(copied > 0, 'the clipboard holds a PNG')
  } finally { await fixture.close() }
})

test('the panel opens the studio only when asked, and closes itself afterwards', async () => {
  const fixture = await harness('<style>body{margin:0;background:rgb(95,65,180)}</style>')
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.deepEqual(fixture.pageMessages, [], 'nothing is sent to the worker until the person acts')

    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    await panel.locator('button[data-studio]').click()
    await fixture.page.locator('[data-imageshot-capture]').waitFor({ state: 'detached' })
    assert.deepEqual(fixture.pageMessages, [{ type: 'IMAGESHOT_OPEN_STUDIO', id: record.id }])
    // The worker turns that message into the tab the person asked for.
    await fixture.send({ type: 'IMAGESHOT_OPEN_STUDIO', id: record.id })
    assert.deepEqual(fixture.urls, [`chrome-extension://imageshot-test/editor.html?capture=${record.id}`])
  } finally { await fixture.close() }
})

test('the pin uses display pixels on a high-density screen and copies the original size', async () => {
  const fixture = await harness('<style>body{margin:0;background:rgb(95,65,180)}</style><p>Sharp capture text</p>', { secure: true, deviceScaleFactor: 2 })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.deepEqual([record.width, record.height], [1440, 1000])
    const panel = fixture.page.locator('[data-imageshot-capture]')
    const preview = await panel.locator('.picture canvas').evaluate(canvas => {
      const box = canvas.getBoundingClientRect()
      return { width: canvas.width, height: canvas.height, displayWidth: box.width, displayHeight: box.height, ratio: window.devicePixelRatio }
    })
    assert.equal(preview.width, Math.round(preview.displayWidth * preview.ratio))
    assert.equal(preview.height, Math.round(preview.displayHeight * preview.ratio))
    await panel.locator('button[data-copy]').click()
    await panel.locator('button[data-copy]').getByText('Copied', { exact: true }).waitFor()
    const copied = await fixture.page.evaluate(async () => {
      const bitmap = await createImageBitmap(await (await navigator.clipboard.read())[0].getType('image/png'))
      return [bitmap.width, bitmap.height]
    })
    assert.deepEqual(copied, [1440, 1000])
  } finally { await fixture.close() }
})

test('copy works while the pinned preview is still decoding', async () => {
  const fixture = await harness('<p>Copy without waiting for the thumbnail</p>', { secure: true })
  try {
    await fixture.page.evaluate(() => {
      const decode = HTMLImageElement.prototype.decode
      const gate = new Promise(resolve => { window.__releasePreview = resolve })
      HTMLImageElement.prototype.decode = async function () {
        await gate
        return decode.call(this)
      }
    })
    const pending = fixture.capture('visible')
    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    await panel.locator('button[data-copy]').click()
    await panel.locator('button[data-copy]').getByText('Copied', { exact: true }).waitFor()
    assert.equal(await panel.locator('.working').count(), 1)
    assert.equal(await panel.locator('.picture canvas').count(), 0)
    await fixture.page.evaluate(() => window.__releasePreview())
    assert.equal((await pending).ok, true)
  } finally { await fixture.close() }
})

/** A page short enough to letterbox whole, so the preview can be read end to end. */
const shortPageFixture = `<style>
  body { margin:0; }
  .fixed { position:fixed;inset:0 0 auto;height:40px;background:rgb(240,64,64);z-index:2; }
  .sticky { position:sticky;top:0;height:40px;background:rgb(40,170,100); }
  .band { height:380px; }
  .one { background:rgb(70,130,230); } .two { background:rgb(130,80,210); }
</style><div class="fixed">Header</div><div class="sticky">Sticky content</div><div class="band one"></div><div class="band two"></div>`

test('a full-page capture stitches the panel preview and copies the whole page', async () => {
  const fixture = await harness(shortPageFixture, { secure: true })
  try {
    const response = await fixture.capture('full')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.equal(record.tiles.length, 2, 'the fixture needs more than one viewport to stitch')
    assert.ok(record.height / record.width > 0.62, 'this page is shown whole, not cropped')

    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    // The panel stitches the tiles itself, so the preview has to land the same bands
    // in the same order the editor would.
    const preview = await panel.locator('.picture canvas').evaluate((canvas) => {
      const context = canvas.getContext('2d')
      const at = (y) => [...context.getImageData(Math.floor(canvas.width / 2), Math.min(canvas.height - 1, y), 1, 1).data]
      return { width: canvas.width, height: canvas.height, pixels: [at(Math.round(canvas.height * 0.28)), at(Math.round(canvas.height * 0.8))] }
    })
    assert.ok(Math.abs(preview.height / preview.width - record.height / record.width) < 0.05, 'the preview keeps the page aspect ratio')
    assert.deepEqual(preview.pixels, [[70, 130, 230, 255], [130, 80, 210, 255]])
    assert.equal(await panel.locator('.more').isVisible(), false, 'a whole page is not cropped')

    // Copying a full page has to rebuild it at full size, not hand over the preview.
    await panel.locator('button[data-copy]').click()
    await panel.locator('button[data-copy]').getByText('Copied', { exact: true }).waitFor()
    const copied = await fixture.page.evaluate(async () => {
      const blob = await (await (await navigator.clipboard.read())[0].getType('image/png')).arrayBuffer()
      const bitmap = await createImageBitmap(new Blob([blob], { type: 'image/png' }))
      return { width: bitmap.width, height: bitmap.height }
    })
    assert.deepEqual(copied, { width: record.width, height: record.height })
  } finally { await fixture.close() }
})

test('the panel paints its actions so the copy button is actually visible', async () => {
  const fixture = await harness('<p>contrast</p>', { secure: true })
  try {
    await fixture.capture('visible')
    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    // A reset rule that out-specifies the fill leaves white text on a white pill, so
    // both sides of the pair are checked rather than trusting the stylesheet.
    const painted = await panel.locator('[data-copy], [data-studio]').evaluateAll(buttons => buttons.map(button => {
      const style = getComputedStyle(button)
      return { fill: style.backgroundColor, ink: style.color }
    }))
    assert.deepEqual(painted, [
      { fill: 'rgb(98, 68, 224)', ink: 'rgb(255, 255, 255)' },
      { fill: 'rgb(243, 241, 248)', ink: 'rgb(30, 30, 30)' },
    ])
  } finally { await fixture.close() }
})

test('a page far taller than it is wide shows its top instead of a sliver', async () => {
  const fixture = await harness('<p>very long</p>', { secure: true, viewport: { width: 720, height: 2000 } })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.ok(record.height / record.width > 2, 'the fixture is a tall page')

    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    const frame = await panel.locator('.shot').boundingBox()
    const picture = await panel.locator('.picture').boundingBox()
    // Letterboxing a 1:3 page into a fixed frame leaves a strip too narrow to read, so
    // the preview fills the width instead and admits it is only the top.
    assert.ok(picture.width / frame.width > 0.85, `the preview should fill the frame width, got ${Math.round(picture.width)} of ${Math.round(frame.width)}`)
    assert.equal(await panel.locator('.more').isVisible(), true)
    assert.match(await panel.locator('.more').textContent(), /Top of a long page/)
  } finally { await fixture.close() }
})

test('a page that is not secure is told where copying works instead of failing quietly', async () => {
  const fixture = await harness('<p>insecure</p>')
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    assert.equal(await panel.locator('button[data-copy]').isDisabled(), true)
    assert.match(await panel.locator('.note').textContent(), /HTTPS page/)
    assert.match(await panel.locator('.note').textContent(), /Studio/)
  } finally { await fixture.close() }
})

test('the panel closes on its own button and on Escape, and a new capture replaces it', async () => {
  const fixture = await harness('<p>dismiss</p>')
  try {
    await fixture.capture('visible')
    const panel = fixture.page.locator('[data-imageshot-capture]')
    await panel.waitFor()
    assert.equal(await fixture.page.locator('[data-imageshot-capture]').count(), 1)

    await panel.locator('button.close').click()
    await fixture.page.locator('[data-imageshot-capture]').waitFor({ state: 'detached' })

    await fixture.capture('visible')
    await fixture.page.locator('[data-imageshot-capture]').waitFor()
    await fixture.page.keyboard.press('Escape')
    await fixture.page.locator('[data-imageshot-capture]').waitFor({ state: 'detached' })

    await fixture.capture('visible')
    await fixture.page.locator('[data-imageshot-capture]').waitFor()
    // Two captures in a row must not stack a second panel on top of the first.
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await fixture.page.locator('[data-imageshot-capture]').count(), 1)
  } finally { await fixture.close() }
})

test('a failed capture leaves no panel behind', async () => {
  const fixture = await harness('<p>fails</p>', { failAtCapture: 1 })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, false)
    assert.equal(fixture.records.length, 0)
    assert.equal(await fixture.page.locator('[data-imageshot-capture]').count(), 0)
    assert.equal(await fixture.page.locator('[data-imageshot-notice]').count(), 1)
    assert.deepEqual(fixture.urls, [])
  } finally { await fixture.close() }
})

test('the studio destination keeps opening the editor, and never shows a panel', async () => {
  const fixture = await harness('<style>body{margin:0;background:rgb(95,65,180)}</style>', { destination: 'studio' })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    // The editor is opened in the background before the pixels exist, so the tab and
    // the app are already loading while the capture runs, and only then take focus.
    assert.deepEqual(fixture.urls, [`chrome-extension://imageshot-test/editor.html?capture=${record.id}&pending=1`])
    assert.deepEqual(fixture.events, ['open-hidden', 'capture', 'store', 'focus'])
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await fixture.page.locator('[data-imageshot-capture]').count(), 0)
  } finally { await fixture.close() }
})

test('the editor is already open before the first pixel is captured', async () => {
  const fixture = await harness(fullPageFixture, { destination: 'studio' })
  try {
    const response = await fixture.capture('full')
    assert.equal(response.ok, true, response.error)
    const firstCapture = fixture.events.indexOf('capture')
    assert.ok(firstCapture > 0, 'the capture loop must not start before the editor tab is open')
    assert.equal(fixture.events[0], 'open-hidden')
    // Focus waits for the record, so the editor never wakes up to a missing capture.
    assert.deepEqual(fixture.events.slice(-2), ['store', 'focus'])
  } finally { await fixture.close() }
})

test('a capture taller than one browser canvas is reduced to fit instead of failing', async () => {
  const fixture = await harness('<p>oversized</p>')
  try {
    await fixture.page.addScriptTag({ content: `${storeSource}\nwindow.__materializeCapture = materializeCapture;\nwindow.__captureFitScale = captureFitScale;` })
    const result = await fixture.page.evaluate(async () => {
      // 1600 x 40000 is 64 megapixels and 40000 px tall: over both the pixel budget
      // and Chrome's 32767 px canvas side. Each tile is a 4x1 strip stretched to its
      // slot, so a solid colour proves the tile landed at the reduced offset.
      const width = 1600
      const height = 40000
      const rows = 8
      const rowHeight = height / rows
      const colours = [[220, 20, 60], [20, 160, 60], [40, 90, 220], [230, 160, 20], [150, 40, 200], [20, 190, 190], [240, 90, 30], [90, 90, 90]]
      const tiles = []
      for (let index = 0; index < rows; index += 1) {
        const strip = document.createElement('canvas')
        strip.width = 4
        strip.height = 1
        const stripContext = strip.getContext('2d')
        stripContext.fillStyle = `rgb(${colours[index].join(',')})`
        stripContext.fillRect(0, 0, 4, 1)
        tiles.push({ dataUrl: strip.toDataURL('image/png'), sourceX: 0, sourceY: 0, sourceWidth: 4, sourceHeight: 1, x: 0, y: index * rowHeight, width, height: rowHeight })
      }
      const scale = window.__captureFitScale(width, height)
      const { image } = await window.__materializeCapture({ id: 'oversized', name: 'Oversized', createdAt: 0, mode: 'full', width, height, tiles })
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const column = Math.floor(image.width / 2)
      const at = (y) => [...context.getImageData(column, y, 1, 1).data]
      // The boundary between tile 3 and tile 4 must sit on the reduced offset.
      const boundary = Math.round(4 * rowHeight * scale)
      return {
        scale,
        width: image.width,
        height: image.height,
        insideThird: at(boundary - 3),
        insideFourth: at(boundary + 3),
        firstRow: at(2),
        lastRow: at(image.height - 3),
      }
    })
    assert.ok(result.scale < 1, 'an oversized capture must be reduced')
    assert.equal(result.width, Math.floor(1600 * result.scale))
    assert.equal(result.height, Math.floor(40000 * result.scale))
    assert.ok(result.height <= 32_000, `reduced height ${result.height} must stay under the canvas side limit`)
    assert.ok(result.width * result.height <= 48_000_000, `reduced image ${result.width}x${result.height} must stay under the pixel budget`)
    assert.deepEqual(result.firstRow, [220, 20, 60, 255])
    assert.deepEqual(result.insideThird, [230, 160, 20, 255])
    assert.deepEqual(result.insideFourth, [150, 40, 200, 255])
    assert.deepEqual(result.lastRow, [90, 90, 90, 255])
  } finally { await fixture.close() }
})

test('Studio opens tiled captures without PNG re-encoding or waiting for animation frames, preserving export pixels', { timeout: 10000 }, async () => {
  const fixture = await harness('<p>Lossless tile loading</p>')
  try {
    await fixture.page.addScriptTag({ content: `${storeSource}\nwindow.__materializeCapture = materializeCapture;` })
    const result = await fixture.page.evaluate(async () => {
      const source = document.createElement('canvas')
      source.width = 28
      source.height = 24
      const sourceContext = source.getContext('2d')
      const pixels = sourceContext.createImageData(source.width, source.height)
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        pixels.data.set([(offset / 4 * 37) % 256, (offset / 4 * 61) % 256, (offset / 4 * 97) % 256, 255], offset)
      }
      sourceContext.putImageData(pixels, 0, 0)
      const dataUrl = source.toDataURL('image/png')
      const tiles = [
        { dataUrl, sourceX: 3, sourceY: 2, sourceWidth: 16, sourceHeight: 9, x: 0, y: 0, width: 16, height: 9 },
        { dataUrl, sourceX: 6, sourceY: 13, sourceWidth: 16, sourceHeight: 7, x: 0, y: 9, width: 16, height: 7 },
      ]
      const record = { id: 'lossless', name: 'Lossless', createdAt: 0, mode: 'full', width: 16, height: 16, tiles }
      const toBlob = HTMLCanvasElement.prototype.toBlob
      let encodes = 0
      HTMLCanvasElement.prototype.toBlob = function (...args) { encodes += 1; return toBlob.apply(this, args) }
      const nextFrame = window.requestAnimationFrame
      // Background tabs do not get frames. Their Studio preload must still finish.
      window.requestAnimationFrame = () => 0
      const first = window.__materializeCapture(record)
      const second = window.__materializeCapture(record)
      const { image, src } = await first
      const reused = first === second && (await second).image === image
      window.requestAnimationFrame = nextFrame
      const openingEncodes = encodes
      const expected = document.createElement('canvas')
      expected.width = 16
      expected.height = 16
      const expectedContext = expected.getContext('2d')
      for (const tile of tiles) expectedContext.drawImage(source, tile.sourceX, tile.sourceY, tile.sourceWidth, tile.sourceHeight, tile.x, tile.y, tile.width, tile.height)
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      // Export must be origin-clean and keep every original pixel around crop seams.
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const bitmap = await createImageBitmap(png)
      context.clearRect(0, 0, 16, 16)
      context.drawImage(bitmap, 0, 0)
      const actual = context.getImageData(0, 0, 16, 16).data
      const wanted = expectedContext.getImageData(0, 0, 16, 16).data
      const identical = actual.every((value, index) => value === wanted[index])
      URL.revokeObjectURL(src)
      return { reused, openingEncodes, exportEncodes: encodes, identical, width: bitmap.width, height: bitmap.height, type: png.type }
    })
    assert.deepEqual(result, { reused: true, openingEncodes: 0, exportEncodes: 1, identical: true, width: 16, height: 16, type: 'image/png' })
  } finally { await fixture.close() }
})

test('full-page capture stitches the partial bottom tile and restores scrolling and sticky styles', async () => {
  const fixture = await harness(fullPageFixture)
  try {
    await fixture.page.evaluate(() => {
      window.__panelDecodes = 0
      const decode = HTMLImageElement.prototype.decode
      HTMLImageElement.prototype.decode = function () { window.__panelDecodes += 1; return decode.call(this) }
    })
    await fixture.page.evaluate(() => window.scrollTo(0, 330))
    const response = await fixture.capture('full')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.deepEqual([record.width, record.height], [720, 2140])
    assert.equal(record.tiles.length, 5)
    const decodedTiles = await fixture.page.evaluate(() => window.__panelDecodes)
    assert.ok(decodedTiles > 0 && decodedTiles < record.tiles.length, 'the pin only decodes tiles visible in its top preview')
    assert.equal(record.tiles.at(-1).sourceY, 360)
    assert.equal(record.tiles.at(-1).height, 140)
    const image = await fixture.sample(record, [[50, 10], [50, 510], [50, 1010], [50, 1510], [50, 2130]])
    assert.deepEqual(image.pixels, [[240, 64, 64, 255], [70, 130, 230, 255], [130, 80, 210, 255], [245, 190, 70, 255], [245, 190, 70, 255]])
    assert.deepEqual(await fixture.page.evaluate(() => ({
      y: window.scrollY,
      stickyPosition: getComputedStyle(document.querySelector('.sticky')).position,
      stickyTop: document.querySelector('.sticky').style.getPropertyValue('top'),
      stickyPriority: document.querySelector('.sticky').style.getPropertyPriority('top'),
      fixedVisibility: document.querySelector('.fixed').style.visibility,
      temporaryState: !!window.__imageshotCaptureState,
    })), { y: 330, stickyPosition: 'sticky', stickyTop: '13px', stickyPriority: 'important', fixedVisibility: 'visible', temporaryState: false })
    for (let i = 1; i < fixture.captureTimes.length; i += 1) assert.ok(fixture.captureTimes[i] - fixture.captureTimes[i - 1] >= 580, 'Capture calls must stay below Chromium rate limit')
  } finally { await fixture.close() }
})

test('full-page capture includes horizontal overflow without overlapping edge tiles', async () => {
  const fixture = await harness('<style>body{margin:0}.wide{width:1150px;height:830px;background:linear-gradient(to right,rgb(230,90,90) 0 720px,rgb(60,170,140) 720px)}</style><div class="wide"></div>')
  try {
    const response = await fixture.capture('full')
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.deepEqual([record.width, record.height], [1150, 830])
    assert.equal(record.tiles.length, 4)
    const image = await fixture.sample(record, [[710, 400], [730, 400], [1140, 820]])
    assert.deepEqual(image.pixels, [[230, 90, 90, 255], [60, 170, 140, 255], [60, 170, 140, 255]])
  } finally { await fixture.close() }
})

test('area selection captures only the dragged rectangle after removing the overlay', async () => {
  const fixture = await harness('<style>body{margin:0;background:rgb(75,155,210)}</style>')
  try {
    const pending = fixture.capture('area')
    await fixture.page.locator('[data-imageshot-selector]').waitFor()
    await fixture.page.mouse.move(90, 120)
    await fixture.page.mouse.down()
    await fixture.page.mouse.move(430, 350)
    await fixture.page.mouse.up()
    const response = await pending
    assert.equal(response.ok, true, response.error)
    const record = fixture.records[0]
    assert.deepEqual([record.width, record.height], [340, 230])
    assert.deepEqual([record.tiles[0].sourceX, record.tiles[0].sourceY], [90, 120])
    assert.equal(await fixture.page.locator('[data-imageshot-selector]').count(), 0)
    const image = await fixture.sample(record, [[1, 1], [338, 228]])
    assert.deepEqual(image.pixels, [[75, 155, 210, 255], [75, 155, 210, 255]])
  } finally { await fixture.close() }
})

test('Escape cancels area selection without saving or opening an editor', async () => {
  const fixture = await harness('Capture fixture', { destination: 'studio' })
  try {
    const pending = fixture.capture('area')
    await fixture.page.locator('[data-imageshot-selector]').waitFor()
    await fixture.page.keyboard.press('Escape')
    const response = await pending
    assert.equal(response.ok, false)
    assert.equal(response.error, 'Capture cancelled.')
    assert.equal(fixture.records.length, 0)
    // The editor was opened early, so cancelling has to take it back down.
    assert.deepEqual(fixture.events, ['open-hidden', 'close'])
    assert.equal(await fixture.page.locator('[data-imageshot-selector]').count(), 0)
  } finally { await fixture.close() }
})

test('a capture failure restores the original webpage and reports the error', async () => {
  const fixture = await harness(fullPageFixture, { failAtCapture: 2, destination: 'studio' })
  try {
    await fixture.page.evaluate(() => window.scrollTo(0, 420))
    const response = await fixture.capture('full')
    assert.equal(response.ok, false)
    assert.match(response.error, /Simulated browser capture failure/)
    assert.equal(fixture.records.length, 0)
    assert.deepEqual(fixture.events, ['open-hidden', 'capture', 'capture', 'close'])
    assert.deepEqual(await fixture.page.evaluate(() => [window.scrollY, getComputedStyle(document.querySelector('.sticky')).position, document.querySelector('.fixed').style.visibility, !!window.__imageshotCaptureState]), [420, 'sticky', 'visible', false])
    assert.equal(await fixture.page.locator('[data-imageshot-notice]').count(), 1)
  } finally { await fixture.close() }
})

test('switching tabs stops capture before a screenshot of the wrong page is saved', async () => {
  const fixture = await harness(fullPageFixture, { switchAtCapture: 1, destination: 'studio' })
  try {
    const response = await fixture.capture('full')
    assert.equal(response.ok, false)
    assert.match(response.error, /switched tabs/)
    assert.equal(fixture.records.length, 0)
    assert.equal(fixture.events.at(-1), 'close')
    assert.equal(await fixture.page.evaluate(() => !!window.__imageshotCaptureState), false)
  } finally { await fixture.close() }
})

test('restricted browser tabs return a useful error without taking a screenshot', async () => {
  const fixture = await harness('Browser settings', { tabUrl: 'chrome://settings/' })
  try {
    const response = await fixture.capture('visible')
    assert.equal(response.ok, false)
    assert.match(response.error, /regular website/)
    assert.equal(fixture.captureTimes.length, 0)
    assert.equal(fixture.records.length, 0)
  } finally { await fixture.close() }
})

test('the draft store keeps a data URL image and drops an object URL one', async () => {
  const fixture = await harness('Draft storage')
  try {
    await fixture.page.addScriptTag({ content: `${draftSource}\nwindow.__drafts = { writeDraft, readDraft };` })
    const result = await fixture.page.evaluate(async () => {
      const drafts = window.__drafts
      const base = { name: 'Shot', annotations: [], style: {}, sample: false, captureId: 'draft-capture' }
      // A composed capture is served as an object URL, which means nothing after a
      // reload, so the draft must not be the only place it is kept.
      const objectUrl = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
      await drafts.writeDraft({ ...base, imageSrc: objectUrl })
      const composed = await drafts.readDraft('capture:draft-capture')
      URL.revokeObjectURL(objectUrl)
      // A cropped or imported image is a data URL and the draft is its only copy.
      const dataUrl = 'data:image/png;base64,iVBORw0KGgo='
      await drafts.writeDraft({ ...base, imageSrc: dataUrl })
      const cropped = await drafts.readDraft('capture:draft-capture')
      return {
        composed: { imageSrc: composed?.imageSrc, name: composed?.name, captureId: composed?.captureId },
        cropped: { imageSrc: cropped?.imageSrc, captureId: cropped?.captureId },
        latest: (await drafts.readDraft('latest'))?.imageSrc,
      }
    })
    assert.deepEqual(result.composed, { imageSrc: '', name: 'Shot', captureId: 'draft-capture' })
    assert.deepEqual(result.cropped, { imageSrc: 'data:image/png;base64,iVBORw0KGgo=', captureId: 'draft-capture' })
    assert.equal(result.latest, 'data:image/png;base64,iVBORw0KGgo=')
  } finally { await fixture.close() }
})

test('local screenshot history persists records, retains the newest twelve, and supports deletion', async () => {
  const fixture = await harness('Local screenshot storage')
  try {
    await fixture.page.addScriptTag({ content: `${storeSource}\nwindow.__captureStore = { saveCapture, getCapture, listCaptures, deleteCapture };` })
    const result = await fixture.page.evaluate(async () => {
      const storage = window.__captureStore
      for (let i = 0; i < 14; i += 1) await storage.saveCapture({
        id: `capture-${i}`, name: `Screenshot ${i}`, createdAt: i, mode: 'visible', width: 1, height: 1,
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=',
      })
      const history = await storage.listCaptures(12)
      const removedOldest = await storage.getCapture('capture-0')
      const newest = await storage.getCapture('capture-13')
      await storage.deleteCapture('capture-13')
      return { ids: history.map((record) => record.id), removedOldest, newest: newest?.name, afterDelete: await storage.getCapture('capture-13') }
    })
    assert.deepEqual(result.ids, Array.from({ length: 12 }, (_, index) => `capture-${13 - index}`))
    assert.equal(result.removedOldest, undefined)
    assert.equal(result.newest, 'Screenshot 13')
    assert.equal(result.afterDelete, undefined)
  } finally { await fixture.close() }
})
